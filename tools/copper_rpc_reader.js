// Paid V1 read-only Solana RPC reader (devnet).
//
// Purpose: fetch on-chain state needed by the settlement pipeline without any
// external dependency (uses Node 20's built-in fetch). Zero signing, zero
// transactions, zero mutations.
//
// Provides:
//   - fetchVaultState(cluster, poolKind)              -> decoded VaultState
//   - listPendingSettlements(cluster, poolKind)       -> [{ pubkey, period_id, total_collected, rent_payer, sealed_at }]
//   - listPeriods(cluster, poolKind)                  -> [{ pubkey, period_id, merkle_root, total_payout, num_winners, num_claimed, claimed_so_far, is_finalized, posted_at }]
//   - PDA pubkeys for the 4 VaultStates are hardcoded from a prior verified
//     init_pool run (see check_state.py); memcmp is used to enumerate
//     PendingSettlement / Period so no client-side PDA derivation is needed.
//
// Data layouts follow anchor-program-spec.md §5.3, §5.4, §5.5.

'use strict';

const COPPER_PROGRAM_ID = 'EdYmMfzFidw4epQkBBiEP3bzJLYRGbKe6uqUuqq1Ggsg';

const CLUSTERS = Object.freeze({
  devnet:  'https://api.devnet.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com',
});

// VaultState PDAs for the CURRENT program (owner = EdYmMfzFidw4epQkBBiEP3bzJLYRGbKe6uqUuqq1Ggsg).
// Verified 2026-08-22 by enumerating getProgramAccounts filtered dataSize=151
// and inspecting pool_kind at offset 8.
//
// Note: check_state.py hardcodes a DIFFERENT set of pubkeys — those belong to
// an ORPHAN prior deployment (owner=3e8EsKpaRaHevRLyPdWW73NELqHC1keBD6ZMVrbV2rUF)
// that is no longer wired in copper-beta.html. Reads via those pubkeys will
// succeed (the program is upgradeable and old accounts still exist) but the
// data is stale relative to what the running frontend produces.
const VAULT_STATE_PDA = Object.freeze({
  0: '4oRyLU9ajheaJM8dz61pSknYBiDRrULw8f964PxhzFE4',   // DAILY   (V2)
  1: 'DZyKiMBbwDHZGbwweHmvhe8JsaDkDtAUG4hEBDR5qvYo',   // WEEKLY  (V2)
  2: 'EVi1twXcfeY1wJGDX8FBBKbR2AATdfdq2Fmm5cxNpdZh',   // MONTHLY (V2)
  3: '7sM92MXjKwxmw1U8VQD7KaUiP5mRjeD8oSaJBtgSzCM7',   // JACKPOT (V2)
});
// Vault PDAs (system-owned holding SOL) for V2 are not enumerable via
// getProgramAccounts (they're not owned by the copper program). Their
// balances are informational only for the settlement pipeline, which does
// not need them; the reader intentionally omits them until derived via a
// proper Ed25519-aware PDA client.
const VAULT_PDA = Object.freeze({});

// Anchor account sizes (with 8-byte discriminator) per spec §5.
const VAULT_STATE_LEN         = 151;
const PENDING_SETTLEMENT_LEN  =  98;
const PERIOD_LEN              = 115;

// ---------- base58 encode (test-only-quality; used for memcmp filter bytes) --
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58Encode(bytes) {
  if (bytes.length === 0) return '';
  let z = 0; while (z < bytes.length && bytes[z] === 0) z++;
  const hex = Buffer.from(bytes).toString('hex');
  let n = hex.length === 0 ? 0n : BigInt('0x' + hex);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n = n / 58n; }
  // z leading zero bytes -> z leading '1' chars. Never append an extra '1'.
  return '1'.repeat(z) + out;
}
const B58_MAP = (() => { const m = {}; for (let i = 0; i < B58.length; i++) m[B58[i]] = i; return m; })();
function b58Decode(str) {
  if (typeof str !== 'string') throw new Error('b58Decode: expected string');
  let z = 0; while (z < str.length && str[z] === '1') z++;
  let n = 0n;
  for (const c of str.slice(z)) {
    const idx = B58_MAP[c];
    if (idx === undefined) throw new Error(`b58Decode: invalid char ${JSON.stringify(c)}`);
    n = n * 58n + BigInt(idx);
  }
  let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex;
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  const out = Buffer.alloc(z + body.length);
  body.copy(out, z);
  return out;
}

// ---------- JSON-RPC ---------------------------------------------------------
async function rpc(cluster, method, params) {
  const url = CLUSTERS[cluster] || cluster;   // accept full URL too
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${method}: HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

// ---------- decoders (spec §5.3, §5.4, §5.5) --------------------------------
function decodeVaultState(buf) {
  if (buf.length !== VAULT_STATE_LEN) {
    throw new Error(`VaultState: expected ${VAULT_STATE_LEN} bytes, got ${buf.length}`);
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 8;   // skip discriminator
  const pool_kind  = buf[off++];
  const bump       = buf[off++];
  const vault_bump = buf[off++];
  const epoch_zero              = dv.getBigInt64(off, true); off += 8;
  const period_duration_seconds = dv.getUint32 (off, true); off += 4;
  const open_period_id          = dv.getBigUint64(off, true); off += 8;
  const open_period_collected   = dv.getBigUint64(off, true); off += 8;
  const awaiting_settlement_total = dv.getBigUint64(off, true); off += 8;
  const obligations_lamports    = dv.getBigUint64(off, true); off += 8;
  const total_collected_lifetime = dv.getBigUint64(off, true); off += 8;
  const total_paid_lifetime     = dv.getBigUint64(off, true); off += 8;
  const last_seal_at            = dv.getBigInt64(off, true); off += 8;
  const last_settlement_at      = dv.getBigInt64(off, true); off += 8;
  return {
    pool_kind, bump, vault_bump,
    epoch_zero, period_duration_seconds, open_period_id, open_period_collected,
    awaiting_settlement_total, obligations_lamports,
    total_collected_lifetime, total_paid_lifetime,
    last_seal_at, last_settlement_at,
  };
}
function decodePendingSettlement(buf) {
  if (buf.length !== PENDING_SETTLEMENT_LEN) {
    throw new Error(`PendingSettlement: expected ${PENDING_SETTLEMENT_LEN} bytes, got ${buf.length}`);
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 8;
  const pool_kind = buf[off++];
  const bump      = buf[off++];
  const period_id = dv.getBigUint64(off, true); off += 8;
  const total_collected = dv.getBigUint64(off, true); off += 8;
  const rent_payer = b58Encode(buf.subarray(off, off + 32)); off += 32;
  const sealed_at  = dv.getBigInt64(off, true); off += 8;
  return { pool_kind, bump, period_id, total_collected, rent_payer, sealed_at };
}
function decodePeriod(buf) {
  if (buf.length !== PERIOD_LEN) {
    throw new Error(`Period: expected ${PERIOD_LEN} bytes, got ${buf.length}`);
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 8;
  const pool_kind = buf[off++];
  const bump      = buf[off++];
  const period_id = dv.getBigUint64(off, true); off += 8;
  const merkle_root  = Buffer.from(buf.subarray(off, off + 32)).toString('hex'); off += 32;
  const total_payout = dv.getBigUint64(off, true); off += 8;
  const claimed_so_far = dv.getBigUint64(off, true); off += 8;
  const num_winners = dv.getUint32(off, true); off += 4;
  const num_claimed = dv.getUint32(off, true); off += 4;
  const is_finalized = buf[off++] !== 0;
  const posted_at = dv.getBigInt64(off, true); off += 8;
  return {
    pool_kind, bump, period_id,
    merkle_root, total_payout, claimed_so_far,
    num_winners, num_claimed, is_finalized, posted_at,
  };
}

// ---------- public API ------------------------------------------------------
async function fetchVaultState(cluster, poolKind) {
  const pk = VAULT_STATE_PDA[poolKind];
  if (!pk) throw new Error(`unknown poolKind ${poolKind}`);
  const r = await rpc(cluster, 'getAccountInfo', [pk, { encoding: 'base64', commitment: 'finalized' }]);
  const v = r && r.value;
  if (!v) return null;
  const buf = Buffer.from(v.data[0], 'base64');
  return {
    pubkey:   pk,
    lamports: v.lamports,
    owner:    v.owner,
    decoded:  decodeVaultState(buf),
  };
}

async function fetchVaultLamports(cluster, poolKind) {
  const pk = VAULT_PDA[poolKind];
  if (!pk) throw new Error(`unknown poolKind ${poolKind}`);
  const r = await rpc(cluster, 'getBalance', [pk, { commitment: 'finalized' }]);
  return { pubkey: pk, lamports: r.value };
}

// Enumerate accounts owned by the program with size = PendingSettlement (98)
// AND a first-byte-after-discriminator equal to poolKind. Zero PDA derivation.
async function listPendingSettlements(cluster, poolKind) {
  const filters = [
    { dataSize: PENDING_SETTLEMENT_LEN },
    { memcmp: { offset: 8, bytes: b58Encode(Buffer.from([poolKind & 0xff])) } },
  ];
  const result = await rpc(cluster, 'getProgramAccounts', [
    COPPER_PROGRAM_ID,
    { commitment: 'finalized', encoding: 'base64', filters },
  ]);
  return result.map(r => ({
    pubkey:  r.pubkey,
    lamports: r.account.lamports,
    ...decodePendingSettlement(Buffer.from(r.account.data[0], 'base64')),
  })).sort((a, b) => Number(a.period_id - b.period_id));
}

async function listPeriods(cluster, poolKind) {
  const filters = [
    { dataSize: PERIOD_LEN },
    { memcmp: { offset: 8, bytes: b58Encode(Buffer.from([poolKind & 0xff])) } },
  ];
  const result = await rpc(cluster, 'getProgramAccounts', [
    COPPER_PROGRAM_ID,
    { commitment: 'finalized', encoding: 'base64', filters },
  ]);
  return result.map(r => ({
    pubkey:  r.pubkey,
    lamports: r.account.lamports,
    ...decodePeriod(Buffer.from(r.account.data[0], 'base64')),
  })).sort((a, b) => Number(a.period_id - b.period_id));
}

module.exports = {
  COPPER_PROGRAM_ID, CLUSTERS,
  VAULT_STATE_PDA, VAULT_PDA,
  VAULT_STATE_LEN, PENDING_SETTLEMENT_LEN, PERIOD_LEN,
  b58Encode, b58Decode,
  decodeVaultState, decodePendingSettlement, decodePeriod,
  fetchVaultState, fetchVaultLamports,
  listPendingSettlements, listPeriods,
};
