// Paid V1 daily_claims publisher — DECOUPLED from post_settlement broadcast.
//
// Reads a settlement artifact + a settlement_signature (of the confirmed
// on-chain post_settlement tx), verifies the on-chain Period against the
// artifact, then idempotently inserts one row per winner into
// public.daily_claims.
//
// This tool NEVER broadcasts on-chain. It NEVER retries a failed
// post_settlement. It is safe to re-run: identical rows are no-op; conflicting
// rows are hard-fails (must not silently overwrite).
//
// Credentials:
//   SUPABASE_URL              (default: https://dfcccaxcamnsyaevyhqz.supabase.co)
//   SUPABASE_SERVICE_ROLE_KEY (required; service_role bypasses RLS)
//   The service-role key is NEVER printed, NEVER written to disk in the repo,
//   NEVER committed. Env only.
//
// Usage:
//   SUPABASE_SERVICE_ROLE_KEY=... \
//   node tools/publish_daily_claims.js \
//     --artifact <path.json> \
//     --settlement-signature <base58 sig of confirmed post_settlement tx>

'use strict';

const fs = require('fs');
const { Connection, PublicKey } = require('@solana/web3.js');
const {
  CLUSTERS, validateArtifact, derivePdas,
} = require('./post_settlement_simulator.js');
const { decodePeriod } = require('./copper_rpc_reader.js');

const DEFAULT_SUPABASE_URL = 'https://dfcccaxcamnsyaevyhqz.supabase.co';
const CLUSTER = 'devnet';

// ---------- artifact validation (publisher-specific) -----------------------

function assertWinnerRow(w, i) {
  if (!w || typeof w !== 'object') throw new Error(`winners[${i}] must be object`);
  if (!Number.isInteger(w.rank) || w.rank < 1)                      throw new Error(`winners[${i}].rank must be >= 1`);
  if (typeof w.wallet !== 'string' || w.wallet.length === 0)        throw new Error(`winners[${i}].wallet must be non-empty base58 string`);
  // Validate wallet decodes to 32 bytes (throws if invalid base58)
  try { new PublicKey(w.wallet); } catch (e) { throw new Error(`winners[${i}].wallet invalid base58: ${e.message}`); }
  if (!Number.isInteger(w.leafIndex) || w.leafIndex < 0)            throw new Error(`winners[${i}].leafIndex must be non-negative integer`);
  if (!Number.isInteger(w.payoutLamports) || w.payoutLamports <= 0) throw new Error(`winners[${i}].payoutLamports must be positive integer`);
  if (!Array.isArray(w.proof))                                      throw new Error(`winners[${i}].proof must be array`);
  for (let k = 0; k < w.proof.length; k++) {
    if (typeof w.proof[k] !== 'string' || !/^[0-9a-f]{64}$/i.test(w.proof[k])) {
      throw new Error(`winners[${i}].proof[${k}] must be 64-hex string`);
    }
  }
}

function validatePublishInput(artifact, settlementSignature) {
  validateArtifact(artifact);                                     // periodId/poolKind/merkleRoot/totalPayoutLamports/winnerCount
  if (!Array.isArray(artifact.winners))                            throw new Error('artifact.winners must be array');
  if (artifact.winners.length !== artifact.winnerCount)            throw new Error(`winners.length ${artifact.winners.length} !== winnerCount ${artifact.winnerCount}`);
  for (let i = 0; i < artifact.winners.length; i++) assertWinnerRow(artifact.winners[i], i);
  const sumPayouts = artifact.winners.reduce((s, w) => s + w.payoutLamports, 0);
  if (sumPayouts !== artifact.totalPayoutLamports) throw new Error(`sum(winners.payoutLamports)=${sumPayouts} !== totalPayoutLamports=${artifact.totalPayoutLamports}`);
  if (typeof settlementSignature !== 'string' || settlementSignature.length < 32) throw new Error('settlementSignature required (base58 tx signature)');
}

// Convert artifact + one winner into the row shape to send to Supabase.
function winnerToRow(artifact, winner, settlementSignature) {
  const periodIdNum = typeof artifact.periodId === 'string' ? Number(artifact.periodId) : Number(artifact.periodId);
  return {
    pool_kind:            artifact.poolKind,
    period_id:            periodIdNum,
    leaf_index:           winner.leafIndex,
    wallet:               winner.wallet,
    rank:                 winner.rank,
    amount_lamports:      winner.payoutLamports,
    proof:                winner.proof,                          // array of hex strings, stored as JSONB
    merkle_root:          artifact.merkleRoot.toLowerCase(),
    settlement_signature: settlementSignature,
  };
}

// Compare an existing DB row against a freshly-built row. Returns null if
// they match (idempotent skip); returns a string describing the first
// mismatched field otherwise (hard-fail — do NOT overwrite).
function rowsMatch(dbRow, newRow) {
  const fields = ['pool_kind', 'period_id', 'leaf_index', 'wallet', 'rank', 'amount_lamports', 'merkle_root', 'settlement_signature'];
  for (const f of fields) {
    if (String(dbRow[f]) !== String(newRow[f])) {
      return `field "${f}" differs: db=${JSON.stringify(dbRow[f])} vs new=${JSON.stringify(newRow[f])}`;
    }
  }
  // proof: array of strings — deep compare
  const dbProof = Array.isArray(dbRow.proof) ? dbRow.proof : [];
  if (dbProof.length !== newRow.proof.length) {
    return `field "proof" length differs: db=${dbProof.length} vs new=${newRow.proof.length}`;
  }
  for (let i = 0; i < newRow.proof.length; i++) {
    if (String(dbProof[i]).toLowerCase() !== String(newRow.proof[i]).toLowerCase()) {
      return `field "proof[${i}]" differs: db=${dbProof[i]} vs new=${newRow.proof[i]}`;
    }
  }
  return null;
}

// ---------- on-chain cross-verification -----------------------------------

async function verifyOnChain({ conn, artifact }) {
  const pdas = derivePdas({ poolKind: artifact.poolKind, periodId: artifact.periodId });
  const info = await conn.getAccountInfo(pdas.period, 'finalized');
  if (!info) throw new Error(`Period PDA not found on-chain: ${pdas.period.toBase58()} — was post_settlement actually confirmed?`);
  const p = decodePeriod(info.data);

  const errs = [];
  if (p.pool_kind !== artifact.poolKind)                                          errs.push(`pool_kind on-chain ${p.pool_kind} vs artifact ${artifact.poolKind}`);
  if (Number(p.period_id) !== Number(artifact.periodId))                          errs.push(`period_id on-chain ${p.period_id} vs artifact ${artifact.periodId}`);
  if (p.merkle_root.toLowerCase() !== artifact.merkleRoot.toLowerCase())          errs.push(`merkle_root on-chain ${p.merkle_root} vs artifact ${artifact.merkleRoot}`);
  if (Number(p.total_payout) !== artifact.totalPayoutLamports)                    errs.push(`total_payout on-chain ${p.total_payout} vs artifact ${artifact.totalPayoutLamports}`);
  if (p.num_winners !== artifact.winnerCount)                                     errs.push(`num_winners on-chain ${p.num_winners} vs artifact ${artifact.winnerCount}`);
  if (!p.is_finalized)                                                             errs.push(`Period.is_finalized is false`);
  if (errs.length > 0) throw new Error('on-chain / artifact mismatch:\n  - ' + errs.join('\n  - '));

  return { periodPda: pdas.period.toBase58(), period: p };
}

// ---------- Supabase publisher (REST + service_role) ----------------------

function resolveCreds({ url, serviceKey } = {}) {
  const u = url        || process.env.SUPABASE_URL              || DEFAULT_SUPABASE_URL;
  const k = serviceKey || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!k) throw new Error('SUPABASE_SERVICE_ROLE_KEY env var required (never hardcoded, never logged)');
  return { url: u.replace(/\/+$/, ''), serviceKey: k };
}

/**
 * Publish one row idempotently.
 * Result: { status: 'inserted' | 'skipped_identical' | 'conflict', message? }
 */
async function publishOneRow({ creds, newRow, fetchImpl }) {
  const _fetch = fetchImpl || fetch;
  // 1. SELECT existing row for (pool_kind, period_id, leaf_index)
  const selUrl = `${creds.url}/rest/v1/daily_claims?select=*` +
    `&pool_kind=eq.${newRow.pool_kind}` +
    `&period_id=eq.${newRow.period_id}` +
    `&leaf_index=eq.${newRow.leaf_index}`;
  const selRes = await _fetch(selUrl, {
    method:  'GET',
    headers: { 'apikey': creds.serviceKey, 'Authorization': `Bearer ${creds.serviceKey}` },
  });
  if (!selRes.ok) throw new Error(`Supabase SELECT failed: HTTP ${selRes.status} ${await selRes.text().catch(()=>'')}`.slice(0, 400));
  const existing = await selRes.json();

  if (Array.isArray(existing) && existing.length > 0) {
    const mismatch = rowsMatch(existing[0], newRow);
    if (mismatch) {
      throw new Error(`CONFLICT for (pool_kind=${newRow.pool_kind}, period_id=${newRow.period_id}, leaf_index=${newRow.leaf_index}): ${mismatch}`);
    }
    return { status: 'skipped_identical' };
  }

  // 2. INSERT (unique constraint at DB gives us a second layer of protection)
  const insRes = await _fetch(`${creds.url}/rest/v1/daily_claims`, {
    method:  'POST',
    headers: {
      'apikey':        creds.serviceKey,
      'Authorization': `Bearer ${creds.serviceKey}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=minimal',
    },
    body: JSON.stringify(newRow),
  });
  if (!insRes.ok) throw new Error(`Supabase INSERT failed: HTTP ${insRes.status} ${await insRes.text().catch(()=>'')}`.slice(0, 400));
  return { status: 'inserted' };
}

// ---------- CLI ------------------------------------------------------------

function parseArgs(argv) {
  const out = { artifact: null, sig: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '--artifact')             out.artifact = argv[++i];
    else if (a === '--settlement-signature') out.sig      = argv[++i];
    else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
    else { console.error(`unknown arg: ${a}`); printHelp(); process.exit(1); }
  }
  return out;
}
function printHelp() {
  console.log(`Usage:
  SUPABASE_SERVICE_ROLE_KEY=... node tools/publish_daily_claims.js \\
    --artifact <path.json> \\
    --settlement-signature <post_settlement tx signature>`);
}
function hdr(s) { console.log('\n== ' + s + ' =='); }

async function cliMain() {
  const args = parseArgs(process.argv);
  if (!args.artifact || !args.sig) { printHelp(); process.exit(1); }

  const raw = fs.readFileSync(args.artifact, 'utf8');
  const artifact = JSON.parse(raw);
  if (typeof artifact.periodId === 'string') artifact.periodId = Number(artifact.periodId);
  validatePublishInput(artifact, args.sig);
  console.log('artifact validated:', {
    pool_kind:    artifact.poolKind,
    period_id:    artifact.periodId,
    winners:      artifact.winnerCount,
    total_payout: artifact.totalPayoutLamports,
    merkle_root:  artifact.merkleRoot,
  });

  hdr('on-chain cross-verify');
  const conn = new Connection(CLUSTERS[CLUSTER], 'finalized');
  const oc = await verifyOnChain({ conn, artifact });
  console.log('period PDA:', oc.periodPda);
  console.log('on-chain match: OK (pool_kind, period_id, merkle_root, total_payout, num_winners, is_finalized)');

  hdr('Supabase publish');
  const creds = resolveCreds();      // reads env; NEVER logs the key
  console.log('target URL:', creds.url);
  console.log('service role key length (chars):', creds.serviceKey.length, '(value NOT printed)');
  let inserted = 0, skipped = 0;
  for (const w of artifact.winners) {
    const row = winnerToRow(artifact, w, args.sig);
    const res = await publishOneRow({ creds, newRow: row });
    if (res.status === 'inserted')          { inserted++; console.log(`  rank ${w.rank} wallet ${w.wallet.slice(0, 12)}...  INSERTED`); }
    else if (res.status === 'skipped_identical') { skipped++; console.log(`  rank ${w.rank} wallet ${w.wallet.slice(0, 12)}...  already present (identical) — SKIPPED`); }
    else                                    { throw new Error(`unexpected status: ${JSON.stringify(res)}`); }
  }
  hdr('DONE');
  console.log(`  inserted:            ${inserted}`);
  console.log(`  skipped (identical): ${skipped}`);
  console.log(`  total:               ${artifact.winners.length}`);
}

module.exports = {
  DEFAULT_SUPABASE_URL,
  validatePublishInput, assertWinnerRow,
  winnerToRow, rowsMatch,
  verifyOnChain, publishOneRow,
  resolveCreds,
};

if (require.main === module) {
  cliMain().catch(e => { console.error('\nERROR:', e && e.message); process.exit(1); });
}
