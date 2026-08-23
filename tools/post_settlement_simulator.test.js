// Tests for tools/post_settlement_simulator.js — pure + mock-conn tests.
// No network calls, no WSL calls, no signing on real keypair.

'use strict';

const { Keypair, PublicKey, SystemProgram } = require('@solana/web3.js');
const {
  COPPER_PROGRAM_ID, COPPER_PROGRAM_ID_STR,
  POST_SETTLEMENT_DISCRIMINATOR, sighash,
  serializePostSettlementArgs,
  derivePdas,
  decodeConfig, decodePending,
  validateArtifact,
  preflight, buildIx,
} = require('./post_settlement_simulator.js');

let passed = 0, failed = 0;
const failures = [];
function assert(cond, label, ctx) {
  if (cond) { passed++; return; }
  failed++;
  failures.push({ label, ctx });
  console.log(`  FAIL: ${label}` + (ctx ? '  ' + JSON.stringify(ctx) : ''));
}
async function assertRejects(promise, matchSubstr, label) {
  try { await promise; assert(false, `${label} — expected reject (${matchSubstr})`, null); }
  catch (e) {
    const msg = String(e && e.message);
    if (msg.includes(matchSubstr)) assert(true, `${label} — rejected (${matchSubstr})`);
    else assert(false, `${label} — wrong error`, { expected: matchSubstr, got: msg });
  }
}
function section(name) { console.log('\n== ' + name + ' =='); }

// ---------- test 1: discriminator = sha256('global:post_settlement')[:8] ---
section('test 1 — discriminator = sha256("global:post_settlement").slice(0, 8)');
{
  // Verify sighash helper against a known Anchor sighash for a familiar
  // instruction we can double-check: seal_period discriminator is documented
  // in copper-beta.html:8441 as [57, 58, 43, 157, 104, 77, 163, 91].
  const seal = sighash('global:seal_period');
  assert(seal.equals(Buffer.from([57, 58, 43, 157, 104, 77, 163, 91])),
    'sighash("global:seal_period") matches copper-beta.html:8441 constant',
    { got: Array.from(seal) });

  // Length + type of post_settlement discriminator
  assert(POST_SETTLEMENT_DISCRIMINATOR.length === 8, 'discriminator is 8 bytes', null);
  assert(Buffer.isBuffer(POST_SETTLEMENT_DISCRIMINATOR), 'discriminator is a Buffer', null);
  // Recompute and compare (belt + suspenders: exported constant equals fresh recomputation)
  const fresh = sighash('global:post_settlement');
  assert(POST_SETTLEMENT_DISCRIMINATOR.equals(fresh), 'exported constant === fresh recomputation', null);
  console.log(`  hex(post_settlement): ${POST_SETTLEMENT_DISCRIMINATOR.toString('hex')}`);
}

// ---------- test 2: serialize post_settlement args, byte-perfect layout ----
section('test 2 — serializePostSettlementArgs: 61 bytes, exact field layout');
{
  const merkle = Buffer.alloc(32, 0xab);
  const buf = serializePostSettlementArgs({
    pool_kind:    0,
    period_id:    64n,
    merkle_root:  merkle,
    total_payout: 5_500_000n,
    num_winners:  1,
  });
  assert(buf.length === 61, 'ix data length = 61 bytes', { len: buf.length });
  assert(buf.subarray(0, 8).equals(POST_SETTLEMENT_DISCRIMINATOR), 'discriminator at offset 0..8', null);
  assert(buf.readUInt8(8) === 0, 'pool_kind at offset 8', null);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  assert(dv.getBigUint64(9, true) === 64n, 'period_id u64 LE at offset 9', null);
  assert(buf.subarray(17, 49).equals(merkle), 'merkle_root [32] at offset 17..49', null);
  assert(dv.getBigUint64(49, true) === 5_500_000n, 'total_payout u64 LE at offset 49', null);
  assert(dv.getUint32(57, true) === 1, 'num_winners u32 LE at offset 57', null);

  // Validation guards
  try { serializePostSettlementArgs({ pool_kind: -1, period_id: 0, merkle_root: merkle, total_payout: 1n, num_winners: 1 }); assert(false, 'negative pool_kind should throw'); }
  catch (e) { assert(String(e.message).includes('pool_kind'), 'pool_kind guard', null); }
  try { serializePostSettlementArgs({ pool_kind: 0, period_id: 0, merkle_root: Buffer.alloc(31), total_payout: 1n, num_winners: 1 }); assert(false, 'wrong merkle length'); }
  catch (e) { assert(String(e.message).includes('merkle_root'), 'merkle length guard', null); }
  try { serializePostSettlementArgs({ pool_kind: 0, period_id: -1, merkle_root: merkle, total_payout: 1n, num_winners: 1 }); assert(false, 'negative period_id'); }
  catch (e) { assert(String(e.message).includes('period_id'), 'period_id guard', null); }
}

// ---------- test 3: PDA derivation reproduces on-chain V2 pubkeys ---------
section('test 3 — derivePdas: config + vault_state match on-chain V2');
{
  const p0 = derivePdas({ poolKind: 0, periodId: 64n });
  // Verified on-chain (V2):
  const expectedConfig    = 'HfqkneZ5xtekKKNMjVKpXb6kAzfhaKVraikSR7f8YAAp';
  const expectedVsDaily   = '4oRyLU9ajheaJM8dz61pSknYBiDRrULw8f964PxhzFE4';
  assert(p0.config.toBase58()     === expectedConfig, 'config PDA', { got: p0.config.toBase58(), expected: expectedConfig });
  assert(p0.vaultState.toBase58() === expectedVsDaily,'vaultState PDA (DAILY)', { got: p0.vaultState.toBase58(), expected: expectedVsDaily });
  // Pending + period differ per periodId; test determinism by re-deriving
  const p0b = derivePdas({ poolKind: 0, periodId: 64n });
  assert(p0.pending.equals(p0b.pending), 'pending PDA deterministic across calls', null);
  assert(p0.period.equals(p0b.period),   'period PDA deterministic across calls', null);

  // Different periodId gives different pending / period
  const p1 = derivePdas({ poolKind: 0, periodId: 65n });
  assert(!p0.pending.equals(p1.pending), 'pending PDA changes with periodId', null);
  assert(!p0.period.equals(p1.period),   'period PDA changes with periodId',  null);

  // Different poolKind gives different vault_state
  const pW = derivePdas({ poolKind: 1, periodId: 64n });
  assert(!p0.vaultState.equals(pW.vaultState), 'vault_state PDA differs by poolKind', null);
  assert(pW.vaultState.toBase58() === 'DZyKiMBbwDHZGbwweHmvhe8JsaDkDtAUG4hEBDR5qvYo', 'WEEKLY vault_state match', null);

  // Guard
  try { derivePdas({ poolKind: 4, periodId: 0 }); assert(false, 'poolKind=4 should throw'); }
  catch (e) { assert(String(e.message).includes('poolKind'), 'poolKind range guard', null); }
}

// ---------- test 4: validateArtifact --------------------------------------
section('test 4 — validateArtifact accepts good, rejects bad');
{
  const good = { poolKind: 0, periodId: 64, merkleRoot: 'ab'.repeat(32), winnerCount: 1, totalPayoutLamports: 5_500_000 };
  assert(validateArtifact(good) === true, 'good artifact passes', null);

  const cases = [
    [{ ...good, poolKind: 4 },                       'poolKind'],
    [{ ...good, periodId: null },                    'periodId'],
    [{ ...good, merkleRoot: 'nothex' },              'merkleRoot'],
    [{ ...good, merkleRoot: '00'.repeat(32) },       'all zeros'],
    [{ ...good, winnerCount: 0 },                    'winnerCount'],
    [{ ...good, winnerCount: -1 },                   'winnerCount'],
    [{ ...good, totalPayoutLamports: 0 },            'totalPayoutLamports'],
    [{ ...good, totalPayoutLamports: 1.5 },          'totalPayoutLamports'],
  ];
  for (const [bad, msgFrag] of cases) {
    try { validateArtifact(bad); assert(false, `bad artifact rejected: ${msgFrag}`, bad); }
    catch (e) { assert(String(e.message).includes(msgFrag), `rejects ${msgFrag}`, { got: e.message }); }
  }
}

// ---------- test 5: decodeConfig / decodePending against synthetic layouts -
section('test 5 — decoders round-trip against synthetic byte layouts');
{
  // Config synthetic (210 bytes)
  const cfg = Buffer.alloc(210);
  const admin = Keypair.generate().publicKey;
  const treasury = Keypair.generate().publicKey;
  const dev = Keypair.generate().publicKey;
  const burn = Keypair.generate().publicKey;
  const pending_admin = Keypair.generate().publicKey;
  admin.toBuffer().copy(cfg, 8);
  treasury.toBuffer().copy(cfg, 40);
  dev.toBuffer().copy(cfg, 72);
  burn.toBuffer().copy(cfg, 104);
  cfg.writeBigUInt64LE(10_000_000n, 136);
  cfg[144] = 0;   // paused = false
  cfg[145] = 255; // bump
  pending_admin.toBuffer().copy(cfg, 146);
  const dc = decodeConfig(cfg);
  assert(dc.admin.equals(admin),         'config.admin decoded', null);
  assert(dc.treasury.equals(treasury),   'config.treasury decoded', null);
  assert(dc.entry_fee === 10_000_000n,   'config.entry_fee decoded', null);
  assert(dc.paused === false,            'config.paused false', null);
  assert(dc.bump === 255,                'config.bump 255', null);
  assert(dc.pending_admin.equals(pending_admin), 'config.pending_admin decoded', null);

  // Pending synthetic (98 bytes)
  const pend = Buffer.alloc(98);
  pend[8] = 0; pend[9] = 254;
  pend.writeBigUInt64LE(64n, 10);
  pend.writeBigUInt64LE(5_500_000n, 18);
  const rentPayer = Keypair.generate().publicKey;
  rentPayer.toBuffer().copy(pend, 26);
  pend.writeBigInt64LE(1_787_430_811n, 58);
  const dp = decodePending(pend);
  assert(dp.pool_kind === 0, 'pool_kind', null);
  assert(dp.period_id === 64n, 'period_id', null);
  assert(dp.total_collected === 5_500_000n, 'total_collected', null);
  assert(dp.rent_payer.equals(rentPayer), 'rent_payer decoded', null);
  assert(dp.sealed_at === 1_787_430_811n, 'sealed_at decoded', null);
}

// ---------- test 6: preflight — admin mismatch, payout mismatch, already-settled
section('test 6 — preflight guards: admin, payout, already-settled, missing pending');
(async () => {
  const admin = Keypair.generate();
  const wrongAdmin = Keypair.generate();
  const rentPayer  = Keypair.generate();
  const goodArtifact = {
    poolKind: 0, periodId: 64n,
    merkleRoot: 'ab'.repeat(32),
    winnerCount: 1,
    totalPayoutLamports: 5_500_000,
  };

  // Helper: build a mock connection returning specified accounts
  function mockConn({ config, pending, period }) {
    return {
      async getAccountInfo(pk /*, commitment */) {
        const s = pk.toBase58();
        if (config && s === config.pk) return { data: config.data };
        if (pending && s === pending.pk) return { data: pending.data };
        if (period && s === period.pk) return { data: period.data };
        return null;
      },
    };
  }

  // Precompute PDAs
  const pdas = derivePdas({ poolKind: 0, periodId: 64n });

  function buildConfigBuf(adminPubkey) {
    const b = Buffer.alloc(210);
    adminPubkey.toBuffer().copy(b, 8);
    // rest zeros — acceptable for decoder
    return b;
  }
  function buildPendingBuf({ total_collected, rent_payer_pk }) {
    const b = Buffer.alloc(98);
    b[8] = 0; b[9] = 255;
    b.writeBigUInt64LE(64n, 10);
    b.writeBigUInt64LE(BigInt(total_collected), 18);
    rent_payer_pk.toBuffer().copy(b, 26);
    b.writeBigInt64LE(0n, 58);
    return b;
  }

  // 6a: admin mismatch
  {
    const conn = mockConn({
      config:  { pk: pdas.config.toBase58(),  data: buildConfigBuf(wrongAdmin.publicKey) },
      pending: { pk: pdas.pending.toBase58(), data: buildPendingBuf({ total_collected: 5_500_000, rent_payer_pk: rentPayer.publicKey }) },
    });
    await assertRejects(
      preflight({ conn, admin, artifact: goodArtifact }),
      'admin mismatch', '6a admin mismatch throws',
    );
  }

  // 6b: payout mismatch
  {
    const conn = mockConn({
      config:  { pk: pdas.config.toBase58(),  data: buildConfigBuf(admin.publicKey) },
      pending: { pk: pdas.pending.toBase58(), data: buildPendingBuf({ total_collected: 999, rent_payer_pk: rentPayer.publicKey }) },
    });
    await assertRejects(
      preflight({ conn, admin, artifact: goodArtifact }),
      'payout mismatch', '6b payout mismatch throws',
    );
  }

  // 6c: already-settled (period PDA exists)
  {
    const conn = mockConn({
      config:  { pk: pdas.config.toBase58(),  data: buildConfigBuf(admin.publicKey) },
      pending: { pk: pdas.pending.toBase58(), data: buildPendingBuf({ total_collected: 5_500_000, rent_payer_pk: rentPayer.publicKey }) },
      period:  { pk: pdas.period.toBase58(),  data: Buffer.alloc(115) },
    });
    await assertRejects(
      preflight({ conn, admin, artifact: goodArtifact }),
      'already been settled', '6c already-settled throws',
    );
  }

  // 6d: missing PendingSettlement
  {
    const conn = mockConn({
      config: { pk: pdas.config.toBase58(),  data: buildConfigBuf(admin.publicKey) },
    });
    await assertRejects(
      preflight({ conn, admin, artifact: goodArtifact }),
      'PendingSettlement not found', '6d missing pending throws',
    );
  }

  // 6e: happy-path preflight returns pdas + cfg + pending
  {
    const conn = mockConn({
      config:  { pk: pdas.config.toBase58(),  data: buildConfigBuf(admin.publicKey) },
      pending: { pk: pdas.pending.toBase58(), data: buildPendingBuf({ total_collected: 5_500_000, rent_payer_pk: rentPayer.publicKey }) },
    });
    const res = await preflight({ conn, admin, artifact: goodArtifact });
    assert(res.pdas.config.equals(pdas.config), '6e preflight OK config', null);
    assert(res.cfg.admin.equals(admin.publicKey), '6e preflight OK admin', null);
    assert(res.pending.total_collected === 5_500_000n, '6e preflight OK total_collected', null);
    assert(res.pending.rent_payer.equals(rentPayer.publicKey), '6e preflight OK rent_payer', null);
  }

  // ---------- test 7: buildIx produces exact 7-account ix ------------------
  section('test 7 — buildIx account list order + signer/writable flags');
  {
    const ix = buildIx({
      artifact: goodArtifact,
      admin,
      pdas,
      rent_payer: rentPayer.publicKey,
    });
    assert(ix.programId.equals(COPPER_PROGRAM_ID), 'programId = COPPER_PROGRAM_ID', null);
    assert(ix.keys.length === 7, 'exactly 7 accounts', { got: ix.keys.length });
    const expected = [
      { pk: admin.publicKey,             isSigner: true,  isWritable: true  },
      { pk: pdas.config,                 isSigner: false, isWritable: false },
      { pk: pdas.vaultState,             isSigner: false, isWritable: true  },
      { pk: pdas.pending,                isSigner: false, isWritable: true  },
      { pk: pdas.period,                 isSigner: false, isWritable: true  },
      { pk: rentPayer.publicKey,         isSigner: false, isWritable: true  },
      { pk: SystemProgram.programId,     isSigner: false, isWritable: false },
    ];
    for (let i = 0; i < 7; i++) {
      assert(ix.keys[i].pubkey.equals(expected[i].pk),          `keys[${i}] pubkey`, { got: ix.keys[i].pubkey.toBase58() });
      assert(ix.keys[i].isSigner === expected[i].isSigner,      `keys[${i}] isSigner=${expected[i].isSigner}`, null);
      assert(ix.keys[i].isWritable === expected[i].isWritable,  `keys[${i}] isWritable=${expected[i].isWritable}`, null);
    }
    assert(ix.data.length === 61, 'ix data length 61 bytes', null);
    assert(ix.data.subarray(0, 8).equals(POST_SETTLEMENT_DISCRIMINATOR), 'ix data starts with discriminator', null);
  }

  // ---------- summary ------------------------------------------------------
  console.log('\n== summary ==');
  console.log(`assertions: pass=${passed} fail=${failed}`);
  if (failed > 0) {
    console.log('\nfailures:');
    for (const f of failures) console.log('  -', f.label, f.ctx == null ? '' : JSON.stringify(f.ctx));
    process.exit(1);
  }
})();
