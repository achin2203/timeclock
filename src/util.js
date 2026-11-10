// Shared helpers: input normalisation, money math, time-zone day grouping.

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (msg) => new HttpError(400, msg);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normEmail(v) {
  if (!v) return null;
  const e = String(v).trim().toLowerCase();
  return EMAIL_RE.test(e) ? e : null;
}

// Normalise to E.164. Bare 10-digit numbers get DEFAULT_COUNTRY_CODE (default "1", US/Canada).
function normPhone(v) {
  if (!v) return null;
  const raw = String(v).trim();
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  let e164;
  if (raw.startsWith('+')) e164 = '+' + digits;
  else if (digits.length === 10) e164 = '+' + (process.env.DEFAULT_COUNTRY_CODE || '1') + digits;
  else if (digits.length === 11 && digits.startsWith('1')) e164 = '+' + digits;
  else e164 = '+' + digits;
  return /^\+\d{8,15}$/.test(e164) ? e164 : null;
}

// "email" | "phone" | null
function classifyTarget(v) {
  const e = normEmail(v);
  if (e) return { kind: 'email', value: e };
  const p = normPhone(v);
  if (p) return { kind: 'phone', value: p };
  return null;
}

// Dollars (number or string like "15.50") -> integer cents.
function toCents(v, field = 'amount') {
  const n = typeof v === 'string' ? Number(v.replace(/[^0-9.\-]/g, '')) : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e7) throw bad(`Invalid ${field}`);
  return Math.round(n * 100);
}

// Wage earned for a time span at an hourly rate, in cents.
function wageCents(rateCents, startMs, endMs) {
  if (!endMs || endMs <= startMs) return 0;
  return Math.round((rateCents * (endMs - startMs)) / 3600000);
}

function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Calendar date (YYYY-MM-DD) of a timestamp in the organisation's time zone.
function localDate(ms, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(ms)
  );
}

function toMs(v, field) {
  if (v === undefined || v === null || v === '') return null;
  const ms = typeof v === 'number' ? v : /^\d+$/.test(String(v)) ? Number(v) : Date.parse(v);
  if (!Number.isFinite(ms)) throw bad(`Invalid ${field}`);
  return ms;
}

const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = {
  HttpError,
  bad,
  normEmail,
  normPhone,
  classifyTarget,
  toCents,
  wageCents,
  validTimezone,
  localDate,
  toMs,
  asyncH,
};
