# MirrorTerra operations log

## 2026-10-24 — external2 preparation

- User approved development under the agreed contribution/probation rules.
  External2 migration numbering was corrected to start at **0038**; 0037 is
  reserved for Hark's research1.
- Read-only checks confirmed `/opt/synterra/current` is
  `/opt/synterra/releases/4cfa80c-island1`; database migration 0036 belongs to
  ferry/island. Service PID 287941, NRestarts 0 in the sampled checks.
- The running process has `MAINNET_WRITE_GATE=false` and
  `SYNC_COMMITTED_PAYOUT_WRITE_GATE=false`.
- Hark's research1 pre-release backup began at 17:39:54 Asia/Shanghai. No
  external2 migration, activation, rollback, configuration change or production
  simulation was performed. Research1's guard pass remains a prerequisite.
- Compared 390 selected cloud source files and prepared the isolated local
  `codex/external2-20261024` branch. Runtime source remains island1; earlier
  observability work remains on its original branch.
- Pure baseline test run: 88 total, 81 pass, 7 fail, 0 skip. Details and outstanding
  acceptance work are in `notes/external2-build.md`.
- Began transferring the completed pre-island1 dump to a mode-0700 local directory
  for complete local restoration. Remote SHA-256 verified; local transfer/restore
  is still in progress. The VPS is not used as the restore target. This existing
  backup is not a substitute for a fresh pre-external2-deployment backup.

### Local preparation updates, 18:09–18:50 Asia/Shanghai

- Full local dump checksum matched the remote SHA-256. The first local restore
  failed because an operator role was missing; its log and failed database were
  preserved. The second restore completed at 18:17:55. Local NOLOGIN owner roles
  and object ownership were reconstructed from the source schema so runtime
  permission checks reflect the backup's mixed ownership. No cloud role changed.
- Replayed 0036 only on the local clone. `synterra_app` startup validation passed
  for 174 required tables. World ID, 11 members, one external and snapshot minute
  1622480 were preserved; conservation is `true:0:0:0`.
- Repaired six independent test fixtures; runtime files remain byte-identical
  to island1. Latest preparation totals: 104 tests, 102 pass, 2 fail, 0 skip.
  Remaining failures and the original failed runs are retained in the build note.
- Read-only production evidence: research1 applied 0037 at 18:30:55, completed
  activation at 18:32:20, PID 302463, and started its 1800-second guard. Last
  samples had NRestarts 0 and conservation `true:0:0:0`; the guard had not finished.
- External2 has not migrated, activated, signed, broadcast or opened production
  reward/withdrawal gates. Source baseline alignment is local commit `dbca741` on
  `codex/external2-20261024`; research1 will be preserved after its guard passes.

### 2026-10-24T19:28:35+08:00 — external2 partial local build, no production mutation

- Accepted research1 at guard completion 19:02:40; verified 397 source hashes,
  PID 302463, NRestarts 0, and both mainnet write gates false. Imported all 17
  Hark changed/new files in commit `7cb1290`; external2 migration starts 0038.
- Source was still research1 on the subsequent 19:12:47 read; no 0038 was present.
- Draft implementation and transaction-rolled-back SQL checks are local only.
  Focused tests 44/44 pass; expanded pure run 153/154 pass, one old source-shape
  assertion fails. Financial integration and runtime acceptance are pending.
- Stopped implementation after discovering that rejecting all missing resident
  IDs would also reject Hark's legitimate institutional research judges.
  Proposed server-only, task-validated institutional principal is awaiting
  confirmation under the user's AGENTS.md section 4. Do not deploy this draft.

### 2026-10-24T22:45+08:00 — external2 local acceptance, production unchanged

- User approved the DB-verified research1 institution-judge exception. External2
  source now extends the accepted research1 baseline, with additive 0038 only;
  no old migration, `gambit-flags.json`, or `patterns.json` was edited.
- Full dump was restored to a local PostgreSQL 16 clone; 0038 applied there and
  passed app-role startup schema validation. The local clone, not the VPS, ran
  three external residents (two under the same operator), 11 World ticks, two
  committed 97/3 withdrawal splits, probation, independent acceptance, a
  signed paid bid, and B.AI external-principal rejection (provider sends 0).
  Four accounting deltas were 0; observed RSS peak was 459,079,680 bytes.
- A legacy-reward freeze loophole was fixed and verified against the clone:
  old income remains frozen during probation and cannot be transferred or
  withdrawn. The wrong infrastructure fee recipient was rejected by the DB.
- Final requested suite after guard changes: 175 tests, 174 pass, 1 fail,
  0 skip. The sole council-liveness fixture failure was present on the
  baseline; it reaches the same no-new-tender assertion after updating its
  payout-aware equation.
- Read-only production at 22:45 still showed
  `/opt/synterra/releases/4cfa80c-research1`, PID 302463, NRestarts 0,
  service start 18:31:41, 0037 as the newest applied migration, no 0038,
  4.8 GB free. Nine baseline-critical source hashes matched local `7cb1290`.
  No external2 production switch, migration, activation, signature or broadcast.

### 2026-10-24T23:13+08:00 — installed candidate, backup running, activation paused

- Pushed commit `02ea9ab` on isolated `codex/external2-20261024` branch.
  Staged release was copied from the currently active research1 directory, then
  verified against the 37-file SHA-256 overlay. `release-install` created
  `/opt/synterra/releases/4cfa80c-external2-02ea9ab`; it did not switch current.
  The migration plan listed only new 0038 with checksum `12dc46fc…916cab`.
- Fresh `pre-external2-20261024` pg_dump began around 23:08:43; it was still
  running at 23:13:46. Current was research1; 0037 was newest applied migration.
- Production guard script cannot query PostgreSQL as `codex-ops` (peer auth
  rejects it), and the allow-listed root ops helper has no general query command.
  A read-only `/local/` guard route is proposed, after confirming loopback
  `/local/health` returns 200 and the public domain returns 404. Per the user's
  AGENTS.md section 4, implementation, migration and activation are paused until
  this plan correction is approved. No chain signing or broadcast occurred.
