// Tests for --output flag in tools/paid_daily_dry_run.js.
// Zero network, zero WSL — uses synthetic ingestor output to prove that a
// serialized artifact round-trips through the post_settlement simulator's
// validateArtifact() unchanged.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { writeSettlementArtifact } = require('./paid_daily_dry_run.js');
const { ingestDailySettlement } = require('./paid_daily_ingestor.js');
const { validateArtifact, serializePostSettlementArgs } = require('./post_settlement_simulator.js');

// ---------- harness --------------------------------------------------------
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
    if (String(e.message).includes(matchSubstr)) assert(true, `${label} — threw (${matchSubstr})`);
    else assert(false, `${label} — wrong error`, { expected: matchSubstr, got: e.message });
  }
}
function section(name) { console.log('\n== ' + name + ' =='); }

// ---------- fixtures -------------------------------------------------------
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58enc(bytes) {
  let z = 0; while (z < bytes.length && bytes[z] === 0) z++;
  const hex = Buffer.from(bytes).toString('hex');
  let n = hex.length === 0 ? 0n : BigInt('0x' + hex);
  let out = '';
  while (n > 0n) { out = BASE58[Number(n % 58n)] + out; n = n / 58n; }
  return '1'.repeat(z) + (out || '1');
}
function makeWallet(seed) {
  return b58enc(crypto.createHash('sha256').update('wallet:' + seed).digest());
}
function makePlayers(n, startTs = 1_787_427_267_000) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      nickname: 'p' + i,
      wallet: makeWallet(i),
      score: 100 + (i * 7) % 500,
      created_at: new Date(startTs + i * 1000).toISOString(),
    });
  }
  return rows;
}

const EPOCH_ZERO = 1781897667;
const DUR        = 86400;
const PERIOD_ID  = 64;
const POOL_KIND  = 0;

// Real period 64 boundaries: [2026-08-22T19:34:27.000Z, 2026-08-23T19:34:27.000Z)
// startUnix = 1787427267 -> startMs = 1787427267000
function buildSyntheticArtifact({ nPlayers, pool }) {
  const rows = makePlayers(nPlayers);
  const res = ingestDailySettlement({
    epochZero: EPOCH_ZERO, periodDurationSeconds: DUR, periodId: PERIOD_ID,
    poolKind: POOL_KIND, dailyPrizePoolLamports: pool, rows,
  });
  if (!res.settlement) throw new Error('fixture: expected settlement, got null');
  return res.settlement;
}

function tmpFile(name) {
  return path.join(os.tmpdir(), `copper-dry-run-artifact-${process.pid}-${Date.now()}-${name}`);
}

// ---------- test 1: writeSettlementArtifact writes valid JSON --------------
section('test 1 — writeSettlementArtifact produces parseable JSON');
{
  const artifact = buildSyntheticArtifact({ nPlayers: 50, pool: 275_000_000 });
  const p = tmpFile('t1.json');
  try {
    writeSettlementArtifact(p, artifact);
    assert(fs.existsSync(p), 'file exists on disk', { path: p });
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    assert(typeof parsed === 'object' && parsed !== null, 'parsed is an object', null);
    assert(parsed.merkleRoot === artifact.merkleRoot, 'merkleRoot preserved', null);
    assert(parsed.winnerCount === artifact.winnerCount, 'winnerCount preserved', null);
    assert(parsed.totalPayoutLamports === artifact.totalPayoutLamports, 'totalPayoutLamports preserved', null);
    assert(parsed.poolKind === artifact.poolKind, 'poolKind preserved', null);
    assert(parsed.periodId === artifact.periodId, 'periodId preserved', null);
    assert(Array.isArray(parsed.winners) && parsed.winners.length === artifact.winnerCount, 'winners array preserved', null);
    // Trailing newline convention
    assert(raw.endsWith('\n'), 'file ends with newline', null);
  } finally { try { fs.unlinkSync(p); } catch {} }
}

// ---------- test 2: parsed artifact passes simulator.validateArtifact -----
section('test 2 — parsed artifact passes post_settlement_simulator.validateArtifact');
for (const [nPlayers, pool] of [[1, 5_500_000], [50, 275_000_000], [100, 550_000_000], [250, 1_375_000_000]]) {
  const artifact = buildSyntheticArtifact({ nPlayers, pool });
  const p = tmpFile(`t2-n${nPlayers}.json`);
  try {
    writeSettlementArtifact(p, artifact);
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    let ok = false;
    try { ok = validateArtifact(parsed) === true; } catch (e) {
      assert(false, `n=${nPlayers}: validateArtifact threw`, { err: e.message });
    }
    assert(ok, `n=${nPlayers}: validateArtifact returns true`, null);
  } finally { try { fs.unlinkSync(p); } catch {} }
}

// ---------- test 3: artifact serializes into post_settlement ix data -------
section('test 3 — parsed artifact feeds directly into serializePostSettlementArgs');
{
  const artifact = buildSyntheticArtifact({ nPlayers: 100, pool: 550_000_000 });
  const p = tmpFile('t3.json');
  try {
    writeSettlementArtifact(p, artifact);
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    validateArtifact(parsed);
    const ixData = serializePostSettlementArgs({
      pool_kind:    parsed.poolKind,
      period_id:    BigInt(parsed.periodId),
      merkle_root:  Buffer.from(parsed.merkleRoot, 'hex'),
      total_payout: BigInt(parsed.totalPayoutLamports),
      num_winners:  parsed.winnerCount,
    });
    assert(ixData.length === 61, 'ix data length = 61 bytes', { len: ixData.length });
    // Sanity: the merkle_root field inside ix data equals the artifact's merkle root
    const merkleInIx = ixData.subarray(17, 49).toString('hex');
    assert(merkleInIx === parsed.merkleRoot.toLowerCase(), 'merkle_root round-trips into ix data byte-exact', null);
  } finally { try { fs.unlinkSync(p); } catch {} }
}

// ---------- test 4: writeSettlementArtifact rejects bad args --------------
section('test 4 — writeSettlementArtifact rejects null/empty inputs');
{
  const artifact = buildSyntheticArtifact({ nPlayers: 1, pool: 5_500_000 });
  assertThrows(() => writeSettlementArtifact('', artifact),   'outputPath required', 'empty path rejected');
  assertThrows(() => writeSettlementArtifact(null, artifact), 'outputPath required', 'null path rejected');
  assertThrows(() => writeSettlementArtifact(tmpFile('x.json'), null), 'settlement required', 'null settlement rejected');
}

// ---------- test 5: deterministic file content (byte-identical on re-run) --
section('test 5 — same input -> byte-identical output file');
{
  const artifact = buildSyntheticArtifact({ nPlayers: 20, pool: 110_000_000 });
  const p1 = tmpFile('t5a.json');
  const p2 = tmpFile('t5b.json');
  try {
    writeSettlementArtifact(p1, artifact);
    writeSettlementArtifact(p2, artifact);
    const raw1 = fs.readFileSync(p1);
    const raw2 = fs.readFileSync(p2);
    assert(Buffer.compare(raw1, raw2) === 0, 'files byte-identical', { len1: raw1.length, len2: raw2.length });
  } finally { try { fs.unlinkSync(p1); } catch {}; try { fs.unlinkSync(p2); } catch {} }
}

// ---------- test 6: BigInt periodId serialization works too ---------------
section('test 6 — BigInt periodId round-trips correctly through file');
{
  const bigPeriod = 12345678n;
  const bigEpochZero = 0;
  const bigStartMs = Number(bigPeriod) * 86400 * 1000;   // start of that period in ms
  const rows = makePlayers(10, bigStartMs + 60_000);       // 10 rows inside period
  const res = ingestDailySettlement({
    epochZero: bigEpochZero, periodDurationSeconds: 86400, periodId: bigPeriod,
    poolKind: 0, dailyPrizePoolLamports: 55_000_000, rows,
  });
  assert(res.settlement != null, 'settlement produced with BigInt periodId', null);
  const p = tmpFile('t6.json');
  try {
    writeSettlementArtifact(p, res.settlement);
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    // Builder serializes BigInt periodId as string (per its own contract)
    assert(parsed.periodId === '12345678', 'BigInt periodId serialized as string', { got: parsed.periodId });
    validateArtifact(parsed);
    // And BigInt(periodId) coercion works for simulator's serializer
    const ix = serializePostSettlementArgs({
      pool_kind:    parsed.poolKind,
      period_id:    BigInt(parsed.periodId),
      merkle_root:  Buffer.from(parsed.merkleRoot, 'hex'),
      total_payout: BigInt(parsed.totalPayoutLamports),
      num_winners:  parsed.winnerCount,
    });
    assert(ix.length === 61, 'BigInt periodId path -> 61-byte ix', null);
    // Read back period_id field at offset 9
    const dv = new DataView(ix.buffer, ix.byteOffset, ix.byteLength);
    assert(dv.getBigUint64(9, true) === bigPeriod, 'ix data period_id matches BigInt input', null);
  } finally { try { fs.unlinkSync(p); } catch {} }
}

// ---------- summary --------------------------------------------------------
console.log('\n== summary ==');
console.log(`assertions: pass=${passed} fail=${failed}`);
if (failed > 0) {
  console.log('\nfailures:');
  for (const f of failures) console.log('  -', f.label, f.ctx == null ? '' : JSON.stringify(f.ctx));
  process.exit(1);
}
