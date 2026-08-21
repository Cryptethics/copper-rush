// Paid V1 Daily leaderboard ranker — pure, deterministic, offline.
//
// Consumes per-player aggregated stats (one entry per wallet) and produces
// the final ranked player list ready to feed daily_settlement_builder.js.
//
// Copper Rush V1 canonical tiebreak (LOCKED):
//   1. dailyScore     DESC   — higher score wins
//   2. best3Sum       DESC   — higher top-3 sum wins
//   3. firstRunTs     ASC    — earliest first-paid-run ms timestamp wins
//   4. wallet lex     ASC    — deterministic final fallback (bytes/ASCII)
//
// Filter (drop silently, do NOT re-rank around them upstream):
//   - entries with no wallet (unmapped nickname in usernames table)
//   - entries whose nickname is empty, missing, or "Anonymous"
//     (case-insensitive — the default written by copper-beta.html when
//      getNickname() is empty; paid mode force-claims a nickname so this
//      should not appear in practice, but the guard is fail-safe.)
//
// Output shape (one per player, in ranked order):
//   { rank, wallet, nickname, dailyScore }
//
// Ranks are contiguous 1..N; the tiebreak above is total-order so no rank
// sharing is possible. Downstream builders can rely on `players[i].rank === i+1`.

'use strict';

const ANONYMOUS_LOWER = 'anonymous';

function normalizeNickname(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function isEligible(entry) {
  if (typeof entry.wallet !== 'string' || entry.wallet.length === 0) return false;
  const nick = normalizeNickname(entry.nickname);
  if (nick.length === 0) return false;
  if (nick.toLowerCase() === ANONYMOUS_LOWER) return false;
  return true;
}

function assertEntry(entry, idx) {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`entries[${idx}] must be an object`);
  }
  if (!Number.isInteger(entry.dailyScore) || entry.dailyScore < 0) {
    throw new Error(`entries[${idx}].dailyScore must be a non-negative integer`);
  }
  if (!Number.isInteger(entry.best3Sum) || entry.best3Sum < 0) {
    throw new Error(`entries[${idx}].best3Sum must be a non-negative integer`);
  }
  if (!Number.isInteger(entry.firstRunTs) || entry.firstRunTs < 0) {
    throw new Error(`entries[${idx}].firstRunTs must be a non-negative integer (ms since epoch)`);
  }
  if (entry.wallet != null && typeof entry.wallet !== 'string') {
    throw new Error(`entries[${idx}].wallet must be string or null/undefined`);
  }
  if (entry.nickname != null && typeof entry.nickname !== 'string') {
    throw new Error(`entries[${idx}].nickname must be string or null/undefined`);
  }
}

// Full total-order comparator. Independent of Array.sort stability guarantees.
function compareEntries(a, b) {
  if (a.dailyScore !== b.dailyScore) return b.dailyScore - a.dailyScore;   // DESC
  if (a.best3Sum   !== b.best3Sum)   return b.best3Sum   - a.best3Sum;     // DESC
  if (a.firstRunTs !== b.firstRunTs) return a.firstRunTs - b.firstRunTs;   // ASC
  if (a.wallet < b.wallet) return -1;                                       // ASC
  if (a.wallet > b.wallet) return  1;
  return 0;
}

function rankDailyLeaderboard(entries) {
  if (!Array.isArray(entries)) throw new Error('entries must be an array');
  for (let i = 0; i < entries.length; i++) assertEntry(entries[i], i);

  const eligible = [];
  for (const e of entries) {
    if (!isEligible(e)) continue;
    eligible.push({
      nickname:   normalizeNickname(e.nickname),
      wallet:     e.wallet,
      dailyScore: e.dailyScore,
      best3Sum:   e.best3Sum,
      firstRunTs: e.firstRunTs,
    });
  }

  eligible.sort(compareEntries);

  return eligible.map((e, i) => ({
    rank:       i + 1,
    wallet:     e.wallet,
    nickname:   e.nickname,
    dailyScore: e.dailyScore,
  }));
}

module.exports = {
  rankDailyLeaderboard,
  compareEntries,
  isEligible,
};
