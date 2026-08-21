// Tests for tools/daily_settlement_builder.js — synthetic data only.
// Usage: node tools/daily_settlement_builder.test.js

'use strict';

const crypto = require('crypto');
const {
  buildDailySettlement,
  verifyProof,
  computeLeaf,
  combineNodes,
  buildTree,
  proofFor,
  base58Decode,
  walletToPubkey,
  MAX_PROOF_LEN,
} = require('./daily_settlement_builder.js');

// ---------- base58 encode (test-only; builder needs decode only) ------------

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(bytes) {
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros++;
  const hex = Buffer.from(bytes).toString('hex');
  let num = hex.length === 0 ? 0n : BigInt('0x' + hex);
  let out = '';
  while (num > 0n) {
    const rem = Number(num % 58n);
    num = num / 58n;
    out = BASE58_ALPHABET[rem] + out;
  }
  out = '1'.repeat(leadingZeros) + out;
  return out || '1';
}

function makeTestWallet(seed) {
  const bytes = crypto.createHash('sha256').update('wallet:' + seed).digest();
  return base58Encode(bytes);
}
function makePlayers(n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = { rank: i + 1, wallet: makeTestWallet(i) };
  return out;
}
function poolFor(totalPlayers) {
  // Simulation only — not required by builder API.
  return totalPlayers * 5_500_000;
}

// ---------- test harness ----------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, label, ctx) {
  if (cond) { passed++; return; }
  failed++;
  failures.push({ label, ctx });
  console.log(`  FAIL: ${label}` + (ctx ? '  ' + JSON.stringify(ctx) : ''));
}
function assertThrows(fn, matchSubstr, label) {
  try {
    fn();
    assert(false, `${label} — expected throw (${matchSubstr})`, null);
  } catch (e) {
    const msg = String(e && e.message);
    if (msg.includes(matchSubstr)) assert(true, `${label} — threw (${matchSubstr})`);
    else assert(false, `${label} — threw wrong error`, { expected: matchSubstr, got: msg });
  }
}
function section(name) {
  console.log('\n== ' + name + ' ==');
}

// ---------- sanity: base58 roundtrip ----------------------------------------
section('base58 roundtrip (test helper vs builder decode)');
for (const seed of [0, 1, 42, 999, 65535, 12345678]) {
  const w  = makeTestWallet(seed);
  const pk = walletToPubkey(w);
  assert(pk.length === 32, `wallet[seed=${seed}] decodes to 32 bytes`, { seed, len: pk.length });
  const w2 = base58Encode(pk);
  assert(w === w2, `roundtrip base58 encode(decode(w)) == w  seed=${seed}`, { w, w2 });
}
// leading-zero edge
{
  const raw = Buffer.alloc(32);           // all zeros
  raw[31] = 1;
  const w   = base58Encode(raw);
  const pk  = walletToPubkey(w);
  assert(pk.length === 32 && pk[31] === 1, 'base58 handles leading zero bytes', { w });
}

// ---------- test 1: deterministic root -------------------------------------
section('test 1 — deterministic artifact for identical input');
{
  const players = makePlayers(200);
  const input = { periodId: 42, poolKind: 0, dailyPrizePoolLamports: poolFor(200), players };
  const a = buildDailySettlement(input);
  const b = buildDailySettlement(input);
  assert(JSON.stringify(a) === JSON.stringify(b),
    'byte-identical artifact on two invocations',
    { rootA: a.merkleRoot, rootB: b.merkleRoot });
  assert(a.merkleRoot === b.merkleRoot, 'identical merkle root', null);
}

// ---------- test 2: exact conservation --------------------------------------
section('test 2 — sum(payoutLamports) === dailyPrizePoolLamports');
for (const n of [1, 50, 99, 100, 101, 500, 1000]) {
  const players = makePlayers(n);
  const pool    = poolFor(n);
  const art     = buildDailySettlement({ periodId: 7n, poolKind: 0, dailyPrizePoolLamports: pool, players });
  const sum     = art.winners.reduce((s, w) => s + w.payoutLamports, 0);
  assert(sum === pool, `n=${n}: sum === pool`, { sum, pool });
  assert(art.totalPayoutLamports === pool, `n=${n}: totalPayoutLamports === pool`, null);
}

// ---------- test 3: winner count = ceil(n * 0.40) ---------------------------
section('test 3 — winnerCount = ceil(totalPlayers * 0.40)');
for (const n of [1, 2, 3, 10, 20, 99, 100, 101, 250, 1000]) {
  const players = makePlayers(n);
  const art     = buildDailySettlement({ periodId: 1, poolKind: 0, dailyPrizePoolLamports: poolFor(n), players });
  const expected = Math.ceil(n * 0.40);
  assert(art.winnerCount === expected, `n=${n} → winners=${expected}`, { got: art.winnerCount });
  assert(art.winners.length === expected, `winners.length === winnerCount`, null);
}

// ---------- test 4: rank → payout mapping preserves order -------------------
section('test 4 — rank[i] pairs with payouts[i]; monotonic non-increasing');
{
  const n = 300;
  const players = makePlayers(n);
  const art = buildDailySettlement({ periodId: 3, poolKind: 0, dailyPrizePoolLamports: poolFor(n), players });
  for (let i = 0; i < art.winners.length; i++) {
    assert(art.winners[i].rank === i + 1, `winners[${i}].rank === ${i + 1}`, null);
    assert(art.winners[i].wallet === players[i].wallet, `winners[${i}].wallet === players[${i}].wallet`, null);
    assert(art.winners[i].leafIndex === i, `winners[${i}].leafIndex === ${i}`, null);
    if (i > 0) {
      assert(art.winners[i].payoutLamports <= art.winners[i - 1].payoutLamports,
        `payout non-increasing at rank ${i + 1}`,
        { prev: art.winners[i - 1].payoutLamports, cur: art.winners[i].payoutLamports });
    }
  }
}

// ---------- test 5: every proof verifies against root -----------------------
section('test 5 — every winner\'s proof verifies against merkleRoot');
for (const n of [1, 5, 50, 99, 100, 250, 1000]) {
  const players = makePlayers(n);
  const art = buildDailySettlement({ periodId: 11n, poolKind: 0, dailyPrizePoolLamports: poolFor(n), players });
  const root = Buffer.from(art.merkleRoot, 'hex');
  let allOk = true;
  for (const w of art.winners) {
    const proof = w.proof.map(h => Buffer.from(h, 'hex'));
    const leaf  = Buffer.from(w.leaf, 'hex');
    if (!verifyProof({ leaf, proof, root })) { allOk = false; break; }
  }
  assert(allOk, `n=${n}: all proofs verify`, { winnerCount: art.winnerCount });
}

// ---------- test 6: modifying amount invalidates proof ---------------------
section('test 6 — bumping amount invalidates proof');
{
  const n = 250;
  const players = makePlayers(n);
  const art = buildDailySettlement({ periodId: 20, poolKind: 0, dailyPrizePoolLamports: poolFor(n), players });
  const root = Buffer.from(art.merkleRoot, 'hex');
  const w = art.winners[7];
  const tamperedLeaf = computeLeaf({
    poolKind:       art.poolKind,
    periodId:       BigInt(art.periodId),
    winnerPubkey:   walletToPubkey(w.wallet),
    amountLamports: w.payoutLamports + 1,       // wrong
    leafIndex:      w.leafIndex,
  });
  const ok = verifyProof({ leaf: tamperedLeaf, proof: w.proof.map(h => Buffer.from(h, 'hex')), root });
  assert(!ok, 'amount tamper invalidates proof', null);
}

// ---------- test 7: modifying wallet invalidates proof ----------------------
section('test 7 — swapping wallet invalidates proof');
{
  const n = 250;
  const players = makePlayers(n);
  const art = buildDailySettlement({ periodId: 21, poolKind: 0, dailyPrizePoolLamports: poolFor(n), players });
  const root = Buffer.from(art.merkleRoot, 'hex');
  const w = art.winners[3];
  const otherWallet = makeTestWallet(9999);      // not any winner's wallet
  const tamperedLeaf = computeLeaf({
    poolKind:       art.poolKind,
    periodId:       BigInt(art.periodId),
    winnerPubkey:   walletToPubkey(otherWallet),
    amountLamports: w.payoutLamports,
    leafIndex:      w.leafIndex,
  });
  const ok = verifyProof({ leaf: tamperedLeaf, proof: w.proof.map(h => Buffer.from(h, 'hex')), root });
  assert(!ok, 'wallet tamper invalidates proof', null);
}

// ---------- test 8: winner i's proof does not verify winner j's leaf --------
section('test 8 — cross-swap: proof(i) does not verify leaf(j)');
{
  const n = 400;
  const players = makePlayers(n);
  const art = buildDailySettlement({ periodId: 22, poolKind: 0, dailyPrizePoolLamports: poolFor(n), players });
  const root = Buffer.from(art.merkleRoot, 'hex');
  const wi = art.winners[10];
  const wj = art.winners[50];
  assert(wi.leafIndex !== wj.leafIndex, 'sanity — different leaf indices', null);
  // Use wi's proof against wj's leaf (different leaf_index and wallet)
  const ok = verifyProof({
    leaf:  Buffer.from(wj.leaf, 'hex'),
    proof: wi.proof.map(h => Buffer.from(h, 'hex')),
    root,
  });
  assert(!ok, 'cross-swap proof rejected', null);
}

// ---------- test 9: sub-100 players (single power-law) ----------------------
section('test 9 — sub-100 players (single power-law path)');
{
  const n = 50;
  const players = makePlayers(n);
  const art = buildDailySettlement({ periodId: 5, poolKind: 0, dailyPrizePoolLamports: poolFor(n), players });
  assert(art.winnerCount === 20, 'winners = 20', null);
  assert(art.totalPayoutLamports === poolFor(n), 'pool conserved', null);
  const root = Buffer.from(art.merkleRoot, 'hex');
  let allOk = true;
  for (const w of art.winners) {
    if (!verifyProof({
      leaf: Buffer.from(w.leaf, 'hex'),
      proof: w.proof.map(h => Buffer.from(h, 'hex')),
      root,
    })) { allOk = false; break; }
  }
  assert(allOk, 'all sub-100 proofs verify', null);
}

// ---------- test 10: >=100 players (bands active) --------------------------
section('test 10 — >=100 players (bands active)');
{
  const n = 100;
  const players = makePlayers(n);
  const art = buildDailySettlement({ periodId: 6, poolKind: 0, dailyPrizePoolLamports: poolFor(n), players });
  assert(art.winnerCount === 40, 'winners = 40', null);
  // Confirm band-boundary economics: A→B and B→C should not be violated.
  const w = art.winners;
  // A=4 → ranks 1..4 in A; B=12 → ranks 5..16 in B; C=24 → ranks 17..40 in C
  assert(w[3].payoutLamports >= w[4].payoutLamports, 'A→B boundary (rank 4 vs 5)', {
    a: w[3].payoutLamports, b: w[4].payoutLamports });
  assert(w[15].payoutLamports >= w[16].payoutLamports, 'B→C boundary (rank 16 vs 17)', {
    a: w[15].payoutLamports, b: w[16].payoutLamports });
}

// ---------- test 11: large tree with all three bands populated -------------
section('test 11 — large tree (n=1000, all bands populated, verify all proofs)');
{
  const n = 1000;
  const players = makePlayers(n);
  const art = buildDailySettlement({ periodId: 100n, poolKind: 0, dailyPrizePoolLamports: poolFor(n), players });
  assert(art.winnerCount === 400, 'winners = 400', null);
  const root = Buffer.from(art.merkleRoot, 'hex');
  let allOk = true;
  let maxProofLen = 0;
  for (const w of art.winners) {
    maxProofLen = Math.max(maxProofLen, w.proof.length);
    if (!verifyProof({
      leaf: Buffer.from(w.leaf, 'hex'),
      proof: w.proof.map(h => Buffer.from(h, 'hex')),
      root,
    })) { allOk = false; break; }
  }
  assert(allOk, 'all 400 proofs verify', null);
  assert(maxProofLen <= MAX_PROOF_LEN, `max proof length ${maxProofLen} <= ${MAX_PROOF_LEN}`, { maxProofLen });
}

// ---------- test 12: invalid inputs ----------------------------------------
section('test 12 — invalid input guards');
{
  const good = { periodId: 1, poolKind: 0, dailyPrizePoolLamports: poolFor(10), players: makePlayers(10) };

  // empty players
  assertThrows(() => buildDailySettlement({ ...good, players: [] }),
    'empty', 'empty players array rejected');

  // non-contiguous rank
  const badRanks = makePlayers(10);
  badRanks[3].rank = 99;
  assertThrows(() => buildDailySettlement({ ...good, players: badRanks }),
    'rank must equal', 'non-contiguous ranks rejected');

  // duplicate rank
  const dupRanks = makePlayers(10);
  dupRanks[5].rank = 3;
  assertThrows(() => buildDailySettlement({ ...good, players: dupRanks }),
    'rank must equal', 'duplicate rank rejected (via contiguity check)');

  // zero rank
  const zeroRank = makePlayers(10);
  zeroRank[0].rank = 0;
  assertThrows(() => buildDailySettlement({ ...good, players: zeroRank }),
    'rank must be > 0', 'rank <= 0 rejected');

  // zero pool
  assertThrows(() => buildDailySettlement({ ...good, dailyPrizePoolLamports: 0 }),
    'must be a positive integer', 'zero pool rejected');

  // negative pool
  assertThrows(() => buildDailySettlement({ ...good, dailyPrizePoolLamports: -1 }),
    'must be a positive integer', 'negative pool rejected');

  // non-integer pool
  assertThrows(() => buildDailySettlement({ ...good, dailyPrizePoolLamports: 1.5 }),
    'must be a positive integer', 'non-integer pool rejected');

  // invalid pool kind
  assertThrows(() => buildDailySettlement({ ...good, poolKind: 4 }),
    'poolKind', 'poolKind out of range rejected');
  assertThrows(() => buildDailySettlement({ ...good, poolKind: -1 }),
    'poolKind', 'negative poolKind rejected');

  // wrong wallet length after decode
  const badWallet = makePlayers(10);
  badWallet[2].wallet = '1';                     // decodes to 1 zero byte, not 32
  assertThrows(() => buildDailySettlement({ ...good, players: badWallet }),
    'expected 32-byte pubkey', 'wallet with wrong length rejected');

  // invalid base58 char
  const badChar = makePlayers(10);
  badChar[4].wallet = '0OIl' + badChar[4].wallet.slice(4);
  assertThrows(() => buildDailySettlement({ ...good, players: badChar }),
    'invalid char', 'invalid base58 char rejected');

  // wallet missing
  const noWallet = makePlayers(10);
  delete noWallet[6].wallet;
  assertThrows(() => buildDailySettlement({ ...good, players: noWallet }),
    'base58 string', 'missing wallet rejected');

  // duplicate wallets are ALLOWED (contract permits — different leaf_index)
  const dupWallet = makePlayers(10);
  dupWallet[7].wallet = dupWallet[2].wallet;
  const artDup = buildDailySettlement({ ...good, players: dupWallet });
  assert(artDup.winnerCount === 4, 'duplicate wallets allowed (winnerCount OK)', null);
  const rootDup = Buffer.from(artDup.merkleRoot, 'hex');
  let dupOk = true;
  for (const w of artDup.winners) {
    if (!verifyProof({ leaf: Buffer.from(w.leaf, 'hex'), proof: w.proof.map(h => Buffer.from(h, 'hex')), root: rootDup })) {
      dupOk = false; break;
    }
  }
  assert(dupOk, 'duplicate-wallet proofs still verify (contract-legal)', null);
}

// ---------- test 13: byte-length invariants for preimages ------------------
section('test 13 — leaf preimage = 54 bytes, node preimage = 65 bytes');
{
  // Assemble a leaf preimage manually, count bytes, hash independently.
  const walletBytes = crypto.randomBytes(32);
  const buf = Buffer.alloc(54);
  buf.writeUInt8(0x00, 0);                          // DOMAIN_LEAF
  buf.writeUInt8(0, 1);                             // pool_kind = 0
  buf.writeBigUInt64LE(BigInt(46), 2);              // period_id
  walletBytes.copy(buf, 10);                        // winner 32 bytes at offset 10..41
  buf.writeBigUInt64LE(BigInt(17245666), 42);       // amount at offset 42..49
  buf.writeUInt32LE(0, 50);                         // leaf_index at offset 50..53
  assert(buf.length === 54, 'manually assembled leaf preimage is exactly 54 bytes', { len: buf.length });

  // Node preimage: 1 + 32 + 32 = 65
  const a = crypto.randomBytes(32);
  const b = crypto.randomBytes(32);
  const buf2 = Buffer.alloc(65);
  buf2.writeUInt8(0x01, 0);
  // lex-min first
  const cmp = Buffer.compare(a, b);
  const lo = cmp <= 0 ? a : b;
  const hi = cmp <= 0 ? b : a;
  lo.copy(buf2, 1);
  hi.copy(buf2, 33);
  assert(buf2.length === 65, 'manually assembled node preimage is exactly 65 bytes', { len: buf2.length });
}

// ---------- test 14: known-vector for leaf (independent implementation) ----
section('test 14 — known-vector: computeLeaf === manual SHA256(54-byte preimage)');
{
  // Manual leaf hash — does NOT reuse u8/u32le/u64le/sha256 helpers from builder.
  function manualLeaf(poolKind, periodId, walletBytes, amount, leafIndex) {
    const buf = Buffer.alloc(54);
    buf.writeUInt8(0x00, 0);
    buf.writeUInt8(poolKind & 0xff, 1);
    buf.writeBigUInt64LE(BigInt(periodId), 2);
    Buffer.from(walletBytes).copy(buf, 10);
    buf.writeBigUInt64LE(BigInt(amount), 42);
    buf.writeUInt32LE(leafIndex >>> 0, 50);
    return crypto.createHash('sha256').update(buf).digest();
  }
  const walletStr = makeTestWallet(0);
  const pk        = walletToPubkey(walletStr);
  const cases = [
    { poolKind: 0, periodId: 0,        amount: 1,         leafIndex: 0 },
    { poolKind: 0, periodId: 46,       amount: 17245666,  leafIndex: 0 },
    { poolKind: 1, periodId: 1,        amount: 5500000,   leafIndex: 7 },
    { poolKind: 3, periodId: 999999,   amount: 12345,     leafIndex: 65535 },
    { poolKind: 0, periodId: 1786810630, amount: 999999999, leafIndex: 4294967295 }, // u32 max
  ];
  for (const c of cases) {
    const manual = manualLeaf(c.poolKind, c.periodId, pk, c.amount, c.leafIndex);
    const built  = computeLeaf({
      poolKind:       c.poolKind,
      periodId:       BigInt(c.periodId),
      winnerPubkey:   pk,
      amountLamports: c.amount,
      leafIndex:      c.leafIndex,
    });
    assert(Buffer.compare(manual, built) === 0,
      `manualLeaf === computeLeaf  (case ${JSON.stringify(c)})`,
      { manual: manual.toString('hex'), built: built.toString('hex') });
  }
}

// ---------- test 15: known-vector for node (independent implementation) ----
section('test 15 — known-vector: combineNodes === manual SHA256(0x01 || min || max)');
{
  function manualNode(a, b) {
    const cmp = Buffer.compare(a, b);
    const lo = cmp <= 0 ? a : b;
    const hi = cmp <= 0 ? b : a;
    const buf = Buffer.alloc(65);
    buf.writeUInt8(0x01, 0);
    lo.copy(buf, 1);
    hi.copy(buf, 33);
    return crypto.createHash('sha256').update(buf).digest();
  }
  // Multiple pairs including a=b sanity (should still sort-pair fine)
  const pairs = [];
  for (let i = 0; i < 5; i++) {
    pairs.push([crypto.randomBytes(32), crypto.randomBytes(32)]);
  }
  // Deterministic pair too
  pairs.push([Buffer.alloc(32, 0x11), Buffer.alloc(32, 0x22)]);
  pairs.push([Buffer.alloc(32, 0xff), Buffer.alloc(32, 0x00)]);   // sort must swap
  for (const [a, b] of pairs) {
    const manual = manualNode(a, b);
    const built  = combineNodes(a, b);
    assert(Buffer.compare(manual, built) === 0,
      'manualNode === combineNodes',
      { a: a.toString('hex').slice(0, 8), b: b.toString('hex').slice(0, 8) });
    // Also confirm commutativity (sort-pair)
    const builtSwapped = combineNodes(b, a);
    assert(Buffer.compare(built, builtSwapped) === 0, 'combineNodes commutative', null);
  }
}

// ---------- test 16: odd-tree structural — [A,B,C] -> [H(A,B), C] ----------
section('test 16 — odd-tree structural: [A,B,C] -> [H(A,B), C], not H(C,C)');
{
  const A = crypto.createHash('sha256').update('leafA').digest();
  const B = crypto.createHash('sha256').update('leafB').digest();
  const C = crypto.createHash('sha256').update('leafC').digest();
  const layers = buildTree([A, B, C]);
  assert(layers.length === 3, 'layer count for 3 leaves = 3', { layers: layers.length });
  assert(layers[0].length === 3, 'layer[0] has 3 leaves', null);
  assert(layers[1].length === 2, 'layer[1] has 2 nodes (paired + promoted)', null);
  assert(layers[2].length === 1, 'layer[2] has root', null);

  const expectedParent0 = combineNodes(A, B);
  assert(Buffer.compare(layers[1][0], expectedParent0) === 0,
    'layer[1][0] === H(sorted(A,B))', null);
  assert(Buffer.compare(layers[1][1], C) === 0,
    'layer[1][1] === C  (unpaired promoted unchanged)', null);

  // Explicit refusal of H(C,C) convention
  const wrongSelfHash = combineNodes(C, C);
  assert(Buffer.compare(layers[1][1], wrongSelfHash) !== 0,
    'layer[1][1] is NOT H(C,C) — self-hash convention rejected', null);

  // Root check
  const expectedRoot = combineNodes(expectedParent0, C);
  assert(Buffer.compare(layers[2][0], expectedRoot) === 0,
    'root === H(sorted(H(A,B), C))', null);
}

// ---------- test 17: odd winner-count end-to-end ---------------------------
section('test 17 — odd winner counts (3, 5, 7, 9): root deterministic, proofs valid');
for (const winnerCount of [3, 5, 7, 9]) {
  // Force exact winner count via totalPlayers: winners = ceil(n*0.4)
  // Pick n so ceil(n*0.4) = winnerCount, i.e. n in ((winnerCount-1)/0.4, winnerCount/0.4]
  // For winnerCount=3: n in (5, 7.5], pick 7 -> ceil(2.8)=3 ✓
  // For winnerCount=5: pick 12 -> ceil(4.8)=5 ✓
  // For winnerCount=7: pick 17 -> ceil(6.8)=7 ✓
  // For winnerCount=9: pick 22 -> ceil(8.8)=9 ✓
  const nMap = { 3: 7, 5: 12, 7: 17, 9: 22 };
  const n = nMap[winnerCount];
  const players = makePlayers(n);
  const artA = buildDailySettlement({ periodId: 100, poolKind: 0, dailyPrizePoolLamports: poolFor(n), players });
  const artB = buildDailySettlement({ periodId: 100, poolKind: 0, dailyPrizePoolLamports: poolFor(n), players });
  assert(artA.winnerCount === winnerCount, `winnerCount=${winnerCount}`, { got: artA.winnerCount });
  assert(artA.merkleRoot === artB.merkleRoot, `root deterministic @ winners=${winnerCount}`, null);
  const root = Buffer.from(artA.merkleRoot, 'hex');
  let maxLen = 0;
  for (const w of artA.winners) {
    maxLen = Math.max(maxLen, w.proof.length);
    const ok = verifyProof({ leaf: Buffer.from(w.leaf, 'hex'), proof: w.proof.map(h => Buffer.from(h, 'hex')), root });
    assert(ok, `winners=${winnerCount} rank=${w.rank} proof verifies`, null);
  }
  assert(maxLen <= MAX_PROOF_LEN, `winners=${winnerCount} maxProofLen=${maxLen} <= ${MAX_PROOF_LEN}`, null);

  // Sibling-tamper: bump byte 0 of first winner's first proof entry (if any) -> proof breaks
  if (artA.winners[0].proof.length > 0) {
    const tamperedProof = artA.winners[0].proof.map(h => Buffer.from(h, 'hex'));
    tamperedProof[0][0] ^= 0x01;
    const ok = verifyProof({ leaf: Buffer.from(artA.winners[0].leaf, 'hex'), proof: tamperedProof, root });
    assert(!ok, `winners=${winnerCount}: tampering sibling invalidates proof`, null);
  }
}

// ---------- test 18: leaf_index convention: rank === leafIndex+1, unique, range
section('test 18 — leaf_index = rank - 1, unique, 0..winnerCount-1');
{
  const n = 500;
  const players = makePlayers(n);
  const art = buildDailySettlement({ periodId: 200, poolKind: 0, dailyPrizePoolLamports: poolFor(n), players });
  const seenIdx = new Set();
  for (const w of art.winners) {
    assert(w.rank === w.leafIndex + 1, `rank ${w.rank} === leafIndex ${w.leafIndex} + 1`, null);
    assert(w.leafIndex >= 0 && w.leafIndex < art.winnerCount,
      `leafIndex ${w.leafIndex} in [0, ${art.winnerCount})`, null);
    assert(!seenIdx.has(w.leafIndex), `leafIndex ${w.leafIndex} unique`, null);
    seenIdx.add(w.leafIndex);
  }
  assert(seenIdx.size === art.winnerCount, `all leafIndex values unique (${seenIdx.size})`, null);
}

// ---------- test 19: period_id domain separation ---------------------------
section('test 19 — same (wallet,amount,leaf_index) but different period_id => different leaf, proof invalid');
{
  const n = 100;
  const players = makePlayers(n);
  const artP1 = buildDailySettlement({ periodId: 1, poolKind: 0, dailyPrizePoolLamports: poolFor(n), players });
  const artP2 = buildDailySettlement({ periodId: 2, poolKind: 0, dailyPrizePoolLamports: poolFor(n), players });

  // Same rank => same wallet, same payout, same leaf_index — but different period_id
  for (let i = 0; i < 3; i++) {
    assert(artP1.winners[i].wallet         === artP2.winners[i].wallet,        'sanity: same wallet', null);
    assert(artP1.winners[i].payoutLamports === artP2.winners[i].payoutLamports,'sanity: same amount', null);
    assert(artP1.winners[i].leafIndex      === artP2.winners[i].leafIndex,     'sanity: same leaf_index', null);
    assert(artP1.winners[i].leaf           !== artP2.winners[i].leaf,          `rank ${i+1}: different leaf across period`, null);
  }
  assert(artP1.merkleRoot !== artP2.merkleRoot, 'different roots', null);

  // Proof for period 1 does not verify against period 2 root
  const w = artP1.winners[0];
  const p2Root = Buffer.from(artP2.merkleRoot, 'hex');
  const ok = verifyProof({ leaf: Buffer.from(w.leaf, 'hex'), proof: w.proof.map(h => Buffer.from(h, 'hex')), root: p2Root });
  assert(!ok, 'cross-period proof rejected', null);
}

// ---------- test 20: pool_kind domain separation ---------------------------
section('test 20 — same (wallet,amount,period,leaf_index) but different pool_kind => different leaf');
{
  const walletStr = makeTestWallet(42);
  const pk = walletToPubkey(walletStr);
  const leafDaily   = computeLeaf({ poolKind: 0, periodId: 10n, winnerPubkey: pk, amountLamports: 12345, leafIndex: 0 });
  const leafWeekly  = computeLeaf({ poolKind: 1, periodId: 10n, winnerPubkey: pk, amountLamports: 12345, leafIndex: 0 });
  const leafJackpot = computeLeaf({ poolKind: 3, periodId: 10n, winnerPubkey: pk, amountLamports: 12345, leafIndex: 0 });
  assert(Buffer.compare(leafDaily, leafWeekly)  !== 0, 'daily leaf !== weekly leaf', null);
  assert(Buffer.compare(leafDaily, leafJackpot) !== 0, 'daily leaf !== jackpot leaf', null);
  assert(Buffer.compare(leafWeekly, leafJackpot) !== 0, 'weekly leaf !== jackpot leaf', null);
}

// ---------- test 21: amount +1 lamport => different leaf, proof invalid ----
section('test 21 — amount ±1 lamport => different leaf');
{
  const walletStr = makeTestWallet(7);
  const pk = walletToPubkey(walletStr);
  const base = computeLeaf({ poolKind: 0, periodId: 5n, winnerPubkey: pk, amountLamports: 10000000, leafIndex: 3 });
  const bumped = computeLeaf({ poolKind: 0, periodId: 5n, winnerPubkey: pk, amountLamports: 10000001, leafIndex: 3 });
  assert(Buffer.compare(base, bumped) !== 0, 'amount+1 changes leaf', null);
}

// ---------- test 22: leaf_index +1 => different leaf ----------------------
section('test 22 — leaf_index ±1 => different leaf');
{
  const walletStr = makeTestWallet(7);
  const pk = walletToPubkey(walletStr);
  const base   = computeLeaf({ poolKind: 0, periodId: 5n, winnerPubkey: pk, amountLamports: 10000000, leafIndex: 3 });
  const bumped = computeLeaf({ poolKind: 0, periodId: 5n, winnerPubkey: pk, amountLamports: 10000000, leafIndex: 4 });
  assert(Buffer.compare(base, bumped) !== 0, 'leaf_index+1 changes leaf', null);
}

// ---------- test 23: root sensitivity to single wallet / payout change -----
section('test 23 — root sensitivity: swap 1 wallet, tweak 1 leaf amount');
{
  const n = 200;
  const players = makePlayers(n);
  const artBase = buildDailySettlement({ periodId: 55, poolKind: 0, dailyPrizePoolLamports: poolFor(n), players });

  // Case A: replace wallet of rank 42
  const playersMod = players.map(p => ({ ...p }));
  playersMod[41].wallet = makeTestWallet(99999);
  const artMod = buildDailySettlement({ periodId: 55, poolKind: 0, dailyPrizePoolLamports: poolFor(n), players: playersMod });
  assert(artBase.merkleRoot !== artMod.merkleRoot, 'root changes when 1 winner wallet changes', null);

  // Case B: rebuild tree with 1 leaf's amount tweaked by 1 lamport at helper level
  //         (bypasses payout engine; direct Merkle-level sensitivity check)
  const leaves = artBase.winners.map(w => Buffer.from(w.leaf, 'hex'));
  const layers1 = buildTree(leaves);
  const root1 = layers1[layers1.length - 1][0];

  const tamperedLeaf = computeLeaf({
    poolKind:       0,
    periodId:       55n,
    winnerPubkey:   walletToPubkey(artBase.winners[10].wallet),
    amountLamports: artBase.winners[10].payoutLamports + 1,   // +1 lamport
    leafIndex:      artBase.winners[10].leafIndex,
  });
  const leaves2 = leaves.slice();
  leaves2[10] = tamperedLeaf;
  const layers2 = buildTree(leaves2);
  const root2 = layers2[layers2.length - 1][0];
  assert(Buffer.compare(root1, root2) !== 0, 'root changes when 1 leaf amount changes by 1 lamport', null);
}

// ---------- test 24: BigInt / MAX_SAFE_INTEGER fail-fast -------------------
section('test 24 — Number.MAX_SAFE_INTEGER guard (fail-fast, not silent precision loss)');
{
  const players = makePlayers(50);
  const good = { periodId: 1, poolKind: 0, dailyPrizePoolLamports: poolFor(50), players };

  // BigInt periodId is accepted (any u64 range value)
  const artBig = buildDailySettlement({ ...good, periodId: 18446744073709551610n });   // near u64 max
  assert(artBig.periodId === '18446744073709551610', 'BigInt periodId accepted and stringified in artifact', null);

  // Number periodId at or below MAX_SAFE_INTEGER is accepted
  buildDailySettlement({ ...good, periodId: Number.MAX_SAFE_INTEGER });    // 2^53-1, accepted
  assert(true, 'Number periodId = MAX_SAFE_INTEGER accepted', null);

  // Number periodId above MAX_SAFE_INTEGER is REFUSED (silent precision loss guard)
  const unsafePeriod = Number.MAX_SAFE_INTEGER + 100;
  assertThrows(() => buildDailySettlement({ ...good, periodId: unsafePeriod }),
    'MAX_SAFE_INTEGER', 'Number periodId > MAX_SAFE_INTEGER refused');

  // Same for dailyPrizePoolLamports as Number
  const unsafePool = Number.MAX_SAFE_INTEGER + 100;
  assertThrows(() => buildDailySettlement({ ...good, dailyPrizePoolLamports: unsafePool }),
    'MAX_SAFE_INTEGER', 'Number pool > MAX_SAFE_INTEGER refused');

  // BigInt in dailyPrizePoolLamports is NOT accepted (design: pool goes through payout engine which is Number-only)
  assertThrows(() => buildDailySettlement({ ...good, dailyPrizePoolLamports: 1_000_000n }),
    'must be a positive integer', 'BigInt pool refused (engine is Number-only)');
}

// ---------- summary --------------------------------------------------------
console.log('\n== summary ==');
console.log(`assertions: pass=${passed} fail=${failed}`);
if (failed > 0) {
  console.log('\nfailures:');
  for (const f of failures) console.log('  -', f.label, f.ctx == null ? '' : JSON.stringify(f.ctx));
  process.exit(1);
}
