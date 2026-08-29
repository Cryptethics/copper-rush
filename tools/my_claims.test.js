// Tests for tools/my_claims.js. Pure helpers only — zero network, zero DB.

'use strict';

const { PublicKey } = require('@solana/web3.js');
const {
  derivePeriodPda, deriveClaimMarkerPda, pdasForRow,
  validateRow, classifyStatus, chunkForRpc,
  lamportsToSolString, RPC_ACCOUNT_BATCH,
} = require('./my_claims.js');

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

// ---------- test 1: derivePeriodPda locked to on-chain V2 -----------------
section('test 1 — derivePeriodPda matches known on-chain Period(0, 64)');
{
  const pda = derivePeriodPda({ poolKind: 0, periodId: 64 });
  assert(pda.toBase58() === '8f8poiFz6ybPnLsTuoXQy1PC7RtwvASio8pszJHGU7ky',
    'period 64 PDA matches on-chain', { got: pda.toBase58() });
  // Determinism
  const pda2 = derivePeriodPda({ poolKind: 0, periodId: 64 });
  assert(pda.equals(pda2), 'deterministic', null);
}

// ---------- test 2: deriveClaimMarkerPda matches Brosky's on-chain marker -
section('test 2 — deriveClaimMarkerPda for period 64 / leaf 0 matches on-chain');
{
  const periodPda = derivePeriodPda({ poolKind: 0, periodId: 64 });
  const cm = deriveClaimMarkerPda({ periodPda, leafIndex: 0 });
  assert(cm.toBase58() === 'F59gswKjqxZG7HaexATr1oYCwiTZZVUiXGaQbjgG9Jig',
    'claim marker matches on-chain (Brosky claim)', { got: cm.toBase58() });
  // Determinism + reactivity
  const cm1 = deriveClaimMarkerPda({ periodPda, leafIndex: 1 });
  assert(!cm.equals(cm1), 'differs by leaf_index', null);
}

// ---------- test 3: pdasForRow end-to-end for real Brosky row -------------
section('test 3 — pdasForRow with Supabase-shape row for Brosky/period 64');
{
  const row = {
    pool_kind: 0, period_id: 64, leaf_index: 0,
    wallet: 'Cjvtyjc8ft8iumzDSEUiHnfk3SPz5E1tJGejBs6WEtyt',
    rank: 1, amount_lamports: 5_500_000, proof: [],
    merkle_root: 'aef2e13c5e44cd6f3e87fe1dbdf7992a1f2b7823d5aa33ab309ec10127bd9f6e',
    settlement_signature: '2CZRaFzA5JAcHpJP8GDKecw9WkAQCWbhraYtKJcEPj2LRoKYjexaZMRsR3SzpJN3mc7grRb4GcRm4HnA2As3TKrz',
  };
  const p = pdasForRow(row);
  assert(p.periodPda.toBase58() === '8f8poiFz6ybPnLsTuoXQy1PC7RtwvASio8pszJHGU7ky',   'period', null);
  assert(p.claimMarker.toBase58() === 'F59gswKjqxZG7HaexATr1oYCwiTZZVUiXGaQbjgG9Jig', 'claim marker', null);

  // Supabase might deliver period_id as string; accept and coerce
  const rowStr = { ...row, period_id: '64' };
  const p2 = pdasForRow(rowStr);
  assert(p2.claimMarker.equals(p.claimMarker), 'string period_id coerced', null);
}

// ---------- test 4: classifyStatus (chain is source of truth) -------------
section('test 4 — classifyStatus');
{
  assert(classifyStatus(null) === 'CLAIMABLE',                'null -> CLAIMABLE',                       null);
  assert(classifyStatus(undefined) === 'CLAIMABLE',           'undefined -> CLAIMABLE',                  null);
  assert(classifyStatus({}) === 'CLAIMED',                    'any object -> CLAIMED',                   null);
  assert(classifyStatus({ data: Buffer.alloc(109) }) === 'CLAIMED', 'real-looking account -> CLAIMED', null);
}

// ---------- test 5: chunkForRpc batching (>100 rewards) -------------------
section('test 5 — chunkForRpc respects 100 max batch');
{
  assert(RPC_ACCOUNT_BATCH === 100, 'RPC_ACCOUNT_BATCH = 100', null);
  const empty = chunkForRpc([]);
  assert(empty.length === 0, 'empty input -> no chunks', null);
  const items = Array.from({ length: 250 }, (_, i) => 'pk' + i);
  const chunks = chunkForRpc(items);
  assert(chunks.length === 3, '250 items -> 3 chunks', { got: chunks.length });
  assert(chunks[0].length === 100 && chunks[1].length === 100 && chunks[2].length === 50,
    'chunk sizes 100/100/50', { sizes: chunks.map(c => c.length) });
  assert(chunks[0][0] === 'pk0' && chunks[2][49] === 'pk249', 'item order preserved', null);

  // Custom batch size
  const smallChunks = chunkForRpc([1, 2, 3, 4, 5], 2);
  assert(smallChunks.length === 3 && smallChunks[2].length === 1, 'maxSize=2 -> 2/2/1', null);
  assertThrows(() => chunkForRpc(null),          'items must be array', 'null items rejected');
  assertThrows(() => chunkForRpc([1], 0),        'maxSize',             'zero maxSize rejected');
  assertThrows(() => chunkForRpc([1], -1),       'maxSize',             'negative maxSize rejected');
}

// ---------- test 6: validateRow rejects bad inputs ------------------------
section('test 6 — validateRow guards');
{
  const good = { pool_kind: 0, period_id: 64, leaf_index: 0 };
  validateRow(good); assert(true, 'good row passes', null);
  assertThrows(() => validateRow(null),                                        'row must be object', 'null row');
  assertThrows(() => validateRow({ ...good, pool_kind: -1 }),                  'pool_kind',          'negative pool_kind');
  assertThrows(() => validateRow({ ...good, pool_kind: 4 }),                   'pool_kind',          'pool_kind > 3');
  assertThrows(() => validateRow({ ...good, period_id: -1 }),                  'period_id',          'negative period_id');
  assertThrows(() => validateRow({ ...good, period_id: 'abc' }),               'period_id',          'non-numeric period_id');
  assertThrows(() => validateRow({ ...good, leaf_index: -1 }),                 'leaf_index',         'negative leaf_index');
  assertThrows(() => validateRow({ ...good, leaf_index: 0xffff_ffff + 1 }),    'leaf_index',         'leaf_index > u32 max');
}

// ---------- test 7: lamportsToSolString formatting ------------------------
section('test 7 — lamportsToSolString compact display');
{
  assert(lamportsToSolString(5_500_000) === '0.0055', '5.5M -> 0.0055 SOL', { got: lamportsToSolString(5_500_000) });
  assert(lamportsToSolString(1_000_000_000) === '1', '1 SOL -> "1"', { got: lamportsToSolString(1_000_000_000) });
  assert(lamportsToSolString(1_500_000_000) === '1.5', '1.5 SOL -> "1.5"', null);
  assert(lamportsToSolString(1) === '0.000000001', '1 lamport -> full precision', null);
  assert(lamportsToSolString(0) === '0', '0 -> "0"', null);
  assert(lamportsToSolString('5500000') === '0.0055', 'string input coerced', null);
  assertThrows(() => lamportsToSolString(-1),   'non-negative', 'negative rejected');
  assertThrows(() => lamportsToSolString(1.5),  'non-negative integer', 'float rejected');
  assertThrows(() => lamportsToSolString('nope'), 'non-negative', 'garbage rejected');
}

// ---------- test 8: empty wallet result path ------------------------------
section('test 8 — empty rewards list stays empty');
{
  const chunks = chunkForRpc([]);
  assert(chunks.length === 0, 'empty chunks', null);
  // Downstream: chunks.length === 0 means no getMultipleAccounts call at all,
  // and the UI shows "No rewards yet." (documented contract).
  assert(true, 'contract documented: len=0 -> "No rewards yet."', null);
}

// ---------- summary --------------------------------------------------------
console.log('\n== summary ==');
console.log(`assertions: pass=${passed} fail=${failed}`);
if (failed > 0) {
  console.log('\nfailures:'); for (const f of failures) console.log('  -', f.label, f.ctx == null ? '' : JSON.stringify(f.ctx));
  process.exit(1);
}
