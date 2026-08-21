// Paid V1 Daily payout engine — standalone, pure functions, no I/O.
//
// Given (totalPlayers, dailyPrizePoolLamports) returns integer-lamport
// payouts per rank, with:
//   sum(payouts) === dailyPrizePoolLamports          (byte-exact)
//   payout[i]   <= payout[i-1]                        (non-increasing)
//   deterministic                                     (ties: lower rank wins)
//
// Approved Paid V1 economics (2026-08-21):
//   winners = ceil(totalPlayers * 0.40)
//   totalPlayers <  100 -> single power-law, alpha = 0.75
//   totalPlayers >= 100 -> 3 bands, GLOBAL rank inside each band:
//     A (Elite):    floor(w*0.10) winners, 39% budget, alpha = 0.70
//     B (Middle):   floor(w*0.30) winners, 28% budget, alpha = 0.40
//     C (Min-cash): remainder,             33% budget, alpha = 0.15

'use strict';

const ALPHA_SINGLE = 0.75;
const THRESHOLD_TOTAL_PLAYERS = 100;
const CUTOFF_FRACTION = 0.40;

const BANDS = Object.freeze({
  A: { alpha: 0.70, budgetBps: 3900 },
  B: { alpha: 0.40, budgetBps: 2800 },
  C: { alpha: 0.15, budgetBps: 3300 },
});
const TOTAL_BPS = 10000;

function assertInt(n, name) {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${n}`);
  }
}

function computeWinnerCount(totalPlayers) {
  assertInt(totalPlayers, 'totalPlayers');
  return Math.ceil(totalPlayers * CUTOFF_FRACTION);
}

function computeBandSizes(winners) {
  assertInt(winners, 'winners');
  const A = Math.floor(winners * 0.10);
  const B = Math.floor(winners * 0.30);
  const C = winners - A - B;
  return { A, B, C };
}

// Weights for ranks startRank .. startRank + count - 1.
// weight(rank) = 1 / rank^alpha  (rank >= 1)
function powerLawWeights(startRank, count, alpha) {
  if (!Number.isInteger(startRank) || startRank < 1) {
    throw new Error(`startRank must be integer >= 1, got ${startRank}`);
  }
  assertInt(count, 'count');
  const w = new Array(count);
  for (let i = 0; i < count; i++) {
    w[i] = Math.pow(startRank + i, -alpha);
  }
  return w;
}

// Largest Remainder Method:
//   exact[i]  = budget * weights[i] / sum(weights)
//   floor[i]  = floor(exact[i])
//   dust      = budget - sum(floor)   in  [0, n-1]
//   sort by remainder desc; tiebreak lower index (= lower global rank) first
//   first `dust` entries get +1 lamport
// Guarantees: sum(out) === budget, integer output.
function distributeLamports(weights, budget) {
  assertInt(budget, 'budget');
  const n = weights.length;
  if (n === 0) {
    if (budget !== 0) {
      throw new Error(`distributeLamports: n=0 but budget=${budget}`);
    }
    return [];
  }
  let totalW = 0;
  for (let i = 0; i < n; i++) {
    if (!(weights[i] > 0) || !Number.isFinite(weights[i])) {
      throw new Error(`weights[${i}] must be a finite positive number`);
    }
    totalW += weights[i];
  }
  const floors = new Array(n);
  const rems   = new Array(n);
  let allocated = 0;
  for (let i = 0; i < n; i++) {
    const exact = (budget * weights[i]) / totalW;
    const fl = Math.floor(exact);
    floors[i] = fl;
    rems[i]   = { i, r: exact - fl };
    allocated += fl;
  }
  const dust = budget - allocated;
  if (dust < 0 || dust >= n) {
    throw new Error(`LRM invariant broken: dust=${dust}, n=${n}, budget=${budget}, allocated=${allocated}`);
  }
  rems.sort((a, b) => (b.r - a.r) || (a.i - b.i));
  for (let k = 0; k < dust; k++) floors[rems[k].i] += 1;
  return floors;
}

// Split lump budget across A/B/C by bps, using LRM at the budget level so
// budgetA + budgetB + budgetC === budget exactly.
function splitBandBudgets(budget) {
  assertInt(budget, 'budget');
  const bps = [BANDS.A.budgetBps, BANDS.B.budgetBps, BANDS.C.budgetBps];
  if (bps.reduce((s, v) => s + v, 0) !== TOTAL_BPS) {
    throw new Error(`band bps must sum to ${TOTAL_BPS}`);
  }
  const floors = bps.map(b => Math.floor((budget * b) / TOTAL_BPS));
  const exact  = bps.map(b => (budget * b) / TOTAL_BPS);
  const rems   = exact.map((v, i) => ({ i, r: v - floors[i] }));
  const alloc  = floors.reduce((s, v) => s + v, 0);
  const dust   = budget - alloc;
  if (dust < 0 || dust >= 3) {
    throw new Error(`splitBandBudgets LRM invariant broken: dust=${dust}, budget=${budget}, alloc=${alloc}`);
  }
  rems.sort((a, b) => (b.r - a.r) || (a.i - b.i));
  for (let k = 0; k < dust; k++) floors[rems[k].i] += 1;
  return { A: floors[0], B: floors[1], C: floors[2] };
}

function computePayouts(totalPlayers, dailyPrizePoolLamports) {
  assertInt(totalPlayers, 'totalPlayers');
  assertInt(dailyPrizePoolLamports, 'dailyPrizePoolLamports');

  const winners = computeWinnerCount(totalPlayers);
  const useBands = totalPlayers >= THRESHOLD_TOTAL_PLAYERS;

  if (winners === 0) {
    return { winners: 0, useBands, payouts: [], bands: null };
  }

  if (!useBands) {
    const weights = powerLawWeights(1, winners, ALPHA_SINGLE);
    const payouts = distributeLamports(weights, dailyPrizePoolLamports);
    return { winners, useBands: false, payouts, bands: null };
  }

  const { A: sizeA, B: sizeB, C: sizeC } = computeBandSizes(winners);
  const budgets = splitBandBudgets(dailyPrizePoolLamports);

  // Global ranks per band (contiguous, no reset):
  //   A: 1              .. sizeA
  //   B: sizeA+1        .. sizeA+sizeB
  //   C: sizeA+sizeB+1  .. winners
  const wA = powerLawWeights(1,                 sizeA, BANDS.A.alpha);
  const wB = powerLawWeights(sizeA + 1,         sizeB, BANDS.B.alpha);
  const wC = powerLawWeights(sizeA + sizeB + 1, sizeC, BANDS.C.alpha);

  const pA = sizeA > 0 ? distributeLamports(wA, budgets.A) : [];
  const pB = sizeB > 0 ? distributeLamports(wB, budgets.B) : [];
  const pC = sizeC > 0 ? distributeLamports(wC, budgets.C) : [];

  return {
    winners,
    useBands: true,
    payouts: pA.concat(pB, pC),
    bands: {
      A: { size: sizeA, budget: budgets.A, ranks: [1, sizeA],                    alpha: BANDS.A.alpha, payouts: pA },
      B: { size: sizeB, budget: budgets.B, ranks: [sizeA + 1, sizeA + sizeB],    alpha: BANDS.B.alpha, payouts: pB },
      C: { size: sizeC, budget: budgets.C, ranks: [sizeA + sizeB + 1, winners],  alpha: BANDS.C.alpha, payouts: pC },
    },
  };
}

// Returns { ok: true } or { ok: false, rank, prevRank, prevPayout, payout, bandBefore?, bandAfter? }.
// If a bands snapshot is provided, tags the violation with the two bands involved.
function verifyMonotonic(payouts, bands) {
  function bandOfRank(r) {
    if (!bands) return null;
    if (r >= bands.A.ranks[0] && r <= bands.A.ranks[1]) return 'A';
    if (r >= bands.B.ranks[0] && r <= bands.B.ranks[1]) return 'B';
    if (r >= bands.C.ranks[0] && r <= bands.C.ranks[1]) return 'C';
    return null;
  }
  for (let i = 1; i < payouts.length; i++) {
    if (payouts[i] > payouts[i - 1]) {
      const prevRank = i;
      const rank     = i + 1;
      return {
        ok: false,
        rank,
        prevRank,
        prevPayout: payouts[i - 1],
        payout:     payouts[i],
        bandBefore: bandOfRank(prevRank),
        bandAfter:  bandOfRank(rank),
      };
    }
  }
  return { ok: true };
}

function verifySumEquals(payouts, budget) {
  const sum = payouts.reduce((s, v) => s + v, 0);
  return { ok: sum === budget, sum, budget, delta: sum - budget };
}

module.exports = {
  ALPHA_SINGLE,
  THRESHOLD_TOTAL_PLAYERS,
  CUTOFF_FRACTION,
  BANDS,
  TOTAL_BPS,
  computeWinnerCount,
  computeBandSizes,
  powerLawWeights,
  distributeLamports,
  splitBandBudgets,
  computePayouts,
  verifyMonotonic,
  verifySumEquals,
};
