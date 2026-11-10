// Sign-in: one-time codes (email/SMS), Google, Facebook. Sessions are JWTs in an httpOnly cookie.
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { OAuth2Client } = require('google-auth-library');
const { knex } = require('./db');
const { sendCode } = require('./notify');
const { HttpError, bad, classifyTarget, normEmail, asyncH } = require('./util');

const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? null : 'dev-secret-change-me');
if (!JWT_SECRET) throw new Error('JWT_SECRET must be set in production');

const COOKIE = 'tc_session';
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const FB_APP_ID = process.env.FACEBOOK_APP_ID || '';
const FB_APP_SECRET = process.env.FACEBOOK_APP_SECRET || '';
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

const hashCode = (target, code) => crypto.createHmac('sha256', JWT_SECRET).update(`${target}:${code}`).digest('hex');

function setSession(res, userId) {
  const token = jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_DAYS * 86400000,
    path: '/',
  });
}

// Middleware: attaches req.user or responds 401.
const requireUser = asyncH(async (req, res, next) => {
  const token = req.cookies?.[COOKIE];
  if (!token) throw new HttpError(401, 'Not signed in');
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    throw new HttpError(401, 'Session expired');
  }
  const user = await knex('users').where({ id: payload.uid }).first();
  if (!user) throw new HttpError(401, 'Not signed in');
  req.user = user;
  next();
});

// Attach any employee records an admin created for this email/phone to the user account.
async function claimInvites(user) {
  const pending = await knex('members')
    .whereNull('user_id')
    .andWhere((q) => {
      if (user.email) q.orWhere('invite_email', user.email);
      if (user.phone) q.orWhere('invite_phone', user.phone);
      if (!user.email && !user.phone) q.whereRaw('1 = 0');
    });
  for (const m of pending) {
    const already = await knex('members').where({ org_id: m.org_id, user_id: user.id }).first();
    if (!already) await knex('members').where({ id: m.id }).update({ user_id: user.id });
  }
}

async function findOrCreateUser({ email, phone, name, googleSub, facebookId }) {
  let user = null;
  if (googleSub) user = await knex('users').where({ google_sub: googleSub }).first();
  if (!user && facebookId) user = await knex('users').where({ facebook_id: facebookId }).first();
  if (!user && email) user = await knex('users').where({ email }).first();
  if (!user && phone) user = await knex('users').where({ phone }).first();

  if (!user) {
    const [row] = await knex('users')
      .insert({
        email: email || null,
        phone: phone || null,
        name: name || null,
        google_sub: googleSub || null,
        facebook_id: facebookId || null,
        created_at: Date.now(),
      })
      .returning('id');
    user = await knex('users').where({ id: row.id ?? row }).first();
  } else {
    const patch = {};
    if (googleSub && !user.google_sub) patch.google_sub = googleSub;
    if (facebookId && !user.facebook_id) patch.facebook_id = facebookId;
    if (email && !user.email) patch.email = email;
    if (name && !user.name) patch.name = name;
    if (Object.keys(patch).length) {
      await knex('users').where({ id: user.id }).update(patch);
      user = { ...user, ...patch };
    }
  }
  await claimInvites(user);
  return user;
}

const router = express.Router();

const otpLimiter = rateLimit({ windowMs: 15 * 60000, limit: 10, standardHeaders: true, legacyHeaders: false });

router.get('/config', (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID || null, facebookAppId: FB_APP_ID || null });
});

router.post(
  '/otp/request',
  otpLimiter,
  asyncH(async (req, res) => {
    const t = classifyTarget(req.body?.target);
    if (!t) throw bad('Enter a valid email address or phone number');
    const recent = await knex('otp_codes')
      .where({ target: t.value })
      .andWhere('created_at', '>', Date.now() - 30000)
      .first();
    if (recent) throw new HttpError(429, 'Please wait 30 seconds before requesting another code');

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await knex('otp_codes').where({ target: t.value }).del();
    await knex('otp_codes').insert({
      target: t.value,
      code_hash: hashCode(t.value, code),
      attempts: 0,
      expires_at: Date.now() + 10 * 60000,
      created_at: Date.now(),
    });
    let r;
    try {
      r = await sendCode(t.kind, t.value, code);
    } catch (e) {
      await knex('otp_codes').where({ target: t.value }).del(); // let them retry right away
      throw e;
    }
    res.json({ ok: true, kind: t.kind, target: t.value, ...(r.devCode ? { devCode: r.devCode } : {}) });
  })
);

router.post(
  '/otp/verify',
  otpLimiter,
  asyncH(async (req, res) => {
    const t = classifyTarget(req.body?.target);
    const code = String(req.body?.code || '').replace(/\D/g, '');
    if (!t || code.length !== 6) throw bad('Enter the 6-digit code');
    const row = await knex('otp_codes').where({ target: t.value }).orderBy('id', 'desc').first();
    if (!row || row.expires_at < Date.now()) throw bad('Code expired — request a new one');
    if (row.attempts >= 5) throw bad('Too many attempts — request a new code');

    const ok = crypto.timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(hashCode(t.value, code)));
    if (!ok) {
      await knex('otp_codes').where({ id: row.id }).increment('attempts', 1);
      throw bad('Incorrect code');
    }
    await knex('otp_codes').where({ target: t.value }).del();
    const user = await findOrCreateUser(t.kind === 'email' ? { email: t.value } : { phone: t.value });
    setSession(res, user.id);
    res.json({ ok: true });
  })
);

router.post(
  '/google',
  asyncH(async (req, res) => {
    if (!googleClient) throw new HttpError(503, 'Google sign-in is not configured');
    let p;
    try {
      const ticket = await googleClient.verifyIdToken({ idToken: req.body?.credential, audience: GOOGLE_CLIENT_ID });
      p = ticket.getPayload();
    } catch {
      throw new HttpError(401, 'Google sign-in failed');
    }
    const user = await findOrCreateUser({
      googleSub: p.sub,
      email: p.email_verified ? normEmail(p.email) : null,
      name: p.name,
    });
    setSession(res, user.id);
    res.json({ ok: true });
  })
);

router.post(
  '/facebook',
  asyncH(async (req, res) => {
    if (!FB_APP_ID || !FB_APP_SECRET) throw new HttpError(503, 'Facebook sign-in is not configured');
    const token = String(req.body?.accessToken || '');
    if (!token) throw bad('Missing token');
    // Confirm the token was issued for *our* app before trusting it.
    const dbg = await fetch(
      `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(token)}&access_token=${FB_APP_ID}|${FB_APP_SECRET}`
    ).then((r) => r.json());
    if (!dbg?.data?.is_valid || String(dbg.data.app_id) !== FB_APP_ID) throw new HttpError(401, 'Facebook sign-in failed');
    const me = await fetch(
      `https://graph.facebook.com/me?fields=id,name,email&access_token=${encodeURIComponent(token)}`
    ).then((r) => r.json());
    if (!me?.id) throw new HttpError(401, 'Facebook sign-in failed');
    const user = await findOrCreateUser({ facebookId: me.id, email: normEmail(me.email), name: me.name });
    setSession(res, user.id);
    res.json({ ok: true });
  })
);

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

module.exports = { router, requireUser, claimInvites, findOrCreateUser };
