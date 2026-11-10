// DynamoDB data access. One table (on-demand / pay-per-request), keys `pk` + `sk`, TTL attribute `ttl`.
//
// Item layout (all reads are strongly consistent; no secondary indexes needed):
//   USER#<uid>            PROFILE              user profile
//   USER#<uid>            ORG#<oid>            { memberId }     -> orgs this user belongs to
//   IDENT#<kind>#<value>  IDENT                { userId }       unique email / phone / google / facebook
//   ORG#<oid>             META                 organisation
//   ORG#<oid>             MEMBER#<mid>         employee record (openShiftId while clocked in)
//   INVITE#<kind>#<value> ORG#<oid>            { memberId }     employee invited by email/phone
//   MEMBER#<mid>          SHIFT#<sid>          shift (times are epoch ms, money is integer cents)
//   MEMBER#<mid>          PAY#<pid>            payment
//   OTP#<target>          OTP                  one-time sign-in code (auto-expires via TTL)
const crypto = require('crypto');
const { DynamoDBClient, CreateTableCommand, DescribeTableCommand } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  BatchGetCommand,
} = require('@aws-sdk/lib-dynamodb');

const TABLE = process.env.TABLE_NAME || 'timeclock';
const endpoint = process.env.DYNAMODB_ENDPOINT || undefined; // set for local dev/tests (dynalite)
const client = new DynamoDBClient({
  region: process.env.AWS_REGION || 'us-east-2',
  ...(endpoint ? { endpoint, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
});
const ddb = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });

const newId = () => crypto.randomBytes(9).toString('base64url');
const isCondFail = (e) => e?.name === 'ConditionalCheckFailedException';

async function get(pk, sk) {
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk, sk }, ConsistentRead: true }));
  return r.Item || null;
}
async function put(item, condition) {
  await ddb.send(
    new PutCommand({ TableName: TABLE, Item: item, ...(condition ? { ConditionExpression: condition } : {}) })
  );
}
async function del(pk, sk) {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk, sk } }));
}
async function queryAll(pk, skPrefix) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const r = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: skPrefix ? 'pk = :pk AND begins_with(sk, :sk)' : 'pk = :pk',
        ExpressionAttributeValues: { ':pk': pk, ...(skPrefix ? { ':sk': skPrefix } : {}) },
        ConsistentRead: true,
        ExclusiveStartKey,
      })
    );
    items.push(...(r.Items || []));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}
async function batchGet(keys) {
  const out = [];
  for (let i = 0; i < keys.length; i += 100) {
    let req = { [TABLE]: { Keys: keys.slice(i, i + 100), ConsistentRead: true } };
    while (req && Object.keys(req).length) {
      const r = await ddb.send(new BatchGetCommand({ RequestItems: req }));
      out.push(...(r.Responses?.[TABLE] || []));
      req = r.UnprocessedKeys;
    }
  }
  return out;
}
// Partial update: set fields in `set`, remove names in `remove`.
async function update(pk, sk, set = {}, remove = [], condition, extraValues = {}) {
  const names = {};
  const values = { ...extraValues };
  const sets = Object.entries(set)
    .filter(([, v]) => v !== undefined)
    .map(([k, v], i) => {
      names[`#s${i}`] = k;
      values[`:s${i}`] = v;
      return `#s${i} = :s${i}`;
    });
  const rems = remove.map((k, i) => {
    names[`#r${i}`] = k;
    return `#r${i}`;
  });
  const expr = [sets.length ? 'SET ' + sets.join(', ') : '', rems.length ? 'REMOVE ' + rems.join(', ') : '']
    .filter(Boolean)
    .join(' ');
  if (!expr) return;
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk, sk },
      UpdateExpression: expr,
      ...(condition ? { ConditionExpression: condition } : {}),
      ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
      ExpressionAttributeValues: Object.keys(values).length ? values : undefined,
    })
  );
}

const strip = (item) => {
  if (!item) return item;
  const { pk, sk, ...rest } = item; // eslint-disable-line no-unused-vars
  return rest;
};

// ---------------- users & identities ----------------
const identKey = (kind, value) => `IDENT#${kind}#${value}`;

async function getUser(id) {
  return strip(await get(`USER#${id}`, 'PROFILE'));
}
async function findUserByIdent(kind, value) {
  if (!value) return null;
  const it = await get(identKey(kind, value), 'IDENT');
  return it ? getUser(it.userId) : null;
}
// Claim an identity for a user; returns false if someone else already has it.
async function claimIdent(kind, value, userId) {
  if (!value) return true;
  try {
    await put({ pk: identKey(kind, value), sk: 'IDENT', userId }, 'attribute_not_exists(pk)');
    return true;
  } catch (e) {
    if (!isCondFail(e)) throw e;
    const it = await get(identKey(kind, value), 'IDENT');
    return it?.userId === userId;
  }
}
async function createUser(fields) {
  const user = { id: newId(), createdAt: Date.now(), ...fields };
  await put({ pk: `USER#${user.id}`, sk: 'PROFILE', ...user });
  return user;
}
async function updateUser(id, patch) {
  await update(`USER#${id}`, 'PROFILE', patch);
}

// ---------------- one-time codes ----------------
async function getOtp(target) {
  return get(`OTP#${target}`, 'OTP');
}
async function putOtp(target, codeHash, ttlMs) {
  const now = Date.now();
  await put({
    pk: `OTP#${target}`,
    sk: 'OTP',
    codeHash,
    attempts: 0,
    createdAt: now,
    expiresAt: now + ttlMs,
    ttl: Math.floor((now + ttlMs) / 1000) + 3600,
  });
}
async function bumpOtpAttempts(target) {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `OTP#${target}`, sk: 'OTP' },
      UpdateExpression: 'ADD attempts :one',
      ExpressionAttributeValues: { ':one': 1 },
    })
  );
}
async function deleteOtp(target) {
  await del(`OTP#${target}`, 'OTP');
}

// ---------------- organisations & members ----------------
async function createOrg({ name, timezone, currency }) {
  const org = { id: newId(), name, timezone, currency, createdAt: Date.now() };
  await put({ pk: `ORG#${org.id}`, sk: 'META', ...org });
  return org;
}
async function getOrg(id) {
  return strip(await get(`ORG#${id}`, 'META'));
}
async function updateOrg(id, patch) {
  await update(`ORG#${id}`, 'META', patch);
}
async function getMember(orgId, memberId) {
  return strip(await get(`ORG#${orgId}`, `MEMBER#${memberId}`));
}
async function listMembers(orgId) {
  return (await queryAll(`ORG#${orgId}`, 'MEMBER#')).map(strip);
}
async function inviteOwner(orgId, kind, value) {
  if (!value) return null;
  return get(`INVITE#${kind}#${value}`, `ORG#${orgId}`);
}
async function putInvite(orgId, kind, value, memberId) {
  if (value) await put({ pk: `INVITE#${kind}#${value}`, sk: `ORG#${orgId}`, memberId });
}
async function deleteInvite(orgId, kind, value) {
  if (value) await del(`INVITE#${kind}#${value}`, `ORG#${orgId}`);
}
async function linkMember(orgId, memberId, userId) {
  try {
    await update(`ORG#${orgId}`, `MEMBER#${memberId}`, { userId }, [], 'attribute_not_exists(userId)');
  } catch (e) {
    if (isCondFail(e)) return false;
    throw e;
  }
  await put({ pk: `USER#${userId}`, sk: `ORG#${orgId}`, memberId });
  return true;
}
async function createMember(orgId, fields) {
  const m = {
    id: newId(),
    orgId,
    role: 'employee',
    hourlyRateCents: 0,
    active: true,
    createdAt: Date.now(),
    ...fields,
  };
  const { userId, ...rest } = m;
  await put({ pk: `ORG#${orgId}`, sk: `MEMBER#${m.id}`, ...rest });
  await putInvite(orgId, 'email', m.inviteEmail, m.id);
  await putInvite(orgId, 'phone', m.invitePhone, m.id);
  if (userId) await linkMember(orgId, m.id, userId);
  return getMember(orgId, m.id);
}
async function updateMember(orgId, memberId, patch, remove = []) {
  await update(`ORG#${orgId}`, `MEMBER#${memberId}`, patch, remove);
}
async function membershipFor(userId, orgId) {
  const link = await get(`USER#${userId}`, `ORG#${orgId}`);
  if (!link) return null;
  return getMember(orgId, link.memberId);
}
// All active memberships for a user, with org details.
async function userOrgs(userId) {
  const links = await queryAll(`USER#${userId}`, 'ORG#');
  if (!links.length) return [];
  const keys = links.flatMap((l) => {
    const orgId = l.sk.slice(4);
    return [
      { pk: `ORG#${orgId}`, sk: 'META' },
      { pk: `ORG#${orgId}`, sk: `MEMBER#${l.memberId}` },
    ];
  });
  const items = await batchGet(keys);
  const byKey = Object.fromEntries(items.map((i) => [`${i.pk}|${i.sk}`, i]));
  return links
    .map((l) => {
      const orgId = l.sk.slice(4);
      const org = byKey[`ORG#${orgId}|META`];
      const m = byKey[`ORG#${orgId}|MEMBER#${l.memberId}`];
      return org && m && m.active ? { id: orgId, name: org.name, role: m.role, memberId: m.id } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}
// Link pending employee records (invited by this user's email/phone) to the user.
async function claimInvites(user) {
  const found = [];
  for (const [kind, value] of [
    ['email', user.email],
    ['phone', user.phone],
  ]) {
    if (value) found.push(...(await queryAll(`INVITE#${kind}#${value}`, 'ORG#')));
  }
  for (const inv of found) {
    const orgId = inv.sk.slice(4);
    if (await get(`USER#${user.id}`, `ORG#${orgId}`)) continue; // already in this org
    const m = await getMember(orgId, inv.memberId);
    if (m && !m.userId) await linkMember(orgId, m.id, user.id);
  }
}

// ---------------- shifts & payments ----------------
async function memberRecords(memberId) {
  const items = await queryAll(`MEMBER#${memberId}`);
  const shifts = [];
  const payments = [];
  for (const it of items) {
    if (it.sk.startsWith('SHIFT#')) shifts.push(strip(it));
    else if (it.sk.startsWith('PAY#')) payments.push(strip(it));
  }
  shifts.sort((a, b) => b.clockIn - a.clockIn);
  payments.sort((a, b) => b.paidAt - a.paidAt);
  return { shifts, payments };
}
async function getShift(memberId, shiftId) {
  return strip(await get(`MEMBER#${memberId}`, `SHIFT#${shiftId}`));
}
async function putShift(shift) {
  await put({ pk: `MEMBER#${shift.memberId}`, sk: `SHIFT#${shift.id}`, ...shift });
}
async function deleteShift(memberId, shiftId) {
  await del(`MEMBER#${memberId}`, `SHIFT#${shiftId}`);
}
async function getPayment(memberId, paymentId) {
  return strip(await get(`MEMBER#${memberId}`, `PAY#${paymentId}`));
}
async function putPayment(p) {
  await put({ pk: `MEMBER#${p.memberId}`, sk: `PAY#${p.id}`, ...p });
}
async function deletePayment(memberId, paymentId) {
  await del(`MEMBER#${memberId}`, `PAY#${paymentId}`);
}

// Clock in: atomically mark the member as on-shift (only if not already), then write the shift.
async function clockIn(member, note) {
  const now = Date.now();
  const shift = {
    id: newId(),
    orgId: member.orgId,
    memberId: member.id,
    clockIn: now,
    rateCents: member.hourlyRateCents,
    note: note || undefined,
    createdAt: now,
  };
  try {
    await update(
      `ORG#${member.orgId}`,
      `MEMBER#${member.id}`,
      { openShiftId: shift.id },
      [],
      'attribute_not_exists(openShiftId) AND active = :t',
      { ':t': true }
    );
  } catch (e) {
    if (isCondFail(e)) return null;
    throw e;
  }
  await putShift(shift);
  return shift;
}
async function clockOut(member) {
  if (!member.openShiftId) return null;
  const s = await getShift(member.id, member.openShiftId);
  const now = Math.max(Date.now(), (s?.clockIn || 0) + 1000);
  try {
    await update(
      `ORG#${member.orgId}`,
      `MEMBER#${member.id}`,
      {},
      ['openShiftId'],
      'openShiftId = :sid',
      { ':sid': member.openShiftId }
    );
  } catch (e) {
    if (isCondFail(e)) return null;
    throw e;
  }
  if (!s) return null;
  const closed = { ...s, clockOut: now };
  await putShift(closed);
  return closed;
}

// Local dev / tests: create the table if it doesn't exist.
async function ensureTable() {
  try {
    await client.send(new DescribeTableCommand({ TableName: TABLE }));
  } catch (e) {
    if (e.name !== 'ResourceNotFoundException') throw e;
    await client.send(
      new CreateTableCommand({
        TableName: TABLE,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
      })
    );
    for (let i = 0; i < 50; i++) {
      const d = await client.send(new DescribeTableCommand({ TableName: TABLE }));
      if (d.Table.TableStatus === 'ACTIVE') break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

async function ping() {
  await client.send(new DescribeTableCommand({ TableName: TABLE }));
}

module.exports = {
  newId,
  isCondFail,
  ensureTable,
  ping,
  getUser,
  findUserByIdent,
  claimIdent,
  createUser,
  updateUser,
  getOtp,
  putOtp,
  bumpOtpAttempts,
  deleteOtp,
  createOrg,
  getOrg,
  updateOrg,
  getMember,
  listMembers,
  inviteOwner,
  putInvite,
  deleteInvite,
  linkMember,
  createMember,
  updateMember,
  membershipFor,
  userOrgs,
  claimInvites,
  memberRecords,
  getShift,
  putShift,
  deleteShift,
  getPayment,
  putPayment,
  deletePayment,
  clockIn,
  clockOut,
};
