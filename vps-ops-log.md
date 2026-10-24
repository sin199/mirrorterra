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
