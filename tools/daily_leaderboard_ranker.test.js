// Tests for tools/daily_leaderboard_ranker.js — synthetic data only.
// Usage: node tools/daily_leaderboard_ranker.test.js

'use strict';

const { rankDailyLeaderboard, isEligible, compareEntries } = require('./daily_leaderboard_ranker.js');

// ---------- harness ---------------------------------------------------------
let passed = 0, failed = 0;
const failures = [];
function assert(cond, label, ctx) {
  if (cond) { passed++; return; }
  failed++;
  failures.push({ label, ctx });
  console.log(`  FAIL: ${label}` + (ctx ? '  ' + JSON.stringify(ctx) : ''));
}
function assertThrows(fn, matchSubstr, label) {
  try { fn(); assert(false, `${label} — expected throw (${matchSubstr})`, null); }
  catch (e) {
    const msg = String(e && e.message);
    if (msg.includes(matchSubstr)) assert(true, `${label} — threw (${matchSubstr})`);
    else assert(false, `${label} — threw wrong error`, { expected: matchSubstr, got: msg });
  }
}
function section(name) { console.log('\n== ' + name + ' =='); }

// Deterministic shuffle (Fisher-Yates with LCG seed) so test runs are
// reproducible AND the ranker's determinism claim is testable.
function seededShuffle(arr, seed) {
  const out = arr.slice();
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------- test data helpers -----------------------------------------------
function entry(over) {
  // Sensible defaults; override any field per case.
  return Object.assign({
    nickname:   'p0',
    wallet:     'WALLET_p0',
    dailyScore: 1000,
    best3Sum:   900,
    firstRunTs: 1_000_000_000_000,
  }, over || {});
}

// ---------- test 1: level 1 tiebreak (dailyScore DESC) ---------------------
section('test 1 — level 1: dailyScore DESC');
{
  const input = [
    entry({ nickname: 'a', wallet: 'W1', dailyScore: 100 }),
    entry({ nickname: 'b', wallet: 'W2', dailyScore: 300 }),
    entry({ nickname: 'c', wallet: 'W3', dailyScore: 200 }),
  ];
  const out = rankDailyLeaderboard(input);
  assert(out[0].nickname === 'b' && out[0].rank === 1, 'highest dailyScore wins rank 1', out);
  assert(out[1].nickname === 'c' && out[1].rank === 2, 'middle takes rank 2', out);
  assert(out[2].nickname === 'a' && out[2].rank === 3, 'lowest takes rank 3', out);
}

// ---------- test 2: level 2 tiebreak (best3Sum DESC) -----------------------
section('test 2 — level 2: tied dailyScore, best3Sum DESC');
{
  const input = [
    entry({ nickname: 'a', wallet: 'W_A', dailyScore: 1000, best3Sum: 800 }),
    entry({ nickname: 'b', wallet: 'W_B', dailyScore: 1000, best3Sum: 900 }),
    entry({ nickname: 'c', wallet: 'W_C', dailyScore: 1000, best3Sum: 700 }),
  ];
  const out = rankDailyLeaderboard(input);
  assert(out[0].nickname === 'b', 'higher best3Sum wins on dailyScore tie', out);
  assert(out[1].nickname === 'a', 'middle best3Sum', out);
  assert(out[2].nickname === 'c', 'lowest best3Sum', out);
}

// ---------- test 3: level 3 tiebreak (firstRunTs ASC) ----------------------
section('test 3 — level 3: tied dailyScore+best3Sum, firstRunTs ASC (earliest wins)');
{
  const input = [
    entry({ nickname: 'a', wallet: 'W_A', dailyScore: 1000, best3Sum: 900, firstRunTs: 3000 }),
    entry({ nickname: 'b', wallet: 'W_B', dailyScore: 1000, best3Sum: 900, firstRunTs: 1000 }),
    entry({ nickname: 'c', wallet: 'W_C', dailyScore: 1000, best3Sum: 900, firstRunTs: 2000 }),
  ];
  const out = rankDailyLeaderboard(input);
  assert(out[0].nickname === 'b', 'earliest firstRunTs wins', out);
  assert(out[1].nickname === 'c', 'middle firstRunTs', out);
  assert(out[2].nickname === 'a', 'latest firstRunTs last', out);
}

// ---------- test 4: level 4 tiebreak (wallet lex ASC) ---------------------
section('test 4 — level 4: dailyScore+best3Sum+firstRunTs tied, wallet lex ASC');
{
  const input = [
    entry({ nickname: 'x', wallet: 'ZZZ', dailyScore: 1000, best3Sum: 900, firstRunTs: 1000 }),
    entry({ nickname: 'y', wallet: 'AAA', dailyScore: 1000, best3Sum: 900, firstRunTs: 1000 }),
    entry({ nickname: 'z', wallet: 'MMM', dailyScore: 1000, best3Sum: 900, firstRunTs: 1000 }),
  ];
  const out = rankDailyLeaderboard(input);
  assert(out[0].wallet === 'AAA', 'lex-smallest wallet wins final tiebreak', out);
  assert(out[1].wallet === 'MMM', 'middle wallet', out);
  assert(out[2].wallet === 'ZZZ', 'lex-largest wallet last', out);
}

// ---------- test 5: filter — no wallet dropped -----------------------------
section('test 5 — filter: entries with missing/empty wallet dropped');
{
  const input = [
    entry({ nickname: 'ok',       wallet: 'W1',       dailyScore: 100 }),
    entry({ nickname: 'undef',    wallet: undefined,  dailyScore: 200 }),
    entry({ nickname: 'nullw',    wallet: null,       dailyScore: 300 }),
    entry({ nickname: 'empty',    wallet: '',         dailyScore: 400 }),
    entry({ nickname: 'ok2',      wallet: 'W2',       dailyScore: 50 }),
  ];
  const out = rankDailyLeaderboard(input);
  assert(out.length === 2, 'only 2 entries survive wallet filter', out);
  assert(out.every(e => e.wallet && e.wallet.length > 0), 'all output wallets non-empty', out);
  assert(out[0].nickname === 'ok' && out[1].nickname === 'ok2', 'ranks assigned to eligible only', out);
}

// ---------- test 6: filter — Anonymous dropped (case-insensitive) ----------
section('test 6 — filter: nickname "Anonymous" dropped (case-insensitive)');
{
  const input = [
    entry({ nickname: 'alice',      wallet: 'W1', dailyScore: 100 }),
    entry({ nickname: 'Anonymous',  wallet: 'W2', dailyScore: 500 }),
    entry({ nickname: 'ANONYMOUS',  wallet: 'W3', dailyScore: 700 }),
    entry({ nickname: 'anonymous',  wallet: 'W4', dailyScore: 900 }),
    entry({ nickname: '  ',         wallet: 'W5', dailyScore: 999 }),  // empty after trim
    entry({ nickname: '',           wallet: 'W6', dailyScore: 998 }),  // empty
  ];
  const out = rankDailyLeaderboard(input);
  assert(out.length === 1, 'only "alice" survives', out);
  assert(out[0].nickname === 'alice', out[0]);
}

// ---------- test 7: contiguous ranks 1..N ---------------------------------
section('test 7 — output ranks are contiguous 1..N');
{
  const input = [];
  for (let i = 0; i < 50; i++) {
    input.push(entry({
      nickname: 'p' + i, wallet: 'W' + String(i).padStart(3, '0'),
      dailyScore: Math.floor(Math.random() * 10000),
      best3Sum:   Math.floor(Math.random() * 10000),
      firstRunTs: 1_000_000_000_000 + i * 1000,
    }));
  }
  const out = rankDailyLeaderboard(input);
  assert(out.length === 50, '50 entries in output', null);
  for (let i = 0; i < out.length; i++) {
    assert(out[i].rank === i + 1, `rank[${i}] === ${i+1}`, out[i]);
  }
}

// ---------- test 8: empty input & fully-filtered input --------------------
section('test 8 — empty / all-filtered input');
{
  assert(rankDailyLeaderboard([]).length === 0, 'empty input -> empty output', null);

  const allBad = [
    entry({ wallet: null }),
    entry({ nickname: 'anonymous' }),
    entry({ nickname: '', wallet: 'W' }),
  ];
  assert(rankDailyLeaderboard(allBad).length === 0, 'all-filtered -> empty', null);
}

// ---------- test 9: output shape is exactly {rank,wallet,nickname,dailyScore}
section('test 9 — output entry shape');
{
  const out = rankDailyLeaderboard([
    entry({ nickname: 'p1', wallet: 'W1', dailyScore: 100 }),
  ]);
  const keys = Object.keys(out[0]).sort();
  assert(keys.length === 4 && keys.join(',') === 'dailyScore,nickname,rank,wallet',
    'output has exactly {rank,wallet,nickname,dailyScore}', keys);
  assert(!('best3Sum' in out[0]),   'best3Sum not leaked to output', null);
  assert(!('firstRunTs' in out[0]), 'firstRunTs not leaked to output', null);
}

// ---------- test 10: determinism under 200 random shuffles ----------------
section('test 10 — determinism: 200 shuffled orderings all produce identical output');
{
  // Craft an input that exercises every tiebreak level:
  //   - two players tied on dailyScore only (level 2 breaks)
  //   - two tied on dailyScore+best3Sum (level 3 breaks)
  //   - two tied on dailyScore+best3Sum+firstRunTs (level 4 breaks)
  //   - the rest with unique dailyScore
  const base = [
    // unique dailyScore
    entry({ nickname: 'top', wallet: 'W_top', dailyScore: 5000, best3Sum: 4000, firstRunTs: 1_000 }),

    // Level 2 pair (same score, diff best3Sum)
    entry({ nickname: 'l2A', wallet: 'W_l2A', dailyScore: 4000, best3Sum: 3500, firstRunTs: 2_000 }),
    entry({ nickname: 'l2B', wallet: 'W_l2B', dailyScore: 4000, best3Sum: 3200, firstRunTs: 2_500 }),

    // Level 3 pair (same score+best3Sum, diff firstRunTs)
    entry({ nickname: 'l3A', wallet: 'W_l3A', dailyScore: 3000, best3Sum: 2500, firstRunTs: 3_000 }),
    entry({ nickname: 'l3B', wallet: 'W_l3B', dailyScore: 3000, best3Sum: 2500, firstRunTs: 5_000 }),

    // Level 4 pair (all equal, diff wallet lex)
    entry({ nickname: 'l4A', wallet: 'AAA',    dailyScore: 2000, best3Sum: 1500, firstRunTs: 4_000 }),
    entry({ nickname: 'l4B', wallet: 'ZZZ',    dailyScore: 2000, best3Sum: 1500, firstRunTs: 4_000 }),

    // A few unique fillers
    entry({ nickname: 'f1',  wallet: 'W_f1',   dailyScore: 1500, best3Sum: 1000, firstRunTs: 6_000 }),
    entry({ nickname: 'f2',  wallet: 'W_f2',   dailyScore:  700, best3Sum:  500, firstRunTs: 7_000 }),
    entry({ nickname: 'f3',  wallet: 'W_f3',   dailyScore:  100, best3Sum:   80, firstRunTs: 8_000 }),
  ];
  const reference = rankDailyLeaderboard(base);
  const refJson   = JSON.stringify(reference);

  let allIdentical = true;
  for (let seed = 1; seed <= 200; seed++) {
    const shuffled = seededShuffle(base, seed);
    const out = rankDailyLeaderboard(shuffled);
    if (JSON.stringify(out) !== refJson) { allIdentical = false; break; }
  }
  assert(allIdentical, '200 shuffles → identical output', { reference });

  // Sanity: verify the intended tiebreak resolutions in the reference
  const byNick = Object.fromEntries(reference.map(r => [r.nickname, r.rank]));
  assert(byNick.top === 1, 'rank 1 = top', byNick);
  assert(byNick.l2A === 2 && byNick.l2B === 3, 'l2A before l2B (higher best3Sum)', byNick);
  assert(byNick.l3A === 4 && byNick.l3B === 5, 'l3A before l3B (earlier firstRunTs)', byNick);
  assert(byNick.l4A === 6 && byNick.l4B === 7, 'l4A (AAA) before l4B (ZZZ) (lex)', byNick);
}

// ---------- test 11: invalid inputs throw ---------------------------------
section('test 11 — input validation');
{
  assertThrows(() => rankDailyLeaderboard(null),         'must be an array',      'null rejected');
  assertThrows(() => rankDailyLeaderboard('nope'),       'must be an array',      'string rejected');
  assertThrows(() => rankDailyLeaderboard([null]),       'must be an object',     'null entry rejected');
  assertThrows(() => rankDailyLeaderboard([{ ...entry(), dailyScore: -1 }]),
    'dailyScore', 'negative dailyScore rejected');
  assertThrows(() => rankDailyLeaderboard([{ ...entry(), dailyScore: 1.5 }]),
    'dailyScore', 'non-integer dailyScore rejected');
  assertThrows(() => rankDailyLeaderboard([{ ...entry(), best3Sum: -5 }]),
    'best3Sum', 'negative best3Sum rejected');
  assertThrows(() => rankDailyLeaderboard([{ ...entry(), firstRunTs: -1 }]),
    'firstRunTs', 'negative firstRunTs rejected');
  assertThrows(() => rankDailyLeaderboard([{ ...entry(), wallet: 42 }]),
    'wallet must be', 'non-string wallet rejected');
  assertThrows(() => rankDailyLeaderboard([{ ...entry(), nickname: 12 }]),
    'nickname must be', 'non-string nickname rejected');
  // Missing required numeric field
  assertThrows(() => rankDailyLeaderboard([{ nickname: 'x', wallet: 'W', best3Sum: 0, firstRunTs: 0 }]),
    'dailyScore', 'missing dailyScore rejected');
}

// ---------- test 12: input immutability -----------------------------------
section('test 12 — ranker does not mutate its input');
{
  const input = [
    entry({ nickname: 'a', wallet: 'W1', dailyScore: 300 }),
    entry({ nickname: 'b', wallet: 'W2', dailyScore: 100 }),
    entry({ nickname: 'c', wallet: 'W3', dailyScore: 200 }),
  ];
  const snapshot = JSON.stringify(input);
  rankDailyLeaderboard(input);
  assert(JSON.stringify(input) === snapshot, 'input array unchanged', null);
}

// ---------- test 13: single-player edge cases -----------------------------
section('test 13 — single eligible player');
{
  const out = rankDailyLeaderboard([
    entry({ nickname: 'solo', wallet: 'W_solo', dailyScore: 42 }),
  ]);
  assert(out.length === 1 && out[0].rank === 1 && out[0].nickname === 'solo', 'solo -> rank 1', out);
}

// ---------- test 14: mixed filter + tiebreak still deterministic ----------
section('test 14 — filter + tiebreak combined stays deterministic under shuffle');
{
  const base = [
    entry({ nickname: 'ok1',       wallet: 'W_o1',  dailyScore: 500, best3Sum: 400, firstRunTs: 1000 }),
    entry({ nickname: 'anonymous', wallet: 'W_an1', dailyScore: 999 }),
    entry({ nickname: 'ok2',       wallet: 'W_o2',  dailyScore: 500, best3Sum: 400, firstRunTs: 1000 }),  // ties ok1 on all but wallet
    entry({ nickname: 'nowallet',  wallet: null,    dailyScore: 999 }),
    entry({ nickname: 'ok3',       wallet: 'W_o3',  dailyScore: 100 }),
  ];
  const ref = rankDailyLeaderboard(base);
  assert(ref.length === 3, '3 eligible remain', ref);
  // ok1 wallet W_o1 lex-smaller than W_o2 -> ok1 rank 1, ok2 rank 2, ok3 rank 3
  assert(ref[0].nickname === 'ok1' && ref[0].rank === 1, 'ok1 wins wallet-lex tiebreak', ref);
  assert(ref[1].nickname === 'ok2' && ref[1].rank === 2, 'ok2 second', ref);
  assert(ref[2].nickname === 'ok3' && ref[2].rank === 3, 'ok3 third', ref);

  const refJson = JSON.stringify(ref);
  let allSame = true;
  for (let seed = 1; seed <= 50; seed++) {
    const out = rankDailyLeaderboard(seededShuffle(base, seed));
    if (JSON.stringify(out) !== refJson) { allSame = false; break; }
  }
  assert(allSame, '50 shuffles with filter -> identical output', null);
}

// ---------- test 15: compareEntries exported symbol behaves as a total order
section('test 15 — compareEntries is a total order');
{
  const a = entry({ nickname: 'a', wallet: 'W1', dailyScore: 100 });
  const b = entry({ nickname: 'b', wallet: 'W2', dailyScore: 200 });
  assert(compareEntries(a, b) > 0, 'a > b when a has lower dailyScore', null);
  assert(compareEntries(b, a) < 0, 'b < a inverse', null);
  const c = { ...a };
  assert(compareEntries(a, c) === 0, 'identical entries compare equal', null);
}

// ---------- test 16: isEligible exposed for auditability ------------------
section('test 16 — isEligible exposed helper');
{
  assert(isEligible(entry({ nickname: 'p', wallet: 'W' })), 'normal -> eligible', null);
  assert(!isEligible(entry({ nickname: 'p', wallet: null })), 'no wallet -> not eligible', null);
  assert(!isEligible(entry({ nickname: 'Anonymous', wallet: 'W' })), 'anonymous -> not eligible', null);
  assert(!isEligible(entry({ nickname: '', wallet: 'W' })), 'empty nickname -> not eligible', null);
}

// ---------- summary -------------------------------------------------------
console.log('\n== summary ==');
console.log(`assertions: pass=${passed} fail=${failed}`);
if (failed > 0) {
  console.log('\nfailures:');
  for (const f of failures) console.log('  -', f.label, f.ctx == null ? '' : JSON.stringify(f.ctx));
  process.exit(1);
}
