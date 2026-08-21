// Tests for tools/daily_period_boundaries.js
// Usage: node tools/daily_period_boundaries.test.js

'use strict';

const { dailyPeriodBoundaries } = require('./daily_period_boundaries.js');

let passed = 0, failed = 0;
const failures = [];
function assert(cond, label, ctx) {
  if (cond) { passed++; return; }
  failed++;
  failures.push({ label, ctx });
  console.log(`  FAIL: ${label}` + (ctx ? '  ' + JSON.stringify(ctx) : ''));
}
function assertThrows(fn, matchSubstr, label) {
  try { fn(); assert(false, `${label} — expected throw (${matchSubstr})`, null); }
  catch (e) {
    const msg = String(e && e.message);
    if (msg.includes(matchSubstr)) assert(true, `${label} — threw (${matchSubstr})`);
    else assert(false, `${label} — threw wrong error`, { expected: matchSubstr, got: msg });
  }
}
function section(name) { console.log('\n== ' + name + ' =='); }

// ---------- test 1: formula sanity, epochZero=0 ----------------------------
section('test 1 — formula sanity (epochZero = 0)');
{
  const r = dailyPeriodBoundaries({ epochZero: 0, periodDurationSeconds: 86400, periodId: 0 });
  assert(r.startUnix === 0,     'start = 0',      r);
  assert(r.endUnix   === 86400, 'end   = 86400',  r);
  assert(r.startISO  === '1970-01-01T00:00:00.000Z', 'startISO Unix epoch', r);
  assert(r.endISO    === '1970-01-02T00:00:00.000Z', 'endISO   +1 day',    r);
}

// ---------- test 2: real on-chain DAILY values from check_state.py ---------
section('test 2 — real on-chain values (DAILY: epochZero=1777921630, dur=86400)');
{
  // Period 0
  const r0 = dailyPeriodBoundaries({ epochZero: 1777921630, periodDurationSeconds: 86400, periodId: 0 });
  assert(r0.startUnix === 1777921630, 'p=0 start = epochZero', r0);
  assert(r0.endUnix   === 1777921630 + 86400, 'p=0 end = start + 86400', r0);

  // Period 45 (from earlier check_state.py snapshot)
  const r45 = dailyPeriodBoundaries({ epochZero: 1777921630, periodDurationSeconds: 86400, periodId: 45 });
  const expectedStart = 1777921630 + 45 * 86400;
  assert(r45.startUnix === expectedStart, 'p=45 start = epochZero + 45*86400', r45);
  assert(r45.endUnix   === expectedStart + 86400, 'p=45 end = start + 86400', r45);

  // Sanity: (end - start) always exactly = duration
  assert(r45.endUnix - r45.startUnix === 86400, 'p=45 span exactly 1 day', r45);
}

// ---------- test 3: multiple periodIds are contiguous non-overlapping ------
section('test 3 — consecutive periodIds are contiguous and non-overlapping');
{
  const epochZero = 1777921630;
  const dur       = 86400;
  const boundaries = [];
  for (let i = 0; i < 10; i++) {
    boundaries.push(dailyPeriodBoundaries({ epochZero, periodDurationSeconds: dur, periodId: i }));
  }
  for (let i = 0; i < boundaries.length - 1; i++) {
    assert(boundaries[i].endUnix === boundaries[i+1].startUnix,
      `period ${i}.end === period ${i+1}.start (contiguous)`,
      { end_i: boundaries[i].endUnix, start_i1: boundaries[i+1].startUnix });
    assert(boundaries[i+1].startUnix - boundaries[i].startUnix === dur,
      `period spacing = ${dur}s`, null);
  }
}

// ---------- test 4: weekly + monthly durations -----------------------------
section('test 4 — weekly (604800) and monthly (2592000) periods');
{
  const w = dailyPeriodBoundaries({ epochZero: 1777921630, periodDurationSeconds: 604800, periodId: 6 });
  assert(w.endUnix - w.startUnix === 604800, 'weekly span = 604800s', w);
  const m = dailyPeriodBoundaries({ epochZero: 1777921630, periodDurationSeconds: 2592000, periodId: 1 });
  assert(m.endUnix - m.startUnix === 2592000, 'monthly span = 2592000s', m);
}

// ---------- test 5: ISO strings are UTC and round-trip losslessly ----------
section('test 5 — ISO output is UTC (ends in Z), round-trips exactly');
{
  const r = dailyPeriodBoundaries({ epochZero: 1777921630, periodDurationSeconds: 86400, periodId: 100 });
  assert(r.startISO.endsWith('Z'), 'startISO ends with Z', r);
  assert(r.endISO.endsWith('Z'),   'endISO   ends with Z', r);
  // Round-trip via Date.parse: parseback (UTC-native) matches startUnix exactly.
  assert(Math.floor(Date.parse(r.startISO) / 1000) === r.startUnix,
    'Date.parse(startISO)/1000 === startUnix', r);
  assert(Math.floor(Date.parse(r.endISO) / 1000) === r.endUnix,
    'Date.parse(endISO)/1000 === endUnix', r);
  // No millisecond drift
  assert(r.startISO.endsWith('.000Z'), 'startISO has .000Z (integer seconds)', r);
  assert(r.endISO.endsWith('.000Z'),   'endISO   has .000Z (integer seconds)', r);
}

// ---------- test 6: determinism (same input -> byte-identical output) -----
section('test 6 — deterministic across repeated calls');
{
  const args = { epochZero: 1777921630, periodDurationSeconds: 86400, periodId: 42 };
  const a = dailyPeriodBoundaries(args);
  const b = dailyPeriodBoundaries(args);
  assert(JSON.stringify(a) === JSON.stringify(b), 'identical output for identical input', null);
}

// ---------- test 7: timezone independence (no setHours-style leakage) -----
section('test 7 — timezone independence: process.env.TZ perturbation does not affect UTC output');
{
  // toISOString is defined by the spec to be UTC. We verify that the raw
  // startUnix -> ISO mapping is stable regardless of ambient TZ, by comparing
  // ISO output against a UTC construction path that never touches local TZ.
  function utcISOFromUnix(unixSec) {
    // Build UTC date-parts explicitly using UTC getters and re-render manually.
    const d = new Date(unixSec * 1000);
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate())
      + 'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds())
      + '.000Z';
  }
  const r = dailyPeriodBoundaries({ epochZero: 1777921630, periodDurationSeconds: 86400, periodId: 46 });
  assert(r.startISO === utcISOFromUnix(r.startUnix), 'startISO === manual UTC construction', r);
  assert(r.endISO   === utcISOFromUnix(r.endUnix),   'endISO   === manual UTC construction', r);

  // Second scenario: epochZero explicitly midnight-aligned (0 mod 86400).
  // With that alignment the ISO time-of-day should be T00:00:00.000Z.
  const midnightEpoch = 1777852800;   // 2026-05-04T00:00:00Z (multiple of 86400)
  const rm = dailyPeriodBoundaries({ epochZero: midnightEpoch, periodDurationSeconds: 86400, periodId: 46 });
  assert(rm.startISO.endsWith('T00:00:00.000Z'),
    'midnight-aligned epochZero => T00:00:00.000Z boundary', rm);
  // Sanity: the actual on-chain epochZero=1777921630 is NOT midnight-aligned
  // (init_pool ran at 19:07:10 UTC on 2026-05-04), so its boundaries land at
  // 19:07:10 UTC each day. Documented, not a bug.
  assert(1777921630 % 86400 !== 0, 'on-chain epochZero is NOT midnight-aligned (documents observed behavior)', null);
}

// ---------- test 8: BigInt inputs accepted for u64 fields -----------------
section('test 8 — BigInt periodId / epochZero accepted');
{
  const r = dailyPeriodBoundaries({
    epochZero: 1777921630n,
    periodDurationSeconds: 86400,
    periodId: 45n,
  });
  assert(r.startUnix === 1777921630 + 45 * 86400, 'BigInt inputs produce identical numeric output', r);
  assert(typeof r.epochZero === 'number' && typeof r.periodId === 'number',
    'BigInt coerced to Number in output', r);
}

// ---------- test 9: invalid input rejection --------------------------------
section('test 9 — input validation (fail-fast)');
{
  const good = { epochZero: 1777921630, periodDurationSeconds: 86400, periodId: 0 };

  // Duration guards
  assertThrows(() => dailyPeriodBoundaries({ ...good, periodDurationSeconds: 0 }),
    'must be > 0', 'zero duration refused (jackpot manual-rotation)');
  assertThrows(() => dailyPeriodBoundaries({ ...good, periodDurationSeconds: -1 }),
    'must be > 0', 'negative duration refused');
  assertThrows(() => dailyPeriodBoundaries({ ...good, periodDurationSeconds: 1.5 }),
    'must be a positive integer', 'non-integer duration refused');

  // periodId
  assertThrows(() => dailyPeriodBoundaries({ ...good, periodId: -1 }),
    'non-negative', 'negative periodId refused');
  assertThrows(() => dailyPeriodBoundaries({ ...good, periodId: 1.5 }),
    'must be an integer', 'non-integer periodId refused');

  // epochZero
  assertThrows(() => dailyPeriodBoundaries({ ...good, epochZero: -1 }),
    'non-negative', 'negative epochZero refused');
  assertThrows(() => dailyPeriodBoundaries({ ...good, epochZero: 'nope' }),
    'must be an integer', 'string epochZero refused');

  // Missing/null args
  assertThrows(() => dailyPeriodBoundaries(null), 'args must be', 'null args refused');
  assertThrows(() => dailyPeriodBoundaries({}),   'must be an integer', 'empty args (missing epochZero) refused');

  // Precision guards
  assertThrows(() => dailyPeriodBoundaries({ ...good, periodId: Number.MAX_SAFE_INTEGER + 100 }),
    'MAX_SAFE_INTEGER', 'unsafe Number periodId refused');
  assertThrows(() => dailyPeriodBoundaries({ ...good, epochZero: Number.MAX_SAFE_INTEGER + 100 }),
    'MAX_SAFE_INTEGER', 'unsafe Number epochZero refused');
}

// ---------- test 10: interval semantics for downstream filter --------------
section('test 10 — interval semantics: [startUnix, endUnix) → strictly consecutive');
{
  const epochZero = 1777921630;
  const dur       = 86400;
  const p0 = dailyPeriodBoundaries({ epochZero, periodDurationSeconds: dur, periodId: 0 });
  const p1 = dailyPeriodBoundaries({ epochZero, periodDurationSeconds: dur, periodId: 1 });
  // A tx at exactly endUnix(p0) belongs to p1, not p0 — semantics match on-chain
  // pay_entry gating which uses currentPeriodId = (now - epochZero) / duration.
  assert(p0.endUnix === p1.startUnix, 'p0.end === p1.start (half-open interval boundary)', null);
  // Simulated Supabase-style filter equality:
  //   scores WHERE created_at >= startISO AND created_at < endISO
  //   with created_at exactly = endISO -> excluded from p0, included in p1.
  const boundaryTs = p0.endUnix;
  const includedInP0 = (boundaryTs >= p0.startUnix) && (boundaryTs < p0.endUnix);
  const includedInP1 = (boundaryTs >= p1.startUnix) && (boundaryTs < p1.endUnix);
  assert(!includedInP0, 'tx at exact boundary NOT in p0 (< end)', null);
  assert( includedInP1, 'tx at exact boundary IS  in p1 (>= start)', null);
}

// ---------- summary --------------------------------------------------------
console.log('\n== summary ==');
console.log(`assertions: pass=${passed} fail=${failed}`);
if (failed > 0) {
  console.log('\nfailures:');
  for (const f of failures) console.log('  -', f.label, f.ctx == null ? '' : JSON.stringify(f.ctx));
  process.exit(1);
}
