// Paid V1 claim CLI — winner-signed, one leaf per invocation.
//
// Two modes:
//   default            preflight + simulate only. Zero broadcast. If a
//                      --keypair-wsl is provided, verifies signer matches
//                      the winner in the artifact and runs simulation with
//                      sigVerify enabled.
//   --send             broadcast + confirm + verify. REQUIRES --keypair-wsl.
//
// Cluster is fixed to devnet.
//
// Usage:
//   node tools/claim_cli.js --artifact ./.period64.json --rank 1
//   node tools/claim_cli.js --artifact ./.period64.json --rank 1 \
//     --keypair-wsl /home/filip/.config/solana/keypairs/brosky.json
//   node tools/claim_cli.js --artifact ./.period64.json --rank 1 \
//     --keypair-wsl /home/filip/.config/solana/keypairs/brosky.json --send

'use strict';

const fs = require('fs');
const {
  Connection, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {
  COPPER_PROGRAM_ID, CLUSTERS,
  sighash, loadKeypairFromWsl, validateArtifact,
} = require('./post_settlement_simulator.js');
const { decodePeriod } = require('./copper_rpc_reader.js');

const CLUSTER = 'devnet';
const CLAIM_DISCRIMINATOR = sighash('global:claim');

const SEED_PERIOD = Buffer.from('period');
const SEED_CLAIM  = Buffer.from('claim');
const SEED_VS     = Buffer.from('vault_state');
const SEED_VAULT  = Buffer.from('vault');

const VAULT_STATE_LEN = 151;

// ---------- byte helpers ---------------------------------------------------
function u8(v)    { const b = Buffer.alloc(1); b.writeUInt8(v & 0xff, 0);     return b; }
function u32le(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0);   return b; }
function u64le(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; }

// ---------- PDA derivation -------------------------------------------------
function derivePdas({ poolKind, periodId }) {
  const pidLE = Buffer.alloc(8); pidLE.writeBigUInt64LE(BigInt(periodId));
  const poolByte = Buffer.from([poolKind & 0xff]);
  const [period]     = PublicKey.findProgramAddressSync([SEED_PERIOD, poolByte, pidLE], COPPER_PROGRAM_ID);
  const [vaultState] = PublicKey.findProgramAddressSync([SEED_VS,     poolByte],        COPPER_PROGRAM_ID);
  const [vault]      = PublicKey.findProgramAddressSync([SEED_VAULT,  poolByte],        COPPER_PROGRAM_ID);
  return { period, vaultState, vault };
}
function deriveClaimMarker({ period, leafIndex }) {
  const leafLE = Buffer.alloc(4); leafLE.writeUInt32LE(leafIndex >>> 0, 0);
  const [claimMarker] = PublicKey.findProgramAddressSync(
    [SEED_CLAIM, period.toBuffer(), leafLE],
    COPPER_PROGRAM_ID,
  );
  return claimMarker;
}

// ---------- ix data serializer --------------------------------------------
// Layout: discriminator(8) | pool_kind(1) | period_id(8 LE) | leaf_index(4 LE)
//       | amount(8 LE) | proof_len(4 LE) | proof_len * 32
function serializeClaimArgs({ poolKind, periodId, leafIndex, amount, proof }) {
  for (const p of proof) {
    if (!Buffer.isBuffer(p) || p.length !== 32) {
      throw new Error(`proof entries must be 32-byte Buffers, got ${p && p.length}`);
    }
  }
  return Buffer.concat([
    CLAIM_DISCRIMINATOR,
    u8(poolKind),
    u64le(periodId),
    u32le(leafIndex),
    u64le(amount),
    u32le(proof.length),
    ...proof,
  ]);
}

function buildIx({ winnerPubkey, pdas, claimMarker, poolKind, periodId, leafIndex, amount, proof }) {
  const data = serializeClaimArgs({ poolKind, periodId, leafIndex, amount, proof });
  const keys = [
    { pubkey: winnerPubkey,           isSigner: true,  isWritable: true  },
    { pubkey: pdas.period,            isSigner: false, isWritable: true  },
    { pubkey: claimMarker,            isSigner: false, isWritable: true  },
    { pubkey: pdas.vaultState,        isSigner: false, isWritable: true  },
    { pubkey: pdas.vault,             isSigner: false, isWritable: true  },
    { pubkey: SystemProgram.programId,isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: COPPER_PROGRAM_ID, keys, data });
}

// ---------- VaultState decoder (subset needed here) -----------------------
function decodeVaultStateSubset(buf) {
  if (buf.length !== VAULT_STATE_LEN) throw new Error(`VaultState: expected ${VAULT_STATE_LEN} bytes, got ${buf.length}`);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    pool_kind:                 buf[8],
    vault_bump:                buf[10],
    awaiting_settlement_total: dv.getBigUint64(31 + 8, true),  // offset 39
    obligations_lamports:      dv.getBigUint64(39 + 8, true),  // offset 47
    total_paid_lifetime:       dv.getBigUint64(55 + 8, true),  // offset 63
  };
}

// ---------- preflight ------------------------------------------------------
async function preflight({ conn, artifact, rank, winnerPubkey }) {
  validateArtifact(artifact);

  const winners = artifact.winners;
  if (!Array.isArray(winners) || winners.length !== artifact.winnerCount) {
    throw new Error('artifact.winners malformed');
  }
  const w = winners.find(x => x.rank === rank);
  if (!w) throw new Error(`no winner with rank=${rank}`);
  if (typeof w.wallet !== 'string' || typeof w.leafIndex !== 'number' || typeof w.payoutLamports !== 'number' || !Array.isArray(w.proof)) {
    throw new Error(`winner entry malformed at rank=${rank}`);
  }

  const artifactWinnerPubkey = new PublicKey(w.wallet);
  const claimingPubkey = winnerPubkey || artifactWinnerPubkey;   // fallback for keyless preflight

  if (winnerPubkey && !winnerPubkey.equals(artifactWinnerPubkey)) {
    throw new Error(`signer mismatch: keypair=${winnerPubkey.toBase58()} vs artifact.wallet=${w.wallet}`);
  }

  const poolKind = artifact.poolKind;
  const periodId = typeof artifact.periodId === 'bigint' ? artifact.periodId : BigInt(artifact.periodId);

  const pdas = derivePdas({ poolKind, periodId });
  const claimMarker = deriveClaimMarker({ period: pdas.period, leafIndex: w.leafIndex });

  const [periodInfo, claimMarkerInfo, vaultStateInfo, vaultInfo, claimantInfo] = await Promise.all([
    conn.getAccountInfo(pdas.period,       'finalized'),
    conn.getAccountInfo(claimMarker,       'finalized'),
    conn.getAccountInfo(pdas.vaultState,   'finalized'),
    conn.getAccountInfo(pdas.vault,        'finalized'),
    conn.getAccountInfo(claimingPubkey,    'finalized'),
  ]);

  if (!periodInfo)      throw new Error(`Period PDA missing on-chain: ${pdas.period.toBase58()}`);
  if (claimMarkerInfo)  throw new Error(`ClaimMarker already exists — leaf ${w.leafIndex} of period ${periodId} was already claimed: ${claimMarker.toBase58()}`);
  if (!vaultStateInfo)  throw new Error(`VaultState missing: ${pdas.vaultState.toBase58()}`);
  if (!vaultInfo)       throw new Error(`Vault missing: ${pdas.vault.toBase58()}`);

  const period = decodePeriod(periodInfo.data);
  if (period.pool_kind !== poolKind)                                          throw new Error(`Period.pool_kind mismatch: ${period.pool_kind} vs ${poolKind}`);
  if (period.period_id !== periodId)                                          throw new Error(`Period.period_id mismatch: ${period.period_id} vs ${periodId}`);
  if (!period.is_finalized)                                                    throw new Error(`Period not finalized`);
  if (period.merkle_root.toLowerCase() !== artifact.merkleRoot.toLowerCase()) throw new Error(`Period.merkle_root mismatch on-chain vs artifact`);
  if (Number(period.total_payout) !== artifact.totalPayoutLamports)           throw new Error(`Period.total_payout mismatch`);
  if (period.num_winners !== artifact.winnerCount)                            throw new Error(`Period.num_winners mismatch`);
  if (period.num_claimed >= period.num_winners)                               throw new Error(`AllWinnersClaimed already reached`);

  const vs = decodeVaultStateSubset(vaultStateInfo.data);
  const amountBI = BigInt(w.payoutLamports);
  if (vs.obligations_lamports < amountBI) throw new Error(`InsufficientObligations: obligations=${vs.obligations_lamports} vs amount=${amountBI}`);

  const vaultLamports = BigInt(vaultInfo.lamports);
  const rentFloor = 890880n;
  if (vaultLamports < amountBI + rentFloor) throw new Error(`VaultUnderfunded: vault=${vaultLamports} vs need=${amountBI + rentFloor}`);

  const claimantLamports = BigInt(claimantInfo ? claimantInfo.lamports : 0);
  // Rough tx fee upper bound + ClaimMarker rent (~0.00165 SOL = 1_650_000 lamports)
  const minClaimantFloor = 1_700_000n;
  if (claimantLamports < minClaimantFloor) {
    throw new Error(`claimant balance too low for tx fee + ClaimMarker rent: ${claimantLamports} vs ~${minClaimantFloor}`);
  }

  const proofBufs = w.proof.map(hex => Buffer.from(hex, 'hex'));

  return {
    winner: w, pdas, claimMarker, period, vs,
    vaultLamports, claimantLamports, poolKind, periodId,
    proofBufs, amountBI, claimingPubkey,
  };
}

// ---------- CLI ------------------------------------------------------------
function parseArgs(argv) {
  const out = { artifact: null, rank: null, keypairWsl: null, send: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '--artifact')    out.artifact   = argv[++i];
    else if (a === '--rank')        out.rank       = Number(argv[++i]);
    else if (a === '--keypair-wsl') out.keypairWsl = argv[++i];
    else if (a === '--send')        out.send       = true;
    else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
    else { console.error(`unknown arg: ${a}`); printHelp(); process.exit(1); }
  }
  return out;
}
function printHelp() {
  console.log(`Usage:
  node tools/claim_cli.js --artifact <path.json> --rank <N> [--keypair-wsl <wsl path>] [--send]
Cluster hardcoded to devnet.
Without --send: preflight + simulate only. Zero broadcast.
--send REQUIRES --keypair-wsl and broadcasts one claim tx.`);
}
function hdr(s) { console.log('\n== ' + s + ' =='); }
function sol(lamports) { return (Number(lamports) / 1e9).toFixed(9) + ' SOL'; }

async function cliMain() {
  const args = parseArgs(process.argv);
  if (!args.artifact || !Number.isInteger(args.rank)) { printHelp(); process.exit(1); }
  if (args.send && !args.keypairWsl) {
    console.error('--send REQUIRES --keypair-wsl'); process.exit(1);
  }

  const raw = fs.readFileSync(args.artifact, 'utf8');
  const artifact = JSON.parse(raw);
  if (typeof artifact.periodId === 'string') artifact.periodId = BigInt(artifact.periodId);
  else if (typeof artifact.periodId === 'number') artifact.periodId = BigInt(artifact.periodId);
  validateArtifact(artifact);

  console.log('== artifact ==');
  console.log(`  cluster:              ${CLUSTER}   (hardcoded)`);
  console.log(`  poolKind:             ${artifact.poolKind}`);
  console.log(`  periodId:             ${artifact.periodId}`);
  console.log(`  merkleRoot:           ${artifact.merkleRoot}`);
  console.log(`  totalPayoutLamports:  ${artifact.totalPayoutLamports}`);
  console.log(`  winnerCount:          ${artifact.winnerCount}`);
  console.log(`  claiming rank:        ${args.rank}`);

  // Optionally load keypair (required for --send; optional otherwise).
  let claimant = null;
  if (args.keypairWsl) {
    claimant = loadKeypairFromWsl(args.keypairWsl);
    console.log(`\n== claimant keypair ==`);
    console.log(`  publicKey: ${claimant.publicKey.toBase58()}   (secret NOT displayed)`);
  }

  const conn = new Connection(CLUSTERS[CLUSTER], 'finalized');
  const winnerPubkey = claimant ? claimant.publicKey : null;

  hdr('preflight (read-only on-chain checks)');
  const pf = await preflight({ conn, artifact, rank: args.rank, winnerPubkey });

  console.log(`  winner (from artifact):     ${pf.winner.wallet}`);
  console.log(`  leaf_index:                 ${pf.winner.leafIndex}`);
  console.log(`  amount lamports:            ${pf.winner.payoutLamports}   (${sol(pf.winner.payoutLamports)})`);
  console.log(`  proof length:               ${pf.proofBufs.length}`);

  console.log(`\n-- PDAs --`);
  console.log(`  period:      ${pf.pdas.period.toBase58()}`);
  console.log(`  claimMarker: ${pf.claimMarker.toBase58()}   (must NOT exist yet — CHECK PASSED)`);
  console.log(`  vaultState:  ${pf.pdas.vaultState.toBase58()}`);
  console.log(`  vault:       ${pf.pdas.vault.toBase58()}`);

  console.log(`\n-- Period[on-chain] --`);
  console.log(`  is_finalized:    ${pf.period.is_finalized}`);
  console.log(`  merkle_root:     ${pf.period.merkle_root}   (matches artifact)`);
  console.log(`  total_payout:    ${pf.period.total_payout}`);
  console.log(`  claimed_so_far:  ${pf.period.claimed_so_far}`);
  console.log(`  num_winners:     ${pf.period.num_winners}`);
  console.log(`  num_claimed:     ${pf.period.num_claimed}`);

  console.log(`\n-- Balances --`);
  console.log(`  vault balance:         ${pf.vaultLamports}   (${sol(pf.vaultLamports)})`);
  console.log(`  vault_state.obligations: ${pf.vs.obligations_lamports}   (${sol(pf.vs.obligations_lamports)})`);
  console.log(`  vault_state.total_paid_lifetime: ${pf.vs.total_paid_lifetime}`);
  console.log(`  vault_state.awaiting_settlement: ${pf.vs.awaiting_settlement_total}`);
  console.log(`  claimant SOL balance:  ${pf.claimantLamports}   (${sol(pf.claimantLamports)})`);

  // Build the instruction and simulate.
  const ix = buildIx({
    winnerPubkey: pf.claimingPubkey,
    pdas: pf.pdas, claimMarker: pf.claimMarker,
    poolKind: pf.poolKind, periodId: pf.periodId,
    leafIndex: pf.winner.leafIndex, amount: pf.winner.payoutLamports, proof: pf.proofBufs,
  });

  console.log(`\n-- ix data preview (${ix.data.length} bytes) --`);
  console.log(`  hex: ${ix.data.toString('hex')}`);
  console.log(`  discriminator(8): ${ix.data.subarray(0, 8).toString('hex')} = sha256("global:claim").slice(0,8)`);
  console.log(`  pool_kind(1):     ${ix.data.readUInt8(8)}`);
  const dv = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
  console.log(`  period_id(8 LE):  ${dv.getBigUint64(9, true)}`);
  console.log(`  leaf_index(4 LE): ${dv.getUint32(17, true)}`);
  console.log(`  amount(8 LE):     ${dv.getBigUint64(21, true)}`);
  console.log(`  proof_len(4 LE):  ${dv.getUint32(29, true)}   (0 -> empty proof, correct for single leaf where root=leaf)`);

  console.log(`\n-- account list (order matters) --`);
  const roleNames = ['winner(signer)', 'period', 'claim_marker(init)', 'vault_state', 'vault', 'system_program'];
  ix.keys.forEach((k, i) => {
    console.log(`  #${i} ${roleNames[i].padEnd(20)} ${k.pubkey.toBase58()}  signer=${k.isSigner} writable=${k.isWritable}`);
  });

  // Simulate
  const tx = new Transaction().add(ix);
  tx.feePayer = pf.claimingPubkey;
  const { blockhash } = await conn.getLatestBlockhash('finalized');
  tx.recentBlockhash = blockhash;

  hdr('simulate');
  let sim;
  if (claimant) {
    tx.sign(claimant);
    console.log('  signing with claimant keypair; sigVerify=true');
    sim = await conn.simulateTransaction(tx, undefined, /* sigVerify */ true);
  } else {
    console.log('  no keypair provided; running unsigned simulation (sigVerify=false).');
    console.log('  Provide --keypair-wsl for a signature-verified simulation.');
    sim = await conn.simulateTransaction(tx);
  }
  console.log(`  err:            ${JSON.stringify(sim.value.err)}`);
  console.log(`  units_consumed: ${sim.value.unitsConsumed}`);
  console.log(`  logs:`);
  for (const l of sim.value.logs || []) console.log(`    | ${l}`);
  if (sim.value.err) {
    console.log('\n== SIMULATION FAILED ==');
    process.exit(2);
  }

  if (!args.send) {
    hdr('SIMULATION OK — NOT sent (pass --send to broadcast)');
    console.log(`  expected state changes if sent:`);
    console.log(`    - ClaimMarker PDA created: ${pf.claimMarker.toBase58()}`);
    console.log(`    - Period.claimed_so_far ${pf.period.claimed_so_far} -> ${Number(pf.period.claimed_so_far) + pf.winner.payoutLamports}`);
    console.log(`    - Period.num_claimed    ${pf.period.num_claimed} -> ${pf.period.num_claimed + 1}`);
    console.log(`    - vault_state.obligations ${pf.vs.obligations_lamports} -> ${pf.vs.obligations_lamports - pf.amountBI}`);
    console.log(`    - vault balance ${pf.vaultLamports} -> ${pf.vaultLamports - pf.amountBI} (SOL transferred to claimant)`);
    console.log(`    - claimant receives ${pf.winner.payoutLamports} lamports (${sol(pf.winner.payoutLamports)})`);
    console.log(`    - claimant pays ~1_650_000 lamports rent for ClaimMarker (permanent) + ~5_000 tx fee`);
    console.log(`    - net claimant gain ≈ ${pf.winner.payoutLamports - 1_650_000 - 5_000} lamports`);
    process.exit(0);
  }

  // ---- broadcast ---------------------------------------------------------
  hdr('broadcasting');
  const freshTx = new Transaction().add(ix);
  freshTx.feePayer = pf.claimingPubkey;
  const signature = await sendAndConfirmTransaction(conn, freshTx, [claimant], {
    commitment: 'finalized',
    preflightCommitment: 'finalized',
  });
  console.log(`  signature: ${signature}`);
  console.log(`  explorer:  https://explorer.solana.com/tx/${signature}?cluster=${CLUSTER}`);

  hdr('POST-SEND VERIFICATION');
  const [periodAfter, claimMarkerAfter, vaultStateAfter, vaultAfter, claimantAfter] = await Promise.all([
    conn.getAccountInfo(pf.pdas.period,       'finalized'),
    conn.getAccountInfo(pf.claimMarker,       'finalized'),
    conn.getAccountInfo(pf.pdas.vaultState,   'finalized'),
    conn.getAccountInfo(pf.pdas.vault,        'finalized'),
    conn.getAccountInfo(pf.claimingPubkey,    'finalized'),
  ]);

  const errs = [];
  if (!claimMarkerAfter) errs.push('ClaimMarker missing after send');
  else console.log(`  ClaimMarker created: ${pf.claimMarker.toBase58()}   size=${claimMarkerAfter.data.length}`);

  const periodPost = decodePeriod(periodAfter.data);
  const expClaimedSoFar = pf.amountBI;   // was 0
  const expNumClaimed   = 1;
  console.log(`  Period.claimed_so_far: ${periodPost.claimed_so_far}   (expected ${expClaimedSoFar})`);
  console.log(`  Period.num_claimed:    ${periodPost.num_claimed}      (expected ${expNumClaimed})`);
  if (periodPost.claimed_so_far !== expClaimedSoFar) errs.push('claimed_so_far mismatch');
  if (periodPost.num_claimed !== expNumClaimed)      errs.push('num_claimed mismatch');

  const vsPost = decodeVaultStateSubset(vaultStateAfter.data);
  console.log(`  vault_state.obligations: ${pf.vs.obligations_lamports} -> ${vsPost.obligations_lamports}   (expected -${pf.amountBI})`);
  console.log(`  vault_state.total_paid_lifetime: ${pf.vs.total_paid_lifetime} -> ${vsPost.total_paid_lifetime}   (expected +${pf.amountBI})`);
  if (pf.vs.obligations_lamports - vsPost.obligations_lamports !== pf.amountBI) errs.push('obligations delta wrong');
  if (vsPost.total_paid_lifetime - pf.vs.total_paid_lifetime !== pf.amountBI)   errs.push('total_paid_lifetime delta wrong');

  const vaultAfterLam = BigInt(vaultAfter.lamports);
  const vaultDelta = pf.vaultLamports - vaultAfterLam;
  console.log(`  vault balance: ${pf.vaultLamports} -> ${vaultAfterLam}   delta=-${vaultDelta}  (expected -${pf.amountBI})`);
  if (vaultDelta !== pf.amountBI) errs.push('vault delta wrong');

  const claimantAfterLam = BigInt(claimantAfter.lamports);
  const claimantDelta = claimantAfterLam - pf.claimantLamports;
  console.log(`  claimant SOL: ${pf.claimantLamports} -> ${claimantAfterLam}   delta=${claimantDelta}`);
  console.log(`    (net = +${pf.amountBI} payout − ClaimMarker rent (~1_650_000) − tx fee (~5_000))`);

  if (errs.length > 0) {
    hdr('VERIFICATION FAILED'); for (const e of errs) console.log('  - ' + e);
    process.exit(1);
  }
  hdr('DONE');
}

module.exports = {
  CLAIM_DISCRIMINATOR, derivePdas, deriveClaimMarker, serializeClaimArgs, buildIx,
};

if (require.main === module) {
  cliMain().catch(e => { console.error('\nERROR:', e && e.message); process.exit(1); });
}
