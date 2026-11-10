// Organisation, employee, clock, shift and payment endpoints.
const express = require('express');
const { knex } = require('../db');
const { requireUser, claimInvites } = require('../auth');
const {
  HttpError,
  bad,
  normEmail,
  normPhone,
  toCents,
  wageCents,
  validTimezone,
  localDate,
  toMs,
  asyncH,
} = require('../util');

const router = express.Router();
router.use(requireUser);

const ADMIN_ROLES = ['owner', 'admin'];
const isAdmin = (m) => ADMIN_ROLES.includes(m.role);
const DAY = 86400000;

// ---------- serialisers ----------
const orgOut = (o) => ({ id: o.id, name: o.name, timezone: o.timezone, currency: o.currency });
const memberOut = (m) => ({
  id: m.id,
  name: m.display_name,
  email: m.invite_email,
  phone: m.invite_phone,
  role: m.role,
  hourlyRateCents: m.hourly_rate_cents,
  active: !!m.active,
  linked: !!m.user_id,
});
const shiftOut = (s, now = Date.now()) => ({
  id: s.id,
  memberId: s.member_id,
  clockIn: s.clock_in,
  clockOut: s.clock_out,
  rateCents: s.rate_cents,
  minutes: Math.round(((s.clock_out || now) - s.clock_in) / 60000),
  wageCents: wageCents(s.rate_cents, s.clock_in, s.clock_out || now),
  open: !s.clock_out,
  note: s.note,
});
const paymentOut = (p) => ({
  id: p.id,
  memberId: p.member_id,
  amountCents: p.amount_cents,
  method: p.method,
  paidAt: p.paid_at,
  note: p.note,
});

// Per-shift rounded wage, summed in SQL (works in Postgres and SQLite).
const EARNED_SQL = 'COALESCE(SUM(ROUND(rate_cents * (clock_out - clock_in) / 3600000.0)), 0)';

async function balances(orgId, memberIds) {
  if (!memberIds.length) return {};
  const earned = await knex('shifts')
    .select('member_id')
    .select(knex.raw(`${EARNED_SQL} as earned`))
    .where({ org_id: orgId })
    .whereIn('member_id', memberIds)
    .whereNotNull('clock_out')
    .groupBy('member_id');
  const paid = await knex('payments')
    .select('member_id')
    .sum({ paid: 'amount_cents' })
    .where({ org_id: orgId })
    .whereIn('member_id', memberIds)
    .groupBy('member_id');
  const out = {};
  for (const id of memberIds) out[id] = { earnedCents: 0, paidCents: 0, balanceCents: 0 };
  for (const r of earned) out[r.member_id].earnedCents = Number(r.earned);
  for (const r of paid) out[r.member_id].paidCents = Number(r.paid);
  for (const id of memberIds) out[id].balanceCents = out[id].earnedCents - out[id].paidCents;
  return out;
}

// ---------- org access middleware ----------
const loadOrg = asyncH(async (req, res, next) => {
  const orgId = Number(req.params.orgId);
  const me = await knex('members').where({ org_id: orgId, user_id: req.user.id, active: true }).first();
  if (!me) throw new HttpError(404, 'Organization not found');
  req.me = me;
  req.org = await knex('organizations').where({ id: orgId }).first();
  next();
});
const requireAdmin = (req, res, next) => (isAdmin(req.me) ? next() : next(new HttpError(403, 'Admins only')));

async function getMember(req, id) {
  const m = await knex('members').where({ id: Number(id), org_id: req.org.id }).first();
  if (!m) throw new HttpError(404, 'Employee not found');
  return m;
}

// Self, or an admin acting on someone in the same org.
async function resolveTarget(req, memberId) {
  if (!memberId || Number(memberId) === req.me.id) return req.me;
  if (!isAdmin(req.me)) throw new HttpError(403, 'Admins only');
  return getMember(req, memberId);
}

async function assertNoOverlap(memberId, start, end, excludeId) {
  const q = knex('shifts')
    .where({ member_id: memberId })
    .andWhere((w) => w.whereNull('clock_out').orWhere('clock_out', '>', start));
  if (end) q.andWhere('clock_in', '<', end);
  if (excludeId) q.andWhereNot('id', excludeId);
  if (await q.first()) throw new HttpError(409, 'This overlaps another shift for the same employee');
}

// ---------- me ----------
router.get(
  '/me',
  asyncH(async (req, res) => {
    await claimInvites(req.user);
    const orgs = await knex('members as m')
      .join('organizations as o', 'o.id', 'm.org_id')
      .where({ 'm.user_id': req.user.id, 'm.active': true })
      .select('o.id', 'o.name', 'm.role', 'm.id as member_id')
      .orderBy('o.name');
    res.json({
      user: { id: req.user.id, name: req.user.name, email: req.user.email, phone: req.user.phone },
      orgs: orgs.map((o) => ({ id: o.id, name: o.name, role: o.role, memberId: o.member_id })),
    });
  })
);

router.patch(
  '/me',
  asyncH(async (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 120);
    if (!name) throw bad('Name is required');
    await knex('users').where({ id: req.user.id }).update({ name });
    res.json({ ok: true });
  })
);

// ---------- organisations ----------
router.post(
  '/orgs',
  asyncH(async (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 120);
    const timezone = req.body?.timezone || 'America/New_York';
    const currency = String(req.body?.currency || 'USD').toUpperCase().slice(0, 3);
    if (!name) throw bad('Organization name is required');
    if (!validTimezone(timezone)) throw bad('Invalid time zone');
    const now = Date.now();
    const orgId = await knex.transaction(async (trx) => {
      const [o] = await trx('organizations').insert({ name, timezone, currency, created_at: now }).returning('id');
      const id = o.id ?? o;
      await trx('members').insert({
        org_id: id,
        user_id: req.user.id,
        display_name: req.user.name || req.body?.yourName || req.user.email || req.user.phone || 'Owner',
        invite_email: req.user.email,
        invite_phone: req.user.phone,
        role: 'owner',
        hourly_rate_cents: req.body?.yourHourlyRate ? toCents(req.body.yourHourlyRate, 'hourly rate') : 0,
        active: true,
        created_at: now,
      });
      return id;
    });
    if (req.body?.yourName && !req.user.name) {
      await knex('users').where({ id: req.user.id }).update({ name: String(req.body.yourName).slice(0, 120) });
    }
    res.status(201).json({ id: orgId });
  })
);

router.get(
  '/orgs/:orgId',
  loadOrg,
  asyncH(async (req, res) => {
    res.json({ org: orgOut(req.org), me: memberOut(req.me), isAdmin: isAdmin(req.me) });
  })
);

router.patch(
  '/orgs/:orgId',
  loadOrg,
  requireAdmin,
  asyncH(async (req, res) => {
    const patch = {};
    if (req.body.name !== undefined) {
      patch.name = String(req.body.name).trim().slice(0, 120);
      if (!patch.name) throw bad('Name is required');
    }
    if (req.body.timezone !== undefined) {
      if (!validTimezone(req.body.timezone)) throw bad('Invalid time zone');
      patch.timezone = req.body.timezone;
    }
    if (req.body.currency !== undefined) patch.currency = String(req.body.currency).toUpperCase().slice(0, 3);
    if (Object.keys(patch).length) await knex('organizations').where({ id: req.org.id }).update(patch);
    res.json({ ok: true });
  })
);

// ---------- employees ----------
router.get(
  '/orgs/:orgId/members',
  loadOrg,
  requireAdmin,
  asyncH(async (req, res) => {
    const members = await knex('members').where({ org_id: req.org.id }).orderBy([{ column: 'active', order: 'desc' }, 'display_name']);
    const ids = members.map((m) => m.id);
    const bal = await balances(req.org.id, ids);
    const open = ids.length
      ? await knex('shifts').where({ org_id: req.org.id }).whereNull('clock_out').whereIn('member_id', ids)
      : [];
    const openBy = Object.fromEntries(open.map((s) => [s.member_id, shiftOut(s)]));
    res.json({
      members: members.map((m) => ({ ...memberOut(m), ...bal[m.id], openShift: openBy[m.id] || null })),
    });
  })
);

router.post(
  '/orgs/:orgId/members',
  loadOrg,
  requireAdmin,
  asyncH(async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 120);
    const email = b.email ? normEmail(b.email) : null;
    const phone = b.phone ? normPhone(b.phone) : null;
    if (!name) throw bad('Name is required');
    if (b.email && !email) throw bad('Invalid email address');
    if (b.phone && !phone) throw bad('Invalid phone number');
    if (!email && !phone) throw bad('Add an email or phone number so they can sign in');
    const role = b.role === 'admin' ? 'admin' : 'employee';

    const dup = await knex('members')
      .where({ org_id: req.org.id })
      .andWhere((q) => {
        if (email) q.orWhere('invite_email', email);
        if (phone) q.orWhere('invite_phone', phone);
      })
      .first();
    if (dup) throw new HttpError(409, `${dup.display_name} already uses that email or phone`);

    // If they already have an account, link it right away.
    const existing = await knex('users')
      .where((q) => {
        if (email) q.orWhere('email', email);
        if (phone) q.orWhere('phone', phone);
      })
      .first();
    const linkedElsewhere =
      existing && (await knex('members').where({ org_id: req.org.id, user_id: existing.id }).first());

    const [row] = await knex('members')
      .insert({
        org_id: req.org.id,
        user_id: existing && !linkedElsewhere ? existing.id : null,
        display_name: name,
        invite_email: email,
        invite_phone: phone,
        role,
        hourly_rate_cents: toCents(b.hourlyRate ?? 0, 'hourly rate'),
        active: true,
        created_at: Date.now(),
      })
      .returning('id');
    const m = await getMember(req, row.id ?? row);
    res.status(201).json({ member: memberOut(m) });
  })
);

router.patch(
  '/orgs/:orgId/members/:memberId',
  loadOrg,
  requireAdmin,
  asyncH(async (req, res) => {
    const m = await getMember(req, req.params.memberId);
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) {
      patch.display_name = String(b.name).trim().slice(0, 120);
      if (!patch.display_name) throw bad('Name is required');
    }
    if (b.hourlyRate !== undefined) patch.hourly_rate_cents = toCents(b.hourlyRate, 'hourly rate');
    if (b.email !== undefined) {
      patch.invite_email = b.email ? normEmail(b.email) : null;
      if (b.email && !patch.invite_email) throw bad('Invalid email address');
    }
    if (b.phone !== undefined) {
      patch.invite_phone = b.phone ? normPhone(b.phone) : null;
      if (b.phone && !patch.invite_phone) throw bad('Invalid phone number');
    }
    if (b.role !== undefined || b.active !== undefined) {
      if (m.role === 'owner') throw bad("The owner's role can't be changed");
      if (b.role !== undefined) patch.role = b.role === 'admin' ? 'admin' : 'employee';
      if (b.active !== undefined) patch.active = !!b.active;
    }
    if (Object.keys(patch).length) await knex('members').where({ id: m.id }).update(patch);
    // Optionally re-price the shift currently in progress at the new rate.
    if (patch.hourly_rate_cents !== undefined && b.applyToOpenShift) {
      await knex('shifts').where({ member_id: m.id }).whereNull('clock_out').update({ rate_cents: patch.hourly_rate_cents });
    }
    res.json({ member: memberOut(await getMember(req, m.id)) });
  })
);

// Shifts, payments, daily totals and balance for one employee (admins: anyone; employees: themselves).
router.get(
  '/orgs/:orgId/members/:memberId/summary',
  loadOrg,
  asyncH(async (req, res) => {
    const m = await resolveTarget(req, req.params.memberId === 'me' ? req.me.id : req.params.memberId);
    const now = Date.now();
    const to = toMs(req.query.to, 'to') ?? now + DAY;
    const from = toMs(req.query.from, 'from') ?? now - 30 * DAY;
    const tz = req.org.timezone;

    const shifts = await knex('shifts')
      .where({ member_id: m.id })
      .andWhere('clock_in', '>=', from)
      .andWhere('clock_in', '<', to)
      .orderBy('clock_in', 'desc');
    const openShift = await knex('shifts').where({ member_id: m.id }).whereNull('clock_out').first();
    const payments = await knex('payments')
      .where({ member_id: m.id })
      .andWhere('paid_at', '>=', from)
      .andWhere('paid_at', '<', to)
      .orderBy('paid_at', 'desc');

    // Daily totals in the organisation's time zone (a shift counts toward the day it started).
    const days = {};
    let periodEarned = 0;
    for (const s of shifts) {
      const o = shiftOut(s, now);
      const d = localDate(s.clock_in, tz);
      days[d] ||= { date: d, minutes: 0, wageCents: 0, shifts: 0, inProgress: false };
      days[d].minutes += o.minutes;
      days[d].wageCents += o.wageCents;
      days[d].shifts += 1;
      if (o.open) days[d].inProgress = true;
      else periodEarned += o.wageCents;
    }
    const periodPaid = payments.reduce((a, p) => a + p.amount_cents, 0);
    const bal = (await balances(req.org.id, [m.id]))[m.id];

    res.json({
      member: memberOut(m),
      today: localDate(now, tz),
      openShift: openShift ? shiftOut(openShift, now) : null,
      balance: bal, // all-time: completed shifts minus payments
      period: { from, to, earnedCents: periodEarned, paidCents: periodPaid },
      days: Object.values(days).sort((a, b) => (a.date < b.date ? 1 : -1)),
      shifts: shifts.map((s) => shiftOut(s, now)),
      payments: payments.map(paymentOut),
    });
  })
);

// ---------- clock in / out ----------
router.post(
  '/orgs/:orgId/clock/in',
  loadOrg,
  asyncH(async (req, res) => {
    const m = await resolveTarget(req, req.body?.memberId);
    if (!m.active) throw bad('This employee is inactive');
    const now = Date.now();
    try {
      await knex('shifts').insert({
        org_id: req.org.id,
        member_id: m.id,
        clock_in: now,
        clock_out: null,
        rate_cents: m.hourly_rate_cents,
        note: req.body?.note ? String(req.body.note).slice(0, 500) : null,
        created_at: now,
      });
    } catch (e) {
      if (/unique|constraint/i.test(e.message)) throw new HttpError(409, 'Already clocked in');
      throw e;
    }
    const open = await knex('shifts').where({ member_id: m.id }).whereNull('clock_out').first();
    res.status(201).json({ shift: shiftOut(open) });
  })
);

router.post(
  '/orgs/:orgId/clock/out',
  loadOrg,
  asyncH(async (req, res) => {
    const m = await resolveTarget(req, req.body?.memberId);
    const open = await knex('shifts').where({ member_id: m.id }).whereNull('clock_out').first();
    if (!open) throw new HttpError(409, 'Not clocked in');
    const now = Math.max(Date.now(), open.clock_in + 1000);
    await knex('shifts').where({ id: open.id }).whereNull('clock_out').update({ clock_out: now });
    res.json({ shift: shiftOut({ ...open, clock_out: now }) });
  })
);

// ---------- shift corrections (admin) ----------
router.post(
  '/orgs/:orgId/members/:memberId/shifts',
  loadOrg,
  requireAdmin,
  asyncH(async (req, res) => {
    const m = await getMember(req, req.params.memberId);
    const start = toMs(req.body?.clockIn, 'clock-in time');
    const end = toMs(req.body?.clockOut, 'clock-out time');
    if (!start || !end) throw bad('Clock-in and clock-out times are required');
    if (end <= start) throw bad('Clock-out must be after clock-in');
    if (end > Date.now() + 60000) throw bad("Clock-out can't be in the future");
    await assertNoOverlap(m.id, start, end);
    const rate = req.body?.hourlyRate !== undefined ? toCents(req.body.hourlyRate, 'hourly rate') : m.hourly_rate_cents;
    const [row] = await knex('shifts')
      .insert({
        org_id: req.org.id,
        member_id: m.id,
        clock_in: start,
        clock_out: end,
        rate_cents: rate,
        note: req.body?.note ? String(req.body.note).slice(0, 500) : 'Added manually',
        edited_by: req.user.id,
        created_at: Date.now(),
      })
      .returning('id');
    const s = await knex('shifts').where({ id: row.id ?? row }).first();
    res.status(201).json({ shift: shiftOut(s) });
  })
);

router.patch(
  '/orgs/:orgId/shifts/:shiftId',
  loadOrg,
  requireAdmin,
  asyncH(async (req, res) => {
    const s = await knex('shifts').where({ id: Number(req.params.shiftId), org_id: req.org.id }).first();
    if (!s) throw new HttpError(404, 'Shift not found');
    const b = req.body || {};
    const start = b.clockIn !== undefined ? toMs(b.clockIn, 'clock-in time') : s.clock_in;
    const end = b.clockOut !== undefined ? toMs(b.clockOut, 'clock-out time') : s.clock_out;
    if (!start) throw bad('Clock-in time is required');
    if (end && end <= start) throw bad('Clock-out must be after clock-in');
    if (end && end > Date.now() + 60000) throw bad("Clock-out can't be in the future");
    await assertNoOverlap(s.member_id, start, end, s.id);
    const patch = { clock_in: start, clock_out: end || null, edited_by: req.user.id };
    if (b.hourlyRate !== undefined) patch.rate_cents = toCents(b.hourlyRate, 'hourly rate');
    if (b.note !== undefined) patch.note = b.note ? String(b.note).slice(0, 500) : null;
    try {
      await knex('shifts').where({ id: s.id }).update(patch);
    } catch (e) {
      if (/unique|constraint/i.test(e.message)) throw new HttpError(409, 'Employee already has an open shift');
      throw e;
    }
    res.json({ shift: shiftOut(await knex('shifts').where({ id: s.id }).first()) });
  })
);

router.delete(
  '/orgs/:orgId/shifts/:shiftId',
  loadOrg,
  requireAdmin,
  asyncH(async (req, res) => {
    const n = await knex('shifts').where({ id: Number(req.params.shiftId), org_id: req.org.id }).del();
    if (!n) throw new HttpError(404, 'Shift not found');
    res.json({ ok: true });
  })
);

// ---------- payments (admin) ----------
router.post(
  '/orgs/:orgId/members/:memberId/payments',
  loadOrg,
  requireAdmin,
  asyncH(async (req, res) => {
    const m = await getMember(req, req.params.memberId);
    const amount = toCents(req.body?.amount, 'amount');
    if (amount <= 0) throw bad('Amount must be more than zero');
    const method = ['cash', 'bank', 'check', 'other'].includes(req.body?.method) ? req.body.method : 'cash';
    const paidAt = toMs(req.body?.paidAt, 'payment date') ?? Date.now();
    const [row] = await knex('payments')
      .insert({
        org_id: req.org.id,
        member_id: m.id,
        amount_cents: amount,
        method,
        paid_at: paidAt,
        note: req.body?.note ? String(req.body.note).slice(0, 500) : null,
        recorded_by: req.user.id,
        created_at: Date.now(),
      })
      .returning('id');
    const p = await knex('payments').where({ id: row.id ?? row }).first();
    const bal = (await balances(req.org.id, [m.id]))[m.id];
    res.status(201).json({ payment: paymentOut(p), balance: bal });
  })
);

router.delete(
  '/orgs/:orgId/payments/:paymentId',
  loadOrg,
  requireAdmin,
  asyncH(async (req, res) => {
    const n = await knex('payments').where({ id: Number(req.params.paymentId), org_id: req.org.id }).del();
    if (!n) throw new HttpError(404, 'Payment not found');
    res.json({ ok: true });
  })
);

// ---------- CSV export (admin) ----------
router.get(
  '/orgs/:orgId/export.csv',
  loadOrg,
  requireAdmin,
  asyncH(async (req, res) => {
    const now = Date.now();
    const to = toMs(req.query.to, 'to') ?? now + DAY;
    const from = toMs(req.query.from, 'from') ?? now - 31 * DAY;
    const tz = req.org.timezone;
    const rows = await knex('shifts as s')
      .join('members as m', 'm.id', 's.member_id')
      .where('s.org_id', req.org.id)
      .andWhere('s.clock_in', '>=', from)
      .andWhere('s.clock_in', '<', to)
      .select('s.*', 'm.display_name')
      .orderBy([{ column: 'm.display_name' }, { column: 's.clock_in' }]);
    const fmt = (ms) =>
      ms
        ? new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(new Date(ms))
        : '';
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['Date', 'Employee', 'Clock in', 'Clock out', 'Hours', 'Rate', 'Wage', 'Note'].join(',')];
    for (const r of rows) {
      const o = shiftOut(r, now);
      lines.push(
        [
          localDate(r.clock_in, tz),
          esc(r.display_name),
          esc(fmt(r.clock_in)),
          esc(r.clock_out ? fmt(r.clock_out) : 'in progress'),
          (o.minutes / 60).toFixed(2),
          (r.rate_cents / 100).toFixed(2),
          (o.wageCents / 100).toFixed(2),
          esc(r.note),
        ].join(',')
      );
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="timesheet-${localDate(from, tz)}-to-${localDate(to - 1, tz)}.csv"`);
    res.send(lines.join('\n'));
  })
);

module.exports = router;
