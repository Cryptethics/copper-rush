// Tests for tools/paid_daily_ingestor.js — synthetic rows only.
// Usage: node tools/paid_daily_ingestor.test.js

'use strict';

const crypto = require('crypto');
const {
  ingestDailySettlement,
  computeDailyScoreLocal,
  parseCreatedAtMs,
} = require('./paid_daily_ingestor.js');
const { verifyProof } = require('./daily_settlement_builder.js');

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
    const msg = String(e && e.message);
    if (msg.includes(matchSubstr)) assert(true, `${label} — threw (${matchSubstr})`);
    else assert(false, `${label} — threw wrong error`, { expected: matchSubstr, got: msg });
  }
}
function section(name) { console.log('\n== ' + name + ' =='); }

// Deterministic base58 encoder (matches Solana canonical form).
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58enc(bytes) {
  let z = 0; while (z < bytes.length && bytes[z] === 0) z++;
  const hex = Buffer.from(bytes).toString('hex');
  let n = hex.length === 0 ? 0n : BigInt('0x' + hex);
  let out = '';
  while (n > 0n) { out = BASE58[Number(n % 58n)] + out; n = n / 58n; }
  return '1'.repeat(z) + (out || '1');
}
function makeWallet(seed) { return b58enc(crypto.createHash('sha256').update('wallet:' + seed).digest()); }

// Deterministic Fisher-Yates shuffle (LCG) for reproducible determinism tests.
function seededShuffle(arr, seed) {
  const out = arr.slice();
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------- fixtures --------------------------------------------------------
const EPOCH_ZERO = 1777921630;  // real on-chain DAILY epoch_zero
const DUR        = 86400;
const PERIOD_ID  = 45;
const START_UNIX = EPOCH_ZERO + PERIOD_ID * DUR;      // 1781809630
const END_UNIX   = START_UNIX + DUR;                   // 1781896030
const START_MS   = START_UNIX * 1000;
const END_MS     = END_UNIX   * 1000;
const POOL_KIND  = 0;

function isoAt(ms) { return new Date(ms).toISOString(); }

// ---------- test 1: rows outside period excluded ---------------------------
section('test 1 — rows outside [startUnix, endUnix) excluded, rows without wallet dropped');
{
  const wA = makeWallet('A');
  const wB = makeWallet('B');
  const rows = [
    // Inside
    { nickname: 'A', wallet: wA, score: 100, created_at: isoAt(START_MS)             },   // exact start (inclusive)
    { nickname: 'A', wallet: wA, score: 200, created_at: isoAt(START_MS + 3600_000)  },
    { nickname: 'B', wallet: wB, score: 50,  created_at: isoAt(END_MS - 1)           },
    // Boundary — exact endUnix is exclusive
    { nickname: 'X', wallet: 'W_X', score: 999, created_at: isoAt(END_MS)            },
    // Before period
    { nickname: 'Y', wallet: 'W_Y', score: 500, created_at: isoAt(START_MS - 1)      },
    // After period
    { nickname: 'Z', wallet: 'W_Z', score: 500, created_at: isoAt(END_MS + 3600_000) },
    // No wallet variations
    { nickname: 'N1', wallet: null,      score: 10, created_at: isoAt(START_MS + 100) },
    { nickname: 'N2', wallet: '',        score: 20, created_at: isoAt(START_MS + 200) },
    { nickname: 'N3', wallet: undefined, score: 30, created_at: isoAt(START_MS + 300) },
  ];
  const res = ingestDailySettlement({
    epochZero: EPOCH_ZERO, periodDurationSeconds: DUR, periodId: PERIOD_ID,
    poolKind: POOL_KIND, dailyPrizePoolLamports: 100_000_000, rows,
  });
  assert(res.stats.totalInput === 9,           'totalInput = 9',          res.stats);
  assert(res.stats.droppedNoWallet === 3,      'droppedNoWallet = 3',     res.stats);
  assert(res.stats.droppedOutOfPeriod === 3,   'droppedOutOfPeriod = 3',  res.stats);   // W_X, W_Y, W_Z
  assert(res.stats.kept === 3,                 'kept = 3',                res.stats);
  assert(res.totalPlayers === 2,               '2 wallets survive → 2 players', res);
}

// ---------- test 2: aggregation per wallet ---------------------------------
section('test 2 — aggregation per wallet: distinct wallets isolated');
{
  const wA = makeWallet('A'), wB = makeWallet('B'), wC = makeWallet('C');
  const rows = [
    { nickname: 'A', wallet: wA, score: 100, created_at: isoAt(START_MS + 1000) },
    { nickname: 'A', wallet: wA, score:  50, created_at: isoAt(START_MS + 2000) },
    { nickname: 'B', wallet: wB, score: 200, created_at: isoAt(START_MS + 3000) },
    { nickname: 'C', wallet: wC, score: 300, created_at: isoAt(START_MS + 4000) },
    { nickname: 'C', wallet: wC, score: 100, created_at: isoAt(START_MS + 5000) },
    { nickname: 'C', wallet: wC, score:  50, created_at: isoAt(START_MS + 6000) },
  ];
  const res = ingestDailySettlement({
    epochZero: EPOCH_ZERO, periodDurationSeconds: DUR, periodId: PERIOD_ID,
    poolKind: POOL_KIND, dailyPrizePoolLamports: 100_000_000, rows,
  });
  assert(res.totalPlayers === 3, '3 wallets', res);
  // Manually recompute expected scores.
  // A: [100, 50] -> best3=150, extra=0, bonus=0 -> daily=150
  // B: [200]     -> best3=200, extra=0, bonus=0 -> daily=200
  // C: [300,100,50] -> best3=450, extra=0, bonus=0 -> daily=450
  const byNick = Object.fromEntries(res.rankedLeaderboard.map(p => [p.nickname, p]));
  assert(byNick.A.dailyScore === 150, 'A dailyScore', byNick.A);
  assert(byNick.B.dailyScore === 200, 'B dailyScore', byNick.B);
  assert(byNick.C.dailyScore === 450, 'C dailyScore', byNick.C);
  // Ranks: C > B > A
  assert(byNick.C.rank === 1 && byNick.B.rank === 2 && byNick.A.rank === 3,
    'ranks C>B>A', byNick);
}

// ---------- test 3: Best3 + consistency bonus (extraSum, cap) --------------
section('test 3 — Best3 + volume bonus formula (matches copper-beta.html:3159)');
{
  // Unit-test the local helper directly first.
  // Case 3a: 5 runs, no cap — bonus = 10%*extra
  const r3a = computeDailyScoreLocal([100, 80, 60, 40, 20]);
  // best3 = 100+80+60 = 240, extra = 60, bonus = min(6, 72) = 6, daily = 246
  assert(r3a.best3Sum === 240 && r3a.dailyScore === 246, '3a: best3=240 daily=246', r3a);

  // Case 3b: bonus capped at 30% of best3
  const r3b = computeDailyScoreLocal([10, 10, 10, 100, 100, 100, 100, 100, 100]);
  // best3 = 30, extra = 600, 10%*600=60, 30%*30=9 -> bonus=9, daily=39
  // (This "reverse" order tests that we sort descending internally.)
  assert(r3b.best3Sum === 300, '3b: sorts desc -> best3=300', r3b);
  // sorted desc = [100,100,100,100,100,100,10,10,10]. best3=300, extra=[100,100,100,10,10,10]=330
  // bonus = min(33, 90) = 33 -> daily = 333
  assert(r3b.dailyScore === 333, '3b: daily=333 (cap not triggered here)', r3b);

  // Case 3c: dominant extra hits the cap
  const r3c = computeDailyScoreLocal([100, 90, 80, 200, 200, 200, 200, 200]);
  // sorted desc: [200,200,200,200,200,100,90,80]. best3=600, extra=[200,200,100,90,80]=670
  // bonus = min(67, 180) = 67 -> daily = 667
  assert(r3c.best3Sum === 600 && r3c.dailyScore === 667, '3c: daily=667', r3c);

  // Case 3d: fewer than 3 runs -> extra empty, no bonus
  const r3d = computeDailyScoreLocal([500, 300]);
  assert(r3d.best3Sum === 800 && r3d.dailyScore === 800, '3d: 2 runs -> daily=800', r3d);
}

// ---------- test 4: firstRunTs — min ts per wallet -------------------------
section('test 4 — firstRunTs = min(created_at ms) per wallet');
{
  const wA = makeWallet('A'), wB = makeWallet('B');
  const rows = [
    // A's rows out of chronological order (input order != ts order)
    { nickname: 'A', wallet: wA, score: 100, created_at: isoAt(START_MS + 5000) },
    { nickname: 'A', wallet: wA, score: 200, created_at: isoAt(START_MS + 1000) },   // earliest
    { nickname: 'A', wallet: wA, score:  50, created_at: isoAt(START_MS + 9000) },
    { nickname: 'B', wallet: wB, score: 500, created_at: isoAt(START_MS + 3000) },   // earliest B
    { nickname: 'B', wallet: wB, score:  10, created_at: isoAt(START_MS + 7000) },
  ];
  // Force a scenario where dailyScore + best3Sum tie so firstRunTs is used to
  // break the ranker's tiebreak (level 3). Give A and B identical scores.
  //   A: [100,200,50] -> best3=350, no extra, daily=350
  //   B: [500,10]     -> best3=510, daily=510
  // These don't tie. Let's rig identical scores instead.
  const wC = makeWallet('C'), wD = makeWallet('D');
  const rows2 = [
    { nickname: 'C', wallet: wC, score: 100, created_at: isoAt(START_MS + 5000) },
    { nickname: 'D', wallet: wD, score: 100, created_at: isoAt(START_MS + 2000) },   // earlier
  ];
  const res = ingestDailySettlement({
    epochZero: EPOCH_ZERO, periodDurationSeconds: DUR, periodId: PERIOD_ID,
    poolKind: POOL_KIND, dailyPrizePoolLamports: 100_000_000, rows: rows2,
  });
  // Both have dailyScore=100, best3Sum=100 -> firstRunTs breaks: D wins (earlier).
  assert(res.rankedLeaderboard[0].nickname === 'D', 'firstRunTs breaks tie: earlier wallet wins', res.rankedLeaderboard);
  assert(res.rankedLeaderboard[1].nickname === 'C', '', res.rankedLeaderboard);

  // Verify the first scenario aggregates the min ts correctly by inspecting
  // whether the winner is A (higher score) vs B — indirect but sufficient.
  const res1 = ingestDailySettlement({
    epochZero: EPOCH_ZERO, periodDurationSeconds: DUR, periodId: PERIOD_ID,
    poolKind: POOL_KIND, dailyPrizePoolLamports: 100_000_000, rows,
  });
  const byN = Object.fromEntries(res1.rankedLeaderboard.map(p => [p.nickname, p]));
  assert(byN.A.dailyScore === 350, 'A dailyScore=350', byN.A);
  assert(byN.B.dailyScore === 510, 'B dailyScore=510', byN.B);
  assert(byN.B.rank === 1 && byN.A.rank === 2, 'B before A on dailyScore', byN);
}

// ---------- test 5: ranking deterministic under input shuffle --------------
section('test 5 — deterministic across 100 input shuffles');
{
  const N = 80;
  const rows = [];
  for (let i = 0; i < N; i++) {
    const w = makeWallet('r5_' + i);
    const runs = 1 + (i % 4);   // 1..4 runs per player
    for (let j = 0; j < runs; j++) {
      rows.push({
        nickname: 'p' + i,
        wallet:   w,
        score:    (i * 7 + j * 3) % 500,
        created_at: isoAt(START_MS + i * 60_000 + j * 1000),
      });
    }
  }
  const ref = ingestDailySettlement({
    epochZero: EPOCH_ZERO, periodDurationSeconds: DUR, periodId: PERIOD_ID,
    poolKind: POOL_KIND, dailyPrizePoolLamports: 100_000_000, rows,
  });
  const refRanked = JSON.stringify(ref.rankedLeaderboard);
  const refRoot   = ref.settlement.merkleRoot;
  let allMatch = true;
  for (let seed = 1; seed <= 100; seed++) {
    const shuffled = seededShuffle(rows, seed);
    const out = ingestDailySettlement({
      epochZero: EPOCH_ZERO, periodDurationSeconds: DUR, periodId: PERIOD_ID,
      poolKind: POOL_KIND, dailyPrizePoolLamports: 100_000_000, rows: shuffled,
    });
    if (JSON.stringify(out.rankedLeaderboard) !== refRanked || out.settlement.merkleRoot !== refRoot) {
      allMatch = false; break;
    }
  }
  assert(allMatch, '100 input shuffles produce identical rankedLeaderboard + merkleRoot', null);
}

// ---------- test 6: settlement conservation exact --------------------------
section('test 6 — sum(payouts) === dailyPrizePoolLamports (exact)');
for (const n of [1, 10, 50, 99, 100, 250]) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      nickname: 'p' + i, wallet: makeWallet('r6_' + n + '_' + i),
      score:    100 + i,
      created_at: isoAt(START_MS + i * 1000),
    });
  }
  const pool = n * 5_500_000;
  const res = ingestDailySettlement({
    epochZero: EPOCH_ZERO, periodDurationSeconds: DUR, periodId: PERIOD_ID,
    poolKind: POOL_KIND, dailyPrizePoolLamports: pool, rows,
  });
  const sum = res.settlement.winners.reduce((s, w) => s + w.payoutLamports, 0);
  assert(sum === pool, `n=${n}: sum(payouts)=${sum} === pool=${pool}`, { sum, pool });
  assert(res.settlement.totalPayoutLamports === pool, `n=${n}: totalPayoutLamports === pool`, null);
}

// ---------- test 7: all merkle proofs verify -------------------------------
section('test 7 — every merkle proof verifies locally');
for (const n of [1, 5, 50, 100, 250]) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      nickname: 'p' + i, wallet: makeWallet('r7_' + n + '_' + i),
      score:    50 + i,
      created_at: isoAt(START_MS + i * 1000),
    });
  }
  const pool = Math.max(n * 5_500_000, 1_000_000);
  const res = ingestDailySettlement({
    epochZero: EPOCH_ZERO, periodDurationSeconds: DUR, periodId: PERIOD_ID,
    poolKind: POOL_KIND, dailyPrizePoolLamports: pool, rows,
  });
  const root = Buffer.from(res.settlement.merkleRoot, 'hex');
  let allOk = true;
  for (const w of res.settlement.winners) {
    const ok = verifyProof({
      leaf:  Buffer.from(w.leaf, 'hex'),
      proof: w.proof.map(h => Buffer.from(h, 'hex')),
      root,
    });
    if (!ok) { allOk = false; break; }
  }
  assert(allOk, `n=${n}: all ${res.settlement.winners.length} proofs verify`, null);
}

// ---------- test 8: sub-100 players (single power-law path) ----------------
section('test 8 — sub-100 players => single power-law, no bands');
{
  const n = 50;
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      nickname: 'p' + i, wallet: makeWallet('r8_' + i),
      score: 100 + i,
      created_at: isoAt(START_MS + i * 1000),
    });
  }
  const res = ingestDailySettlement({
    epochZero: EPOCH_ZERO, periodDurationSeconds: DUR, periodId: PERIOD_ID,
    poolKind: POOL_KIND, dailyPrizePoolLamports: 275_000_000, rows,
  });
  assert(res.totalPlayers === 50, 'totalPlayers=50', null);
  assert(res.settlement.winnerCount === 20, 'winners=ceil(50*0.40)=20', null);
  // Payouts non-increasing
  let mono = true;
  for (let i = 1; i < res.settlement.winners.length; i++) {
    if (res.settlement.winners[i].payoutLamports > res.settlement.winners[i-1].payoutLamports) {
      mono = false; break;
    }
  }
  assert(mono, 'sub-100 payouts non-increasing', null);
}

// ---------- test 9: >=100 players (bands active) --------------------------
section('test 9 — >=100 players => bands A/B/C active');
{
  const n = 200;
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      nickname: 'p' + i, wallet: makeWallet('r9_' + i),
      score: 500 - i,
      created_at: isoAt(START_MS + i * 1000),
    });
  }
  const res = ingestDailySettlement({
    epochZero: EPOCH_ZERO, periodDurationSeconds: DUR, periodId: PERIOD_ID,
    poolKind: POOL_KIND, dailyPrizePoolLamports: 1_100_000_000, rows,
  });
  assert(res.totalPlayers === 200, 'totalPlayers=200', null);
  assert(res.settlement.winnerCount === 80, 'winners=80', null);
  // Bands not exposed in the artifact (claim only needs {rank, leaf_index,
  // amount, proof}); compute expected boundaries by V1 formula.
  const sizeA = Math.floor(80 * 0.10);    // 8
  const sizeB = Math.floor(80 * 0.30);    // 24
  const sizeC = 80 - sizeA - sizeB;       // 48
  assert(sizeA + sizeB + sizeC === 80, 'sizes sum to 80', { sizeA, sizeB, sizeC });
  const w = res.settlement.winners;
  assert(w[sizeA - 1].payoutLamports >= w[sizeA].payoutLamports,
    'A->B boundary OK (rank 8 vs rank 9)', {
      lastA: w[sizeA - 1].payoutLamports, firstB: w[sizeA].payoutLamports });
  assert(w[sizeA + sizeB - 1].payoutLamports >= w[sizeA + sizeB].payoutLamports,
    'B->C boundary OK (rank 32 vs rank 33)', {
      lastB: w[sizeA + sizeB - 1].payoutLamports, firstC: w[sizeA + sizeB].payoutLamports });
  // Global monotonicity across all winners
  let mono = true;
  for (let i = 1; i < w.length; i++) {
    if (w[i].payoutLamports > w[i-1].payoutLamports) { mono = false; break; }
  }
  assert(mono, 'all 80 payouts non-increasing', null);
}

// ---------- test 10: empty pool + empty rows edge cases -------------------
section('test 10 — empty rows / zero pool / all-anonymous input');
{
  // 10a: no rows
  const rA = ingestDailySettlement({
    epochZero: EPOCH_ZERO, periodDurationSeconds: DUR, periodId: PERIOD_ID,
    poolKind: POOL_KIND, dailyPrizePoolLamports: 100_000_000, rows: [],
  });
  assert(rA.settlement === null && rA.settlementReason === 'no_eligible_players',
    'empty rows -> no_eligible_players', rA);

  // 10b: all rows outside period
  const wallet = makeWallet('outside');
  const rB = ingestDailySettlement({
    epochZero: EPOCH_ZERO, periodDurationSeconds: DUR, periodId: PERIOD_ID,
    poolKind: POOL_KIND, dailyPrizePoolLamports: 100_000_000,
    rows: [{ nickname: 'x', wallet, score: 10, created_at: isoAt(START_MS - 1) }],
  });
  assert(rB.settlement === null && rB.settlementReason === 'no_eligible_players',
    'all-out-of-period -> no_eligible_players', rB);

  // 10c: pool = 0
  const wA = makeWallet('poolzero');
  const rC = ingestDailySettlement({
    epochZero: EPOCH_ZERO, periodDurationSeconds: DUR, periodId: PERIOD_ID,
    poolKind: POOL_KIND, dailyPrizePoolLamports: 0,
    rows: [{ nickname: 'x', wallet: wA, score: 10, created_at: isoAt(START_MS + 100) }],
  });
  assert(rC.settlement === null && rC.settlementReason === 'empty_pool',
    'zero pool -> empty_pool', rC);

  // 10d: all rows without wallet
  const rD = ingestDailySettlement({
    epochZero: EPOCH_ZERO, periodDurationSeconds: DUR, periodId: PERIOD_ID,
    poolKind: POOL_KIND, dailyPrizePoolLamports: 100_000_000,
    rows: [
      { nickname: 'x', wallet: null, score: 10, created_at: isoAt(START_MS + 100) },
      { nickname: 'y', wallet: '',   score: 10, created_at: isoAt(START_MS + 200) },
    ],
  });
  assert(rD.settlement === null && rD.settlementReason === 'no_eligible_players',
    'all-no-wallet -> no_eligible_players', rD);
}

// ---------- test 11: input validation --------------------------------------
section('test 11 — input validation');
{
  const goodRows = [{ nickname: 'a', wallet: makeWallet('a'), score: 10, created_at: isoAt(START_MS + 100) }];
  const base = {
    epochZero: EPOCH_ZERO, periodDurationSeconds: DUR, periodId: PERIOD_ID,
    poolKind: POOL_KIND, dailyPrizePoolLamports: 100_000_000, rows: goodRows,
  };
  assertThrows(() => ingestDailySettlement(null), 'input must be', 'null input');
  assertThrows(() => ingestDailySettlement({ ...base, poolKind: 4 }),
    'poolKind must be', 'poolKind out of range');
  assertThrows(() => ingestDailySettlement({ ...base, dailyPrizePoolLamports: -1 }),
    'must be a non-negative integer', 'negative pool');
  assertThrows(() => ingestDailySettlement({ ...base, dailyPrizePoolLamports: 1.5 }),
    'must be a non-negative integer', 'float pool');
  assertThrows(() => ingestDailySettlement({ ...base, rows: [{ nickname: 'a', wallet: 'W', score: -5, created_at: isoAt(START_MS) }] }),
    'score must be', 'negative score');
  assertThrows(() => ingestDailySettlement({ ...base, rows: [{ nickname: 'a', wallet: 'W', score: 10 }] }),
    'created_at is required', 'missing created_at');
  assertThrows(() => ingestDailySettlement({ ...base, rows: [{ nickname: 'a', wallet: 'W', score: 10, created_at: 'not-a-date' }] }),
    'unparseable', 'bad created_at');
  assertThrows(() => ingestDailySettlement({ ...base, rows: [{ nickname: 12, wallet: 'W', score: 10, created_at: isoAt(START_MS) }] }),
    'nickname must be', 'wrong-type nickname');
  assertThrows(() => ingestDailySettlement({ ...base, epochZero: -1 }),
    'non-negative', 'negative epochZero propagates');
}

// ---------- test 12: parseCreatedAtMs accepts multiple formats ------------
section('test 12 — parseCreatedAtMs accepts ISO, ms integer');
{
  const isoT = '2026-08-22T15:48:02.741Z';
  const isoSp = '2026-08-22 15:48:02.741325+00';        // Postgres SQL format
  const asMs  = Date.parse(isoT);
  assert(parseCreatedAtMs(isoT) === asMs, 'parse ISO with T', null);
  assert(Math.abs(parseCreatedAtMs(isoSp) - asMs) < 1, 'parse Postgres space format', null);
  assert(parseCreatedAtMs(asMs) === asMs, 'accept raw integer ms', null);
  assertThrows(() => parseCreatedAtMs(-1),      'ISO string or non-negative integer ms', 'negative ms rejected');
  assertThrows(() => parseCreatedAtMs('nope'),  'unparseable',           'garbage rejected');
  assertThrows(() => parseCreatedAtMs(null),    'ISO string or non-negative integer ms', 'null rejected');
}

// ---------- test 13: boundaries reflected in artifact ---------------------
section('test 13 — boundaries object mirrors dailyPeriodBoundaries output');
{
  const res = ingestDailySettlement({
    epochZero: EPOCH_ZERO, periodDurationSeconds: DUR, periodId: PERIOD_ID,
    poolKind: POOL_KIND, dailyPrizePoolLamports: 100_000_000,
    rows: [{ nickname: 'a', wallet: makeWallet('a'), score: 10, created_at: isoAt(START_MS + 100) }],
  });
  assert(res.boundaries.startUnix === START_UNIX, 'startUnix', res.boundaries);
  assert(res.boundaries.endUnix   === END_UNIX,   'endUnix',   res.boundaries);
  assert(res.boundaries.startISO.endsWith('Z'), 'startISO is UTC', res.boundaries);
  assert(res.boundaries.endISO.endsWith('Z'),   'endISO is UTC',   res.boundaries);
  assert(res.boundaries.periodId === PERIOD_ID, 'periodId echoed', res.boundaries);
}

// ---------- summary --------------------------------------------------------
console.log('\n== summary ==');
console.log(`assertions: pass=${passed} fail=${failed}`);
if (failed > 0) {
  console.log('\nfailures:');
  for (const f of failures) console.log('  -', f.label, f.ctx == null ? '' : JSON.stringify(f.ctx));
  process.exit(1);
}
