// Tests for tools/claim_cli.js pure helpers. Zero network, zero WSL, zero
// signing. Exercises: discriminator, byte serialization, PDA derivation,
// buildIx account order + flags.

'use strict';

const { PublicKey, Keypair, SystemProgram } = require('@solana/web3.js');
const {
  CLAIM_DISCRIMINATOR,
  derivePdas, deriveClaimMarker,
  serializeClaimArgs, buildIx,
} = require('./claim_cli.js');
const { sighash, COPPER_PROGRAM_ID } = require('./post_settlement_simulator.js');

let passed = 0, failed = 0;
const failures = [];
function assert(cond, label, ctx) {
  if (cond) { passed++; return; }
  failed++;
  failures.push({ label, ctx });
  console.log(`  FAIL: ${label}` + (ctx ? '  ' + JSON.stringify(ctx) : ''));
}
function assertThrows(fn, matchSubstr, label) {
  try { fn(); assert(false, `${label} — expected throw`, null); }
  catch (e) { assert(String(e.message).includes(matchSubstr), label, { got: e.message }); }
}
function section(name) { console.log('\n== ' + name + ' =='); }

// ---------- test 1: discriminator = sha256("global:claim")[:8] -----------
section('test 1 — CLAIM_DISCRIMINATOR = sha256("global:claim").slice(0, 8)');
{
  assert(Buffer.isBuffer(CLAIM_DISCRIMINATOR), 'is a Buffer', null);
  assert(CLAIM_DISCRIMINATOR.length === 8, 'length = 8', { len: CLAIM_DISCRIMINATOR.length });
  const fresh = sighash('global:claim');
  assert(CLAIM_DISCRIMINATOR.equals(fresh), 'matches fresh recomputation', null);
  // Locked value observed in production (used by the successful devnet claim):
  const LOCKED = Buffer.from([0x3e, 0xc6, 0xd6, 0xc1, 0xd5, 0x9f, 0x6c, 0xd2]);
  assert(CLAIM_DISCRIMINATOR.equals(LOCKED), 'matches locked hex 3ec6d6c1d59f6cd2', null);
}

// ---------- test 2: serializeClaimArgs byte layout (empty proof) ---------
section('test 2 — serializeClaimArgs: empty proof produces 33-byte ix data');
{
  const buf = serializeClaimArgs({
    poolKind: 0, periodId: 64n, leafIndex: 0, amount: 5_500_000n, proof: [],
  });
  assert(buf.length === 33, 'ix data length = 33 bytes', { len: buf.length });
  assert(buf.subarray(0, 8).equals(CLAIM_DISCRIMINATOR), 'discriminator at 0..8', null);
  assert(buf.readUInt8(8) === 0, 'pool_kind at offset 8', null);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  assert(dv.getBigUint64(9, true) === 64n,           'period_id u64 LE at 9', null);
  assert(dv.getUint32(17, true) === 0,               'leaf_index u32 LE at 17', null);
  assert(dv.getBigUint64(21, true) === 5_500_000n,   'amount u64 LE at 21', null);
  assert(dv.getUint32(29, true) === 0,               'proof_len u32 LE at 29 = 0', null);
  // Match the exact hex that the successful devnet claim used
  const LOCKED_HEX = '3ec6d6c1d59f6cd20040000000000000000000000060ec53000000000000000000';
  assert(buf.toString('hex') === LOCKED_HEX, 'matches recorded successful devnet claim hex', {
    got: buf.toString('hex'), expected: LOCKED_HEX,
  });
}

// ---------- test 3: serializeClaimArgs with non-empty proof --------------
section('test 3 — serializeClaimArgs: proof length + inline hashes at end');
{
  const proof = [
    Buffer.alloc(32, 0x11),
    Buffer.alloc(32, 0x22),
    Buffer.alloc(32, 0x33),
  ];
  const buf = serializeClaimArgs({
    poolKind: 1, periodId: 100n, leafIndex: 42, amount: 999_999n, proof,
  });
  // Length = 8 + 1 + 8 + 4 + 8 + 4 + 3*32 = 33 + 96 = 129 bytes
  assert(buf.length === 129, 'length = 129 (33 header + 96 proof)', { len: buf.length });
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  assert(dv.getUint32(29, true) === 3, 'proof_len = 3', null);
  assert(buf.subarray(33, 65).equals(proof[0]),  'proof[0] at 33..65', null);
  assert(buf.subarray(65, 97).equals(proof[1]),  'proof[1] at 65..97', null);
  assert(buf.subarray(97, 129).equals(proof[2]), 'proof[2] at 97..129', null);

  // Bad proof entries
  assertThrows(() => serializeClaimArgs({ poolKind: 0, periodId: 0n, leafIndex: 0, amount: 1n, proof: [Buffer.alloc(31)] }),
    '32-byte Buffers', 'proof entry wrong length rejected');
}

// ---------- test 4: derivePdas — VaultState matches on-chain V2 DAILY ----
section('test 4 — derivePdas: vaultState matches on-chain V2 pubkey');
{
  const p = derivePdas({ poolKind: 0, periodId: 64n });
  // Verified on-chain V2 pubkeys:
  assert(p.vaultState.toBase58() === '4oRyLU9ajheaJM8dz61pSknYBiDRrULw8f964PxhzFE4',
    'vaultState DAILY match', { got: p.vaultState.toBase58() });
  // Period + vault differ per params; test determinism + reactivity
  const p2 = derivePdas({ poolKind: 0, periodId: 64n });
  assert(p.period.equals(p2.period),         'period deterministic',      null);
  assert(p.vault.equals(p2.vault),           'vault deterministic',       null);
  assert(p.vaultState.equals(p2.vaultState), 'vaultState deterministic',  null);

  // periodId affects period, not vault_state or vault
  const p3 = derivePdas({ poolKind: 0, periodId: 65n });
  assert(!p.period.equals(p3.period),        'period varies with periodId',    null);
  assert(p.vault.equals(p3.vault),           'vault same across periods',      null);
  assert(p.vaultState.equals(p3.vaultState), 'vault_state same across periods', null);

  // poolKind affects vault + vault_state
  const pW = derivePdas({ poolKind: 1, periodId: 64n });
  assert(!p.vault.equals(pW.vault),           'vault varies with poolKind',      null);
  assert(!p.vaultState.equals(pW.vaultState), 'vault_state varies with poolKind', null);
  assert(pW.vaultState.toBase58() === 'DZyKiMBbwDHZGbwweHmvhe8JsaDkDtAUG4hEBDR5qvYo',
    'WEEKLY vault_state match', null);
}

// ---------- test 5: deriveClaimMarker — deterministic + reactive ---------
section('test 5 — deriveClaimMarker: deterministic; varies by leafIndex');
{
  const period = derivePdas({ poolKind: 0, periodId: 64n }).period;
  const cm0a = deriveClaimMarker({ period, leafIndex: 0 });
  const cm0b = deriveClaimMarker({ period, leafIndex: 0 });
  const cm1  = deriveClaimMarker({ period, leafIndex: 1 });
  assert(cm0a.equals(cm0b),  'deterministic across calls', null);
  assert(!cm0a.equals(cm1),  'differs by leafIndex',       null);
  // Known-good: the period-64 leaf-0 claim marker successfully created on devnet
  assert(cm0a.toBase58() === 'F59gswKjqxZG7HaexATr1oYCwiTZZVUiXGaQbjgG9Jig',
    'matches on-chain claim marker from successful devnet claim',
    { got: cm0a.toBase58() });

  // Same leafIndex, different period -> different marker
  const period2 = derivePdas({ poolKind: 0, periodId: 65n }).period;
  const cm0_p65 = deriveClaimMarker({ period: period2, leafIndex: 0 });
  assert(!cm0a.equals(cm0_p65), 'leaf 0 marker varies by period', null);
}

// ---------- test 6: buildIx — 6 accounts in spec order + correct flags ---
section('test 6 — buildIx: 6-account list matches spec §6.4');
{
  const winner = Keypair.generate().publicKey;
  const pdas = derivePdas({ poolKind: 0, periodId: 64n });
  const claimMarker = deriveClaimMarker({ period: pdas.period, leafIndex: 0 });
  const ix = buildIx({
    winnerPubkey: winner, pdas, claimMarker,
    poolKind: 0, periodId: 64n, leafIndex: 0, amount: 5_500_000n, proof: [],
  });
  assert(ix.programId.equals(COPPER_PROGRAM_ID), 'programId = COPPER_PROGRAM_ID', null);
  assert(ix.keys.length === 6, '6 accounts total', { got: ix.keys.length });
  const expected = [
    { pk: winner,                      isSigner: true,  isWritable: true  },
    { pk: pdas.period,                 isSigner: false, isWritable: true  },
    { pk: claimMarker,                 isSigner: false, isWritable: true  },
    { pk: pdas.vaultState,             isSigner: false, isWritable: true  },
    { pk: pdas.vault,                  isSigner: false, isWritable: true  },
    { pk: SystemProgram.programId,     isSigner: false, isWritable: false },
  ];
  for (let i = 0; i < 6; i++) {
    assert(ix.keys[i].pubkey.equals(expected[i].pk),         `keys[${i}] pubkey`, { got: ix.keys[i].pubkey.toBase58() });
    assert(ix.keys[i].isSigner === expected[i].isSigner,     `keys[${i}].isSigner=${expected[i].isSigner}`, null);
    assert(ix.keys[i].isWritable === expected[i].isWritable, `keys[${i}].isWritable=${expected[i].isWritable}`, null);
  }
  assert(ix.data.length === 33,                              'ix data 33 bytes (empty proof)', null);
  assert(ix.data.subarray(0, 8).equals(CLAIM_DISCRIMINATOR), 'ix data starts with claim discriminator', null);
}

// ---------- summary ------------------------------------------------------
console.log('\n== summary ==');
console.log(`assertions: pass=${passed} fail=${failed}`);
if (failed > 0) {
  console.log('\nfailures:');
  for (const f of failures) console.log('  -', f.label, f.ctx == null ? '' : JSON.stringify(f.ctx));
  process.exit(1);
}
