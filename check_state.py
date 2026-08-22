import json, base64, urllib.request, time

RPC = "https://api.devnet.solana.com"
ALPH = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def b58(b):
    n = int.from_bytes(b, "big"); s = ""
    while n > 0: n, r = divmod(n, 58); s = ALPH[r] + s
    pad = 0
    for c in b:
        if c == 0: pad += 1
        else: break
    return "1" * pad + s

def rpc(method, params):
    req = urllib.request.Request(RPC,
        data=json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode(),
        headers={"Content-Type":"application/json"})
    return json.loads(urllib.request.urlopen(req).read())

# Current Copper Rush program on devnet (V2 = the one copper-beta.html wires
# via COPPER_PROGRAM_ID). Source of truth: tools/copper_rpc_reader.js.
# An older V1 deployment (owner=3e8EsKpaRaHevRLyPdWW73NELqHC1keBD6ZMVrbV2rUF)
# still has orphan VaultState PDAs on-chain but no traffic — do NOT read those.
PROGRAM_ID = "EdYmMfzFidw4epQkBBiEP3bzJLYRGbKe6uqUuqq1Ggsg"
VAULT_STATES = {
    "DAILY":   "4oRyLU9ajheaJM8dz61pSknYBiDRrULw8f964PxhzFE4",
    "WEEKLY":  "DZyKiMBbwDHZGbwweHmvhe8JsaDkDtAUG4hEBDR5qvYo",
    "MONTHLY": "EVi1twXcfeY1wJGDX8FBBKbR2AATdfdq2Fmm5cxNpdZh",
    "JACKPOT": "7sM92MXjKwxmw1U8VQD7KaUiP5mRjeD8oSaJBtgSzCM7",
}
# Vault PDAs (system-owned SOL holders) and operator wallets for V2 are not
# in the trusted source yet — inspect them via `node tools/paid_daily_dry_run.js`
# or a proper Ed25519-aware PDA client. Intentionally omitted here so this
# script never mixes V1 orphan data with V2 authoritative state.

now = int(time.time())
print(f"current Unix time: {now}")
print(f"program: {PROGRAM_ID}\n")
print("=== VaultStates ===")
# VaultState layout: 8 disc + 1 pool_kind + 1 bump + 1 vault_bump + 8 epoch_zero(i64) + 4 period_duration_seconds(u32)
#   + 8 open_period_id(u64) + 8 open_period_collected(u64) + 8 awaiting_settlement_total + 8 obligations_lamports
#   + 8 total_collected_lifetime + 8 total_paid_lifetime + 8 last_seal_at(i64) + 8 last_settlement_at(i64) + 64 reserved
for name, pk in VAULT_STATES.items():
    r = rpc("getAccountInfo", [pk, {"encoding":"base64"}])
    raw = base64.b64decode(r["result"]["value"]["data"][0])
    off = 8
    pool_kind = raw[off]; off += 1
    bump = raw[off]; off += 1
    vault_bump = raw[off]; off += 1
    epoch_zero = int.from_bytes(raw[off:off+8], "little", signed=True); off += 8
    period_dur = int.from_bytes(raw[off:off+4], "little"); off += 4
    open_pid = int.from_bytes(raw[off:off+8], "little"); off += 8
    open_coll = int.from_bytes(raw[off:off+8], "little"); off += 8
    awaiting = int.from_bytes(raw[off:off+8], "little"); off += 8
    obligs = int.from_bytes(raw[off:off+8], "little"); off += 8
    coll_life = int.from_bytes(raw[off:off+8], "little"); off += 8
    paid_life = int.from_bytes(raw[off:off+8], "little"); off += 8
    last_seal = int.from_bytes(raw[off:off+8], "little", signed=True); off += 8
    last_settle = int.from_bytes(raw[off:off+8], "little", signed=True); off += 8
    if period_dur == 0:
        expired = "n/a (jackpot manual)"
    else:
        period_start = epoch_zero + open_pid * period_dur
        period_end = period_start + period_dur
        if now >= period_end:
            expired = f"EXPIRED {now - period_end}s ago — pay_entry will fail with 6309 PayStalePeriod"
        else:
            expired = f"ok, expires in {period_end - now}s"
    print(f"  {name:8s} pool_kind={pool_kind} dur={period_dur:>9d}s open_period_id={open_pid} collected={open_coll} life_collected={coll_life}")
    print(f"           epoch_zero={epoch_zero}, awaiting_settlement_total={awaiting}, obligations={obligs}, paid_lifetime={paid_life}")
    print(f"           expiry: {expired}")

