// Tests for tools/publish_daily_claims.js — pure helpers + mocked fetch.
// Zero network, zero on-chain, zero real Supabase calls.

'use strict';

const {
  validatePublishInput, assertWinnerRow,
  winnerToRow, rowsMatch,
  publishOneRow,
} = require('./publish_daily_claims.js');

let passed = 0, failed = 0;
const failures = [];
function assert(cond, label, ctx) {
  if (cond) { passed++; return; }
  failed++;
  failures.push({ label, ctx });
  console.log(`  FAIL: ${label}` + (ctx ? '  ' + JSON.stringify(ctx) : ''));
}
function assertThrows(fn, matchSubstr, label) {
  try { fn(); assert(false, `${label} — expected throw`, null); }
  catch (e) { assert(String(e.message).includes(matchSubstr), label, { got: e.message }); }
}
async function assertRejects(promise, matchSubstr, label) {
  try { await promise; assert(false, `${label} — expected reject`, null); }
  catch (e) { assert(String(e.message).includes(matchSubstr), label, { got: e.message }); }
}
function section(name) { console.log('\n== ' + name + ' =='); }

// ---------- fixtures -------------------------------------------------------

const REAL_WALLET = 'Cjvtyjc8ft8iumzDSEUiHnfk3SPz5E1tJGejBs6WEtyt';
const REAL_ROOT   = 'aef2e13c5e44cd6f3e87fe1dbdf7992a1f2b7823d5aa33ab309ec10127bd9f6e';
const REAL_SIG    = 'vHRLdmKLGnKnSDWf7iA7PuNqGCsGGwdL69e9QTGHWjEJ';

function goodArtifact(overrides) {
  return Object.assign({
    periodId: 64,
    poolKind: 0,
    winnerCount: 1,
    totalPayoutLamports: 5_500_000,
    merkleRoot: REAL_ROOT,
    winners: [{
      rank: 1,
      wallet: REAL_WALLET,
      payoutLamports: 5_500_000,
      leafIndex: 0,
      leaf: REAL_ROOT,
      proof: [],
    }],
  }, overrides || {});
}

// ---------- test 1: validatePublishInput accepts good --------------------
section('test 1 — validatePublishInput accepts a good artifact');
{
  validatePublishInput(goodArtifact(), REAL_SIG);   // should not throw
  assert(true, 'good artifact + real sig passes', null);

  // Multi-winner sum-check
  const multi = {
    periodId: 100, poolKind: 0, winnerCount: 2, totalPayoutLamports: 100,
    merkleRoot: 'a'.repeat(64),
    winners: [
      { rank: 1, wallet: REAL_WALLET, payoutLamports: 70, leafIndex: 0, leaf: 'b'.repeat(64), proof: [] },
      { rank: 2, wallet: 'DZyKiMBbwDHZGbwweHmvhe8JsaDkDtAUG4hEBDR5qvYo', payoutLamports: 30, leafIndex: 1, leaf: 'c'.repeat(64), proof: ['d'.repeat(64)] },
    ],
  };
  validatePublishInput(multi, REAL_SIG);
  assert(true, 'multi-winner artifact passes', null);
}

// ---------- test 2: validatePublishInput rejects bad --------------------
section('test 2 — validatePublishInput rejects malformed inputs');
{
  // winnerCount vs winners.length mismatch
  const a = goodArtifact({ winnerCount: 2 });
  assertThrows(() => validatePublishInput(a, REAL_SIG), 'winnerCount', 'winners.length mismatch caught');

  // sum(payouts) != totalPayoutLamports
  const b = goodArtifact({ totalPayoutLamports: 9999 });
  assertThrows(() => validatePublishInput(b, REAL_SIG), 'sum', 'payout-sum mismatch caught');

  // Missing signature
  assertThrows(() => validatePublishInput(goodArtifact(), ''), 'settlementSignature', 'empty sig rejected');
  assertThrows(() => validatePublishInput(goodArtifact(), null), 'settlementSignature', 'null sig rejected');
  assertThrows(() => validatePublishInput(goodArtifact(), 'short'), 'settlementSignature', 'short sig rejected');
}

// ---------- test 3: assertWinnerRow bad fields --------------------------
section('test 3 — assertWinnerRow catches every field violation');
{
  const base = { rank: 1, wallet: REAL_WALLET, leafIndex: 0, payoutLamports: 1, proof: [] };
  assertThrows(() => assertWinnerRow({ ...base, rank: 0 }, 0),         'rank',        'rank<1 rejected');
  assertThrows(() => assertWinnerRow({ ...base, wallet: '' }, 0),       'wallet',      'empty wallet rejected');
  assertThrows(() => assertWinnerRow({ ...base, wallet: 'x!!' }, 0),    'base58',      'invalid base58 wallet rejected');
  assertThrows(() => assertWinnerRow({ ...base, leafIndex: -1 }, 0),    'leafIndex',   'negative leafIndex rejected');
  assertThrows(() => assertWinnerRow({ ...base, payoutLamports: 0 }, 0),'payoutLamports','zero amount rejected');
  assertThrows(() => assertWinnerRow({ ...base, payoutLamports: -1 }, 0),'payoutLamports','negative amount rejected');
  assertThrows(() => assertWinnerRow({ ...base, proof: 'not-array' }, 0),'proof',      'non-array proof rejected');
  assertThrows(() => assertWinnerRow({ ...base, proof: ['not-hex'] }, 0),'proof',      'non-hex proof entry rejected');
  assertThrows(() => assertWinnerRow({ ...base, proof: ['aa'.repeat(16)] }, 0), 'proof', 'wrong-length proof entry rejected');
}

// ---------- test 4: winnerToRow shape -----------------------------------
section('test 4 — winnerToRow builds Supabase row correctly');
{
  const art = goodArtifact();
  const row = winnerToRow(art, art.winners[0], REAL_SIG);
  assert(row.pool_kind === 0, 'pool_kind', null);
  assert(row.period_id === 64, 'period_id', null);
  assert(row.leaf_index === 0, 'leaf_index', null);
  assert(row.wallet === REAL_WALLET, 'wallet', null);
  assert(row.rank === 1, 'rank', null);
  assert(row.amount_lamports === 5_500_000, 'amount_lamports', null);
  assert(Array.isArray(row.proof) && row.proof.length === 0, 'proof preserved', null);
  assert(row.merkle_root === REAL_ROOT.toLowerCase(), 'merkle_root lowercased', null);
  assert(row.settlement_signature === REAL_SIG, 'settlement_signature preserved', null);
  assert(!('published_at' in row), 'published_at omitted (DB default)', null);
}

// ---------- test 5: rowsMatch identical vs conflicting -------------------
section('test 5 — rowsMatch returns null on identical, string on conflict');
{
  const art = goodArtifact();
  const a = winnerToRow(art, art.winners[0], REAL_SIG);
  const b = winnerToRow(art, art.winners[0], REAL_SIG);
  assert(rowsMatch(a, b) === null, 'identical rows -> null', null);

  // Different amount
  const c = { ...a, amount_lamports: 999 };
  const mA = rowsMatch(c, a);
  assert(typeof mA === 'string' && mA.includes('amount_lamports'), 'amount mismatch flagged', { got: mA });

  // Different wallet
  const d = { ...a, wallet: 'DZyKiMBbwDHZGbwweHmvhe8JsaDkDtAUG4hEBDR5qvYo' };
  const mB = rowsMatch(d, a);
  assert(typeof mB === 'string' && mB.includes('wallet'), 'wallet mismatch flagged', { got: mB });

  // Different signature (also a conflict — same leaf must not be re-published under a different tx)
  const e = { ...a, settlement_signature: 'DIFFERENT_SIG_' + 'z'.repeat(20) };
  const mC = rowsMatch(e, a);
  assert(typeof mC === 'string' && mC.includes('settlement_signature'), 'signature mismatch flagged', { got: mC });

  // Different proof length
  const withProof = { ...a, proof: ['aa'.repeat(32)] };
  const mD = rowsMatch(withProof, a);
  assert(typeof mD === 'string' && mD.includes('proof'), 'proof length mismatch flagged', { got: mD });

  // Different proof entry (same length)
  const p1 = { ...a, proof: ['aa'.repeat(32)] };
  const p2 = { ...a, proof: ['bb'.repeat(32)] };
  const mE = rowsMatch(p1, p2);
  assert(typeof mE === 'string' && mE.includes('proof[0]'), 'proof entry mismatch flagged', { got: mE });
}

// ---------- test 6: publishOneRow idempotency & conflict --------------
section('test 6 — publishOneRow: insert / skip-identical / conflict');
(async () => {
  const art = goodArtifact();
  const row = winnerToRow(art, art.winners[0], REAL_SIG);

  // Mock fetch — simulate empty DB → INSERT succeeds
  const call1 = { seen: [] };
  const fakeFetch1 = async (url, opts) => {
    call1.seen.push({ url, method: opts.method || 'GET' });
    if (opts.method === 'POST') return { ok: true, status: 201, text: async () => '' };
    return { ok: true, status: 200, json: async () => [] };
  };
  const r1 = await publishOneRow({ creds: { url: 'https://mock', serviceKey: 'x' }, newRow: row, fetchImpl: fakeFetch1 });
  assert(r1.status === 'inserted', '6a empty DB -> inserted', r1);
  assert(call1.seen.length === 2 && call1.seen[0].method === 'GET' && call1.seen[1].method === 'POST',
    '6a called SELECT then POST', call1);

  // Simulate DB already has identical row → skipped
  const fakeFetch2 = async (url, opts) => {
    if (opts.method === 'POST') throw new Error('should not POST when identical');
    return { ok: true, status: 200, json: async () => [row] };
  };
  const r2 = await publishOneRow({ creds: { url: 'https://mock', serviceKey: 'x' }, newRow: row, fetchImpl: fakeFetch2 });
  assert(r2.status === 'skipped_identical', '6b identical -> skipped', r2);

  // Simulate DB has conflicting row (different amount) → hard fail
  const conflicting = { ...row, amount_lamports: row.amount_lamports + 1 };
  const fakeFetch3 = async (url, opts) => {
    if (opts.method === 'POST') throw new Error('should not POST when conflicting');
    return { ok: true, status: 200, json: async () => [conflicting] };
  };
  await assertRejects(
    publishOneRow({ creds: { url: 'https://mock', serviceKey: 'x' }, newRow: row, fetchImpl: fakeFetch3 }),
    'CONFLICT',
    '6c conflicting -> hard fail',
  );

  // Simulate DB has conflicting row (different signature) → hard fail
  const conflictingSig = { ...row, settlement_signature: 'OTHER' + 'z'.repeat(30) };
  const fakeFetch4 = async (url, opts) => {
    if (opts.method === 'POST') throw new Error('should not POST when sig conflicts');
    return { ok: true, status: 200, json: async () => [conflictingSig] };
  };
  await assertRejects(
    publishOneRow({ creds: { url: 'https://mock', serviceKey: 'x' }, newRow: row, fetchImpl: fakeFetch4 }),
    'settlement_signature',
    '6d sig conflict -> hard fail',
  );

  // ---------- test 7: SELECT/INSERT error responses propagate ----------
  section('test 7 — HTTP error responses propagate');
  const fakeFetch5 = async () => ({ ok: false, status: 500, text: async () => 'db down' });
  await assertRejects(
    publishOneRow({ creds: { url: 'https://mock', serviceKey: 'x' }, newRow: row, fetchImpl: fakeFetch5 }),
    'HTTP 500',
    '7 select 500 -> throws',
  );

  const fakeFetch6 = async (url, opts) => {
    if (opts.method === 'POST') return { ok: false, status: 401, text: async () => 'no auth' };
    return { ok: true, status: 200, json: async () => [] };
  };
  await assertRejects(
    publishOneRow({ creds: { url: 'https://mock', serviceKey: 'x' }, newRow: row, fetchImpl: fakeFetch6 }),
    'HTTP 401',
    '7 insert 401 -> throws',
  );

  // ---------- summary ----------------------------------------------------
  console.log('\n== summary ==');
  console.log(`assertions: pass=${passed} fail=${failed}`);
  if (failed > 0) {
    console.log('\nfailures:'); for (const f of failures) console.log('  -', f.label, f.ctx == null ? '' : JSON.stringify(f.ctx));
    process.exit(1);
  }
})();
