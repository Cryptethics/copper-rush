// Paid V1 My Rewards — pure helpers.
//
// Node-runnable / testable. The browser-side copper-beta.html duplicates the
// same derivation logic inline (kept small so no bundler is needed). Tests
// here lock the shape used by both.

'use strict';

const { PublicKey } = require('@solana/web3.js');
const { COPPER_PROGRAM_ID } = require('./post_settlement_simulator.js');

const SEED_PERIOD = Buffer.from('period');
const SEED_CLAIM  = Buffer.from('claim');

const LAMPORTS_PER_SOL = 1_000_000_000;
const RPC_ACCOUNT_BATCH = 100;                      // Solana getMultipleAccounts hard cap

// ---------- byte helpers --------------------------------------------------
function u64le(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; }
function u32le(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0);   return b; }

// ---------- row validation ------------------------------------------------
function validateRow(row) {
  if (!row || typeof row !== 'object') throw new Error('row must be object');
  if (!Number.isInteger(row.pool_kind) || row.pool_kind < 0 || row.pool_kind > 3) {
    throw new Error(`pool_kind must be 0..3, got ${row.pool_kind}`);
  }
  const pid = typeof row.period_id === 'number' ? row.period_id : Number(row.period_id);
  if (!Number.isInteger(pid) || pid < 0) {
    throw new Error(`period_id must be non-negative integer, got ${row.period_id}`);
  }
  if (pid > Number.MAX_SAFE_INTEGER) throw new Error('period_id exceeds MAX_SAFE_INTEGER');
  if (!Number.isInteger(row.leaf_index) || row.leaf_index < 0) {
    throw new Error(`leaf_index must be non-negative integer, got ${row.leaf_index}`);
  }
  if (row.leaf_index > 0xffff_ffff) throw new Error('leaf_index exceeds u32 max');
}

// ---------- PDA derivation ------------------------------------------------
function derivePeriodPda({ poolKind, periodId }) {
  validateRow({ pool_kind: poolKind, period_id: periodId, leaf_index: 0 });
  const [pda] = PublicKey.findProgramAddressSync(
    [SEED_PERIOD, Buffer.from([poolKind & 0xff]), u64le(periodId)],
    COPPER_PROGRAM_ID,
  );
  return pda;
}
function deriveClaimMarkerPda({ periodPda, leafIndex }) {
  if (!(periodPda instanceof PublicKey)) throw new Error('periodPda must be PublicKey');
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex > 0xffff_ffff) {
    throw new Error(`leaf_index must be non-negative u32, got ${leafIndex}`);
  }
  const [pda] = PublicKey.findProgramAddressSync(
    [SEED_CLAIM, periodPda.toBuffer(), u32le(leafIndex)],
    COPPER_PROGRAM_ID,
  );
  return pda;
}
function pdasForRow(row) {
  validateRow(row);
  const periodPda   = derivePeriodPda({ poolKind: row.pool_kind, periodId: Number(row.period_id) });
  const claimMarker = deriveClaimMarkerPda({ periodPda, leafIndex: row.leaf_index });
  return { periodPda, claimMarker };
}

// ---------- status classifier --------------------------------------------
// account is the value returned by getMultipleAccounts[i] (or getAccountInfo).
// null / undefined => CLAIMABLE; anything else => CLAIMED. On-chain is the
// only source of truth for claim status.
function classifyStatus(accountInfo) {
  return accountInfo == null ? 'CLAIMABLE' : 'CLAIMED';
}

// ---------- batching for getMultipleAccounts -----------------------------
function chunkForRpc(items, maxSize = RPC_ACCOUNT_BATCH) {
  if (!Array.isArray(items)) throw new Error('items must be array');
  if (!Number.isInteger(maxSize) || maxSize <= 0) throw new Error('maxSize must be > 0');
  const out = [];
  for (let i = 0; i < items.length; i += maxSize) out.push(items.slice(i, i + maxSize));
  return out;
}

// ---------- display formatting -------------------------------------------
// Integer lamports -> compact SOL string (drops trailing zeros; never scientific).
function lamportsToSolString(lamports) {
  const lam = typeof lamports === 'string' ? Number(lamports) : lamports;
  if (!Number.isFinite(lam) || !Number.isInteger(lam) || lam < 0) {
    throw new Error(`lamports must be non-negative integer, got ${lamports}`);
  }
  if (lam === 0) return '0';
  // 9 fixed decimals then trim trailing zeros (and possibly the dot).
  return (lam / LAMPORTS_PER_SOL).toFixed(9).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

module.exports = {
  SEED_PERIOD, SEED_CLAIM,
  LAMPORTS_PER_SOL, RPC_ACCOUNT_BATCH,
  u64le, u32le,
  validateRow,
  derivePeriodPda, deriveClaimMarkerPda, pdasForRow,
  classifyStatus, chunkForRpc,
  lamportsToSolString,
};
