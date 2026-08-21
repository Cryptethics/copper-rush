// Paid V1 Daily period-boundary helper — pure, deterministic, UTC-only.
//
// Given the on-chain VaultState fields for an auto-rotating pool, computes
// the exact UTC interval of a specific period:
//
//   start = epochZero + periodId * periodDurationSeconds
//   end   = start + periodDurationSeconds
//
// The interval is INCLUSIVE at start, EXCLUSIVE at end. Downstream Supabase
// filters must use created_at >= startISO AND created_at < endISO.
//
// Output ISO strings are always UTC (produced by Date.prototype.toISOString(),
// which is timezone-independent). No setHours()/local-midnight logic anywhere.
//
// Applies to auto-rotating pools only (daily/weekly/monthly). Jackpot uses
// period_duration_seconds = 0 (MANUAL_ROTATION_SENTINEL) and has no time
// boundary — passing duration = 0 is refused.

'use strict';

function toSafeInt(v, name) {
  if (typeof v === 'bigint') {
    if (v < 0n) throw new Error(`${name} must be non-negative, got ${v}`);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${name}=${v} exceeds Number.MAX_SAFE_INTEGER (2^53-1)`);
    }
    return Number(v);
  }
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new Error(`${name} must be an integer, got ${typeof v} ${v}`);
  }
  if (v < 0) throw new Error(`${name} must be non-negative, got ${v}`);
  if (v > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${name}=${v} exceeds Number.MAX_SAFE_INTEGER (2^53-1)`);
  }
  return v;
}

function assertPositiveDuration(v, name) {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new Error(`${name} must be a positive integer, got ${typeof v} ${v}`);
  }
  if (v <= 0) {
    throw new Error(`${name} must be > 0, got ${v} (manual-rotation pools like jackpot have no time boundary)`);
  }
  if (v > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${name}=${v} exceeds Number.MAX_SAFE_INTEGER (2^53-1)`);
  }
}

/**
 * Compute the UTC time interval for a specific on-chain period.
 *
 * @param {object} args
 * @param {number|bigint} args.epochZero               VaultState.epoch_zero, Unix seconds
 * @param {number}        args.periodDurationSeconds   VaultState.period_duration_seconds, > 0
 * @param {number|bigint} args.periodId                Period index (0-based), u64
 * @returns {{ startUnix:number, endUnix:number, startISO:string, endISO:string,
 *             periodId:number, periodDurationSeconds:number, epochZero:number }}
 */
function dailyPeriodBoundaries(args) {
  if (!args || typeof args !== 'object') throw new Error('args must be an object');
  const { epochZero, periodDurationSeconds, periodId } = args;

  const ez  = toSafeInt(epochZero, 'epochZero');
  const pid = toSafeInt(periodId,  'periodId');
  assertPositiveDuration(periodDurationSeconds, 'periodDurationSeconds');

  // Overflow guard: the final `end` must still fit in a safe integer so both
  // Date(x*1000) and downstream Supabase filters stay lossless.
  const startUnix = ez + pid * periodDurationSeconds;
  const endUnix   = startUnix + periodDurationSeconds;
  if (!Number.isSafeInteger(startUnix) || !Number.isSafeInteger(endUnix)) {
    throw new Error(`computed boundary overflows Number.MAX_SAFE_INTEGER (start=${startUnix}, end=${endUnix})`);
  }

  // toISOString is UTC-normalized ("...Z"); independent of process TZ.
  const startISO = new Date(startUnix * 1000).toISOString();
  const endISO   = new Date(endUnix   * 1000).toISOString();

  return {
    epochZero:             ez,
    periodDurationSeconds,
    periodId:              pid,
    startUnix,
    endUnix,
    startISO,
    endISO,
  };
}

module.exports = { dailyPeriodBoundaries };
