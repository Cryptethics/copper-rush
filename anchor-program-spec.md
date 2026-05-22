# Copper Rush — Anchor Program MVP Specification

**Status:** Spec locked. No Rust code written yet.
**Target:** Solana program (Anchor framework) for trust-minimized prize-pool payouts.
**Scope:** 10 instructions (4 runtime + 6 admin/init). Merkle-based payouts. Per-pool reward vaults.

---

## Table of Contents

1. [Design rules (locked)](#1-design-rules-locked)
2. [Pause policy](#2-pause-policy)
3. [Shared constants](#3-shared-constants)
4. [PDA seeds reference](#4-pda-seeds-reference)
5. [Account layouts](#5-account-layouts)
6. [Runtime instructions](#6-runtime-instructions)
   - 6.1 `pay_entry`
   - 6.2 `seal_period`
   - 6.3 `post_settlement`
   - 6.4 `claim`
7. [Admin / init instructions](#7-admin--init-instructions)
   - 7.1 `init_config`
   - 7.2 `init_pool`
   - 7.3 `set_paused`
   - 7.4 `update_treasury_addrs`
   - 7.5 `propose_admin` / `accept_admin`
   - 7.6 `advance_jackpot_round`
8. [Error code map](#8-error-code-map)
9. [Lifecycle test scenarios](#9-lifecycle-test-scenarios)
10. [Implementation order](#10-implementation-order)

---

## 1. Design rules (locked)

These 7 rules govern every instruction below. Any future change requires an explicit revision of this document.

1. **Hashing — SHA-256 only.**
   - Leaf preimage: `[0x00] || pool_kind_u8 || period_id_u64_le || winner_pubkey_32 || amount_u64_le || leaf_index_u32_le`
   - Internal node preimage: `[0x01] || min(left, right) || max(left, right)` (sorted-pair, commutative)

2. **Vault model.** Reward vaults are **system-owned PDAs** holding SOL only (no data). Outbound transfers MUST use `system_program::transfer` with `invoke_signed`. NO direct lamport manipulation.

3. **Per-pool separation.**
   - Vault seeds: `[b"vault", pool_kind]`
   - VaultState seeds: `[b"vault_state", pool_kind]`
   - Each of the 4 pools (daily/weekly/monthly/jackpot) has its own pair.

4. **ClaimMarker seeds.** `[b"claim", period_pda.key(), leaf_index_le]`. `leaf_index` is mandatory and unique. The `winner` is intentionally **NOT** in the seeds — it is already pinned in the leaf hash, so binding it again in seeds is redundant and would clutter the seed space.

5. **Claim is pause-immune.** `claim` MUST work even if `config.paused == true`.

6. **Settlement equality.** `Period.total_payout == PendingSettlement.total_collected` strict equality. No dust to operator side, no rollover, no expiry, no partial settlement.

7. **Proof bounds.** `MAX_PROOF_LEN = 24` (≤ 2^24 winners per period). Sorted-pair hashing.

---

## 2. Pause policy

**Only `pay_entry` is gated by `config.paused`.** Pause exists to halt new economic intake; it MUST NOT block:

| Instruction | Pause-respected? |
|---|---|
| `pay_entry` | **YES** — blocked when paused |
| `seal_period` | no |
| `post_settlement` | no |
| `claim` | no |
| `advance_jackpot_round` | no |
| `init_config` | n/a (config doesn't exist yet) |
| `init_pool` | no |
| `set_paused` | no (must always work — it's the lever) |
| `update_treasury_addrs` | no |
| `propose_admin` | no |
| `accept_admin` | no |

Rationale: pause must never become a footgun that locks admin out of recovery, nor block users from collecting rewards already owed to them.

---

## 3. Shared constants

```rust
// pool kinds
const POOL_DAILY:   u8 = 0;
const POOL_WEEKLY:  u8 = 1;
const POOL_MONTHLY: u8 = 2;
const POOL_JACKPOT: u8 = 3;
const NUM_POOLS:    usize = 4;

// merkle
const MAX_PROOF_LEN:  usize = 24;
const DOMAIN_LEAF:    u8 = 0x00;
const DOMAIN_NODE:    u8 = 0x01;

// split
const SPLIT_BPS: [u32; 7] = [3500, 2500, 500, 500, 2000, 500, 500];
//                          [daily, weekly, monthly, jackpot, treasury, dev, burn]
const TOTAL_BPS: u32      = 10_000;

// pool durations (3 of 4 pools auto-rotate)
const DAILY_DURATION_SECONDS:   u32 =    86_400;   // 1 day
const WEEKLY_DURATION_SECONDS:  u32 =   604_800;   // 7 days
const MONTHLY_DURATION_SECONDS: u32 = 2_592_000;   // 30 days

// jackpot rotation: MANUAL ONLY in MVP
//   - VaultState.period_duration_seconds = 0 sentinel
//   - VaultState.open_period_id = current jackpot_round_id
//   - admin advances rounds via `advance_jackpot_round`
const MANUAL_ROTATION_SENTINEL: u32 = 0;

// seed prefixes
const SEED_CONFIG:  &[u8] = b"config";
const SEED_VAULT:   &[u8] = b"vault";
const SEED_VS:      &[u8] = b"vault_state";
const SEED_PENDING: &[u8] = b"pending";
const SEED_PERIOD:  &[u8] = b"period";
const SEED_CLAIM:   &[u8] = b"claim";
```

**Splits are program constants, not config-driven.** Admin cannot redirect funds without a visible program upgrade.

---

## 4. PDA seeds reference

| PDA | Seeds | Owner | Has data? |
|---|---|---|---|
| `Config` | `[SEED_CONFIG]` | program | yes |
| `Vault` (per pool) | `[SEED_VAULT, &[pool_kind]]` | **System Program** | no |
| `VaultState` (per pool) | `[SEED_VS, &[pool_kind]]` | program | yes |
| `PendingSettlement` (per pool, per period) | `[SEED_PENDING, &[pool_kind], &period_id.to_le_bytes()]` | program | yes |
| `Period` (per pool, per period) | `[SEED_PERIOD, &[pool_kind], &period_id.to_le_bytes()]` | program | yes |
| `ClaimMarker` (per period, per leaf) | `[SEED_CLAIM, period.key().as_ref(), &leaf_index.to_le_bytes()]` | program | yes |

`Vault` is the only System-owned PDA; everything else is program-owned.

---

## 5. Account layouts

Sizes include the 8-byte Anchor discriminator. Rent estimates use `(data_size + 128) * 6960` lamports.

### 5.1 `Config` (singleton, 210 bytes, ~0.00235 SOL one-time)

```rust
#[account]
pub struct Config {
    pub admin:            Pubkey,    // 32
    pub treasury_pubkey:  Pubkey,    // 32
    pub dev_pubkey:       Pubkey,    // 32
    pub burn_pubkey:      Pubkey,    // 32
    pub entry_fee:        u64,       //  8
    pub paused:           bool,      //  1
    pub bump:             u8,        //  1
    pub pending_admin:    Pubkey,    // 32 — Pubkey::default() = no pending
    pub _reserved:        [u8; 32],  // 32
}
```

### 5.2 `Vault` (per pool × 4, 0 data bytes, ~0.00089 SOL each)

System-owned, no struct, holds SOL only. Created via manual `system_program::create_account` CPI in `init_pool`.

**Invariant (post every successful instruction):**
`vault.lamports() >= rent_exempt(0) + vault_state.awaiting_settlement_total + vault_state.obligations_lamports`

### 5.3 `VaultState` (per pool × 4, 151 bytes, ~0.00194 SOL each)

```rust
#[account]
pub struct VaultState {
    pub pool_kind:                   u8,        //  1
    pub bump:                        u8,        //  1
    pub vault_bump:                  u8,        //  1

    pub epoch_zero:                  i64,       //  8 — set at init_pool, irrelevant if duration == 0
    pub period_duration_seconds:     u32,       //  4 — 0 = MANUAL_ROTATION_SENTINEL (jackpot)

    pub open_period_id:              u64,       //  8 — for jackpot, this is jackpot_round_id
    pub open_period_collected:       u64,       //  8

    pub awaiting_settlement_total:   u64,       //  8 — sum of unposted PendingSettlements
    pub obligations_lamports:        u64,       //  8 — sum of (Period.total_payout - claimed_so_far)

    pub total_collected_lifetime:    u64,       //  8 — monotonic, observability
    pub total_paid_lifetime:         u64,       //  8

    pub last_seal_at:                i64,       //  8
    pub last_settlement_at:          i64,       //  8

    pub _reserved:                   [u8; 64],  // 64
}
```

### 5.4 `PendingSettlement` (transient, 98 bytes, ~0.00157 SOL refundable)

```rust
#[account]
pub struct PendingSettlement {
    pub pool_kind:        u8,        //  1
    pub bump:             u8,        //  1
    pub period_id:        u64,       //  8
    pub total_collected:  u64,       //  8 — frozen at seal time
    pub rent_payer:       Pubkey,    // 32 — receives rent on close
    pub sealed_at:        i64,       //  8
    pub _reserved:        [u8; 32],  // 32
}
```

Lifecycle: created by `seal_period` (or `advance_jackpot_round`) iff `open_period_collected > 0`; closed by `post_settlement` with rent → `rent_payer`.

### 5.5 `Period` (permanent, 115 bytes, ~0.00169 SOL non-refundable)

```rust
#[account]
pub struct Period {
    pub pool_kind:        u8,        //  1
    pub bump:             u8,        //  1
    pub period_id:        u64,       //  8
    pub merkle_root:      [u8; 32],  // 32
    pub total_payout:     u64,       //  8 — strict-equal to PendingSettlement.total_collected
    pub claimed_so_far:   u64,       //  8 — increases on each claim
    pub num_winners:      u32,       //  4
    pub num_claimed:      u32,       //  4 — incremented by claim
    pub is_finalized:     bool,      //  1 — true after post_settlement; never unset
    pub posted_at:        i64,       //  8
    pub _reserved:        [u8; 32],  // 32
}
```

**Invariants:**
- `is_finalized == true` always (set at init).
- `claimed_so_far ≤ total_payout`.
- `num_claimed ≤ num_winners`.
- `total_payout > 0` (empty periods never become Period — strict equality with non-zero PendingSettlement).
- `merkle_root != [0u8; 32]`.

### 5.6 `ClaimMarker` (permanent, 109 bytes, ~0.00165 SOL non-refundable)

```rust
#[account]
pub struct ClaimMarker {
    pub bump:         u8,        //  1
    pub period:       Pubkey,    // 32
    pub winner:       Pubkey,    // 32
    pub leaf_index:   u32,       //  4
    pub amount:       u64,       //  8
    pub claimed_at:   i64,       //  8
    pub _reserved:    [u8; 16],  // 16
}
```

Existence is the dedupe sentinel — `init` constraint blocks double-claim.

### 5.7 Total rent footprint

**One-time (program init):** ~0.0137 SOL (Config + 4 × VaultState + 4 × Vault).

**Per-period permanent burn:**
- 1 Period: 0.00169 SOL
- N ClaimMarkers: 0.00165 SOL × N

**Annual estimate (illustrative):** daily pool with 10 winners/day claiming → ~6.6 SOL/year permanent rent.

---

## 6. Runtime instructions

### 6.1 `pay_entry`

Sole inbound path. Splits the entry fee 7 ways atomically.

#### Arguments

```
pay_entry(
    ctx,
    run_id:           [u8; 16],   // client-generated unique-per-run id
    expected_amount:  u64,        // race guard against config.entry_fee changes
)
```

**NOT arguments:** entry fee value (read from config), split percentages (program constants), pool_kind (no single pool — instruction touches all 4), treasury/dev/burn addresses (read from config and validated).

#### Accounts

| Account | Type | Mut | Signer | Seeds / Constraint |
|---|---|---|---|---|
| `player` | `Signer` | yes | yes | — |
| `config` | `Account<Config>` | no | no | `[SEED_CONFIG]`, bump |
| `vault_daily` | `SystemAccount` | yes | no | `[SEED_VAULT, &[POOL_DAILY]]` |
| `vault_weekly` | `SystemAccount` | yes | no | `[SEED_VAULT, &[POOL_WEEKLY]]` |
| `vault_monthly` | `SystemAccount` | yes | no | `[SEED_VAULT, &[POOL_MONTHLY]]` |
| `vault_jackpot` | `SystemAccount` | yes | no | `[SEED_VAULT, &[POOL_JACKPOT]]` |
| `vault_state_daily` | `Account<VaultState>` | yes | no | `[SEED_VS, &[POOL_DAILY]]`, bump |
| `vault_state_weekly` | `Account<VaultState>` | yes | no | `[SEED_VS, &[POOL_WEEKLY]]`, bump |
| `vault_state_monthly` | `Account<VaultState>` | yes | no | `[SEED_VS, &[POOL_MONTHLY]]`, bump |
| `vault_state_jackpot` | `Account<VaultState>` | yes | no | `[SEED_VS, &[POOL_JACKPOT]]`, bump |
| `treasury_wallet` | `SystemAccount` | yes | no | `key() == config.treasury_pubkey` |
| `dev_wallet` | `SystemAccount` | yes | no | `key() == config.dev_pubkey` |
| `burn_wallet` | `SystemAccount` | yes | no | `key() == config.burn_pubkey` |
| `system_program` | `Program<System>` | no | no | — |

Total: 14 accounts.

#### Execution flow

```
Step 0 — Anchor preamble: verify all seeds + treasury/dev/burn matches.

Step 1 — Pause gate (canonical economic-intake gate):
   require !config.paused                                     else Paused

Step 2 — Entry fee validation:
   fee = config.entry_fee
   require fee > 0                                            else InvalidEntryFee
   require fee == expected_amount                             else WrongEntryFee

Step 3 — Defensive split-bps check (compile-time constants):
   require SPLIT_BPS.iter().sum::<u32>() == TOTAL_BPS         else SplitBpsInvalid

Step 4 — Compute splits (player-side dust rule):
   daily_floor = fee.checked_mul(3500)? / 10_000
   weekly      = fee.checked_mul(2500)? / 10_000
   monthly     = fee.checked_mul( 500)? / 10_000
   jackpot     = fee.checked_mul( 500)? / 10_000
   treasury    = fee.checked_mul(2000)? / 10_000
   dev         = fee.checked_mul( 500)? / 10_000
   burn        = fee.checked_mul( 500)? / 10_000

   remainder = fee.checked_sub(
                 daily_floor + weekly + monthly + jackpot + treasury + dev + burn
               )?
               // bounded 0..=6 lamports

   daily = daily_floor.checked_add(remainder)?
   // dust attributed to daily pool (player side); never to operator side

   require daily + weekly + monthly + jackpot + treasury + dev + burn == fee
                                                              else SplitMismatch

Step 5 — Verify all 4 pools current:
   now = Clock::get()?.unix_timestamp
   for vs in [vault_state_daily, weekly, monthly, jackpot]:
       if vs.period_duration_seconds == 0:
           // jackpot: manual rotation, skip period-current check
           continue;
       delta             = now.checked_sub(vs.epoch_zero)?
                              .try_into::<u64>()              else ClockBeforeEpochZero
       current_period_id = delta / vs.period_duration_seconds as u64
       require vs.open_period_id == current_period_id         else StalePeriod

Step 6 — Atomic transfers (7 system_program::transfer CPIs from player):
   transfer(player → vault_daily,    daily)
   transfer(player → vault_weekly,   weekly)
   transfer(player → vault_monthly,  monthly)
   transfer(player → vault_jackpot,  jackpot)
   transfer(player → treasury_wallet,treasury)
   transfer(player → dev_wallet,     dev)
   transfer(player → burn_wallet,    burn)

Step 7 — Update each vault_state (checked):
   for (vs, share) in [(daily_vs, daily), (weekly_vs, weekly),
                       (monthly_vs, monthly), (jackpot_vs, jackpot)]:
       vs.open_period_collected     = vs.open_period_collected
                                        .checked_add(share)?
       vs.total_collected_lifetime  = vs.total_collected_lifetime
                                        .checked_add(share)?

Step 8 — Emit EntryPaid (see event below).
```

#### Replay / duplicate `run_id`

**Off-chain only.** No on-chain `RunMarker` PDA. Reasoning:
- A user gains nothing economic from replaying a `run_id` — they pay a full fee again, all pools receive their split.
- On-chain dedupe would create permanent rent burn proportional to game volume.
- The leaderboard already needs `run_id` uniqueness; events provide the dedupe key.

#### Errors (block 6300)

```
Paused                  = 6300,
InvalidEntryFee         = 6301,
WrongEntryFee           = 6302,
SplitBpsInvalid         = 6303,
SplitMismatch           = 6304,
TreasuryWalletMismatch  = 6305,
DevWalletMismatch       = 6306,
BurnWalletMismatch      = 6307,
ClockBeforeEpochZero    = 6308,
StalePeriod             = 6309,
ArithmeticOverflow      = 6310,
```

#### Event `EntryPaid`

```rust
#[event]
pub struct EntryPaid {
    pub player:               Pubkey,
    pub run_id:               [u8; 16],
    pub paid_at:              i64,
    pub entry_fee:            u64,
    pub rounding_remainder:   u64,        // 0..=6; INCLUDED in share_daily

    pub share_daily:          u64,        // = daily_floor + rounding_remainder
    pub share_weekly:         u64,
    pub share_monthly:        u64,
    pub share_jackpot:        u64,
    pub share_treasury:       u64,
    pub share_dev:            u64,
    pub share_burn:           u64,

    pub period_id_daily:      u64,
    pub period_id_weekly:     u64,
    pub period_id_monthly:    u64,
    pub period_id_jackpot:    u64,        // = current jackpot_round_id

    pub open_collected_after_daily:    u64,
    pub open_collected_after_weekly:   u64,
    pub open_collected_after_monthly:  u64,
    pub open_collected_after_jackpot:  u64,

    pub lifetime_after_daily:   u64,
    pub lifetime_after_weekly:  u64,
    pub lifetime_after_monthly: u64,
    pub lifetime_after_jackpot: u64,
}
```

---

### 6.2 `seal_period`

Permissionless. Auto-rotation pools only (daily/weekly/monthly). Closes the open period if expired; creates `PendingSettlement` iff non-empty.

#### Arguments

```
seal_period(ctx, pool_kind: u8, expected_open_period_id: u64)
```

`expected_open_period_id` serves both PDA seed derivation and race-guard against concurrent callers.

#### Accounts

| Account | Type | Mut | Signer | Seeds / Constraint |
|---|---|---|---|---|
| `caller` | `Signer` | yes (pays rent if pending created) | yes | — |
| `vault_state` | `Account<VaultState>` | yes | no | `[SEED_VS, &[pool_kind]]`, `vault_state.open_period_id == expected_open_period_id` |
| `pending_settlement` | `UncheckedAccount` | yes (manually created in branch A) | no | `[SEED_PENDING, &[pool_kind], &expected_open_period_id.to_le_bytes()]` |
| `system_program` | `Program<System>` | no | no | — |

#### Execution flow

```
Step 0 — Anchor preamble (seeds + expected_open_period_id match).

Step 0.5 — Auto-rotation gate:
   require vault_state.period_duration_seconds != 0           else ManualRotationOnly

Step 1 — Pause check: NONE (Rule 1).

Step 2 — Compute current_period_id:
   now = Clock::get()?.unix_timestamp
   delta = now.checked_sub(vault_state.epoch_zero)?
              .try_into::<u64>()                              else ClockBeforeEpochZero
   current_period_id = delta / vault_state.period_duration_seconds as u64

Step 3 — Expiration gate:
   require vault_state.open_period_id < current_period_id     else NotExpired

Step 4 — Manual PDA verification + branch:
   (bump_pending, derived) = find_program_address(
       &[SEED_PENDING, &[pool_kind], &expected_open_period_id.to_le_bytes()],
       &program_id
   )
   require derived == pending_settlement.key()                else PdaMismatch

   IF vault_state.open_period_collected > 0:
       --- Branch A (non-empty) ---
       require pending_settlement.lamports() == 0
            && pending_settlement.data_is_empty()             else PendingAlreadyExists

       CPI system_program::create_account(
           from = caller, to = pending_settlement,
           lamports = rent_exempt(8 + PendingSettlement::LEN),
           space    = 8 + PendingSettlement::LEN,
           owner    = program_id,
           signer_seeds = [SEED_PENDING, &[pool_kind],
                           &expected_open_period_id.to_le_bytes(),
                           &[bump_pending]],
       )

       pending.pool_kind        = pool_kind
       pending.period_id        = vault_state.open_period_id
       pending.total_collected  = vault_state.open_period_collected
       pending.rent_payer       = caller.key()
       pending.sealed_at        = now
       pending.bump             = bump_pending

       vault_state.awaiting_settlement_total =
           vault_state.awaiting_settlement_total
              .checked_add(vault_state.open_period_collected)? // ArithmeticOverflow

   ELSE:
       --- Branch B (empty period) ---
       require pending_settlement.lamports() == 0
            && pending_settlement.data_is_empty()             else PendingShouldNotExist
       // no creation; no PendingSettlement ever exists for this period_id

Step 5 — Advance vault_state:
   sealed_period_id        = vault_state.open_period_id
   sealed_period_collected = vault_state.open_period_collected
   skipped = (current_period_id - sealed_period_id - 1) as u32
            // ≥ 1 only if seal was multiple periods late

   vault_state.open_period_id        = current_period_id
   vault_state.open_period_collected = 0
   vault_state.last_seal_at          = now

Step 6 — Emit PeriodSealed.
```

**Skipped empty periods absorbed:** since `pay_entry` rejects when `open_period_id != current_period_id` (auto pools), gap periods have zero contributions by construction. Advancing directly to `current_period_id` is sound.

#### Errors (block 6200)

```
NotExpired              = 6200,
ExpectedPeriodMismatch  = 6201,
PdaMismatch             = 6202,
PendingAlreadyExists    = 6203,
PendingShouldNotExist   = 6204,
ArithmeticOverflow      = 6205,
ClockBeforeEpochZero    = 6206,
ManualRotationOnly      = 6207,
```

#### Event `PeriodSealed`

```rust
#[event]
pub struct PeriodSealed {
    pub caller:                    Pubkey,
    pub pool_kind:                 u8,
    pub sealed_period_id:          u64,
    pub sealed_period_collected:   u64,             // 0 in branch B
    pub pending_settlement:        Option<Pubkey>,  // None in branch B
    pub rent_paid_by_caller:       u64,
    pub new_open_period_id:        u64,
    pub skipped_empty_periods:     u32,
    pub vault_awaiting_after:      u64,
    pub vault_obligations_after:   u64,
    pub sealed_at:                 i64,
}
```

---

### 6.3 `post_settlement`

Admin-only. Creates `Period` PDA from a `PendingSettlement`; publishes the Merkle root.

#### Arguments

```
post_settlement(
    ctx,
    pool_kind:    u8,
    period_id:    u64,
    merkle_root:  [u8; 32],
    total_payout: u64,         // MUST equal pending.total_collected
    num_winners:  u32,
)
```

#### Accounts

| Account | Type | Mut | Signer | Seeds / Constraint |
|---|---|---|---|---|
| `admin` | `Signer` | yes (pays Period rent) | yes | — |
| `config` | `Account<Config>` | no | no | `config.admin == admin.key()` |
| `vault_state` | `Account<VaultState>` | yes | no | `[SEED_VS, &[pool_kind]]` |
| `pending_settlement` | `Account<PendingSettlement>` | yes (closed) | no | `[SEED_PENDING, &[pool_kind], &period_id.to_le_bytes()]`, `close = rent_payer` |
| `period` | `Account<Period>` | yes (`init`) | no | `[SEED_PERIOD, &[pool_kind], &period_id.to_le_bytes()]`, `init, payer = admin` |
| `rent_payer` | `SystemAccount` | yes | no | `key() == pending.rent_payer` |
| `system_program` | `Program<System>` | no | no | — |

**Note:** `vault` is NOT in the accounts list. Settlement is pure accounting; lamports stay put.

#### Execution flow

```
Step 0 — Anchor preamble (admin gate, seeds, init period, rent_payer match).

Step 1 — Pause: NOT consulted.

Step 2 — Cheap arg validation:
   require num_winners > 0                                    else NoWinners
   require num_winners as u64 <= 1u64 << MAX_PROOF_LEN        else TreeTooLarge
   require merkle_root != [0u8; 32]                           else EmptyRoot

Step 3 — Settlement equality (the core invariant):
   require total_payout == pending.total_collected            else PayoutMismatch

Step 4 — Initialize Period:
   period.pool_kind        = pool_kind
   period.period_id        = period_id
   period.merkle_root      = merkle_root
   period.total_payout     = total_payout
   period.claimed_so_far   = 0
   period.num_winners      = num_winners
   period.num_claimed      = 0
   period.is_finalized     = true
   period.posted_at        = Clock::get()?.unix_timestamp
   period.bump             = ctx.bumps.period

Step 5 — Update vault_state:
   new_awaiting    = vault_state.awaiting_settlement_total
                       .checked_sub(pending.total_collected)? // AwaitingUnderflow
   new_obligations = vault_state.obligations_lamports
                       .checked_add(total_payout)?            // ArithmeticOverflow

   vault_state.awaiting_settlement_total = new_awaiting
   vault_state.obligations_lamports      = new_obligations
   vault_state.last_settlement_at        = now

   Sanity (advisory):
   require vault.lamports() >= new_awaiting + new_obligations + rent_exempt(0)
                                                              else SolvencyViolation

Step 6 — Close pending_settlement (Anchor `close = rent_payer` runs at handler return).

Step 7 — Emit SettlementPosted.
```

#### Errors (block 6100)

```
NotAuthorized          = 6100,
PoolMismatch           = 6101,
PeriodIdMismatch       = 6102,
RentPayerMismatch      = 6103,
AlreadySettled         = 6104,  // raw Anchor "account in use" on period init
NoWinners              = 6105,
TreeTooLarge           = 6106,
EmptyRoot              = 6107,
PayoutMismatch         = 6108,
AwaitingUnderflow      = 6109,
ArithmeticOverflow     = 6110,
SolvencyViolation      = 6111,
```

#### Event `SettlementPosted`

```rust
#[event]
pub struct SettlementPosted {
    pub admin:                  Pubkey,
    pub period:                 Pubkey,
    pub pool_kind:              u8,
    pub period_id:              u64,
    pub merkle_root:            [u8; 32],
    pub total_payout:           u64,
    pub num_winners:            u32,
    pub vault_awaiting_after:   u64,
    pub vault_obligations_after:u64,
    pub rent_payer:             Pubkey,
    pub rent_returned_lamports: u64,
    pub posted_at:              i64,
}
```

---

### 6.4 `claim`

Winner-signed. Verifies Merkle proof, increments counters, transfers from vault.

#### Arguments

```
claim(
    ctx,
    pool_kind:  u8,
    period_id:  u64,
    leaf_index: u32,
    amount:     u64,
    proof:      Vec<[u8; 32]>,
)
```

`winner` is read from signer (NOT an arg). All identifiers are baked into the leaf hash.

#### Accounts

| Account | Type | Mut | Signer | Seeds / Constraint |
|---|---|---|---|---|
| `winner` | `Signer` | yes | yes | — |
| `period` | `Account<Period>` | yes | no | `[SEED_PERIOD, &[pool_kind], &period_id.to_le_bytes()]`, `is_finalized`, `pool_kind == pool_kind` |
| `claim_marker` | `Account<ClaimMarker>` | yes (`init`) | no | `[SEED_CLAIM, period.key().as_ref(), &leaf_index.to_le_bytes()]`, `payer = winner` |
| `vault_state` | `Account<VaultState>` | yes | no | `[SEED_VS, &[pool_kind]]` |
| `vault` | `SystemAccount` | yes | no | `[SEED_VAULT, &[pool_kind]]` |
| `system_program` | `Program<System>` | no | no | — |

#### Execution flow

```
Step 0 — Anchor preamble (seeds, period.is_finalized, init claim_marker = AlreadyClaimed gate).

Step 1 — Pause check: NONE (Rule 5).

Step 2 — Cheap arg validation:
   require amount > 0                                         else InvalidAmount
   require proof.len() <= MAX_PROOF_LEN (24)                  else ProofTooLong

Step 3 — Reconstruct leaf (SHA-256):
   leaf_preimage =
       [DOMAIN_LEAF (0x00)]
       || pool_kind                  (1 byte)
       || period_id.to_le_bytes()    (8)
       || winner.key().to_bytes()    (32)
       || amount.to_le_bytes()       (8)
       || leaf_index.to_le_bytes()   (4)
   leaf = sha256(leaf_preimage)

Step 4 — Walk proof up (sorted-pair, commutative):
   current = leaf
   for sibling in proof:
       (lo, hi) = sort_lex(current, sibling)
       node_preimage = [DOMAIN_NODE (0x01)] || lo || hi
       current = sha256(node_preimage)
   require current == period.merkle_root                      else InvalidProof

Step 5 — Period accounting:
   new_claimed = period.claimed_so_far.checked_add(amount)?
   require new_claimed <= period.total_payout                 else OverPeriodBudget
   require period.num_claimed < period.num_winners            else AllWinnersClaimed

Step 6 — Vault solvency:
   new_obligations = vault_state.obligations_lamports
                       .checked_sub(amount)?                  else InsufficientObligations
   require vault.lamports() >= amount + rent_exempt(0)        else VaultUnderfunded

Step 7 — Persist mutations:
   claim_marker.period      = period.key()
   claim_marker.winner      = winner.key()
   claim_marker.leaf_index  = leaf_index
   claim_marker.amount      = amount
   claim_marker.claimed_at  = Clock::get()?.unix_timestamp
   claim_marker.bump        = ctx.bumps.claim_marker

   period.claimed_so_far = new_claimed
   period.num_claimed    = period.num_claimed.checked_add(1)?

   vault_state.obligations_lamports  = new_obligations
   vault_state.total_paid_lifetime   = vault_state.total_paid_lifetime
                                          .checked_add(amount)?

Step 8 — Pay out via CPI (vault PDA signs for itself):
   signer_seeds = [SEED_VAULT, &[pool_kind], &[vault_state.vault_bump]]
   system_program::transfer(
       from = vault, to = winner, lamports = amount,
   ) with invoke_signed(&[signer_seeds])

Step 9 — Emit ClaimEvent.
```

#### Errors (block 6000)

```
InvalidAmount             = 6000,
ProofTooLong              = 6001,
InvalidProof              = 6002,
PeriodNotFinalized        = 6003,
PeriodMismatch            = 6004,
OverPeriodBudget          = 6005,
InsufficientObligations   = 6006,
VaultUnderfunded          = 6007,
AlreadyClaimed            = 6008,  // raw Anchor "account in use" on claim_marker init
ArithmeticOverflow        = 6009,
AllWinnersClaimed         = 6010,
```

#### Event `ClaimEvent`

```rust
#[event]
pub struct ClaimEvent {
    pub winner:                       Pubkey,
    pub period:                       Pubkey,
    pub pool_kind:                    u8,
    pub period_id:                    u64,
    pub leaf_index:                   u32,
    pub amount:                       u64,
    pub period_claimed_so_far_after:  u64,
    pub period_num_claimed_after:     u32,
    pub period_total_payout:          u64,
    pub vault_obligations_after:      u64,
    pub vault_total_paid_lifetime:    u64,
    pub timestamp:                    i64,
}
```

---

## 7. Admin / init instructions

### 7.1 `init_config`

Bootstrap. Gated by program upgrade authority.

#### Arguments

```
init_config(
    ctx,
    admin:            Pubkey,
    treasury_pubkey:  Pubkey,
    dev_pubkey:       Pubkey,
    burn_pubkey:      Pubkey,
    entry_fee:        u64,
)
```

#### Accounts

| Account | Type | Mut | Signer | Constraint |
|---|---|---|---|---|
| `payer` | `Signer` | yes | yes | should be program upgrade authority |
| `program_data` | `Account<ProgramData>` | no | no | `upgrade_authority_address == Some(payer.key())` |
| `config` | `Account<Config>` | yes (`init`) | no | `[SEED_CONFIG]`, `init, payer = payer` |
| `system_program` | `Program<System>` | no | no | — |

#### Execution flow

```
Step 0 — Anchor preamble (init config, upgrade authority match).

Step 1 — Validate non-zero pubkeys:
   require admin            != Pubkey::default()              else InvalidAdmin
   require treasury_pubkey  != Pubkey::default()              else InvalidTreasury
   require dev_pubkey       != Pubkey::default()              else InvalidDev
   require burn_pubkey      != Pubkey::default()              else InvalidBurn
   require entry_fee > 0                                      else InvalidEntryFee

Step 2 — Anti-aliasing (operator wallets must be distinct):
   require treasury_pubkey != dev_pubkey                      else AddrAliasing
   require treasury_pubkey != burn_pubkey                     else AddrAliasing
   require dev_pubkey      != burn_pubkey                     else AddrAliasing

Step 3 — Initialize Config:
   config.admin            = admin
   config.treasury_pubkey  = treasury_pubkey
   config.dev_pubkey       = dev_pubkey
   config.burn_pubkey      = burn_pubkey
   config.entry_fee        = entry_fee
   config.paused           = false
   config.pending_admin    = Pubkey::default()
   config.bump             = ctx.bumps.config

Step 4 — Emit ConfigInitialized.
```

#### Errors (block 6500)

```
NotUpgradeAuthority   = 6500,
InvalidAdmin          = 6501,
InvalidTreasury       = 6502,
InvalidDev            = 6503,
InvalidBurn           = 6504,
InvalidEntryFee       = 6505,
AddrAliasing          = 6506,
```

#### Event `ConfigInitialized`

```
{ payer, admin, treasury_pubkey, dev_pubkey, burn_pubkey, entry_fee, initialized_at }
```

---

### 7.2 `init_pool`

Creates `Vault` + `VaultState` for one pool. Called 4 times at deploy.

#### Arguments

```
init_pool(ctx, pool_kind: u8)
```

Single arg — duration is a per-pool program constant.

#### Accounts

| Account | Type | Mut | Signer | Seeds / Constraint |
|---|---|---|---|---|
| `admin` | `Signer` | yes (pays rent) | yes | — |
| `config` | `Account<Config>` | no | no | `config.admin == admin.key()` |
| `vault_state` | `Account<VaultState>` | yes (`init`) | no | `[SEED_VS, &[pool_kind]]`, `init, payer = admin` |
| `vault` | `UncheckedAccount` | yes (manually created) | no | `[SEED_VAULT, &[pool_kind]]` |
| `system_program` | `Program<System>` | no | no | — |

#### Execution flow

```
Step 1 — require pool_kind <= POOL_JACKPOT                    else InvalidPoolKind

Step 2 — Resolve duration:
   duration = match pool_kind {
       POOL_DAILY   => DAILY_DURATION_SECONDS,
       POOL_WEEKLY  => WEEKLY_DURATION_SECONDS,
       POOL_MONTHLY => MONTHLY_DURATION_SECONDS,
       POOL_JACKPOT => MANUAL_ROTATION_SENTINEL,
   }

Step 3 — Derive vault PDA:
   (vault_bump, derived) = find_program_address(
       &[SEED_VAULT, &[pool_kind]], &program_id
   )
   require derived == vault.key()                             else PdaMismatch
   require vault.lamports() == 0
        && vault.data_is_empty()                              else VaultAlreadyExists

Step 4 — CPI create vault (system-owned, 0 data):
   system_program::create_account(
       from = admin, to = vault,
       lamports = rent_exempt(0), space = 0, owner = system_program,
       signer_seeds = [SEED_VAULT, &[pool_kind], &[vault_bump]],
   )

Step 5 — Initialize VaultState:
   now = Clock::get()?.unix_timestamp
   vault_state.pool_kind                 = pool_kind
   vault_state.bump                      = ctx.bumps.vault_state
   vault_state.vault_bump                = vault_bump
   vault_state.epoch_zero                = now
   vault_state.period_duration_seconds   = duration
   vault_state.open_period_id            = 0
   vault_state.open_period_collected     = 0
   vault_state.awaiting_settlement_total = 0
   vault_state.obligations_lamports      = 0
   vault_state.total_collected_lifetime  = 0
   vault_state.total_paid_lifetime       = 0
   vault_state.last_seal_at              = 0
   vault_state.last_settlement_at        = 0

Step 6 — Emit PoolInitialized.
```

#### Errors (block 6520)

```
NotAdmin              = 6520,
InvalidPoolKind       = 6521,
VaultAlreadyExists    = 6522,
PdaMismatch           = 6523,
```

#### Event `PoolInitialized`

```
{ admin, pool_kind, vault, vault_state, epoch_zero, period_duration_seconds, initialized_at }
```

---

### 7.3 `set_paused`

#### Arguments

```
set_paused(ctx, paused: bool)
```

#### Accounts

| Account | Type | Mut | Signer | Constraint |
|---|---|---|---|---|
| `admin` | `Signer` | no | yes | matches `config.admin` |
| `config` | `Account<Config>` | yes | no | seeds + bump |

#### Execution flow

```
Step 1 — Idempotent toggle:
   was_paused = config.paused
   config.paused = paused

Step 2 — Emit PauseToggled { admin, was_paused, now_paused, toggled_at }.
```

Idempotency intentional — `set_paused(true)` when already true succeeds (event still emitted). Useful for ops scripts.

#### Errors (block 6540)

```
NotAdmin = 6540,
```

---

### 7.4 `update_treasury_addrs`

#### Arguments

```
update_treasury_addrs(
    ctx,
    new_treasury: Pubkey,
    new_dev:      Pubkey,
    new_burn:     Pubkey,
)
```

All three required (no partial update).

#### Accounts

| Account | Type | Mut | Signer | Constraint |
|---|---|---|---|---|
| `admin` | `Signer` | no | yes | matches `config.admin` |
| `config` | `Account<Config>` | yes | no | seeds + bump |

#### Execution flow

```
Step 1 — Non-zero:
   require new_treasury != Pubkey::default()                  else InvalidTreasury
   require new_dev      != Pubkey::default()                  else InvalidDev
   require new_burn     != Pubkey::default()                  else InvalidBurn

Step 2 — Pairwise distinct:
   require new_treasury != new_dev                            else AddrAliasing
   require new_treasury != new_burn                           else AddrAliasing
   require new_dev      != new_burn                           else AddrAliasing

Step 3 — Capture & mutate:
   old_treasury = config.treasury_pubkey
   old_dev      = config.dev_pubkey
   old_burn     = config.burn_pubkey
   config.treasury_pubkey = new_treasury
   config.dev_pubkey      = new_dev
   config.burn_pubkey     = new_burn

Step 4 — Emit OperatorAddrsUpdated.
```

#### Errors (block 6560)

```
NotAdmin              = 6560,
InvalidTreasury       = 6561,
InvalidDev            = 6562,
InvalidBurn           = 6563,
AddrAliasing          = 6564,
```

#### Event

```
OperatorAddrsUpdated {
    admin, old_treasury, new_treasury, old_dev, new_dev, old_burn, new_burn, updated_at
}
```

---

### 7.5 `propose_admin` / `accept_admin` (2-step transfer)

Protects against transferring admin to a typo'd or lost keypair.

#### 7.5a `propose_admin`

```
propose_admin(ctx, new_admin: Pubkey)
```

Accounts: `admin: Signer` (current), `config: mut`.

**Flow:**
- `new_admin == Pubkey::default()` is allowed → cancels any pending proposal (no separate cancel instruction needed).
- `new_admin == config.admin` allowed → no-op.
- If non-default: require `new_admin != config.{treasury,dev,burn}_pubkey` (anti-aliasing).
- `config.pending_admin = new_admin`.
- Emit `AdminProposed { admin, old_pending, new_pending, proposed_at }`.

#### 7.5b `accept_admin`

```
accept_admin(ctx)
```

Accounts: `new_admin: Signer` (must match `config.pending_admin`), `config: mut`.

**Flow:**
- `require config.pending_admin != Pubkey::default()` else `NoPendingAdmin`.
- `require config.pending_admin == new_admin.key()` else `NotPendingAdmin`.
- Atomic swap: `config.admin = new_admin.key(); config.pending_admin = Pubkey::default()`.
- Emit `AdminTransferred { old_admin, new_admin, accepted_at }`.

#### Errors (block 6580)

```
NotAdmin              = 6580,
AdminAliasesOperator  = 6581,
NoPendingAdmin        = 6582,
NotPendingAdmin       = 6583,
```

---

### 7.6 `advance_jackpot_round`

Admin-only manual-rotation analog of `seal_period`. **MVP-required** — the only way to ever pay out a jackpot.

#### Arguments

```
advance_jackpot_round(ctx, expected_round_id: u64)
```

#### Accounts

| Account | Type | Mut | Signer | Constraint |
|---|---|---|---|---|
| `admin` | `Signer` | yes (pays pending rent) | yes | matches `config.admin` |
| `config` | `Account<Config>` | no | no | seeds + bump |
| `vault_state` | `Account<VaultState>` | yes | no | `[SEED_VS, &[POOL_JACKPOT]]`, `open_period_id == expected_round_id`, `period_duration_seconds == 0` |
| `pending_settlement` | `UncheckedAccount` | yes (manually created) | no | `[SEED_PENDING, &[POOL_JACKPOT], &expected_round_id.to_le_bytes()]` |
| `system_program` | `Program<System>` | no | no | — |

#### Execution flow

```
Step 0 — Preamble (admin gate, manual-rotation gate, expected round match).

Step 1 — Reject empty rounds:
   require vault_state.open_period_collected > 0              else EmptyJackpotRound

Step 2 — PDA derivation + non-existence check (same as seal_period branch A).

Step 3 — CPI create_account for pending_settlement.

Step 4 — Initialize PendingSettlement (rent_payer = admin, period_id = expected_round_id, etc.).

Step 5 — Update vault_state:
   new_awaiting = vault_state.awaiting_settlement_total
                    .checked_add(vault_state.open_period_collected)?
   new_round_id = vault_state.open_period_id.checked_add(1)?

   vault_state.awaiting_settlement_total = new_awaiting
   vault_state.open_period_id            = new_round_id
   vault_state.open_period_collected     = 0
   vault_state.last_seal_at              = now

Step 6 — Emit JackpotRoundAdvanced.
```

#### Errors (block 6600)

```
NotAdmin               = 6600,
ExpectedRoundMismatch  = 6601,
NotManualRotation      = 6602,
EmptyJackpotRound      = 6603,
PdaMismatch            = 6604,
PendingAlreadyExists   = 6605,
ArithmeticOverflow     = 6606,
```

#### Event `JackpotRoundAdvanced`

```rust
#[event]
pub struct JackpotRoundAdvanced {
    pub admin:                   Pubkey,
    pub sealed_round_id:         u64,
    pub sealed_round_collected:  u64,
    pub pending_settlement:      Pubkey,
    pub rent_paid_by_admin:      u64,
    pub new_open_round_id:       u64,
    pub vault_awaiting_after:    u64,
    pub vault_obligations_after: u64,
    pub sealed_at:               i64,
}
```

---

## 8. Error code map

| Block | Owner |
|---|---|
| 6000 | `ClaimError` |
| 6100 | `SettlementError` (post_settlement) |
| 6200 | `SealError` (seal_period) |
| 6300 | `PayError` (pay_entry) |
| 6400 | reserved (future treasury_withdraw) |
| 6500 | `init_config` |
| 6520 | `init_pool` |
| 6540 | `set_paused` |
| 6560 | `update_treasury_addrs` |
| 6580 | `propose_admin` / `accept_admin` |
| 6600 | `advance_jackpot_round` |

---

## 9. Lifecycle test scenarios

Scenarios to cover before declaring a Rust implementation complete:

1. **Cold start → first paid run → first claim.**
   `init_config` → `init_pool × 4` → `pay_entry` → wait 24h → `seal_period(daily)` → `post_settlement(daily)` → `claim`. All 7 steps must succeed.

2. **Admin rotation mid-life.**
   `propose_admin(B)` (current admin A signs) → `accept_admin` (B signs) → `set_paused(true)` (B succeeds; A fails with `NotAdmin`).

3. **Treasury rotation.**
   `update_treasury_addrs(T2, D, B)` → next `pay_entry` routes 20% to T2; stale Phantom tx still using T1 fails `TreasuryWalletMismatch`.

4. **Pause regression.**
   `set_paused(true)` → `pay_entry` fails `Paused`; `seal_period`, `post_settlement`, `claim`, `advance_jackpot_round` all succeed.

5. **Jackpot manual flow.**
   Many `pay_entry` accumulate jackpot share into round 0 → admin `advance_jackpot_round` → `post_settlement(jackpot, period_id=0, ...)` → winner `claim` → next round 1 begins.

6. **2-step admin recovery from typo.**
   `propose_admin(WRONG)` → admin notices → `propose_admin(default)` cancels → `propose_admin(CORRECT)` → `accept_admin`.

7. **Permissionless seal liveness.**
   Admin cron dies for 3 days. Any player calls `seal_period(daily)` → period 1 closes (PendingSettlement created) → period_id advances to 4 → `skipped_empty_periods = 2` reported in event.

8. **Empty period end-to-end.**
   No `pay_entry` for 24h on daily → `seal_period(daily)` → branch B (no PendingSettlement created) → `vault_state.open_period_id` advances → no `post_settlement` ever needed for that gap.

9. **Double-claim attempt.**
   First `claim(leaf_index=5)` succeeds → second `claim(leaf_index=5)` fails with raw "account already in use" (mapped to `AlreadyClaimed`).

10. **Cross-pool replay attempt.**
    Build a Merkle leaf for pool=daily, period=10, then submit it as pool=weekly, period=10 → leaf preimage differs (pool_kind byte changes) → `InvalidProof`.

---

## 10. Implementation order

Suggested dependency order for Rust implementation:

1. **Foundations**: shared constants module, all account structs, all error enums, event structs.
2. **Bootstrap**: `init_config` → `init_pool`.
3. **Smallest runtime surface first**: `claim` (depends on Period, ClaimMarker, VaultState — but no cross-instruction state mutations of its own beyond increments).
4. **Settlement path**: `post_settlement` (depends on PendingSettlement existing, validates against Period init).
5. **Seal path**: `seal_period` (creates PendingSettlement; requires manual-rotation gate logic).
6. **Intake path**: `pay_entry` (touches all 4 vault_states, requires the largest accounts list).
7. **Admin remainder**: `set_paused` → `update_treasury_addrs` → `propose_admin` / `accept_admin`.
8. **Jackpot rotation**: `advance_jackpot_round`.
9. **Devnet deploy + integration tests** against existing `copper-beta.html` flow.
10. **Mainnet readiness**: switch `SOLANA_NETWORK = "mainnet-beta"` in front-end, audit pass, transfer admin to multisig.

---

**End of spec.** Anything not specified above is intentionally left to implementation discretion (e.g., struct field ordering for borsh, exact bump-derivation pattern, unit test layout).
