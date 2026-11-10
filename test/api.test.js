// End-to-end API test against an in-memory DynamoDB (dynalite).
const test = require('node:test');
const assert = require('node:assert');
const dynalite = require('dynalite');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.TABLE_NAME = 'timeclock-test';

let app, srv;
test.before(async () => {
  srv = dynalite({ createTableMs: 0 });
  await new Promise((r) => srv.listen(0, r));
  process.env.DYNAMODB_ENDPOINT = `http://127.0.0.1:${srv.address().port}`;
  await require('../src/db').ensureTable();
  app = require('../src/server').createApp();
});
test.after(() => srv.close());

async function login(target) {
  const agent = request.agent(app);
  const r1 = await agent.post('/api/auth/otp/request').send({ target });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  const r2 = await agent.post('/api/auth/otp/verify').send({ target, code: r1.body.devCode });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  return agent;
}

test('full flow: org, employee invite, clock, wages, payments, balance', async () => {
  const owner = await login('Owner@Example.com');
  const r = await owner.post('/api/orgs').send({ name: 'Acme Cafe', timezone: 'America/New_York', yourName: 'Achin' });
  assert.equal(r.status, 201);
  const orgId = r.body.id;

  // Add employee by phone; 10-digit number is normalised to +1
  const add = await owner
    .post(`/api/orgs/${orgId}/members`)
    .send({ name: 'Priya', phone: '(919) 555-0101', hourlyRate: '15.50' });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  assert.equal(add.body.member.phone, '+19195550101');
  assert.equal(add.body.member.hourlyRateCents, 1550);
  assert.equal(add.body.member.linked, false);
  const mid = add.body.member.id;

  // Duplicate phone rejected
  const dup = await owner.post(`/api/orgs/${orgId}/members`).send({ name: 'X', phone: '+1 919 555 0101' });
  assert.equal(dup.status, 409);

  // Employee signs in with the phone number -> sees the org
  const emp = await login('919-555-0101');
  const me = await emp.get('/api/me');
  assert.equal(me.body.orgs.length, 1);
  assert.equal(me.body.orgs[0].role, 'employee');

  // Employee can't see team list or record payments
  assert.equal((await emp.get(`/api/orgs/${orgId}/members`)).status, 403);
  assert.equal((await emp.post(`/api/orgs/${orgId}/members/${mid}/payments`).send({ amount: 5 })).status, 403);

  // Clock in, double clock-in blocked, clock out
  assert.equal((await emp.post(`/api/orgs/${orgId}/clock/in`).send({})).status, 201);
  assert.equal((await emp.post(`/api/orgs/${orgId}/clock/in`).send({})).status, 409);
  const out = await emp.post(`/api/orgs/${orgId}/clock/out`).send({});
  assert.equal(out.status, 200);
  assert.equal((await emp.post(`/api/orgs/${orgId}/clock/out`).send({})).status, 409);

  // Admin adds an 8-hour shift yesterday: 8h * $15.50 = $124.00
  const y = Date.now() - 86400000;
  const shift = await owner
    .post(`/api/orgs/${orgId}/members/${mid}/shifts`)
    .send({ clockIn: y - 8 * 3600000, clockOut: y });
  assert.equal(shift.status, 201, JSON.stringify(shift.body));
  assert.equal(shift.body.shift.wageCents, 12400);

  // Overlapping shift rejected
  const ov = await owner
    .post(`/api/orgs/${orgId}/members/${mid}/shifts`)
    .send({ clockIn: y - 3600000, clockOut: y + 1000 });
  assert.equal(ov.status, 409);

  // Cash payment of $100 -> balance $24 (+ a few cents at most from the short live shift)
  const pay = await owner.post(`/api/orgs/${orgId}/members/${mid}/payments`).send({ amount: 100, note: 'Cash advance' });
  assert.equal(pay.status, 201);
  assert.equal(pay.body.payment.method, 'cash');
  assert.ok(pay.body.balance.balanceCents >= 2400 && pay.body.balance.balanceCents <= 2401, JSON.stringify(pay.body));

  // Employee sees own summary with daily breakdown
  const sum = await emp.get(`/api/orgs/${orgId}/members/me/summary`);
  assert.equal(sum.status, 200);
  assert.equal(sum.body.payments.length, 1);
  assert.ok(sum.body.days.length >= 1);
  assert.equal(sum.body.balance.paidCents, 10000);

  // Rate change affects future shifts only; edit shift to 4h -> $62
  await owner.patch(`/api/orgs/${orgId}/members/${mid}`).send({ hourlyRate: 20 });
  const ed = await owner.patch(`/api/orgs/${orgId}/members/${mid}/shifts/${shift.body.shift.id}`).send({ clockIn: y - 4 * 3600000 });
  assert.equal(ed.body.shift.wageCents, 6200);

  // Team list shows balance
  const team = await owner.get(`/api/orgs/${orgId}/members`);
  const p = team.body.members.find((m) => m.id === mid);
  assert.ok(p.balanceCents <= -3799 && p.balanceCents >= -3800, String(p.balanceCents));
  assert.equal(p.linked, true);

  // CSV export
  const csv = await owner.get(`/api/orgs/${orgId}/export.csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.text, /Priya/);

  // Other users can't access the org
  const stranger = await login('stranger@example.com');
  assert.equal((await stranger.get(`/api/orgs/${orgId}`)).status, 404);
});

test('bad OTP is rejected and limited', async () => {
  const agent = request.agent(app);
  await agent.post('/api/auth/otp/request').send({ target: 'x@example.com' });
  const r = await agent.post('/api/auth/otp/verify').send({ target: 'x@example.com', code: '000000' });
  assert.equal(r.status, 400);
  assert.equal((await agent.get('/api/me')).status, 401);
});

test('admin actions: clock for others, deletes, contact edits, deactivate', async () => {
  const owner = await login('owner2@example.com');
  const { body } = await owner.post('/api/orgs').send({ name: 'Shop Two', timezone: 'Asia/Kolkata', currency: 'INR', yourName: 'Boss' });
  const orgId = body.id;
  const a = (await owner.post(`/api/orgs/${orgId}/members`).send({ name: 'Asha', email: 'asha@example.com', hourlyRate: 100 })).body.member;
  const b = (await owner.post(`/api/orgs/${orgId}/members`).send({ name: 'Bala', email: 'bala@example.com', hourlyRate: 120 })).body.member;

  // Can't give Bala Asha's email
  assert.equal((await owner.patch(`/api/orgs/${orgId}/members/${b.id}`).send({ email: 'asha@example.com' })).status, 409);
  // Change Bala's email, then Bala signs in with the new one and is linked
  assert.equal((await owner.patch(`/api/orgs/${orgId}/members/${b.id}`).send({ email: 'bala.new@example.com' })).status, 200);
  const bala = await login('bala.new@example.com');
  assert.equal((await bala.get('/api/me')).body.orgs.length, 1);
  const balaOld = await login('bala@example.com');
  assert.equal((await balaOld.get('/api/me')).body.orgs.length, 0);

  // Admin clocks Asha in, deletes the open shift -> she can clock in again
  const cin = await owner.post(`/api/orgs/${orgId}/clock/in`).send({ memberId: a.id });
  assert.equal(cin.status, 201);
  assert.equal((await owner.delete(`/api/orgs/${orgId}/members/${a.id}/shifts/${cin.body.shift.id}`).send({})).status, 200);
  assert.equal((await owner.post(`/api/orgs/${orgId}/clock/in`).send({ memberId: a.id })).status, 201);
  // Admin closes her open shift by editing clock-out
  const sum = (await owner.get(`/api/orgs/${orgId}/members/${a.id}/summary`)).body;
  const open = sum.openShift;
  const fixed = await owner
    .patch(`/api/orgs/${orgId}/members/${a.id}/shifts/${open.id}`)
    .send({ clockIn: Date.now() - 2 * 3600000, clockOut: Date.now() - 1000 });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.equal(fixed.body.shift.open, false);
  const after = (await owner.get(`/api/orgs/${orgId}/members/${a.id}/summary`)).body;
  assert.equal(after.openShift, null);
  assert.ok(after.balance.earnedCents >= 19990 && after.balance.earnedCents <= 20000, String(after.balance.earnedCents));

  // Payment then delete it
  const pay = await owner.post(`/api/orgs/${orgId}/members/${a.id}/payments`).send({ amount: 50 });
  assert.equal(pay.body.balance.paidCents, 5000);
  assert.equal((await owner.delete(`/api/orgs/${orgId}/members/${a.id}/payments/${pay.body.payment.id}`).send({})).status, 200);
  assert.equal((await owner.get(`/api/orgs/${orgId}/members/${a.id}/summary`)).body.balance.paidCents, 0);

  // Owner can't be demoted; deactivated employee loses access
  const ownerMember = (await owner.get(`/api/orgs/${orgId}`)).body.me;
  assert.equal((await owner.patch(`/api/orgs/${orgId}/members/${ownerMember.id}`).send({ role: 'employee' })).status, 400);
  await owner.patch(`/api/orgs/${orgId}/members/${b.id}`).send({ active: false });
  assert.equal((await bala.get('/api/me')).body.orgs.length, 0);
  assert.equal((await bala.get(`/api/orgs/${orgId}`)).status, 404);

  // Wrong-org access to member records is blocked
  const other = await login('other-owner@example.com');
  const o2 = (await other.post('/api/orgs').send({ name: 'Other' })).body.id;
  assert.equal((await other.get(`/api/orgs/${o2}/members/${a.id}/summary`)).status, 404);
});
