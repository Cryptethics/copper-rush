// Paid V1 Daily settlement builder — standalone, offline, no I/O.
//
// Given a sealed period's pool + the final leaderboard (ranked, one wallet
// per rank), produces the Merkle root + per-winner proofs required by the
// on-chain `post_settlement` and `claim` instructions.
//
// Contract format (verbatim from anchor-program-spec.md rules 1 + §6.4):
//   leaf_preimage =
//       [0x00]                     (1 byte  — DOMAIN_LEAF)
//       || pool_kind               (1 byte  — u8)
//       || period_id.to_le_bytes   (8 bytes — u64 LE)
//       || winner.key().to_bytes   (32 bytes — raw pubkey)
//       || amount.to_le_bytes      (8 bytes — u64 LE, lamports)
//       || leaf_index.to_le_bytes  (4 bytes — u32 LE)
//   leaf = sha256(leaf_preimage)
//
//   node_preimage =
//       [0x01]                     (1 byte  — DOMAIN_NODE)
//       || min(left, right)        (32 bytes — sort_lex)
//       || max(left, right)        (32 bytes)
//   node = sha256(node_preimage)
//
// Copper Rush V1 canonical Merkle conventions (LOCKED for V1):
//   - leaf_index = rank - 1  (0-based; unique in [0, num_winners))
//     Rank 1 -> leaf_index 0, rank 2 -> leaf_index 1, ..., rank N -> N-1.
//     Rank itself is NOT part of the leaf preimage — only leaf_index is.
//   - Unpaired nodes are promoted unchanged to the next Merkle layer.
//     Concretely, a layer [A, B, C] produces [H(sorted(A,B)), C].
//     Never H(C, C). Never any other convention.
//
// Both conventions are part of the V1 protocol. Changing either requires
// an explicit protocol revision, coordinated with whichever tool posts
// merkle_root on-chain and whichever proof server serves claim proofs.
//
// MAX_PROOF_LEN on-chain = 24  =>  up to 2^24 winners per period.

'use strict';

const crypto = require('crypto');
const { computePayouts, computeWinnerCount } = require('./payout_engine.js');

const DOMAIN_LEAF     = 0x00;
const DOMAIN_NODE     = 0x01;
const MAX_PROOF_LEN   = 24;
const PUBKEY_BYTES    = 32;
const HASH_BYTES      = 32;
const VALID_POOL_KIND = new Set([0, 1, 2, 3]);

// ---------- byte helpers -----------------------------------------------------

function u8(v) {
  const buf = Buffer.alloc(1);
  buf.writeUInt8(v & 0xff, 0);
  return buf;
}
function u32le(v) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(v >>> 0, 0);
  return buf;
}
function u64le(v) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(v));
  return buf;
}
function sha256(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function compareLex(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
function toHex(buf) {
  return Buffer.from(buf).toString('hex');
}

// ---------- base58 (Solana-canonical) ----------------------------------------

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(str) {
  if (typeof str !== 'string' || str.length === 0) {
    throw new Error('base58Decode: expected non-empty string');
  }
  let leadingOnes = 0;
  while (leadingOnes < str.length && str[leadingOnes] === '1') leadingOnes++;
  const rest = str.slice(leadingOnes);
  let num = 0n;
  for (const c of rest) {
    const idx = BASE58_ALPHABET.indexOf(c);
    if (idx < 0) throw new Error(`base58Decode: invalid char ${JSON.stringify(c)}`);
    num = num * 58n + BigInt(idx);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const body = num === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  const out = Buffer.alloc(leadingOnes + body.length);
  body.copy(out, leadingOnes);
  return out;
}
function walletToPubkey(walletStr) {
  const bytes = base58Decode(walletStr);
  if (bytes.length !== PUBKEY_BYTES) {
    throw new Error(`walletToPubkey: expected ${PUBKEY_BYTES}-byte pubkey, got ${bytes.length} bytes from ${JSON.stringify(walletStr)}`);
  }
  return bytes;
}

// ---------- leaf + node hashes (contract-exact) ------------------------------

function computeLeaf({ poolKind, periodId, winnerPubkey, amountLamports, leafIndex }) {
  return sha256(
    u8(DOMAIN_LEAF),
    u8(poolKind),
    u64le(periodId),
    Buffer.from(winnerPubkey),
    u64le(amountLamports),
    u32le(leafIndex),
  );
}
function combineNodes(a, b) {
  const [lo, hi] = compareLex(a, b) <= 0 ? [a, b] : [b, a];
  return sha256(u8(DOMAIN_NODE), lo, hi);
}

// ---------- Merkle tree ------------------------------------------------------
// layers[0] = leaves (in leaf_index order)
// layers[L] = [root]
// Odd nodes promoted unchanged.

function buildTree(leaves) {
  if (!Array.isArray(leaves) || leaves.length === 0) {
    throw new Error('buildTree: leaves must be non-empty array');
  }
  const layers = [leaves.map(l => Buffer.from(l))];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      if (i + 1 >= prev.length) next.push(prev[i]);           // promote unpaired
      else                       next.push(combineNodes(prev[i], prev[i + 1]));
    }
    layers.push(next);
  }
  return layers;
}
function proofFor(layers, leafIndex) {
  const proof = [];
  let idx = leafIndex;
  for (let l = 0; l < layers.length - 1; l++) {
    const layer = layers[l];
    if (idx % 2 === 0) {
      if (idx + 1 < layer.length) proof.push(layer[idx + 1]);
      // else: promoted alone; skip layer, no sibling recorded
    } else {
      proof.push(layer[idx - 1]);
    }
    idx = Math.floor(idx / 2);
  }
  return proof;
}
function verifyProof({ leaf, proof, root }) {
  if (proof.length > MAX_PROOF_LEN) return false;
  let cur = Buffer.from(leaf);
  for (const sibling of proof) cur = combineNodes(cur, sibling);
  return bytesEqual(cur, root);
}

// ---------- input validation -------------------------------------------------

// Fail-fast on silent precision loss. Above Number.MAX_SAFE_INTEGER (2^53-1)
// JS still reports Number.isInteger === true for integer-valued doubles, but
// the specific integer value silently rounds. We refuse those inputs; callers
// with u64-scale values (period_id in particular) must pass BigInt.
function assertNonNegInt(v, name) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${typeof v} ${v}`);
  }
  if (v > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${name}=${v} exceeds Number.MAX_SAFE_INTEGER (2^53-1); pass BigInt or reduce value`);
  }
}
function assertPositiveInt(v, name) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new Error(`${name} must be a positive integer, got ${typeof v} ${v}`);
  }
  if (v > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${name}=${v} exceeds Number.MAX_SAFE_INTEGER (2^53-1); pass BigInt or reduce value`);
  }
}
function assertU64Compatible(v, name) {
  if (typeof v === 'bigint') {
    if (v < 0n || v > 0xffff_ffff_ffff_ffffn) throw new Error(`${name} out of u64 range`);
    return;
  }
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new Error(`${name} must be non-negative integer or BigInt fitting u64, got ${typeof v} ${v}`);
  }
  if (v > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${name}=${v} exceeds Number.MAX_SAFE_INTEGER (2^53-1); pass BigInt for large values`);
  }
}

function validateInput(input) {
  if (!input || typeof input !== 'object') throw new Error('input must be an object');
  const { periodId, poolKind, dailyPrizePoolLamports, players } = input;

  assertU64Compatible(periodId, 'periodId');
  if (!Number.isInteger(poolKind) || !VALID_POOL_KIND.has(poolKind)) {
    throw new Error(`poolKind must be 0|1|2|3, got ${poolKind}`);
  }
  assertPositiveInt(dailyPrizePoolLamports, 'dailyPrizePoolLamports');
  if (!Array.isArray(players)) throw new Error('players must be an array');
  if (players.length === 0)   throw new Error('players array is empty');

  const seenRanks = new Set();
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (!p || typeof p !== 'object') throw new Error(`players[${i}] must be an object`);
    if (!Number.isInteger(p.rank)) throw new Error(`players[${i}].rank must be integer`);
    if (p.rank <= 0)               throw new Error(`players[${i}].rank must be > 0, got ${p.rank}`);
    if (p.rank !== i + 1) {
      throw new Error(`players[${i}].rank must equal ${i + 1} (1-based, contiguous), got ${p.rank}`);
    }
    if (seenRanks.has(p.rank)) throw new Error(`duplicate rank ${p.rank}`);
    seenRanks.add(p.rank);
    if (typeof p.wallet !== 'string' || p.wallet.length === 0) {
      throw new Error(`players[${i}].wallet must be non-empty base58 string`);
    }
    // Wallet decode validity (also validates length == 32)
    walletToPubkey(p.wallet);
  }
  // Duplicate wallets: PERMITTED by contract (different leaf_index) and by
  // this builder. On-chain, each leaf claims independently via its unique
  // ClaimMarker seed [SEED_CLAIM, period, leaf_index_le]; wallet identity
  // is only bound inside the leaf hash and via the claim signer.
}

// ---------- top-level: build settlement --------------------------------------

function buildDailySettlement(input) {
  validateInput(input);
  const { periodId, poolKind, dailyPrizePoolLamports, players } = input;
  const totalPlayers = players.length;
  const winnerCount  = computeWinnerCount(totalPlayers);

  if (winnerCount === 0) throw new Error('winnerCount = 0 (empty distribution)');
  if (winnerCount > (1 << MAX_PROOF_LEN)) {
    throw new Error(`winnerCount ${winnerCount} exceeds on-chain limit 2^${MAX_PROOF_LEN}`);
  }

  const payoutRes = computePayouts(totalPlayers, dailyPrizePoolLamports);
  if (payoutRes.winners !== winnerCount) {
    throw new Error(`internal: winnerCount ${winnerCount} !== payoutRes.winners ${payoutRes.winners}`);
  }

  // Winner set: players[0..winnerCount-1] by rank.
  const winners = [];
  const leaves  = [];
  const periodIdBI = typeof periodId === 'bigint' ? periodId : BigInt(periodId);
  let totalPayout = 0;
  for (let i = 0; i < winnerCount; i++) {
    const p           = players[i];
    const amount      = payoutRes.payouts[i];
    const leafIndex   = i;                                  // 0-based, unique
    const winnerPk    = walletToPubkey(p.wallet);           // 32 bytes
    const leaf        = computeLeaf({
      poolKind, periodId: periodIdBI, winnerPubkey: winnerPk,
      amountLamports: amount, leafIndex,
    });
    winners.push({ rank: p.rank, wallet: p.wallet, payoutLamports: amount, leafIndex, leaf });
    leaves.push(leaf);
    totalPayout += amount;
  }

  if (totalPayout !== dailyPrizePoolLamports) {
    throw new Error(`internal: sum(payouts)=${totalPayout} !== pool=${dailyPrizePoolLamports}`);
  }

  const layers = buildTree(leaves);
  const root   = layers[layers.length - 1][0];

  const proofPerWinner = winners.map((w) => proofFor(layers, w.leafIndex));

  // Enforce on-chain proof-length bound as a builder-level guard.
  for (let i = 0; i < proofPerWinner.length; i++) {
    if (proofPerWinner[i].length > MAX_PROOF_LEN) {
      throw new Error(`winner ${i} proof length ${proofPerWinner[i].length} exceeds MAX_PROOF_LEN=${MAX_PROOF_LEN}`);
    }
  }

  // Self-verify every proof against our root before publishing.
  for (let i = 0; i < winners.length; i++) {
    const ok = verifyProof({ leaf: winners[i].leaf, proof: proofPerWinner[i], root });
    if (!ok) throw new Error(`internal: proof for winner ${i} does not verify against builder root`);
  }

  // Artifact — stable field order for deterministic serialization.
  return {
    periodId: typeof periodId === 'bigint' ? periodId.toString() : periodId,
    poolKind,
    totalPlayers,
    winnerCount,
    dailyPrizePoolLamports,
    totalPayoutLamports: totalPayout,
    merkleRoot: toHex(root),
    algorithm: {
      protocol:            'Copper Rush V1',
      hash:                'sha256',
      domainLeaf:          '0x00',
      domainNode:          '0x01',
      pairing:             'sorted',
      oddLayerHandling:    'promote-unpaired',
      oddLayerHandlingDoc: 'Copper Rush V1 canonical: unpaired node forwarded unchanged to next layer. Never H(node,node).',
      leafIndexConvention: 'Copper Rush V1 canonical: leaf_index = rank - 1 (0-based).',
      leafPreimage:        '[0x00] || pool_kind_u8 || period_id_u64_le || winner_pubkey_32 || amount_u64_le || leaf_index_u32_le',
      leafPreimageLen:     54,
      nodePreimageLen:     65,
      maxProofLen:         MAX_PROOF_LEN,
    },
    winners: winners.map((w, i) => ({
      rank:           w.rank,
      wallet:         w.wallet,
      payoutLamports: w.payoutLamports,
      leafIndex:      w.leafIndex,
      leaf:           toHex(w.leaf),
      proof:          proofPerWinner[i].map(toHex),
    })),
  };
}

module.exports = {
  DOMAIN_LEAF,
  DOMAIN_NODE,
  MAX_PROOF_LEN,
  PUBKEY_BYTES,
  HASH_BYTES,
  base58Decode,
  walletToPubkey,
  computeLeaf,
  combineNodes,
  buildTree,
  proofFor,
  verifyProof,
  validateInput,
  buildDailySettlement,
};
