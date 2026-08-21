// Exhaustive stress-test for tools/payout_engine.js
// Covers totalDailyPlayers = 100 .. 10_000 inclusive (9,901 scenarios).
// No mutations to the engine; read-only verification harness.
//
// Pool model:
//   dailyPrizePoolLamports = totalDailyPlayers * 5_500_000
//   (= totalDailyPlayers * 0.01 SOL * 55%)

'use strict';

const {
  computePayouts,
  verifyMonotonic,
  verifySumEquals,
} = require('./payout_engine.js');

const ENTRY_FEE_LAMPORTS       = 10_000_000;   // 0.01 SOL
const DAILY_ALLOCATION_PER_RUN =  5_500_000;   // 55% of entry fee
const START = 100;
const END   = 10_000;

function poolFor(n) {
  return n * DAILY_ALLOCATION_PER_RUN;
}

// Structural equality for the payouts array + band summary (integers only).
function resultsEqual(a, b) {
  if (a.winners !== b.winners) return false;
  if (a.useBands !== b.useBands) return false;
  if (a.payouts.length !== b.payouts.length) return false;
  for (let i = 0; i < a.payouts.length; i++) {
    if (a.payouts[i] !== b.payouts[i]) return false;
  }
  if (!a.bands && !b.bands) return true;
  if (!a.bands || !b.bands) return false;
  for (const k of ['A', 'B', 'C']) {
    if (a.bands[k].size   !== b.bands[k].size)   return false;
    if (a.bands[k].budget !== b.bands[k].budget) return false;
    if (a.bands[k].ranks[0] !== b.bands[k].ranks[0]) return false;
    if (a.bands[k].ranks[1] !== b.bands[k].ranks[1]) return false;
  }
  return true;
}

const summary = {
  total: 0,
  lamportConservationFails: 0,
  positiveFails:            0,
  monotonicityFails:        0,
  abBoundaryFails:          0,
  bcBoundaryFails:          0,
  determinismFails:         0,
  integerFails:             0,
  winnerCountFails:         0,
  bandSumFails:             0,
};

let firstFailure = null;

let worst = {
  minAB:        { value: Infinity, n: null },
  minBC:        { value: Infinity, n: null },
  minLastPct:   { value: Infinity, n: null, lamports: null, winners: null },
  minMedPct:    { value: Infinity, n: null, lamports: null, winners: null, medRank: null },
};

function recordFailure(kind, ctx) {
  if (!firstFailure) firstFailure = { kind, ...ctx };
}

function runOne(n) {
  const pool = poolFor(n);
  const res  = computePayouts(n, pool);
  const { winners, useBands, payouts, bands } = res;

  // 1. winner count
  const expectedW = Math.ceil(n * 0.40);
  if (winners !== expectedW) {
    summary.winnerCountFails++;
    recordFailure('winner-count', { n, winners, expected: expectedW, pool });
    return;
  }

  // integer + positive + non-neg
  for (let i = 0; i < payouts.length; i++) {
    const p = payouts[i];
    if (!Number.isInteger(p)) {
      summary.integerFails++;
      recordFailure('non-integer-payout', { n, winners, rank: i + 1, payout: p, pool });
      return;
    }
    if (p <= 0) {
      summary.positiveFails++;
      recordFailure('non-positive-payout', { n, winners, rank: i + 1, payout: p, pool });
      return;
    }
  }

  // sum
  const sumCheck = verifySumEquals(payouts, pool);
  if (!sumCheck.ok) {
    summary.lamportConservationFails++;
    recordFailure('sum-mismatch', { n, winners, sum: sumCheck.sum, pool, delta: sumCheck.delta });
    return;
  }

  // monotonic — no rank inversion anywhere
  const mono = verifyMonotonic(payouts, bands);
  if (!mono.ok) {
    summary.monotonicityFails++;
    recordFailure('monotonic', {
      n, winners, pool,
      rank: mono.rank, prevRank: mono.prevRank,
      payout: mono.payout, prevPayout: mono.prevPayout,
      bandBefore: mono.bandBefore, bandAfter: mono.bandAfter,
    });
    return;
  }

  // band-level checks (all scenarios here have n>=100 so bands are on)
  if (!useBands) {
    // Guard: should never trip since n>=100 in this stress test
    recordFailure('bands-off-unexpected', { n, winners, pool });
    return;
  }
  const { A, B, C } = bands;

  if (A.size + B.size + C.size !== winners) {
    summary.bandSumFails++;
    recordFailure('band-size-sum', { n, winners, A: A.size, B: B.size, C: C.size });
    return;
  }

  const sumA = A.payouts.reduce((s, v) => s + v, 0);
  const sumB = B.payouts.reduce((s, v) => s + v, 0);
  const sumC = C.payouts.reduce((s, v) => s + v, 0);
  if (sumA !== A.budget || sumB !== B.budget || sumC !== C.budget) {
    summary.bandSumFails++;
    recordFailure('band-budget-mismatch', {
      n, winners,
      sumA, budgetA: A.budget,
      sumB, budgetB: B.budget,
      sumC, budgetC: C.budget,
    });
    return;
  }

  // A -> B boundary
  const lastAPay  = A.payouts[A.size - 1];
  const firstBPay = B.payouts[0];
  const abDelta   = lastAPay - firstBPay;
  if (abDelta < 0) {
    summary.abBoundaryFails++;
    recordFailure('A->B-boundary', {
      n, winners, pool,
      lastARank: A.ranks[1], lastAPay,
      firstBRank: B.ranks[0], firstBPay,
      delta: abDelta,
    });
    return;
  }
  if (abDelta < worst.minAB.value) worst.minAB = { value: abDelta, n };

  // B -> C boundary
  const lastBPay  = B.payouts[B.size - 1];
  const firstCPay = C.payouts[0];
  const bcDelta   = lastBPay - firstCPay;
  if (bcDelta < 0) {
    summary.bcBoundaryFails++;
    recordFailure('B->C-boundary', {
      n, winners, pool,
      lastBRank: B.ranks[1], lastBPay,
      firstCRank: C.ranks[0], firstCPay,
      delta: bcDelta,
    });
    return;
  }
  if (bcDelta < worst.minBC.value) worst.minBC = { value: bcDelta, n };

  // worst last-winner payout as % of entry fee
  const lastPayout = payouts[winners - 1];
  const lastPct    = (lastPayout / ENTRY_FEE_LAMPORTS) * 100;
  if (lastPct < worst.minLastPct.value) {
    worst.minLastPct = { value: lastPct, n, lamports: lastPayout, winners };
  }

  // worst median-winner payout as % of entry fee
  const medRank    = Math.ceil(winners / 2);
  const medPayout  = payouts[medRank - 1];
  const medPct     = (medPayout / ENTRY_FEE_LAMPORTS) * 100;
  if (medPct < worst.minMedPct.value) {
    worst.minMedPct = { value: medPct, n, lamports: medPayout, winners, medRank };
  }

  // determinism: run again, compare
  const res2 = computePayouts(n, pool);
  if (!resultsEqual(res, res2)) {
    summary.determinismFails++;
    recordFailure('determinism', { n, winners, pool });
    return;
  }
}

function main() {
  for (let n = START; n <= END; n++) {
    summary.total++;
    runOne(n);
    // Process the full range; first-failure detail is captured but we
    // keep scanning so worst-case stats cover all 9,901 scenarios.
  }

  console.log(`TOTAL SCENARIOS: ${summary.total.toLocaleString('en-US')}`);
  console.log('');

  const verdict = (fails) => fails === 0 ? 'PASS' : 'FAIL';
  console.log(`Lamport conservation: ${verdict(summary.lamportConservationFails)}`);
  console.log(`Positive payouts:     ${verdict(summary.positiveFails + summary.integerFails)}`);
  console.log(`Monotonicity:         ${verdict(summary.monotonicityFails)}`);
  console.log(`A->B boundaries:      ${verdict(summary.abBoundaryFails)}`);
  console.log(`B->C boundaries:      ${verdict(summary.bcBoundaryFails)}`);
  console.log(`Determinism:          ${verdict(summary.determinismFails)}`);

  console.log('');
  console.log('== worst cases across all 9,901 scenarios ==');
  const fmtDelta = (v) => (v === Infinity ? 'n/a' : v.toLocaleString('en-US'));
  const fmtPct   = (v) => (v === Infinity ? 'n/a' : v.toFixed(4) + '%');
  console.log(`min A->B delta:            ${fmtDelta(worst.minAB.value)} lamports at totalPlayers = ${worst.minAB.n}`);
  console.log(`min B->C delta:            ${fmtDelta(worst.minBC.value)} lamports at totalPlayers = ${worst.minBC.n}`);
  if (worst.minLastPct.lamports != null) {
    console.log(`min last-winner payout:    ${fmtPct(worst.minLastPct.value)} of entry fee = ${worst.minLastPct.lamports.toLocaleString('en-US')} lamports at totalPlayers = ${worst.minLastPct.n} (winners = ${worst.minLastPct.winners})`);
  } else {
    console.log(`min last-winner payout:    n/a (no scenarios completed all checks)`);
  }
  if (worst.minMedPct.lamports != null) {
    console.log(`min median-winner payout:  ${fmtPct(worst.minMedPct.value)} of entry fee = ${worst.minMedPct.lamports.toLocaleString('en-US')} lamports at totalPlayers = ${worst.minMedPct.n} (winners = ${worst.minMedPct.winners}, medRank = ${worst.minMedPct.medRank})`);
  } else {
    console.log(`min median-winner payout:  n/a (no scenarios completed all checks)`);
  }

  if (firstFailure) {
    console.log('\n== FIRST FAILURE ==');
    console.log(JSON.stringify(firstFailure, null, 2));
    process.exit(1);
  }
}

main();
