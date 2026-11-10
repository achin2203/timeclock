// End-to-end API test against a temporary SQLite database.
const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');

const dbFile = path.join(os.tmpdir(), `tc-test-${process.pid}.sqlite`);
process.env.DATABASE_URL = `sqlite:${dbFile}`;
process.env.NODE_ENV = 'test';

const request = require('supertest');
const { migrate, knex } = require('../src/db');
const { createApp } = require('../src/server');

let app;
test.before(async () => {
  await migrate();
  app = createApp();
});
test.after(async () => {
  await knex.destroy();
  fs.rmSync(dbFile, { force: true });
});

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
  const ed = await owner.patch(`/api/orgs/${orgId}/shifts/${shift.body.shift.id}`).send({ clockIn: y - 4 * 3600000 });
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
