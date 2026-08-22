// Tests for tools/copper_rpc_reader.js — pure decoders + b58 helpers only.
// Network-dependent flows (fetchVaultState, listPendingSettlements) are
// exercised by tools/paid_daily_dry_run.js during dev; not run in this suite.

'use strict';

const {
  b58Encode, b58Decode,
  decodeVaultState, decodePendingSettlement, decodePeriod,
  VAULT_STATE_LEN, PENDING_SETTLEMENT_LEN, PERIOD_LEN,
} = require('./copper_rpc_reader.js');

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

// -------- base58 roundtrip incl. leading-zero + single-zero-byte edge -------
section('test 1 — b58Encode/b58Decode roundtrip (leading-zero + single-byte)');
{
  const cases = [
    Buffer.from([0]),                     // '1'
    Buffer.from([0, 0]),                  // '11'
    Buffer.from([1]),                     // '2'
    Buffer.from([0, 1]),                  // '12'
    Buffer.from([255]),                   // ...
    Buffer.from('CKvPTWaXV9NxiSYZJM42wmRrr9ssLv3pzZnH6c1xtXCh', 'utf8').slice(0, 32),  // arbitrary 32-byte
    Buffer.alloc(32, 0xff),               // max 32-byte value
    Buffer.alloc(32, 0x00),               // all-zero 32-byte -> '11...1' (32 ones)
  ];
  for (const c of cases) {
    const enc = b58Encode(c);
    const dec = b58Decode(enc);
    assert(Buffer.compare(dec, c) === 0,
      `roundtrip len=${c.length} first=${c[0]}  enc=${enc.slice(0, 20)}`,
      { orig: c.toString('hex'), enc, dec: dec.toString('hex') });
  }
  // Direct sanity for the previously-buggy single-zero case
  assert(b58Encode(Buffer.from([0])) === '1', 'b58Encode([0]) === "1" (single leading-zero fix)', null);
  assert(b58Encode(Buffer.from([0, 0])) === '11', 'b58Encode([0,0]) === "11"', null);
}

// -------- decodeVaultState synthetic --------------------------------------
section('test 2 — decodeVaultState against a synthetic 151-byte layout');
{
  const buf = Buffer.alloc(VAULT_STATE_LEN);
  buf.writeUInt8(0x11, 0);                                    // discriminator byte 0 (irrelevant to decoder)
  // Anchor discriminator = bytes 0..7; skipped by decoder.
  let off = 8;
  buf.writeUInt8(0, off++);                                   // pool_kind = DAILY
  buf.writeUInt8(254, off++);                                 // bump
  buf.writeUInt8(253, off++);                                 // vault_bump
  buf.writeBigInt64LE(1781897667n, off); off += 8;             // epoch_zero
  buf.writeUInt32LE(86400, off); off += 4;                     // period_duration_seconds
  buf.writeBigUInt64LE(56n, off); off += 8;                    // open_period_id
  buf.writeBigUInt64LE(27_500_000n, off); off += 8;            // open_period_collected
  buf.writeBigUInt64LE(671_000_000n, off); off += 8;           // awaiting_settlement_total
  buf.writeBigUInt64LE(0n, off); off += 8;                     // obligations_lamports
  buf.writeBigUInt64LE(698_500_000n, off); off += 8;           // total_collected_lifetime
  buf.writeBigUInt64LE(0n, off); off += 8;                     // total_paid_lifetime
  buf.writeBigInt64LE(1_786_805_713n, off); off += 8;          // last_seal_at
  buf.writeBigInt64LE(0n, off); off += 8;                      // last_settlement_at
  // remainder is reserved zeros

  const d = decodeVaultState(buf);
  assert(d.pool_kind === 0,                                  'pool_kind', d);
  assert(d.bump === 254,                                     'bump', d);
  assert(d.vault_bump === 253,                               'vault_bump', d);
  assert(d.epoch_zero === 1781897667n,                       'epoch_zero', d);
  assert(d.period_duration_seconds === 86400,                'period_duration_seconds', d);
  assert(d.open_period_id === 56n,                           'open_period_id', d);
  assert(d.open_period_collected === 27_500_000n,            'open_period_collected', d);
  assert(d.awaiting_settlement_total === 671_000_000n,       'awaiting_settlement_total', d);
  assert(d.obligations_lamports === 0n,                      'obligations_lamports', d);
  assert(d.total_collected_lifetime === 698_500_000n,        'total_collected_lifetime', d);
  assert(d.total_paid_lifetime === 0n,                       'total_paid_lifetime', d);
  assert(d.last_seal_at === 1_786_805_713n,                  'last_seal_at', d);
  assert(d.last_settlement_at === 0n,                        'last_settlement_at', d);

  assertThrows(() => decodeVaultState(Buffer.alloc(100)),    'expected 151', 'length guard');
}

// -------- decodePendingSettlement synthetic --------------------------------
section('test 3 — decodePendingSettlement against a synthetic 98-byte layout');
{
  const buf = Buffer.alloc(PENDING_SETTLEMENT_LEN);
  let off = 8;
  buf.writeUInt8(0, off++);                                    // pool_kind DAILY
  buf.writeUInt8(255, off++);                                  // bump
  buf.writeBigUInt64LE(49n, off); off += 8;                    // period_id
  buf.writeBigUInt64LE(11_000_000n, off); off += 8;            // total_collected
  // rent_payer pubkey (32 bytes) — use 0x22 repeated
  Buffer.alloc(32, 0x22).copy(buf, off); off += 32;
  buf.writeBigInt64LE(1_786_805_713n, off); off += 8;          // sealed_at

  const d = decodePendingSettlement(buf);
  assert(d.pool_kind === 0,          'pool_kind', d);
  assert(d.period_id === 49n,        'period_id', d);
  assert(d.total_collected === 11_000_000n, 'total_collected', d);
  assert(d.sealed_at === 1_786_805_713n, 'sealed_at', d);
  assert(d.rent_payer.length > 0,    'rent_payer base58 non-empty', d);
  // rent_payer decoded back to raw bytes should be all 0x22
  assert(b58Decode(d.rent_payer).every(x => x === 0x22), 'rent_payer roundtrip = 0x22×32', null);

  assertThrows(() => decodePendingSettlement(Buffer.alloc(50)), 'expected 98', 'length guard');
}

// -------- decodePeriod synthetic -------------------------------------------
section('test 4 — decodePeriod against a synthetic 115-byte layout');
{
  const buf = Buffer.alloc(PERIOD_LEN);
  let off = 8;
  buf.writeUInt8(0, off++);                                    // pool_kind
  buf.writeUInt8(252, off++);                                  // bump
  buf.writeBigUInt64LE(100n, off); off += 8;                   // period_id
  Buffer.alloc(32, 0xab).copy(buf, off); off += 32;             // merkle_root
  buf.writeBigUInt64LE(1_000_000_000n, off); off += 8;         // total_payout
  buf.writeBigUInt64LE(500_000_000n, off); off += 8;           // claimed_so_far
  buf.writeUInt32LE(400, off); off += 4;                        // num_winners
  buf.writeUInt32LE(200, off); off += 4;                        // num_claimed
  buf.writeUInt8(1, off++);                                     // is_finalized
  buf.writeBigInt64LE(1_787_000_000n, off); off += 8;          // posted_at

  const d = decodePeriod(buf);
  assert(d.pool_kind === 0,                              'pool_kind', d);
  assert(d.period_id === 100n,                           'period_id', d);
  assert(d.merkle_root === 'ab'.repeat(32),              'merkle_root hex', d);
  assert(d.total_payout === 1_000_000_000n,              'total_payout', d);
  assert(d.claimed_so_far === 500_000_000n,              'claimed_so_far', d);
  assert(d.num_winners === 400,                          'num_winners', d);
  assert(d.num_claimed === 200,                          'num_claimed', d);
  assert(d.is_finalized === true,                        'is_finalized', d);
  assert(d.posted_at === 1_787_000_000n,                 'posted_at', d);

  assertThrows(() => decodePeriod(Buffer.alloc(50)), 'expected 115', 'length guard');
}

console.log('\n== summary ==');
console.log(`assertions: pass=${passed} fail=${failed}`);
if (failed > 0) process.exit(1);
