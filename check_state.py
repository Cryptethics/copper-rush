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

VAULT_STATES = {
    "DAILY":   "w8YZd6VcPXRFz4DJQXJoxQY1kofz2dU9wuYkNiCYqvi",
    "WEEKLY":  "6QnrzcuRX83QvVwWQxxHTAA5DcDZg1SuvvcuBTzigcQ4",
    "MONTHLY": "Etf393tpZcukbP9ioYU9snAi9jEki5dauotCB6JsA26d",
    "JACKPOT": "rKLwTJ1WwNzcyrbSikZoHS3bzp2qNm7khjKBA5aHBju",
}
VAULTS = {
    "DAILY":   "4fB3C8rALN3FYb4BCYAbhYfBxq1hE9o3tegV2mGxXd99",
    "WEEKLY":  "FcXvbTzHq9PAAdPcp9A2iADLUr8yYwcN5p6xwDwan8hX",
    "MONTHLY": "5jSZBpV4gcxZqN6iv5XRCcy9pJUnVVtsJgjHvCfx2MUn",
    "JACKPOT": "2Lor277QA8uazot6L2UBQ8ADhrQQUrbMCYZYKSPwU4cn",
}
OPS = {
    "treasury": "6CzmSfWPsy4wj3QBQ1jH8CJVULeHQRXbmK6fNPCX5V65",
    "dev":      "HaAShEiX69acKB56FEFHMrC3zJfuc5d2AXFuJVR6i2YS",
    "burn":     "Euarr1Pu3LMPWgZRcwUYEcjwfE6FzJ5W5wsN8Wm6AD39",
}

now = int(time.time())
print(f"current Unix time: {now}\n")
print("=== VaultStates ===")
# VaultState layout: 8 disc + 1 pool_kind + 1 bump + 1 vault_bump + 8 epoch_zero(i64) + 8 period_duration_seconds(u64)
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
    period_dur = int.from_bytes(raw[off:off+8], "little"); off += 8
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
    print(f"           epoch_zero={epoch_zero}, expiry: {expired}")

print("\n=== Vault balances (lamports) ===")
for name, pk in VAULTS.items():
    r = rpc("getBalance", [pk])
    bal = r["result"]["value"]
    rent_floor = 890880  # 0-byte system account rent-exempt
    excess = bal - rent_floor
    print(f"  vault_{name:8s} {pk[:12]}... balance={bal:>10d}   (excess over rent ={excess})")

print("\n=== Operator wallets (lamports) ===")
for name, pk in OPS.items():
    r = rpc("getBalance", [pk])
    bal = r["result"]["value"]
    print(f"  {name:8s} {pk[:12]}... balance={bal:>10d}")
