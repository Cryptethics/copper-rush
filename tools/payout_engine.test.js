// Test + simulation runner for tools/payout_engine.js
// Usage: node tools/payout_engine.test.js
//
// Verifies for each scenario:
//   1. winners === ceil(totalPlayers * 0.40)
//   2. A + B + C === winners   (for totalPlayers >= 100)
//   3. sum(payouts) === pool  (byte-exact)
//   4. each payout is integer
//   5. each payout >= 0
//   6. each payout > 0        (scenario-specific: no dust winners at these budgets)
//   7. payouts non-increasing (monotonic)
//   8. sum(band payouts) === band budget  (for A / B / C)

'use strict';

const {
  computeWinnerCount,
  computeBandSizes,
  computePayouts,
  verifyMonotonic,
  verifySumEquals,
  THRESHOLD_TOTAL_PLAYERS,
} = require('./payout_engine.js');

const LAMPORTS_PER_SOL      = 1_000_000_000;
const ENTRY_FEE_LAMPORTS    = Math.round(0.01 * LAMPORTS_PER_SOL);   // 10_000_000
const DAILY_ALLOCATION_BPS  = 5500;

// Simulation-only helper: 1 paid entry per player.
// The engine itself never assumes 1-run-per-player; it takes the pool as input.
function poolFor(totalPlayers) {
  const totalFeesLamports = totalPlayers * ENTRY_FEE_LAMPORTS;
  return Math.floor((totalFeesLamports * DAILY_ALLOCATION_BPS) / 10000);
}

const SCENARIOS = [1, 2, 3, 10, 20, 50, 99, 100, 101, 200, 300, 400, 500, 600, 700, 800, 900, 1000];

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, label, ctx) {
  if (cond) { passed++; return; }
  failed++;
  failures.push({ label, ctx });
}

function fmtLam(v) {
  if (v == null) return '';
  return String(v).padStart(13, ' ');
}
function fmtSol(lamports, digits = 9) {
  return (lamports / LAMPORTS_PER_SOL).toFixed(digits);
}

// ---------------------- assertions per scenario -----------------------------
function runScenario(totalPlayers) {
  const pool = poolFor(totalPlayers);
  const res  = computePayouts(totalPlayers, pool);
  const { winners, useBands, payouts, bands } = res;

  // 1. winner count
  const expectedW = Math.ceil(totalPlayers * 0.40);
  assert(winners === expectedW,
    `winners = ceil(${totalPlayers}*0.40) = ${expectedW}`,
    { totalPlayers, winners, expected: expectedW });

  // 4. integer, 5. non-negative, 6. non-zero (scenario-specific)
  let allInt = true, allNonNeg = true, allPositive = true;
  for (const p of payouts) {
    if (!Number.isInteger(p))       allInt      = false;
    if (p < 0)                      allNonNeg   = false;
    if (p <= 0)                     allPositive = false;
  }
  assert(allInt,      `all payouts are integer @ ${totalPlayers}`, null);
  assert(allNonNeg,   `all payouts >= 0 @ ${totalPlayers}`,        null);
  assert(allPositive, `all payouts >  0 @ ${totalPlayers}`,        null);

  // 3. exact sum
  const sumCheck = verifySumEquals(payouts, pool);
  assert(sumCheck.ok,
    `sum(payouts) === pool @ ${totalPlayers}`,
    sumCheck);

  // 7. monotonic
  const monoCheck = verifyMonotonic(payouts, bands);
  assert(monoCheck.ok,
    `payouts monotonic @ ${totalPlayers}`,
    monoCheck);

  if (useBands) {
    // 2. band size invariant
    const { A, B, C } = bands;
    assert(A.size + B.size + C.size === winners,
      `A+B+C === winners @ ${totalPlayers}`,
      { A: A.size, B: B.size, C: C.size, winners });

    // 8. per-band budget conservation
    const sumA = A.payouts.reduce((s, v) => s + v, 0);
    const sumB = B.payouts.reduce((s, v) => s + v, 0);
    const sumC = C.payouts.reduce((s, v) => s + v, 0);
    assert(sumA === A.budget, `sum(A) === A.budget @ ${totalPlayers}`, { sumA, budget: A.budget });
    assert(sumB === B.budget, `sum(B) === B.budget @ ${totalPlayers}`, { sumB, budget: B.budget });
    assert(sumC === C.budget, `sum(C) === C.budget @ ${totalPlayers}`, { sumC, budget: C.budget });
    assert(A.budget + B.budget + C.budget === pool,
      `A.budget + B.budget + C.budget === pool @ ${totalPlayers}`,
      { total: A.budget + B.budget + C.budget, pool });
  }

  return { totalPlayers, pool, res, sumCheck, monoCheck };
}

// ---------------------- print helpers ---------------------------------------
function medianRank(w) { return Math.ceil(w / 2); }

function padStr(s, w, align = 'left') {
  s = String(s);
  if (s.length >= w) return s;
  const pad = ' '.repeat(w - s.length);
  return align === 'right' ? pad + s : s + pad;
}

function printMainTable(rows) {
  const cols = [
    { k: 'totalPlayers', l: 'players',    w: 7,  a: 'right' },
    { k: 'poolSol',      l: 'pool_SOL',   w: 10, a: 'right' },
    { k: 'winners',      l: 'winners',    w: 7,  a: 'right' },
    { k: 'p1',           l: 'pay#1',      w: 13, a: 'right' },
    { k: 'p2',           l: 'pay#2',      w: 13, a: 'right' },
    { k: 'p3',           l: 'pay#3',      w: 13, a: 'right' },
    { k: 'p5',           l: 'pay#5',      w: 13, a: 'right' },
    { k: 'p10',          l: 'pay#10',     w: 13, a: 'right' },
    { k: 'medRank',      l: 'medRank',    w: 7,  a: 'right' },
    { k: 'medPay',       l: 'medPay',     w: 13, a: 'right' },
    { k: 'lastRank',     l: 'lastRank',   w: 8,  a: 'right' },
    { k: 'lastPay',      l: 'lastPay',    w: 13, a: 'right' },
    { k: 'sum',          l: 'sum',        w: 13, a: 'right' },
  ];
  console.log('== main table (integer lamports; pool in SOL) ==');
  console.log(cols.map(c => padStr(c.l, c.w, c.a)).join(' | '));
  console.log(cols.map(c => '-'.repeat(c.w)).join('-+-'));
  for (const r of rows) console.log(cols.map(c => padStr(r[c.k] == null ? '-' : r[c.k], c.w, c.a)).join(' | '));
}

function printBandTable(rows) {
  const cols = [
    { k: 'totalPlayers', l: 'players',      w: 7,  a: 'right' },
    { k: 'winners',      l: 'winners',      w: 7,  a: 'right' },
    { k: 'sizeA',        l: 'A_size',       w: 6,  a: 'right' },
    { k: 'sizeB',        l: 'B_size',       w: 6,  a: 'right' },
    { k: 'sizeC',        l: 'C_size',       w: 6,  a: 'right' },
    { k: 'lastA_rank',   l: 'A_lastRank',   w: 10, a: 'right' },
    { k: 'lastA_pay',    l: 'A_lastPay',    w: 13, a: 'right' },
    { k: 'firstB_rank',  l: 'B_firstRank',  w: 11, a: 'right' },
    { k: 'firstB_pay',   l: 'B_firstPay',   w: 13, a: 'right' },
    { k: 'lastB_rank',   l: 'B_lastRank',   w: 10, a: 'right' },
    { k: 'lastB_pay',    l: 'B_lastPay',    w: 13, a: 'right' },
    { k: 'firstC_rank',  l: 'C_firstRank',  w: 11, a: 'right' },
    { k: 'firstC_pay',   l: 'C_firstPay',   w: 13, a: 'right' },
  ];
  console.log('\n== band-boundary table (>=100 players) ==');
  console.log(cols.map(c => padStr(c.l, c.w, c.a)).join(' | '));
  console.log(cols.map(c => '-'.repeat(c.w)).join('-+-'));
  for (const r of rows) console.log(cols.map(c => padStr(r[c.k] == null ? '-' : r[c.k], c.w, c.a)).join(' | '));
}

function printBoundaryDeltas(rows) {
  console.log('\n== boundary deltas (>=100 players) — payout(lastA) vs payout(firstB), payout(lastB) vs payout(firstC) ==');
  const cols = [
    { k: 'totalPlayers', l: 'players',   w: 7,  a: 'right' },
    { k: 'AB_ok',        l: 'A->B_ok',   w: 7,  a: 'right' },
    { k: 'AB_delta',     l: 'A->B_delta',w: 12, a: 'right' },
    { k: 'BC_ok',        l: 'B->C_ok',   w: 7,  a: 'right' },
    { k: 'BC_delta',     l: 'B->C_delta',w: 12, a: 'right' },
  ];
  console.log(cols.map(c => padStr(c.l, c.w, c.a)).join(' | '));
  console.log(cols.map(c => '-'.repeat(c.w)).join('-+-'));
  for (const r of rows) console.log(cols.map(c => padStr(r[c.k] == null ? '-' : r[c.k], c.w, c.a)).join(' | '));
}

// ---------------------- unit tests (independent of scenarios) ---------------
function unitTests() {
  console.log('== unit tests ==');

  // computeWinnerCount
  assert(computeWinnerCount(0)   === 0,  'winners(0)=0',   null);
  assert(computeWinnerCount(1)   === 1,  'winners(1)=1',   null);
  assert(computeWinnerCount(2)   === 1,  'winners(2)=1',   null);
  assert(computeWinnerCount(3)   === 2,  'winners(3)=2',   null);
  assert(computeWinnerCount(100) === 40, 'winners(100)=40', null);
  assert(computeWinnerCount(101) === 41, 'winners(101)=41', null);
  assert(computeWinnerCount(1000)=== 400,'winners(1000)=400',null);

  // computeBandSizes — user-supplied example: 40 winners -> A=4 B=12 C=24
  const bs40 = computeBandSizes(40);
  assert(bs40.A === 4 && bs40.B === 12 && bs40.C === 24,
    'bandSizes(40) = {4,12,24}',
    bs40);
  // 41 winners -> A=4 B=12 C=25 (remainder to C)
  const bs41 = computeBandSizes(41);
  assert(bs41.A === 4 && bs41.B === 12 && bs41.C === 25,
    'bandSizes(41) = {4,12,25}',
    bs41);
  // 400 winners -> A=40 B=120 C=240
  const bs400 = computeBandSizes(400);
  assert(bs400.A === 40 && bs400.B === 120 && bs400.C === 240,
    'bandSizes(400) = {40,120,240}',
    bs400);

  // LRM sanity
  const { distributeLamports, splitBandBudgets } = require('./payout_engine.js');
  const eq = distributeLamports([1, 1, 1], 10);
  assert(eq.reduce((s, v) => s + v, 0) === 10, 'LRM equal-weights sum=10', eq);
  const one = distributeLamports([1], 5);
  assert(one[0] === 5, 'LRM single winner takes all', one);

  const budgets = splitBandBudgets(1);
  assert(budgets.A + budgets.B + budgets.C === 1,
    'splitBandBudgets(1) === 1 total', budgets);
  const budgets7 = splitBandBudgets(7);
  assert(budgets7.A + budgets7.B + budgets7.C === 7,
    'splitBandBudgets(7) === 7 total', budgets7);
  const budgetsBig = splitBandBudgets(5_500_000_000);
  assert(budgetsBig.A + budgetsBig.B + budgetsBig.C === 5_500_000_000,
    'splitBandBudgets(5.5B) sums exactly', budgetsBig);

  console.log(`unit assertions: pass=${passed} fail=${failed}`);
}

// ---------------------- driver ----------------------------------------------
function main() {
  unitTests();

  const mainRows  = [];
  const bandRows  = [];
  const deltaRows = [];

  let anyMonoBreak    = false;
  let anySumBreak     = false;
  let anyBoundaryBad  = false;

  for (const n of SCENARIOS) {
    const { pool, res, sumCheck, monoCheck } = runScenario(n);
    const { winners, useBands, payouts, bands } = res;

    if (!sumCheck.ok)  anySumBreak  = true;
    if (!monoCheck.ok) anyMonoBreak = true;

    const mr = winners > 0 ? medianRank(winners) : 0;

    mainRows.push({
      totalPlayers: n,
      poolSol:      fmtSol(pool, 6),
      winners,
      p1:  payouts[0]         ?? null,
      p2:  payouts[1]         ?? null,
      p3:  payouts[2]         ?? null,
      p5:  payouts[4]         ?? null,
      p10: payouts[9]         ?? null,
      medRank: mr,
      medPay:  winners > 0 ? payouts[mr - 1] : null,
      lastRank: winners,
      lastPay:  winners > 0 ? payouts[winners - 1] : null,
      sum: payouts.reduce((s, v) => s + v, 0),
    });

    if (useBands) {
      const { A, B, C } = bands;
      const lastA_rank  = A.ranks[1];
      const lastA_pay   = A.payouts[A.size - 1];
      const firstB_rank = B.ranks[0];
      const firstB_pay  = B.payouts[0];
      const lastB_rank  = B.ranks[1];
      const lastB_pay   = B.payouts[B.size - 1];
      const firstC_rank = C.ranks[0];
      const firstC_pay  = C.payouts[0];

      bandRows.push({
        totalPlayers: n,
        winners,
        sizeA: A.size, sizeB: B.size, sizeC: C.size,
        lastA_rank,  lastA_pay,
        firstB_rank, firstB_pay,
        lastB_rank,  lastB_pay,
        firstC_rank, firstC_pay,
      });

      const AB_ok    = lastA_pay >= firstB_pay;
      const BC_ok    = lastB_pay >= firstC_pay;
      const AB_delta = lastA_pay - firstB_pay;
      const BC_delta = lastB_pay - firstC_pay;
      if (!AB_ok || !BC_ok) anyBoundaryBad = true;

      deltaRows.push({
        totalPlayers: n,
        AB_ok:    AB_ok ? 'PASS' : 'FAIL',
        AB_delta,
        BC_ok:    BC_ok ? 'PASS' : 'FAIL',
        BC_delta,
      });
    }
  }

  console.log('');
  printMainTable(mainRows);
  printBandTable(bandRows);
  printBoundaryDeltas(deltaRows);

  console.log('');
  console.log('== summary ==');
  console.log(`assertions:              pass=${passed} fail=${failed}`);
  console.log(`exact lamport sum:       ${anySumBreak     ? 'BROKEN' : 'OK'}`);
  console.log(`monotonic non-increasing:${anyMonoBreak    ? ' BROKEN' : ' OK'}`);
  console.log(`A->B and B->C boundaries:${anyBoundaryBad  ? ' BROKEN' : ' OK'}`);

  if (failed > 0) {
    console.log('\n== failures ==');
    for (const f of failures) {
      console.log(`- ${f.label}`, f.ctx == null ? '' : JSON.stringify(f.ctx));
    }
    process.exit(1);
  }
}

main();
