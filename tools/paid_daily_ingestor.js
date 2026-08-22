// Paid V1 Daily settlement ingestor / orchestrator — pure, offline.
//
// Ties together the existing modules for one on-chain daily period:
//
//   dailyPeriodBoundaries   -> [startUnix, endUnix) UTC
//   filter rows             -> in-period + wallet present
//   aggregate per wallet    -> dailyScore + best3Sum + firstRunTs
//                              (dailyScore MUST match copper-beta.html:3159)
//   rankDailyLeaderboard    -> deterministic ranks 1..N with V1 tiebreak
//   buildDailySettlement    -> merkle root + per-winner proofs
//
// Inputs are synthetic in tests; production callers pass rows fetched from
// Supabase and VaultState fields fetched via RPC. This module never touches
// RPC or Supabase directly.

'use strict';

const { dailyPeriodBoundaries } = require('./daily_period_boundaries.js');
const { rankDailyLeaderboard }  = require('./daily_leaderboard_ranker.js');
const { buildDailySettlement }  = require('./daily_settlement_builder.js');

// ----------- daily-score formula (canonical) --------------------------------
// MUST match copper-beta.html:3159 `computeDailyScore` byte-for-byte.
// Duplicated here (not shared) because copper-beta.html is not a Node module.
// If that changes, extract to a shared module and consume both.
function computeDailyScoreLocal(runScores) {
  const sorted = runScores.slice().sort((a, b) => b - a);
  const best3 = sorted.slice(0, 3);
  const best3Sum = best3.reduce((s, v) => s + v, 0);
  const extraRuns = sorted.slice(3);
  const extraSum = extraRuns.reduce((s, v) => s + v, 0);
  const volumeBonus = Math.min(0.10 * extraSum, 0.30 * best3Sum);
  return {
    dailyScore: Math.round(best3Sum + volumeBonus),
    best3Sum,
  };
}

// ----------- helpers --------------------------------------------------------
function parseCreatedAtMs(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v; // already ms
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`created_at must be ISO string or non-negative integer ms, got ${typeof v}`);
  }
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) throw new Error(`created_at unparseable: ${JSON.stringify(v)}`);
  return ms;
}

function assertRows(rows) {
  if (!Array.isArray(rows)) throw new Error('rows must be an array');
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r || typeof r !== 'object') throw new Error(`rows[${i}] must be an object`);
    if (r.wallet != null && typeof r.wallet !== 'string') {
      throw new Error(`rows[${i}].wallet must be string, null, or undefined`);
    }
    if (r.nickname != null && typeof r.nickname !== 'string') {
      throw new Error(`rows[${i}].nickname must be string, null, or undefined`);
    }
    if (!Number.isInteger(r.score) || r.score < 0) {
      throw new Error(`rows[${i}].score must be a non-negative integer`);
    }
    if (r.created_at == null) throw new Error(`rows[${i}].created_at is required`);
  }
}

// ----------- ingestor -------------------------------------------------------
/**
 * Consume raw score rows for one on-chain daily period and produce a fully
 * ranked leaderboard plus a signed-ready settlement artifact.
 *
 * @param {object} input
 * @param {number|bigint} input.epochZero
 * @param {number}        input.periodDurationSeconds
 * @param {number|bigint} input.periodId
 * @param {number}        input.poolKind                   0=daily / 1=weekly / 2=monthly / 3=jackpot
 * @param {number}        input.dailyPrizePoolLamports    integer lamports; must equal on-chain pending.total_collected
 * @param {Array<{nickname:string|null,wallet:string|null,score:number,created_at:string|number}>} input.rows
 *
 * @returns {{
 *   boundaries: object,
 *   stats: { totalInput:number, droppedNoWallet:number, droppedOutOfPeriod:number, kept:number },
 *   totalPlayers: number,
 *   rankedLeaderboard: Array<{rank,wallet,nickname,dailyScore}>,
 *   settlement: object|null,
 *   settlementReason: string|null,
 * }}
 */
function ingestDailySettlement(input) {
  if (!input || typeof input !== 'object') throw new Error('input must be an object');
  const {
    epochZero, periodDurationSeconds, periodId,
    poolKind, dailyPrizePoolLamports, rows,
  } = input;

  if (!Number.isInteger(poolKind) || poolKind < 0 || poolKind > 3) {
    throw new Error(`poolKind must be 0|1|2|3, got ${poolKind}`);
  }
  if (!Number.isInteger(dailyPrizePoolLamports) || dailyPrizePoolLamports < 0) {
    throw new Error(`dailyPrizePoolLamports must be a non-negative integer, got ${dailyPrizePoolLamports}`);
  }
  assertRows(rows);

  const boundaries = dailyPeriodBoundaries({ epochZero, periodDurationSeconds, periodId });
  const startMs = boundaries.startUnix * 1000;
  const endMs   = boundaries.endUnix   * 1000;

  // ---- filter rows ---------------------------------------------------------
  const inPeriod = [];
  const stats = { totalInput: rows.length, droppedNoWallet: 0, droppedOutOfPeriod: 0, kept: 0 };
  for (const r of rows) {
    const tsMs = parseCreatedAtMs(r.created_at);
    if (typeof r.wallet !== 'string' || r.wallet.length === 0) {
      stats.droppedNoWallet++;
      continue;
    }
    if (tsMs < startMs || tsMs >= endMs) {
      stats.droppedOutOfPeriod++;
      continue;
    }
    inPeriod.push({ nickname: r.nickname, wallet: r.wallet, score: r.score, tsMs });
    stats.kept++;
  }

  // ---- aggregate per wallet ------------------------------------------------
  // scores[], firstRunTs (min tsMs), nickname (from the min-tsMs row; tiebreak
  // lex ASC on nickname when tsMs collides — total-order for reproducibility).
  const byWallet = new Map();
  for (const r of inPeriod) {
    let bucket = byWallet.get(r.wallet);
    if (!bucket) {
      bucket = { wallet: r.wallet, scores: [], firstRunTs: r.tsMs, nickname: r.nickname || '' };
      byWallet.set(r.wallet, bucket);
    }
    bucket.scores.push(r.score);
    const thisNick = r.nickname || '';
    if (r.tsMs < bucket.firstRunTs) {
      bucket.firstRunTs = r.tsMs;
      bucket.nickname   = thisNick;
    } else if (r.tsMs === bucket.firstRunTs && thisNick < bucket.nickname) {
      bucket.nickname   = thisNick;
    }
  }

  // ---- daily score per wallet ---------------------------------------------
  const entries = [];
  for (const b of byWallet.values()) {
    const { dailyScore, best3Sum } = computeDailyScoreLocal(b.scores);
    entries.push({
      nickname:   b.nickname,
      wallet:     b.wallet,
      dailyScore,
      best3Sum,
      firstRunTs: b.firstRunTs,
    });
  }

  // ---- rank ---------------------------------------------------------------
  const ranked = rankDailyLeaderboard(entries);

  // ---- settlement (only if both a pool and eligible players exist) --------
  let settlement       = null;
  let settlementReason = null;
  if (ranked.length === 0) {
    settlementReason = 'no_eligible_players';
  } else if (dailyPrizePoolLamports === 0) {
    settlementReason = 'empty_pool';
  } else {
    settlement = buildDailySettlement({
      periodId,
      poolKind,
      dailyPrizePoolLamports,
      players: ranked.map(p => ({ rank: p.rank, wallet: p.wallet })),
    });
  }

  return {
    boundaries: {
      epochZero:             boundaries.epochZero,
      periodDurationSeconds: boundaries.periodDurationSeconds,
      periodId:              boundaries.periodId,
      startUnix:             boundaries.startUnix,
      endUnix:               boundaries.endUnix,
      startISO:              boundaries.startISO,
      endISO:                boundaries.endISO,
    },
    stats,
    totalPlayers:      ranked.length,
    rankedLeaderboard: ranked,
    settlement,
    settlementReason,
  };
}

module.exports = {
  ingestDailySettlement,
  computeDailyScoreLocal,
  parseCreatedAtMs,
};
