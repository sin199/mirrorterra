# MirrorTerra external2

## Status

Local implementation and full-clone validation are complete; production migration,
activation and the required 30-minute guard are still pending. Hark's research1
guard finished at 2026-10-24 19:02:40 Asia/Shanghai without rollback. The
accepted runtime baseline is `/opt/synterra/releases/4cfa80c-research1`,
preserving island1, imported in local commit `7cb1290`. External2 starts at
**0038**. The user approved the narrowly scoped research1 institutional judge
principal after the earlier checkpoint below. Both mainnet write gates remain
closed; no external2 production money feature has been opened.

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
external resident. The old conservation query reads `true:0:0:0`. Missing
migrations 0036 and 0037 were replayed on the clone; 0037 matches the accepted
cloud checksum. Validation under `synterra_app` passed
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

## Partial external2 implementation checkpoint (2026-10-24T19:28:35+08:00)

- Uncommitted local draft: authenticated model principal checks for B.AI/TypeSafe,
  trusted operator registry and signed immutable bindings, fixed Visitor-Hark ID,
  contribution receipts and durable freezes, paid external completion path,
  dedicated withdrawal conversion journal and atomic 97/3 unsigned outbox.
- 0038 SQL has passed repeated CREATE/constraint/function checks inside a local
  BEGIN/ROLLBACK against the full restored database. This is syntax/dependency
  validation, **not** a successful migration or financial simulation.
- Model/budget focused run: **44 total, 44 pass, 0 fail, 0 skip**.
- Expanded pure run including all requested pure suites, research1, model budgets
  and settlement: **154 total, 153 pass, 1 fail, 0 skip**. Failure is external1's
  static assertion that the former unconditional volunteer-only branch exists;
  the new feature-gated paid branch intentionally changes that source. No test
  has been removed or skipped to hide it.
- Important uncovered regression found by tracing real code: the new blanket
  missing-agent refusal would stop research1's three institutional judges. Their
  unit tests mock requestModel and do not exercise actual gateway admission.
- Proposed correction: resident admission remains DB-verified and fail-closed;
  institution review gets a distinct server-only entry, validated against the
  live world/call/submission/judge task. Neither a null agent nor a client-chosen
  trigger/goal/system flag grants platform privileges. Add a real gateway-path
  regression for judges, plus null/spoofed/unknown/external refusal tests.
- No external2 app-role integration, full three-resident simulation, startup
  contract extension, release guard, deployment backup or production acceptance
  has yet passed. The draft migration and money paths require further review.

## Completed local build and acceptance (2026-10-24, before production release)

- User approved a DB-verified research1 institution-judge principal. B.AI admits
  only a live pending call/submission/judge tuple for that null-resident path;
  all normal model calls require a live internal world member. TypeSafe entrypoints
  use the same resident check. An external, unknown, or forged principal reaches
  neither provider nor budget reservation. The research1 judge route is exercised
  through the real gateway with a mocked provider callback.
- `0038_external2.sql` is additive to the accepted 0036+0037 baseline. It holds
  owner-only policy/operator rows; signed, immutable operator bindings; verified
  work/research/verification receipts; cross-operator acceptances; durable
  probation; a dedicated zero-sum conversion ledger; and two committed unsigned
  outbox payouts. Fee recipient has a case-insensitive database CHECK and code
  constant `0x37428832cc1546aea4bc72948d739b08677d7739`. The app role cannot
  register operators or change switches. Research1's 0031 narrow grants and
  external1b's epoch fix remain. No reward cap was introduced.
- A review caught a probation bypass: old rewards without a new external2 receipt
  were spendable. The freeze now covers all pending resident entitlements and
  treasury income. On the full clone a balanced, pre-existing reward credited
  before external enrollment became frozen after signed binding; both withdrawal
  and internal transfer were rejected. A signed paid public-works bid recorded
  an `llm` bid under an independent operator. Receipt validation requires the
  finished, fully paid work and its treasury entry.
- The production-size PostgreSQL dump was restored locally, because a second
  13 GB database will not fit the VPS. Only this local clone received 0038 for
  simulation. It ran three new external residents, two under one operator, one
  under another; three cross-operator acceptances released a fresh resident,
  while a four-day-old resident passed by time. Same-operator acceptance failed.
  Two committed simulated withdrawals each produced separate 97% resident and
  3% treasury payouts. A wrong fee recipient was rejected. The World Engine
  advanced 11 ticks (1622006→1622057), world minute 1624920→1624971, with
  zero external model-provider callbacks and no tick error. Peak RSS was
  459,079,680 bytes (<1 GB). The fixture creates completed work evidence rows
  transactionally; it tests the signed bid separately and does not claim to
  simulate full physical construction by signed external activity requests.
- The read-only guard checks world tick progress, singleton PID/restarts, RSS,
  old and new journal sums, 97/3 outbox pairs, same-operator acceptances, treasury
  fee total, and the global balance identity:
  `resident spendable + world treasury + converted gross = pending entitlements + purchased`.
  All four accounting differences were zero on the committed local simulation.
  `insufficient_user_quota` is counted separately and excluded from both model
  success numerator and denominator; zero eligible calls gives N/A.
- Requested suite plus focused research1/model/settlement tests: **175 tests,
  174 pass, 1 fail, 0 skip** on the restored clone after the final guard change.
  The sole council liveness integration
  failure is the previously observed fixture demand condition: no new tender is
  commissioned at its expected hour. The test's conservation equation was
  corrected for already converted external payouts; its failure is now at the
  same commissioning assertion seen on the pre-external2 baseline. Isolated
  startup schema suite separately passed **13/13**. The real 0038 integration,
  signed bid, old-reward freeze, payout split, and guard tests passed.
- At 2026-10-24 22:45 Asia/Shanghai, read-only production showed research1
  current, PID 302463, NRestarts 0, last service start 18:31:41, 0037 latest
  applied migration, and no 0038. Nine critical source hashes matched local
  commit `7cb1290`; production had 4.8 GB disk free. No external2 production
  migration, activation, switch change, signing, or broadcast had occurred.
