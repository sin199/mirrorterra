# MirrorTerra external2

## Status

Preparation started on 2026-10-24. Runtime implementation, external2 migration,
activation and the external2 production guard have **not** run. The prerequisite
is Hark's research1 activation and successful guard. Research1 started its
pre-release backup at 2026-10-24 17:39:54 Asia/Shanghai, applied 0037 at 18:30:55,
and completed activation at 18:32:20. Its 30-minute guard was still running at
the last inspection; this is not yet a guard-pass claim.

This is a preparation record, not an external2 completion report.

## Approved rules

- Common production ancestor: `/opt/synterra/releases/4cfa80c-island1`.
  Preserve research1's subsequently accepted changes before releasing external2.
- `0036_ferry_island.sql` belongs to island1; `0037_research_society.sql` belongs
  to research1. External2 starts at **0038**; check for collisions before writing
  the migration and again before deployment.
- External residents use their own model and signed APIs. The platform's model
  gateway must refuse their requests, including direct calls and identity lookup
  failure paths. No platform-generated external decisions.
- No individual or operator reward amount cap. Only engine-verifiable completed
  and accepted public works, adopted research, and successful verification earn
  rewards, using existing prices and work evidence. Existing funding and global
  budget constraints still apply. No registration, attendance or fixed subsidy.
- Operators are registered through a trusted administrative path. Resident
  bindings require the operator's signature and cannot be self-asserted or
  casually rebound. Same-operator attestations/cooperation do not earn rewards
  or count toward probation. Visitor-Hark remains non-independent.
  These restrictions govern external-resident rewards; preserve research1's
  existing internal-resident rules.
- Probation ends after **3 real days OR 3 distinct contributions accepted by
  residents of other operators**, whichever occurs first. Both thresholds are
  configurable. Rewards arrive frozen; neither withdrawal nor transfer can
  bypass the freeze. Repeated acceptance of one contribution counts once.
- Earning has no withdrawal fee. Withdrawal splits atomically into two committed
  payouts with distinct payout IDs: 97% to the external wallet and 3% to the
  infrastructure treasury. Use integer raw units, floor the fee, and reject
  requests too small to produce two positive payouts.
- Treasury wallet is the code constant
  `0x37428832cc1546aea4bc72948d739b08677d7739`. The migration must enforce it
  with a case-insensitive database CHECK. No environment override or mutation
  API. Treasury credit must come only from a resident's 3% withdrawal fee,
  never a reserve allocation or an Operating Pool grant.
- This version prepares ledger records and outbox only: no authorization
  signatures, transaction signing, broadcast or minting. External submitters
  pay their own gas when a future explicitly authorized chain path is opened.
- Each new capability has its own switch. Existing committed records and frozen
  obligations survive switch-off. Production reward/withdrawal activation is
  separate from development approval.
- Preserve `MAINNET_WRITE_GATE=false` and
  `SYNC_COMMITTED_PAYOUT_WRITE_GATE=false`; do not edit `gambit-flags.json` or
  `patterns.json`. Only append migrations; preserve historical checksums and
  external1b's non-null epoch fix.

## Baseline verification

At 17:27:55 Asia/Shanghai, `/opt/synterra/current` was island1, service PID
287941, NRestarts 0. The database reported PostgreSQL 16.15, size
13,698,358,295 bytes, and migration 0036 applied at 16:35:02.

A fresh read-only source manifest compared 390 selected source/runtime files.
The old local working branch differed only in its extra rollup regression test
and observability document. A new `codex/external2-20261024` branch restores
those two files to the captured cloud versions; no runtime file was changed.
The earlier work remains on `codex/runtime-observability-20261024`.
The exact island1 alignment is commit `dbca741`; subsequent preparation changes
are limited to test fixtures and these records.

The running process's two mainnet payout gates were both verified as `false`.
No production configuration, database rows, services or releases were changed
by this external2 preparation.

## Baseline tests, before external2 changes

Command: Node 22.22.0, `--test --test-concurrency=1`, isolated state directory,
the pure external1, sync-internal-economy, council/council2/council3/council4,
gambit1, database-migrations and startup-schema test files.

**88 tests: 81 passed, 7 failed, 0 skipped.** No full `npm test` was run.

Observed failures:

| Test | Failure observed |
| --- | --- |
| council: economy-off reward path | Mock expects one query; the existing external lookup adds another. |
| council: engine/reward/context wiring | Source regex assumes the required migration list ends at 0031/0032. |
| council3: no grants/prizes | Broad fake query response makes the internal fixture appear external. |
| council3: startup wiring | Source regex assumes the required migration list ends at 0031/0032. |
| council4: weight below 1x | Broad fake query response makes the internal fixture appear external. |
| gambit1: honesty slot | Asset version assertion is pinned to gambit1, while island1 serves a newer version. |
| sync-internal-economy: saved capacity snapshot | Worker fixture does not handle the existing external-resident read; snapshot status remains null. |

These are baseline observations, not a waiver of final validation. The final
report must include every pass/fail/skip count and separately identify any
failure reproduced on the unmodified accepted production baseline.

### Fixture corrections and latest island1 preparation runs

Only tests changed: explicit internal/external responses in mocks, mutation
assertions independent of metadata reads, migration-list assertions that permit
later migrations, cache-version assertions independent of the old growth4 tag,
budget-call fixture rows preserving the real attribution FK, and a membership
expectation that includes already-eligible residents in the production snapshot.
No production runtime, model limits, funding rules or database constraint was
relaxed to obtain these results.

| Run | Total | Pass | Fail | Skip |
| --- | ---: | ---: | ---: | ---: |
| Requested pure baseline suites, after fixture corrections | 88 | 87 | 1 | 0 |
| startup-schema integration on a separate fresh local database | 13 | 13 | 0 | 0 |
| external1, council-liveness, gambit1 integration on full restored clone | 3 | 2 | 1 | 0 |
| Latest preparation results combined | 104 | 102 | 2 | 0 |

Remaining failures are the old gambit1 asset-version pin and council-liveness's
expectation of a new commission within six world hours. The restored world has
9 eligible/free builders, 12,926.846028 SYNC of free treasury balance, no open
construction, and **no unmet construction needs**. Do not change the world rules
to force that fixture to commission unnecessary works. This remains a reported
baseline failure, not an external2 pass or a skipped scenario.

The external1 fixture and gambit1 integration both pass. The initial
startup-schema fixture failure (23503) is resolved by recording its mocked
provider calls in the required budget ledger; the real paid-call gate is unchanged.

Private local evidence directory:
`/Users/xyu/Library/Application Support/MirrorTerra/external2-simulation-20261024`.
The source manifest and test output are stored there; no database dump enters Git.

## Replica preparation

The VPS has about 5.5 GiB free; the local Mac had about 78 GiB free. Restore the
full copy only into the owned local PostgreSQL 16 cluster on 127.0.0.1:55635.
Do not restore or run simulation writes on production.

Replica source is the already completed, root-owned backup
`synterra-pre-island1-20261024T075219Z.dump`, 477,423,474 bytes. Its independently
read remote SHA-256 is
`1ba7039be3ef7337a27ca7c401f6756e9f9de848a276c04665f5b648bcb4e860`.
The full local checksum matched. Restore attempt 1 was blocked by a missing local
`turnkey_provision_operator` role. It was preserved for diagnosis. Attempt 2
completed at 18:17:55 Asia/Shanghai after creating that local NOLOGIN role.
Mixed object ownership from the backup (postgres/synterra_app/xyu) was then
restored from its schema metadata. The local postgres owner mirrors the source's
superuser privileges while remaining NOLOGIN; no production role was changed.

Accepted clone: `external2_replica_20261024_test` on 127.0.0.1:55635. It retains
World `ce434421-8bcd-4aac-b9ba-183383c713de`, minute 1622480, 11 residents and one
external resident. The old conservation query reads `true:0:0:0`. Only missing
migration 0036 was replayed on the clone. Validation under `synterra_app` passed
checksums, required objects and runtime grants for 174 required tables without
executing schema.sql. Baseline integration writes rolled back; World minute and
membership counts remain unchanged.

This older snapshot is for simulation preparation. It is **not** the fresh
pre-deployment backup required for a future production migration.

## Guard requirements and findings

- Exclude exactly `provider_error_code=insufficient_user_quota` from the model
  success-rate numerator/denominator; log the quota count separately. With no
  eligible completed calls, report N/A rather than 100% success. Quota exhaustion
  alone must not roll back a release.
- The old guard's third field sums external balances and requires zero. Legitimate
  external2 rewards invalidate that old assumption. The external2 guard must
  preserve monetary conservation and check unauthorized external origins/freeze
  bypasses, with all components and their definitions documented explicitly.
- Frozen balances remain obligations. Withdrawal conversions must reduce available
  claims exactly once, retain Operating Pool backing, and prevent concurrent
  spending. Do not reuse the old gross-entitlement commit path for a resident
  whose balance has already moved through transfers or treasury payments.
- Preserve the members-first lock order used by the world engine. New finance
  paths must not take advisory/account locks before world-member locks.
- Rollback on actual service crashes, ledger imbalance or frozen world ticks.
  Observe persisted clock progress; a single stale health flag is insufficient.
- Verify the accepted baseline starts against the upgraded schema on the local
  clone before migrating production. Do not rewrite historical rows to roll back.

## Remaining acceptance work

1. Wait for research1 to finish its guard; capture accepted source and
   migration hashes and verify its overlay preserves island1.
2. Implement external2 and 0038 on the accepted source, with independent switches.
3. Run targeted tests plus all requested suites; report exact counts.
4. On the restored clone, simulate at least three external residents, two sharing
   an operator. Check signed ingress, valid/invalid contributions, no fixed grants,
   both probation exits, transfer/withdrawal freeze, atomic 97/3 outbox, fee address
   rejection, conservation, advancing ticks, and zero external provider sends.
5. Before deployment, verify no other activation or migration in the preceding
   30 minutes, recheck source/ownership, create and verify a new backup, migrate,
   activate once and run the 30-minute guard. Do not deploy concurrently with Hark.
6. Append actual execution results here and in `vps-ops-log.md`.
