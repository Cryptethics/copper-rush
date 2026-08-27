// Paid V1 post_settlement SENDER — real broadcast on devnet.
//
// Reuses the validated pure helpers from post_settlement_simulator.js
// (loadKeypairFromWsl, derivePdas, buildIx, preflight, decoders). This
// module adds: strict preflight -> simulate -> broadcast ONE tx ->
// confirm -> refetch + verify.
//
// Cluster is restricted to `devnet` here; broadcasting to mainnet requires
// deliberate code change (never accidental via CLI flag).
//
// Security: admin secret is loaded via `wsl bash -lc 'cat ...'`, kept only
// inside a transient Uint8Array passed to Keypair.fromSecretKey, and never
// printed. Only the public key is ever displayed.

'use strict';

const fs = require('fs');
const {
  Connection, Transaction, sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {
  CLUSTERS,
  loadKeypairFromWsl, derivePdas, buildIx,
  preflight, validateArtifact,
  decodePending,
} = require('./post_settlement_simulator.js');
const { fetchVaultState } = require('./copper_rpc_reader.js');

const CLUSTER = 'devnet';   // restricted; do not parameterize

// ---------- CLI parsing ----------------------------------------------------

function parseArgs(argv) {
  const out = { artifact: null, keypairWsl: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '--artifact')    out.artifact   = argv[++i];
    else if (a === '--keypair-wsl') out.keypairWsl = argv[++i];
    else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
    else { console.error(`unknown arg: ${a}`); printHelp(); process.exit(1); }
  }
  return out;
}
function printHelp() {
  console.log(`Usage:
  node tools/post_settlement_sender.js \\
    --artifact <path.json> \\
    --keypair-wsl <wsl path to Solana JSON keypair>
Cluster is fixed to devnet. Broadcasts ONE post_settlement tx.`);
}

function hdr(s) { console.log('\n== ' + s + ' =='); }
function sol(lamports) { return (Number(lamports) / 1e9).toFixed(9) + ' SOL'; }

// ---------- send flow ------------------------------------------------------

async function sendPostSettlement({ conn, admin, artifact }) {
  // 1. Preflight — reused pure helper. Throws on any mismatch.
  const { pdas, cfg, pending } = await preflight({ conn, admin, artifact });

  // 2. Snapshot PRE state of VaultState.
  const preVs = await fetchVaultState(CLUSTER, artifact.poolKind);
  if (!preVs) throw new Error('PRE VaultState fetch returned null');
  const preAwaiting     = preVs.decoded.awaiting_settlement_total;
  const preObligations  = preVs.decoded.obligations_lamports;

  // 3. Build the ix + tx. sendAndConfirmTransaction will set recentBlockhash,
  //    sign with the provided signer, broadcast, and confirm — all in one call.
  const ix = buildIx({ artifact, admin, pdas, rent_payer: pending.rent_payer });
  const tx = new Transaction().add(ix);
  tx.feePayer = admin.publicKey;

  // 4. Simulate — abort on error. Set blockhash for the simulation only;
  //    sendAndConfirmTransaction will fetch a fresh one before broadcast.
  const { blockhash: simBlockhash } = await conn.getLatestBlockhash('finalized');
  tx.recentBlockhash = simBlockhash;
  tx.sign(admin);
  console.log('\n-- simulate (final gate before broadcast) --');
  const sim = await conn.simulateTransaction(tx);
  console.log(`  err:            ${JSON.stringify(sim.value.err)}`);
  console.log(`  units_consumed: ${sim.value.unitsConsumed}`);
  if (sim.value.err) {
    console.log('  logs:');
    for (const l of sim.value.logs || []) console.log(`    | ${l}`);
    throw new Error(`simulate failed: ${JSON.stringify(sim.value.err)}`);
  }

  // 5. Broadcast + confirm via the well-tested helper.
  console.log('\n-- broadcasting --');
  const freshTx = new Transaction().add(ix);
  freshTx.feePayer = admin.publicKey;
  const signature = await sendAndConfirmTransaction(conn, freshTx, [admin], {
    commitment: 'finalized',
    preflightCommitment: 'finalized',
  });
  console.log(`  signature: ${signature}`);
  console.log(`  explorer:  https://explorer.solana.com/tx/${signature}?cluster=${CLUSTER}`);
  console.log(`  confirmed (finalized)`);

  // 7. Refetch on-chain state + verify.
  hdr('POST-SEND VERIFICATION');
  const [periodInfo, pendingInfoAfter, postVs] = await Promise.all([
    conn.getAccountInfo(pdas.period,  'finalized'),
    conn.getAccountInfo(pdas.pending, 'finalized'),
    fetchVaultState(CLUSTER, artifact.poolKind),
  ]);

  const errs = [];

  if (!periodInfo) errs.push(`Period PDA missing after send: ${pdas.period.toBase58()}`);
  else {
    // Decode Period inline (same layout as copper_rpc_reader.decodePeriod)
    const buf = periodInfo.data;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let off = 8;
    const pool_kind    = buf[off++]; /* bump= */ off++;
    const period_id    = dv.getBigUint64(off, true); off += 8;
    const merkle_root  = Buffer.from(buf.subarray(off, off + 32)).toString('hex'); off += 32;
    const total_payout = dv.getBigUint64(off, true); off += 8;
    /* claimed_so_far= */ dv.getBigUint64(off, true); off += 8;
    const num_winners  = dv.getUint32(off, true); off += 4;
    console.log(`  Period.pool_kind:    ${pool_kind}     (expected ${artifact.poolKind})`);
    console.log(`  Period.period_id:    ${period_id}    (expected ${artifact.periodId})`);
    console.log(`  Period.merkle_root:  ${merkle_root}`);
    console.log(`                       expected: ${artifact.merkleRoot}`);
    console.log(`  Period.total_payout: ${total_payout}  (expected ${artifact.totalPayoutLamports})`);
    console.log(`  Period.num_winners:  ${num_winners}   (expected ${artifact.winnerCount})`);
    if (pool_kind !== artifact.poolKind)                        errs.push('Period.pool_kind mismatch');
    if (Number(period_id) !== Number(artifact.periodId))        errs.push('Period.period_id mismatch');
    if (merkle_root.toLowerCase() !== artifact.merkleRoot.toLowerCase()) errs.push('Period.merkle_root mismatch');
    if (Number(total_payout) !== artifact.totalPayoutLamports)  errs.push('Period.total_payout mismatch');
    if (num_winners !== artifact.winnerCount)                   errs.push('Period.num_winners mismatch');
  }

  if (pendingInfoAfter) errs.push(`PendingSettlement PDA still exists after send: ${pdas.pending.toBase58()}`);
  else console.log(`  PendingSettlement 64: CLOSED (account no longer exists)`);

  if (!postVs) errs.push('POST VaultState fetch returned null');
  else {
    const postAwaiting    = postVs.decoded.awaiting_settlement_total;
    const postObligations = postVs.decoded.obligations_lamports;
    const awaitingDelta    = postAwaiting    - preAwaiting;         // BigInt arithmetic
    const obligationsDelta = postObligations - preObligations;
    const expectedDelta = BigInt(artifact.totalPayoutLamports);
    console.log(`  VaultState.awaiting_settlement_total PRE:  ${preAwaiting}`);
    console.log(`  VaultState.awaiting_settlement_total POST: ${postAwaiting}   delta=${awaitingDelta}   (expected -${expectedDelta})`);
    console.log(`  VaultState.obligations_lamports      PRE:  ${preObligations}`);
    console.log(`  VaultState.obligations_lamports      POST: ${postObligations}  delta=+${obligationsDelta}  (expected +${expectedDelta})`);
    if (awaitingDelta    !== -expectedDelta) errs.push(`awaiting delta wrong: got ${awaitingDelta}, expected -${expectedDelta}`);
    if (obligationsDelta !==  expectedDelta) errs.push(`obligations delta wrong: got +${obligationsDelta}, expected +${expectedDelta}`);
  }

  if (errs.length > 0) {
    console.log('\n== VERIFICATION FAILURES ==');
    for (const e of errs) console.log(`  - ${e}`);
    throw new Error('post-send verification failed');
  }

  return {
    signature,
    pdas: {
      period:  pdas.period.toBase58(),
      pending: pdas.pending.toBase58(),
    },
    pre:  { awaiting: preAwaiting.toString(),  obligations: preObligations.toString()  },
  };
}

module.exports = { sendPostSettlement, CLUSTER };

// ---------- CLI ------------------------------------------------------------

async function cliMain() {
  const args = parseArgs(process.argv);
  if (!args.artifact || !args.keypairWsl) { printHelp(); process.exit(1); }

  const raw = fs.readFileSync(args.artifact, 'utf8');
  const artifact = JSON.parse(raw);
  if (typeof artifact.periodId === 'string') artifact.periodId = BigInt(artifact.periodId);
  else if (typeof artifact.periodId === 'number') artifact.periodId = BigInt(artifact.periodId);
  validateArtifact(artifact);

  console.log('== loaded artifact ==');
  console.log(`  cluster:             ${CLUSTER}   (hardcoded)`);
  console.log(`  poolKind:            ${artifact.poolKind}`);
  console.log(`  periodId:            ${artifact.periodId}`);
  console.log(`  winnerCount:         ${artifact.winnerCount}`);
  console.log(`  totalPayoutLamports: ${artifact.totalPayoutLamports}`);
  console.log(`  merkleRoot:          ${artifact.merkleRoot}`);

  const admin = loadKeypairFromWsl(args.keypairWsl);
  console.log(`\n== admin keypair loaded from WSL ==`);
  console.log(`  publicKey: ${admin.publicKey.toBase58()}   (secret NOT displayed)`);

  const conn = new Connection(CLUSTERS[CLUSTER], 'finalized');

  const result = await sendPostSettlement({ conn, admin, artifact });

  hdr('DONE');
  console.log(`  signature: ${result.signature}`);
  console.log(`  Period:    ${result.pdas.period}`);
  console.log(`  Pending:   ${result.pdas.pending}  (closed)`);
}

if (require.main === module) {
  cliMain().catch(e => {
    console.error('\nERROR:', e && e.message);
    process.exit(1);
  });
}
