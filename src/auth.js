// Sign-in: one-time codes (email/SMS), Google, Facebook. Sessions are JWTs in an httpOnly cookie.
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const { sendCode, smsEnabled } = require('./notify');
const { HttpError, bad, classifyTarget, normEmail, asyncH } = require('./util');

const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? null : 'dev-secret-change-me');
if (!JWT_SECRET) throw new Error('JWT_SECRET must be set in production');

const COOKIE = 'tc_session';
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const FB_APP_ID = process.env.FACEBOOK_APP_ID || '';
const FB_APP_SECRET = process.env.FACEBOOK_APP_SECRET || '';

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
  const user = await db.getUser(payload.uid);
  if (!user) throw new HttpError(401, 'Not signed in');
  req.user = user;
  next();
});

async function findOrCreateUser({ email, phone, name, googleSub, facebookId }) {
  const idents = [
    ['google', googleSub],
    ['facebook', facebookId],
    ['email', email],
    ['phone', phone],
  ].filter(([, v]) => v);

  let user = null;
  for (const [kind, value] of idents) {
    user = await db.findUserByIdent(kind, value);
    if (user) break;
  }

  if (!user) {
    const fields = { email: email || undefined, phone: phone || undefined, name: name || undefined, googleSub, facebookId };
    user = await db.createUser(fields);
    for (const [kind, value] of idents) {
      if (!(await db.claimIdent(kind, value, user.id))) {
        // Lost a race with a parallel sign-in: use the account that got there first.
        const winner = await db.findUserByIdent(kind, value);
        if (winner) {
          user = winner;
          break;
        }
      }
    }
  } else {
    const patch = {};
    if (googleSub && !user.googleSub && (await db.claimIdent('google', googleSub, user.id))) patch.googleSub = googleSub;
    if (facebookId && !user.facebookId && (await db.claimIdent('facebook', facebookId, user.id))) patch.facebookId = facebookId;
    if (email && !user.email && (await db.claimIdent('email', email, user.id))) patch.email = email;
    if (phone && !user.phone && (await db.claimIdent('phone', phone, user.id))) patch.phone = phone;
    if (name && !user.name) patch.name = name;
    if (Object.keys(patch).length) {
      await db.updateUser(user.id, patch);
      user = { ...user, ...patch };
    }
  }
  await db.claimInvites(user);
  return user;
}

const router = express.Router();

// Per-instance limiter (Lambda instances are short-lived); the DB-level 30s throttle and
// 5-attempt limit below are the real protection.
const otpLimiter = rateLimit({ windowMs: 15 * 60000, limit: 20, standardHeaders: true, legacyHeaders: false });

router.get('/config', (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID || null, facebookAppId: FB_APP_ID || null, sms: smsEnabled() });
});

router.post(
  '/otp/request',
  otpLimiter,
  asyncH(async (req, res) => {
    const t = classifyTarget(req.body?.target);
    if (!t) throw bad('Enter a valid email address or phone number');
    const prev = await db.getOtp(t.value);
    if (prev && prev.createdAt > Date.now() - 30000) {
      throw new HttpError(429, 'Please wait 30 seconds before requesting another code');
    }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await db.putOtp(t.value, hashCode(t.value, code), 10 * 60000);
    let r;
    try {
      r = await sendCode(t.kind, t.value, code);
    } catch (e) {
      await db.deleteOtp(t.value); // let them retry right away
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
    const row = await db.getOtp(t.value);
    if (!row || row.expiresAt < Date.now()) throw bad('Code expired — request a new one');
    if (row.attempts >= 5) throw bad('Too many attempts — request a new code');

    const ok = crypto.timingSafeEqual(Buffer.from(row.codeHash), Buffer.from(hashCode(t.value, code)));
    if (!ok) {
      await db.bumpOtpAttempts(t.value);
      throw bad('Incorrect code');
    }
    await db.deleteOtp(t.value);
    const user = await findOrCreateUser(t.kind === 'email' ? { email: t.value } : { phone: t.value });
    setSession(res, user.id);
    res.json({ ok: true });
  })
);

// Verify a Google ID token with Google's tokeninfo endpoint (checks signature, expiry, audience).
async function verifyGoogle(idToken) {
  const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!r.ok) return null;
  const p = await r.json();
  const issOk = p.iss === 'accounts.google.com' || p.iss === 'https://accounts.google.com';
  if (!issOk || p.aud !== GOOGLE_CLIENT_ID || Number(p.exp) * 1000 < Date.now()) return null;
  return p;
}

router.post(
  '/google',
  asyncH(async (req, res) => {
    if (!GOOGLE_CLIENT_ID) throw new HttpError(503, 'Google sign-in is not configured');
    const credential = String(req.body?.credential || '');
    const p = credential ? await verifyGoogle(credential) : null;
    if (!p?.sub) throw new HttpError(401, 'Google sign-in failed');
    const user = await findOrCreateUser({
      googleSub: p.sub,
      email: p.email_verified === 'true' || p.email_verified === true ? normEmail(p.email) : null,
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

module.exports = { router, requireUser, findOrCreateUser };
