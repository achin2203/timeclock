// Organisation, employee, clock, shift and payment endpoints.
const express = require('express');
const db = require('../db');
const { requireUser } = require('../auth');
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
const clip = (v, n) => (v === undefined || v === null || v === '' ? undefined : String(v).slice(0, n));

// ---------- serialisers ----------
const orgOut = (o) => ({ id: o.id, name: o.name, timezone: o.timezone, currency: o.currency });
const memberOut = (m) => ({
  id: m.id,
  name: m.displayName,
  email: m.inviteEmail || null,
  phone: m.invitePhone || null,
  role: m.role,
  hourlyRateCents: m.hourlyRateCents,
  active: !!m.active,
  linked: !!m.userId,
});
const shiftOut = (s, now = Date.now()) => ({
  id: s.id,
  memberId: s.memberId,
  clockIn: s.clockIn,
  clockOut: s.clockOut || null,
  rateCents: s.rateCents,
  minutes: Math.round(((s.clockOut || now) - s.clockIn) / 60000),
  wageCents: wageCents(s.rateCents, s.clockIn, s.clockOut || now),
  open: !s.clockOut,
  note: s.note || null,
});
const paymentOut = (p) => ({
  id: p.id,
  memberId: p.memberId,
  amountCents: p.amountCents,
  method: p.method,
  paidAt: p.paidAt,
  note: p.note || null,
});

// All-time balance: wages from completed shifts minus payments.
function balanceOf({ shifts, payments }) {
  const earnedCents = shifts.filter((s) => s.clockOut).reduce((a, s) => a + wageCents(s.rateCents, s.clockIn, s.clockOut), 0);
  const paidCents = payments.reduce((a, p) => a + p.amountCents, 0);
  return { earnedCents, paidCents, balanceCents: earnedCents - paidCents };
}

// ---------- org access middleware ----------
const loadOrg = asyncH(async (req, res, next) => {
  const orgId = String(req.params.orgId);
  const me = await db.membershipFor(req.user.id, orgId);
  if (!me || !me.active) throw new HttpError(404, 'Organization not found');
  const org = await db.getOrg(orgId);
  if (!org) throw new HttpError(404, 'Organization not found');
  req.me = me;
  req.org = org;
  next();
});
const requireAdmin = (req, res, next) => (isAdmin(req.me) ? next() : next(new HttpError(403, 'Admins only')));

async function getMember(req, id) {
  const m = await db.getMember(req.org.id, String(id));
  if (!m) throw new HttpError(404, 'Employee not found');
  return m;
}

// Self, or an admin acting on someone in the same org.
async function resolveTarget(req, memberId) {
  if (!memberId || memberId === 'me' || String(memberId) === req.me.id) return req.me;
  if (!isAdmin(req.me)) throw new HttpError(403, 'Admins only');
  return getMember(req, memberId);
}

function assertNoOverlap(shifts, start, end, excludeId) {
  const hit = shifts.find(
    (s) => s.id !== excludeId && (s.clockOut ? s.clockOut > start : true) && (end ? s.clockIn < end : true)
  );
  if (hit) throw new HttpError(409, 'This overlaps another shift for the same employee');
}

// ---------- me ----------
router.get(
  '/me',
  asyncH(async (req, res) => {
    await db.claimInvites(req.user);
    const orgs = await db.userOrgs(req.user.id);
    const u = req.user;
    res.json({
      user: { id: u.id, name: u.name || null, email: u.email || null, phone: u.phone || null },
      orgs,
    });
  })
);

router.patch(
  '/me',
  asyncH(async (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 120);
    if (!name) throw bad('Name is required');
    await db.updateUser(req.user.id, { name });
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
    const yourName = clip(String(req.body?.yourName || '').trim(), 120);
    if (yourName && !req.user.name) await db.updateUser(req.user.id, { name: yourName });

    const org = await db.createOrg({ name, timezone, currency });
    await db.createMember(org.id, {
      userId: req.user.id,
      displayName: req.user.name || yourName || req.user.email || req.user.phone || 'Owner',
      inviteEmail: req.user.email,
      invitePhone: req.user.phone,
      role: 'owner',
      hourlyRateCents: req.body?.yourHourlyRate ? toCents(req.body.yourHourlyRate, 'hourly rate') : 0,
    });
    res.status(201).json({ id: org.id });
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
    if (Object.keys(patch).length) await db.updateOrg(req.org.id, patch);
    res.json({ ok: true });
  })
);

// ---------- employees ----------
router.get(
  '/orgs/:orgId/members',
  loadOrg,
  requireAdmin,
  asyncH(async (req, res) => {
    const members = await db.listMembers(req.org.id);
    const now = Date.now();
    const rows = await Promise.all(
      members.map(async (m) => {
        const rec = await db.memberRecords(m.id);
        const open = rec.shifts.find((s) => !s.clockOut);
        return { ...memberOut(m), ...balanceOf(rec), openShift: open ? shiftOut(open, now) : null };
      })
    );
    rows.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
    res.json({ members: rows });
  })
);

async function assertContactFree(orgId, email, phone, selfId) {
  for (const [kind, value] of [
    ['email', email],
    ['phone', phone],
  ]) {
    const inv = await db.inviteOwner(orgId, kind, value);
    if (inv && inv.memberId !== selfId) {
      const other = await db.getMember(orgId, inv.memberId);
      throw new HttpError(409, `${other?.displayName || 'Another employee'} already uses that ${kind}`);
    }
  }
}

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
    await assertContactFree(req.org.id, email, phone);

    // If they already have an account (and aren't already in this org), link it right away.
    const existing = (await db.findUserByIdent('email', email)) || (await db.findUserByIdent('phone', phone));
    const alreadyIn = existing && (await db.membershipFor(existing.id, req.org.id));

    const m = await db.createMember(req.org.id, {
      userId: existing && !alreadyIn ? existing.id : undefined,
      displayName: name,
      inviteEmail: email || undefined,
      invitePhone: phone || undefined,
      role: b.role === 'admin' ? 'admin' : 'employee',
      hourlyRateCents: toCents(b.hourlyRate ?? 0, 'hourly rate'),
    });
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
    const remove = [];
    if (b.name !== undefined) {
      patch.displayName = String(b.name).trim().slice(0, 120);
      if (!patch.displayName) throw bad('Name is required');
    }
    if (b.hourlyRate !== undefined) patch.hourlyRateCents = toCents(b.hourlyRate, 'hourly rate');

    let email = m.inviteEmail || null;
    let phone = m.invitePhone || null;
    if (b.email !== undefined) {
      email = b.email ? normEmail(b.email) : null;
      if (b.email && !email) throw bad('Invalid email address');
    }
    if (b.phone !== undefined) {
      phone = b.phone ? normPhone(b.phone) : null;
      if (b.phone && !phone) throw bad('Invalid phone number');
    }
    if (!email && !phone) throw bad('Keep an email or phone number so they can sign in');
    await assertContactFree(req.org.id, email, phone, m.id);

    if (b.role !== undefined || b.active !== undefined) {
      if (m.role === 'owner') throw bad("The owner's role can't be changed");
      if (b.role !== undefined) patch.role = b.role === 'admin' ? 'admin' : 'employee';
      if (b.active !== undefined) patch.active = !!b.active;
    }
    if (email !== (m.inviteEmail || null)) {
      await db.deleteInvite(req.org.id, 'email', m.inviteEmail);
      await db.putInvite(req.org.id, 'email', email, m.id);
      if (email) patch.inviteEmail = email;
      else remove.push('inviteEmail');
    }
    if (phone !== (m.invitePhone || null)) {
      await db.deleteInvite(req.org.id, 'phone', m.invitePhone);
      await db.putInvite(req.org.id, 'phone', phone, m.id);
      if (phone) patch.invitePhone = phone;
      else remove.push('invitePhone');
    }
    await db.updateMember(req.org.id, m.id, patch, remove);

    // Optionally re-price the shift currently in progress at the new rate.
    if (patch.hourlyRateCents !== undefined && b.applyToOpenShift && m.openShiftId) {
      const s = await db.getShift(m.id, m.openShiftId);
      if (s && !s.clockOut) await db.putShift({ ...s, rateCents: patch.hourlyRateCents });
    }
    // New contact details may match someone who already has an account.
    if (!m.userId) {
      const existing = (await db.findUserByIdent('email', email)) || (await db.findUserByIdent('phone', phone));
      if (existing && !(await db.membershipFor(existing.id, req.org.id))) await db.linkMember(req.org.id, m.id, existing.id);
    }
    res.json({ member: memberOut(await getMember(req, m.id)) });
  })
);

// Shifts, payments, daily totals and balance for one employee (admins: anyone; employees: themselves).
router.get(
  '/orgs/:orgId/members/:memberId/summary',
  loadOrg,
  asyncH(async (req, res) => {
    const m = await resolveTarget(req, req.params.memberId);
    const now = Date.now();
    const to = toMs(req.query.to, 'to') ?? now + DAY;
    const from = toMs(req.query.from, 'from') ?? now - 30 * DAY;
    const tz = req.org.timezone;

    const rec = await db.memberRecords(m.id);
    const shifts = rec.shifts.filter((s) => s.clockIn >= from && s.clockIn < to);
    const payments = rec.payments.filter((p) => p.paidAt >= from && p.paidAt < to);
    const openShift = rec.shifts.find((s) => !s.clockOut);

    // Daily totals in the organisation's time zone (a shift counts toward the day it started).
    const days = {};
    let periodEarned = 0;
    for (const s of shifts) {
      const o = shiftOut(s, now);
      const d = localDate(s.clockIn, tz);
      days[d] ||= { date: d, minutes: 0, wageCents: 0, shifts: 0, inProgress: false };
      days[d].minutes += o.minutes;
      days[d].wageCents += o.wageCents;
      days[d].shifts += 1;
      if (o.open) days[d].inProgress = true;
      else periodEarned += o.wageCents;
    }

    res.json({
      member: memberOut(m),
      today: localDate(now, tz),
      openShift: openShift ? shiftOut(openShift, now) : null,
      balance: balanceOf(rec),
      period: { from, to, earnedCents: periodEarned, paidCents: payments.reduce((a, p) => a + p.amountCents, 0) },
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
    const s = await db.clockIn(m, clip(req.body?.note, 500));
    if (!s) throw new HttpError(409, 'Already clocked in');
    res.status(201).json({ shift: shiftOut(s) });
  })
);

router.post(
  '/orgs/:orgId/clock/out',
  loadOrg,
  asyncH(async (req, res) => {
    const m = await resolveTarget(req, req.body?.memberId);
    const s = await db.clockOut(m);
    if (!s) throw new HttpError(409, 'Not clocked in');
    res.json({ shift: shiftOut(s) });
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
    const { shifts } = await db.memberRecords(m.id);
    assertNoOverlap(shifts, start, end);
    const s = {
      id: db.newId(),
      orgId: req.org.id,
      memberId: m.id,
      clockIn: start,
      clockOut: end,
      rateCents: req.body?.hourlyRate !== undefined ? toCents(req.body.hourlyRate, 'hourly rate') : m.hourlyRateCents,
      note: clip(req.body?.note, 500) || 'Added manually',
      editedBy: req.user.id,
      createdAt: Date.now(),
    };
    await db.putShift(s);
    res.status(201).json({ shift: shiftOut(s) });
  })
);

router.patch(
  '/orgs/:orgId/members/:memberId/shifts/:shiftId',
  loadOrg,
  requireAdmin,
  asyncH(async (req, res) => {
    const m = await getMember(req, req.params.memberId);
    const s = await db.getShift(m.id, String(req.params.shiftId));
    if (!s) throw new HttpError(404, 'Shift not found');
    const isOpen = !s.clockOut;
    const b = req.body || {};
    const start = b.clockIn !== undefined ? toMs(b.clockIn, 'clock-in time') : s.clockIn;
    let end = b.clockOut !== undefined ? toMs(b.clockOut, 'clock-out time') : s.clockOut || null;
    if (!start) throw bad('Clock-in time is required');
    if (!isOpen && !end) throw bad('Clock-out time is required');
    if (end && end <= start) throw bad('Clock-out must be after clock-in');
    if (end && end > Date.now() + 60000) throw bad("Clock-out can't be in the future");
    if (isOpen && start > Date.now() + 60000) throw bad("Clock-in can't be in the future");
    const { shifts } = await db.memberRecords(m.id);
    assertNoOverlap(shifts, start, end, s.id);

    const next = { ...s, clockIn: start, editedBy: req.user.id };
    if (end) next.clockOut = end;
    if (b.hourlyRate !== undefined) next.rateCents = toCents(b.hourlyRate, 'hourly rate');
    if (b.note !== undefined) next.note = clip(b.note, 500);
    await db.putShift(next);
    if (isOpen && end && m.openShiftId === s.id) await db.updateMember(req.org.id, m.id, {}, ['openShiftId']);
    res.json({ shift: shiftOut(next) });
  })
);

router.delete(
  '/orgs/:orgId/members/:memberId/shifts/:shiftId',
  loadOrg,
  requireAdmin,
  asyncH(async (req, res) => {
    const m = await getMember(req, req.params.memberId);
    const s = await db.getShift(m.id, String(req.params.shiftId));
    if (!s) throw new HttpError(404, 'Shift not found');
    await db.deleteShift(m.id, s.id);
    if (m.openShiftId === s.id) await db.updateMember(req.org.id, m.id, {}, ['openShiftId']);
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
    const p = {
      id: db.newId(),
      orgId: req.org.id,
      memberId: m.id,
      amountCents: amount,
      method,
      paidAt: toMs(req.body?.paidAt, 'payment date') ?? Date.now(),
      note: clip(req.body?.note, 500),
      recordedBy: req.user.id,
      createdAt: Date.now(),
    };
    await db.putPayment(p);
    res.status(201).json({ payment: paymentOut(p), balance: balanceOf(await db.memberRecords(m.id)) });
  })
);

router.delete(
  '/orgs/:orgId/members/:memberId/payments/:paymentId',
  loadOrg,
  requireAdmin,
  asyncH(async (req, res) => {
    const m = await getMember(req, req.params.memberId);
    const p = await db.getPayment(m.id, String(req.params.paymentId));
    if (!p) throw new HttpError(404, 'Payment not found');
    await db.deletePayment(m.id, p.id);
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
    const members = (await db.listMembers(req.org.id)).sort((a, b) => a.displayName.localeCompare(b.displayName));
    const fmt = (ms) =>
      ms
        ? new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(new Date(ms))
        : '';
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['Date', 'Employee', 'Clock in', 'Clock out', 'Hours', 'Rate', 'Wage', 'Note'].join(',')];
    for (const m of members) {
      const { shifts } = await db.memberRecords(m.id);
      for (const r of shifts.filter((s) => s.clockIn >= from && s.clockIn < to).sort((a, b) => a.clockIn - b.clockIn)) {
        const o = shiftOut(r, now);
        lines.push(
          [
            localDate(r.clockIn, tz),
            esc(m.displayName),
            esc(fmt(r.clockIn)),
            esc(r.clockOut ? fmt(r.clockOut) : 'in progress'),
            (o.minutes / 60).toFixed(2),
            (r.rateCents / 100).toFixed(2),
            (o.wageCents / 100).toFixed(2),
            esc(r.note),
          ].join(',')
        );
      }
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="timesheet-${localDate(from, tz)}-to-${localDate(to - 1, tz)}.csv"`
    );
    res.send(lines.join('\n'));
  })
);

module.exports = router;
