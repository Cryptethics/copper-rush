// Paid V1 Daily settlement DRY RUN — read-only, produces no on-chain tx.
//
// Wires together the read-only modules to preview a real settlement for a
// given DAILY periodId, based on live devnet + Supabase state. Never signs,
// never posts, never mutates.
//
// Usage:
//   node tools/paid_daily_dry_run.js                     # scans all sealed periods
//   node tools/paid_daily_dry_run.js --period-id 45      # inspects one
//   node tools/paid_daily_dry_run.js --cluster devnet    # default: devnet
//
// Exit code 0 on clean run (with or without blocker report).
// Exit code 2 when a blocker prevents settlement (details in stdout).

'use strict';

const {
  fetchVaultState,
  listPendingSettlements, listPeriods,
} = require('./copper_rpc_reader.js');
const {
  fetchPaidScoresInPeriod, countWalletTaggedPaidRows,
} = require('./paid_supabase_fetcher.js');
const { dailyPeriodBoundaries } = require('./daily_period_boundaries.js');
const { ingestDailySettlement } = require('./paid_daily_ingestor.js');

const POOL_KIND_DAILY = 0;

// ---------- CLI parsing -----------------------------------------------------
function parseArgs(argv) {
  const out = { cluster: 'devnet', periodId: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cluster')        out.cluster  = argv[++i];
    else if (a === '--period-id') out.periodId = Number(argv[++i]);
    else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
    else { console.error(`unknown arg: ${a}`); printHelp(); process.exit(1); }
  }
  return out;
}
function printHelp() {
  console.log(`Usage: node tools/paid_daily_dry_run.js [--cluster devnet] [--period-id N]`);
}

// ---------- helpers ---------------------------------------------------------
function hdr(s) { console.log('\n== ' + s + ' =='); }
function sol(lamports) { return (Number(lamports) / 1e9).toFixed(9) + ' SOL'; }

// ---------- main ------------------------------------------------------------
async function main() {
  const { cluster, periodId } = parseArgs(process.argv);

  hdr(`DAILY VaultState (${cluster})`);
  const vs = await fetchVaultState(cluster, POOL_KIND_DAILY);
  if (!vs) { console.error('DAILY VaultState not found — abort'); process.exit(1); }
  const d = vs.decoded;
  console.log(`  pubkey                 ${vs.pubkey}`);
  console.log(`  epoch_zero             ${d.epoch_zero.toString()}  (${new Date(Number(d.epoch_zero) * 1000).toISOString()})`);
  console.log(`  period_duration_seconds ${d.period_duration_seconds}`);
  console.log(`  open_period_id         ${d.open_period_id.toString()}`);
  console.log(`  open_period_collected  ${d.open_period_collected.toString()} lamports  (${sol(d.open_period_collected)})`);
  console.log(`  awaiting_settlement    ${d.awaiting_settlement_total.toString()} lamports`);
  console.log(`  obligations            ${d.obligations_lamports.toString()} lamports`);
  console.log(`  lifetime collected     ${d.total_collected_lifetime.toString()} lamports  (${sol(d.total_collected_lifetime)})`);
  console.log(`  lifetime paid          ${d.total_paid_lifetime.toString()} lamports`);

  hdr(`On-chain PendingSettlement PDAs for DAILY`);
  const pendings = await listPendingSettlements(cluster, POOL_KIND_DAILY);
  if (pendings.length === 0) {
    console.log('  (none)   — no period has been sealed with non-zero collection yet.');
  } else {
    for (const p of pendings) {
      console.log(`  period ${p.period_id.toString().padStart(6)}   total_collected=${p.total_collected.toString().padStart(12)}  sealed_at=${p.sealed_at}  rent_payer=${p.rent_payer.slice(0, 12)}...`);
    }
  }

  hdr(`On-chain Period PDAs (already settled) for DAILY`);
  const periods = await listPeriods(cluster, POOL_KIND_DAILY);
  if (periods.length === 0) {
    console.log('  (none)   — no post_settlement has ever run for DAILY.');
  } else {
    for (const p of periods) {
      console.log(`  period ${p.period_id.toString().padStart(6)}   winners=${p.num_winners}  claimed=${p.num_claimed}/${p.num_winners}  paid=${p.claimed_so_far}/${p.total_payout}  root=${p.merkle_root.slice(0,8)}...`);
    }
  }

  // Diagnostic: how many wallet-tagged paid rows exist AT ALL?
  hdr('Supabase paid-rows diagnostic');
  let walletTaggedTotal = null;
  try {
    walletTaggedTotal = await countWalletTaggedPaidRows();
    console.log(`  scores WHERE wallet IS NOT NULL   (any period): ${walletTaggedTotal}`);
  } catch (e) {
    console.log(`  count query failed: ${e.message}`);
  }

  // If no periodId requested, stop after inventory.
  if (periodId == null) {
    hdr('Summary');
    console.log('  Pass --period-id N to inspect a specific period.');
    console.log(`  Candidate sealed periods available for dry-run: ${pendings.map(p => Number(p.period_id)).join(', ') || '(none)'}`);
    process.exit(0);
  }

  // ---------- inspect a specific periodId ----------------------------------
  hdr(`Dry run for period_id = ${periodId}`);
  const boundaries = dailyPeriodBoundaries({
    epochZero:             Number(d.epoch_zero),
    periodDurationSeconds: Number(d.period_duration_seconds),
    periodId,
  });
  console.log(`  boundaries: [${boundaries.startISO}, ${boundaries.endISO})   (Unix ${boundaries.startUnix} .. ${boundaries.endUnix})`);

  const pending = pendings.find(p => Number(p.period_id) === periodId);
  if (!pending) {
    hdr('BLOCKER — no PendingSettlement on-chain for this period');
    console.log(`  period_id=${periodId} has not been sealed (or has already been post-settled).`);
    console.log(`  If sealed:      look in Period list above for period_id=${periodId}.`);
    console.log(`  If not sealed:  someone must call seal_period(pool_kind=0, period_id=${periodId}) first.`);
    console.log(`                  (autoSeal in copper-beta.html triggers this on any pay_entry.)`);
    process.exit(2);
  }

  const dailyPrizePoolLamports = Number(pending.total_collected);
  console.log(`  pending.total_collected = ${dailyPrizePoolLamports} lamports  (${sol(dailyPrizePoolLamports)})`);

  // Supabase fetch for this window.
  hdr(`Supabase rows in period [${boundaries.startISO}, ${boundaries.endISO})`);
  const rows = await fetchPaidScoresInPeriod({
    startISO: boundaries.startISO,
    endISO:   boundaries.endISO,
  });
  console.log(`  rows returned (wallet IS NOT NULL): ${rows.length}`);

  if (rows.length === 0) {
    hdr('BLOCKER — no wallet-tagged paid scores exist in this period window');
    console.log(`  Root cause: the DB migration adding scores.wallet was applied on 2026-08-22.`);
    console.log(`  Rows from this period were written by clients that did not send wallet.`);
    console.log(`  Total wallet-tagged rows across ALL periods: ${walletTaggedTotal}`);
    console.log(`  We DO NOT invent wallet mapping. Wait for post-migration paid runs to accumulate,`);
    console.log(`  then re-run the dry-run for a period that contains them.`);
    process.exit(2);
  }

  // Feed into ingestor.
  hdr(`Ingestor result`);
  const res = ingestDailySettlement({
    epochZero:             Number(d.epoch_zero),
    periodDurationSeconds: Number(d.period_duration_seconds),
    periodId,
    poolKind:              POOL_KIND_DAILY,
    dailyPrizePoolLamports,
    rows,
  });
  console.log(`  stats:               ${JSON.stringify(res.stats)}`);
  console.log(`  totalPlayers:        ${res.totalPlayers}`);
  if (res.settlement) {
    console.log(`  winnerCount:         ${res.settlement.winnerCount}`);
    console.log(`  totalPayoutLamports: ${res.settlement.totalPayoutLamports}`);
    console.log(`  merkleRoot:          ${res.settlement.merkleRoot}`);
    console.log(`  algorithm:           ${JSON.stringify(res.settlement.algorithm)}`);
    console.log(`  ready for post_settlement: YES`);
    console.log(`    (would post: pool_kind=0, period_id=${periodId}, merkle_root=${res.settlement.merkleRoot}, total_payout=${res.settlement.totalPayoutLamports}, num_winners=${res.settlement.winnerCount})`);
  } else {
    hdr('BLOCKER — settlement not produced');
    console.log(`  settlementReason: ${res.settlementReason}`);
    process.exit(2);
  }

  process.exit(0);
}

main().catch(e => { console.error('ERROR:', e); process.exit(1); });
