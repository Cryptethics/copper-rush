// Paid V1 post_settlement SIMULATOR — signs but does NOT send.
//
// Runs the full flight of a `post_settlement` transaction against devnet
// (or any cluster), stopping at simulateTransaction. Never invokes
// sendTransaction. Never mutates on-chain state.
//
// Usage (CLI):
//   node tools/post_settlement_simulator.js \
//     --artifact <path.json>                          # output of buildDailySettlement
//     --keypair-wsl /home/filip/.config/solana/id.json # admin keypair in WSL
//     --cluster devnet
//
// Security:
//   - Admin secret key is loaded via `wsl bash -lc 'cat <path>'` into a
//     transient Uint8Array, immediately zeroed after Keypair construction.
//   - Nothing about the secret is logged.
//   - The keypair file is NEVER copied into Windows / this repo.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { spawnSync } = require('child_process');
const {
  Connection, PublicKey, Transaction, TransactionInstruction,
  Keypair, SystemProgram,
} = require('@solana/web3.js');

// ---------- constants -----------------------------------------------------

const COPPER_PROGRAM_ID_STR = 'EdYmMfzFidw4epQkBBiEP3bzJLYRGbKe6uqUuqq1Ggsg';
const COPPER_PROGRAM_ID = new PublicKey(COPPER_PROGRAM_ID_STR);

const CLUSTERS = Object.freeze({
  devnet:  'https://api.devnet.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com',
});

const SEED_CONFIG  = Buffer.from('config');
const SEED_VS      = Buffer.from('vault_state');
const SEED_PENDING = Buffer.from('pending');
const SEED_PERIOD  = Buffer.from('period');

// Anchor-standard instruction sighash: sha256("global:<name>").slice(0, 8).
function sighash(name) {
  return crypto.createHash('sha256').update(name).digest().subarray(0, 8);
}
const POST_SETTLEMENT_DISCRIMINATOR = sighash('global:post_settlement');

// Account sizes (spec §5.1, §5.4, §5.5).
const CONFIG_LEN  = 210;
const PENDING_LEN =  98;

// ---------- pure serializer ----------------------------------------------

function serializePostSettlementArgs({ pool_kind, period_id, merkle_root, total_payout, num_winners }) {
  if (!Number.isInteger(pool_kind) || pool_kind < 0 || pool_kind > 255) {
    throw new Error(`pool_kind must be 0..255, got ${pool_kind}`);
  }
  const pid = typeof period_id === 'bigint' ? period_id : BigInt(period_id);
  if (pid < 0n || pid > 0xffff_ffff_ffff_ffffn) throw new Error('period_id out of u64 range');
  if (!Buffer.isBuffer(merkle_root) || merkle_root.length !== 32) {
    throw new Error(`merkle_root must be 32-byte Buffer, got ${merkle_root && merkle_root.length}`);
  }
  const tp = typeof total_payout === 'bigint' ? total_payout : BigInt(total_payout);
  if (tp < 0n || tp > 0xffff_ffff_ffff_ffffn) throw new Error('total_payout out of u64 range');
  if (!Number.isInteger(num_winners) || num_winners < 0 || num_winners > 0xffff_ffff) {
    throw new Error('num_winners must be u32');
  }
  const buf = Buffer.alloc(8 + 1 + 8 + 32 + 8 + 4);   // 61 bytes exactly
  let off = 0;
  POST_SETTLEMENT_DISCRIMINATOR.copy(buf, off); off += 8;
  buf.writeUInt8(pool_kind & 0xff, off); off += 1;
  buf.writeBigUInt64LE(pid, off); off += 8;
  merkle_root.copy(buf, off); off += 32;
  buf.writeBigUInt64LE(tp, off); off += 8;
  buf.writeUInt32LE(num_winners, off); off += 4;
  return buf;
}

// ---------- PDA derivation ------------------------------------------------

function derivePdas({ poolKind, periodId, programId = COPPER_PROGRAM_ID }) {
  if (!Number.isInteger(poolKind) || poolKind < 0 || poolKind > 3) {
    throw new Error(`poolKind must be 0..3, got ${poolKind}`);
  }
  const pid = typeof periodId === 'bigint' ? periodId : BigInt(periodId);
  const pidLE = Buffer.alloc(8);
  pidLE.writeBigUInt64LE(pid);
  const poolByte = Buffer.from([poolKind & 0xff]);
  const [config]     = PublicKey.findProgramAddressSync([SEED_CONFIG],                       programId);
  const [vaultState] = PublicKey.findProgramAddressSync([SEED_VS,      poolByte],            programId);
  const [pending]    = PublicKey.findProgramAddressSync([SEED_PENDING, poolByte, pidLE],     programId);
  const [period]     = PublicKey.findProgramAddressSync([SEED_PERIOD,  poolByte, pidLE],     programId);
  return { config, vaultState, pending, period };
}

// ---------- decoders ------------------------------------------------------

function decodeConfig(buf) {
  if (buf.length !== CONFIG_LEN) throw new Error(`Config: expected ${CONFIG_LEN} bytes, got ${buf.length}`);
  const admin         = new PublicKey(buf.subarray(8,   40));
  const treasury      = new PublicKey(buf.subarray(40,  72));
  const dev           = new PublicKey(buf.subarray(72, 104));
  const burn          = new PublicKey(buf.subarray(104, 136));
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const entry_fee     = dv.getBigUint64(136, true);
  const paused        = buf[144] !== 0;
  const bump          = buf[145];
  const pending_admin = new PublicKey(buf.subarray(146, 178));
  return { admin, treasury, dev, burn, entry_fee, paused, bump, pending_admin };
}

function decodePending(buf) {
  if (buf.length !== PENDING_LEN) throw new Error(`PendingSettlement: expected ${PENDING_LEN} bytes, got ${buf.length}`);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const pool_kind       = buf[8];
  const bump            = buf[9];
  const period_id       = dv.getBigUint64(10, true);
  const total_collected = dv.getBigUint64(18, true);
  const rent_payer      = new PublicKey(buf.subarray(26, 58));
  const sealed_at       = dv.getBigInt64(58, true);
  return { pool_kind, bump, period_id, total_collected, rent_payer, sealed_at };
}

// ---------- artifact validation ------------------------------------------

function validateArtifact(a) {
  if (!a || typeof a !== 'object') throw new Error('artifact must be an object');
  if (!Number.isInteger(a.poolKind) || a.poolKind < 0 || a.poolKind > 3) {
    throw new Error('artifact.poolKind must be 0..3');
  }
  if (a.periodId == null) throw new Error('artifact.periodId required');
  if (typeof a.merkleRoot !== 'string' || !/^[0-9a-f]{64}$/i.test(a.merkleRoot)) {
    throw new Error('artifact.merkleRoot must be a 64-hex string');
  }
  if (a.merkleRoot.toLowerCase() === '00'.repeat(32)) {
    throw new Error('artifact.merkleRoot cannot be all zeros');
  }
  if (!Number.isInteger(a.winnerCount) || a.winnerCount <= 0) {
    throw new Error('artifact.winnerCount must be a positive integer');
  }
  if (a.winnerCount > (1 << 24)) throw new Error('artifact.winnerCount exceeds 2^24');
  if (!Number.isInteger(a.totalPayoutLamports) || a.totalPayoutLamports <= 0) {
    throw new Error('artifact.totalPayoutLamports must be a positive integer');
  }
  return true;
}

// ---------- WSL keypair loader (no secret printed) ------------------------

function loadKeypairFromWsl(wslPath) {
  if (typeof wslPath !== 'string' || wslPath.length === 0) throw new Error('wslPath required');
  const res = spawnSync('wsl', ['bash', '-lc', `cat ${JSON.stringify(wslPath)}`], {
    encoding: 'utf8', maxBuffer: 8192,
  });
  if (res.status !== 0) throw new Error(`wsl cat failed: ${(res.stderr || '').trim() || 'no stderr'}`);
  let arr;
  try { arr = JSON.parse(res.stdout); }
  catch { throw new Error('keypair file is not valid JSON'); }
  if (!Array.isArray(arr) || arr.length !== 64) {
    throw new Error(`keypair must be a 64-element JSON array (Solana keypair format), got length=${Array.isArray(arr) ? arr.length : typeof arr}`);
  }
  const sk = new Uint8Array(arr);
  const kp = Keypair.fromSecretKey(sk);
  // Best-effort scrub of the transient (won't stop V8 from having copies, but
  // shortens the window during which the raw bytes sit in a named reference).
  for (let i = 0; i < sk.length; i++) sk[i] = 0;
  return kp;
}

// ---------- preflight + build + simulate ---------------------------------

async function preflight({ conn, admin, artifact }) {
  validateArtifact(artifact);
  const pdas = derivePdas({ poolKind: artifact.poolKind, periodId: artifact.periodId });

  const [cfgInfo, pendingInfo, periodInfo] = await Promise.all([
    conn.getAccountInfo(pdas.config,  'finalized'),
    conn.getAccountInfo(pdas.pending, 'finalized'),
    conn.getAccountInfo(pdas.period,  'finalized'),
  ]);

  if (!cfgInfo) throw new Error(`Config PDA not found on-chain: ${pdas.config.toBase58()}`);
  const cfg = decodeConfig(cfgInfo.data);
  if (!cfg.admin.equals(admin.publicKey)) {
    throw new Error(`admin mismatch: keypair=${admin.publicKey.toBase58()} vs config.admin=${cfg.admin.toBase58()}`);
  }

  if (!pendingInfo) {
    throw new Error(`PendingSettlement not found for period ${artifact.periodId}: seal_period(pool=${artifact.poolKind}, period=${artifact.periodId}) must run first`);
  }
  const pending = decodePending(pendingInfo.data);

  if (Number(pending.total_collected) !== artifact.totalPayoutLamports) {
    throw new Error(`payout mismatch: artifact.totalPayoutLamports=${artifact.totalPayoutLamports} vs pending.total_collected=${pending.total_collected}`);
  }

  if (periodInfo) {
    throw new Error(`Period already exists (${pdas.period.toBase58()}): this period has already been settled`);
  }

  return { pdas, cfg, pending };
}

function buildIx({ artifact, admin, pdas, rent_payer }) {
  const data = serializePostSettlementArgs({
    pool_kind:    artifact.poolKind,
    period_id:    BigInt(typeof artifact.periodId === 'string' ? artifact.periodId : artifact.periodId),
    merkle_root:  Buffer.from(artifact.merkleRoot, 'hex'),
    total_payout: BigInt(artifact.totalPayoutLamports),
    num_winners:  artifact.winnerCount,
  });
  const keys = [
    { pubkey: admin.publicKey,          isSigner: true,  isWritable: true  },
    { pubkey: pdas.config,              isSigner: false, isWritable: false },
    { pubkey: pdas.vaultState,          isSigner: false, isWritable: true  },
    { pubkey: pdas.pending,             isSigner: false, isWritable: true  },
    { pubkey: pdas.period,              isSigner: false, isWritable: true  },
    { pubkey: rent_payer,               isSigner: false, isWritable: true  },
    { pubkey: SystemProgram.programId,  isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: COPPER_PROGRAM_ID, keys, data });
}

async function simulate({ conn, admin, artifact }) {
  const { pdas, cfg, pending } = await preflight({ conn, admin, artifact });
  const ix = buildIx({ artifact, admin, pdas, rent_payer: pending.rent_payer });
  const tx = new Transaction().add(ix);
  const { blockhash } = await conn.getLatestBlockhash('finalized');
  tx.recentBlockhash = blockhash;
  tx.feePayer = admin.publicKey;
  tx.sign(admin);
  const sim = await conn.simulateTransaction(tx, [admin]);
  return {
    pdas: {
      config:     pdas.config.toBase58(),
      vaultState: pdas.vaultState.toBase58(),
      pending:    pdas.pending.toBase58(),
      period:     pdas.period.toBase58(),
    },
    cfg: {
      admin: cfg.admin.toBase58(),
      paused: cfg.paused,
      entry_fee: cfg.entry_fee.toString(),
    },
    pending: {
      total_collected: pending.total_collected.toString(),
      rent_payer:      pending.rent_payer.toBase58(),
      sealed_at:       pending.sealed_at.toString(),
    },
    predicted_state_changes: {
      period_pda_created:            pdas.period.toBase58(),
      period_merkle_root:            artifact.merkleRoot,
      period_total_payout_lamports:  artifact.totalPayoutLamports,
      period_num_winners:            artifact.winnerCount,
      vault_state_awaiting_delta:    `-${pending.total_collected}`,
      vault_state_obligations_delta: `+${artifact.totalPayoutLamports}`,
      pending_pda_closed_to:         pending.rent_payer.toBase58(),
      rent_refund_lamports_approx:   'about 0.00157 SOL (98-byte account rent)',
      new_period_rent_burned_approx: 'about 0.00169 SOL (115-byte account rent, permanent)',
    },
    sim: sim.value,
  };
}

module.exports = {
  COPPER_PROGRAM_ID, COPPER_PROGRAM_ID_STR, CLUSTERS,
  SEED_CONFIG, SEED_VS, SEED_PENDING, SEED_PERIOD,
  POST_SETTLEMENT_DISCRIMINATOR, sighash,
  serializePostSettlementArgs,
  derivePdas,
  decodeConfig, decodePending,
  validateArtifact,
  loadKeypairFromWsl,
  preflight, buildIx, simulate,
};

// ---------- CLI ----------------------------------------------------------

function parseArgs(argv) {
  const out = { artifact: null, cluster: 'devnet', keypairWsl: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '--artifact')     out.artifact   = argv[++i];
    else if (a === '--cluster')      out.cluster    = argv[++i];
    else if (a === '--keypair-wsl')  out.keypairWsl = argv[++i];
    else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
    else { console.error(`unknown arg: ${a}`); printHelp(); process.exit(1); }
  }
  return out;
}

function printHelp() {
  console.log(`Usage:
  node tools/post_settlement_simulator.js \\
    --artifact <path.json> \\
    --keypair-wsl <wsl path to Solana JSON keypair> \\
    [--cluster devnet]
Simulation only — never sends the transaction.`);
}

async function cliMain() {
  const args = parseArgs(process.argv);
  if (!args.artifact || !args.keypairWsl) { printHelp(); process.exit(1); }

  const raw = fs.readFileSync(args.artifact, 'utf8');
  const artifact = JSON.parse(raw);

  // periodId may be serialized as string (BigInt-safe) by the builder.
  if (typeof artifact.periodId === 'string') artifact.periodId = BigInt(artifact.periodId);
  else if (typeof artifact.periodId === 'number') artifact.periodId = BigInt(artifact.periodId);

  console.log('== loaded artifact ==');
  console.log(`  poolKind:            ${artifact.poolKind}`);
  console.log(`  periodId:            ${artifact.periodId}`);
  console.log(`  winnerCount:         ${artifact.winnerCount}`);
  console.log(`  totalPayoutLamports: ${artifact.totalPayoutLamports}`);
  console.log(`  merkleRoot:          ${artifact.merkleRoot}`);

  const admin = loadKeypairFromWsl(args.keypairWsl);
  console.log(`\n== admin keypair loaded from WSL ==`);
  console.log(`  publicKey: ${admin.publicKey.toBase58()}   (secret NOT displayed)`);

  const conn = new Connection(CLUSTERS[args.cluster] || args.cluster, 'finalized');
  console.log(`\n== preflight + simulate on ${args.cluster} ==`);

  const result = await simulate({ conn, admin, artifact });
  console.log('\n-- PDAs --');
  for (const [k, v] of Object.entries(result.pdas))    console.log(`  ${k.padEnd(12)} ${v}`);
  console.log('\n-- Config --');
  for (const [k, v] of Object.entries(result.cfg))     console.log(`  ${k.padEnd(12)} ${v}`);
  console.log('\n-- PendingSettlement --');
  for (const [k, v] of Object.entries(result.pending)) console.log(`  ${k.padEnd(16)} ${v}`);
  console.log('\n-- Predicted state changes (would apply on send) --');
  for (const [k, v] of Object.entries(result.predicted_state_changes)) console.log(`  ${k.padEnd(30)} ${v}`);

  console.log('\n-- simulateTransaction result --');
  console.log(`  err:          ${JSON.stringify(result.sim.err)}`);
  console.log(`  units_consumed: ${result.sim.unitsConsumed}`);
  console.log('  logs:');
  for (const l of result.sim.logs || []) console.log(`    | ${l}`);

  if (result.sim.err) {
    console.log('\n== SIMULATION FAILED — transaction would revert if sent ==');
    process.exit(2);
  }
  console.log('\n== SIMULATION OK — transaction would succeed if sent ==');
  console.log('   (NOT sent — this is a simulator; use a separate sender to broadcast.)');
}

if (require.main === module) cliMain().catch(e => { console.error('ERROR:', e && e.message); process.exit(1); });
