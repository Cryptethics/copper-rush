// Paid V1 Supabase fetcher — read-only, offline-safe.
// Uses PostgREST via Node 20's built-in fetch. Zero mutations.
//
// SUPABASE_URL + SUPABASE_ANON_KEY are read from env vars first; if unset
// they fall back to the publishable defaults visible in copper-beta.html
// (the ANON key is a publishable client-side key, not a secret).
//
// Public API:
//   fetchPaidScoresInPeriod({ startISO, endISO, url?, anonKey? })
//     -> [{ nickname, wallet, score, created_at }]  (only wallet IS NOT NULL)

'use strict';

const DEFAULT_URL      = 'https://dfcccaxcamnsyaevyhqz.supabase.co';
const DEFAULT_ANON_KEY = 'sb_publishable_ypbtnuzAqQpy4UJ9Fg_frg__LU7Juf8';

function resolveCreds({ url, anonKey } = {}) {
  const u = url      || process.env.SUPABASE_URL      || DEFAULT_URL;
  const k = anonKey  || process.env.SUPABASE_ANON_KEY || DEFAULT_ANON_KEY;
  if (!u) throw new Error('SUPABASE_URL not set');
  if (!k) throw new Error('SUPABASE_ANON_KEY not set');
  return { url: u.replace(/\/+$/, ''), anonKey: k };
}

async function fetchPaidScoresInPeriod({ startISO, endISO, url, anonKey } = {}) {
  if (typeof startISO !== 'string' || !startISO) throw new Error('startISO required');
  if (typeof endISO   !== 'string' || !endISO)   throw new Error('endISO required');
  const creds = resolveCreds({ url, anonKey });

  // PostgREST uses `wallet=not.is.null` for the "IS NOT NULL" predicate.
  const qs = new URLSearchParams({
    select:     'nickname,wallet,score,created_at',
    wallet:     'not.is.null',
    created_at: `gte.${startISO}`,
    order:      'created_at.asc',
    limit:      '5000',
  });
  // Multiple filters on the same column need separate query pairs; append manually.
  const raw = qs.toString() + '&created_at=' + encodeURIComponent(`lt.${endISO}`);

  const res = await fetch(`${creds.url}/rest/v1/scores?${raw}`, {
    method: 'GET',
    headers: {
      'apikey':        creds.anonKey,
      'Authorization': `Bearer ${creds.anonKey}`,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase fetch failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error(`unexpected response shape: ${JSON.stringify(rows).slice(0, 200)}`);
  return rows;
}

// Convenience helper: count of paid rows with wallet in any period (diagnostic).
async function countWalletTaggedPaidRows({ url, anonKey } = {}) {
  const creds = resolveCreds({ url, anonKey });
  const res = await fetch(`${creds.url}/rest/v1/scores?select=id&wallet=not.is.null&limit=1`, {
    method: 'HEAD',
    headers: {
      'apikey':        creds.anonKey,
      'Authorization': `Bearer ${creds.anonKey}`,
      'Prefer':        'count=exact',
      'Range-Unit':    'items',
      'Range':         '0-0',
    },
  });
  if (!res.ok) throw new Error(`count failed: HTTP ${res.status}`);
  const cr = res.headers.get('content-range');   // "0-0/N"  or  "*/0"
  if (!cr) return null;
  const m = cr.match(/\/(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

module.exports = {
  DEFAULT_URL, DEFAULT_ANON_KEY,
  resolveCreds,
  fetchPaidScoresInPeriod,
  countWalletTaggedPaidRows,
};
