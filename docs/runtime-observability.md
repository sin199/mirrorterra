# Bounded runtime observation

The source baseline includes the deployed `bea9d24-drivefix1` release, with its
behavior changes preserved byte for byte. Before each activation, reconcile any
later deployment and confirm migration numbering and checksums.

## Arc sampling and cognition diagnostics

Arc samples have a 30-second deadline and each SQL operation has a 5-second
deadline. A separate pool also enforces the SQL timeout on PostgreSQL itself.
Cancellation aborts RPC fetches and destroys owned connections, including
connections acquired after the caller timed out. A stopped observer cannot start
another sample. Indexer cursor updates retain their existing transactions.

The status response distinguishes the last attempt, completion and successful
sample. After two missed sampling intervals it marks the sample stale and stops
presenting old RPC/USDC verification as current. Worker liveness remains a
separate field.

The cognition diagnostic endpoint uses its read-only pool and retains the full
24-hour ledger/effects and exact-call lookup. Prompt sections are needed only
for the 12 returned recent calls and an explicitly requested historical call.
Those details are fetched through the existing primary key in bounded batches;
the 24-hour counts, costs and attribution totals continue to use every call.
The response reports the detail limit and number of prompt-section calls read.
Failures expose only the phase, SQLSTATE and elapsed time, never prompt content.
Successful B.AI settlements now store a null failure code; old rows are retained.

## Emergence aggregation

Migration `0035_emergence_rollups.sql` creates two rebuildable derived tables.
It does not rewrite or remove raw emergence events, World state or ledgers.
Startup validation checks their schema and grants. DELETE permission is added
only for the derived hour cache.

The singleton World tick currently writes emergence events and advances its
monotonic clock in the same transaction. Consequently, completed World hours
are immutable. The worker aggregates only those hours, with a maximum of two
hours per refresh. A transaction advisory lock prevents a second rollup writer;
counts and coverage commit atomically. Sequence IDs are not used as a cursor,
since an allocated ID can still belong to an uncommitted tick.

The worker uses its own one-connection pool. PostgreSQL enforces a 1.5-second
timeout per statement, a 250-ms lock timeout and a 10-second idle transaction
timeout. Borrowed clients handle asynchronous connection errors as well as query
rejections, so an idle-transaction disconnect cannot become an unhandled process
error. A failed batch rolls back, destroys a failed connection and can retry on
the next scheduled attempt. The first server error is retained for diagnosis.
The retained cache window is seven World days; pruning removes at most 2,000
derived rows per batch. Earlier reports continue to use raw history.

Report reads combine cached complete hours with raw boundary and tail ranges.
Coverage and counts are read in one SQL statement snapshot, so concurrent cache
pruning cannot create a gap. Partial backfill remains exact. NULL and empty
actions stay distinct; existing count, blocked-reason and recent-event fields
keep their semantics. An additive `aggregation` field reports the source and
coverage watermark; `/local/health` includes the rollup worker status.

Any future producer of backdated emergence events must revise this closed-hour
assumption before it is enabled. The cache does not solve raw-history storage
growth, host CPU contention, skill-selection policy or World write deadlocks.

## Validation and release boundary

Use Node 22+ and a disposable local PostgreSQL database with all numbered
migrations applied. Integration tests refuse a non-local/default-port database.
The targeted validation covers SQL cancellation and pool reuse, fetch aborts,
observer stop/reentry, stale status, asynchronous idle-client disconnects,
diagnostic completeness/index access and full-versus-bounded detail equivalence,
rollup boundaries and NULL groups, interrupted batches, concurrent ticks and
writers, concurrent cache pruning, startup schema/grants, and release cooldowns.
The deployed drivefix/placewear tests are included in the combined run.

Two existing integration cases fail on the unchanged `55d3813` baseline due to
missing fixture rows, and are explicitly excluded from the combined run:

- `validated schema permits World Engine startup and closed gate remains unchanged`:
  a fake model call lacks the referenced budget-ledger row (SQLSTATE 23503).
- `isolated V3 lifecycles settle cooperatively and persist across database reconnects`:
  the fixture lacks its Arc tokenomics deployment row (SQLSTATE 23503).

Other startup checks remain enabled. Do not weaken constraints to make these
fixtures pass. The targeted suite is not the full repository test suite.

Production activation must follow reconciliation with the current cloud source,
a verified backup and space check, migration/schema validation, release
installation, and one controlled activation. Application rollback uses the
previous immutable release; leave the additive derived tables in place. Local
tests do not prove production latency, 1-GB memory support, or recovered natural
Agent execution. Those require a separate production observation window.
