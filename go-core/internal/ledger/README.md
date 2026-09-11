# Durable attempt ledger

Amounts use signed int64 microyuan (1 yuan = 1,000,000 microyuan). The caller calculates prices and captures its configuration version before reserving. This package never receives API keys, prompts, or response bodies. Source is `answer`, `probe`, or `classifier`.

- `Open(path, Options{TimeZone, Now})`: opens an append-only checksummed versioned journal with an exclusive OS file lock. Locks release on process exit; concurrent writers fail closed. Use a dedicated local persistent disk, not NFS/SMB or multiple replicas with separate copies. Do not replace/rotate/unlink the file while it is open.
- `Reserve(attemptID, *estimateMicros, dailyLimitMicros, source)`: fsyncs before success. Positive limits atomically guard total pending + actual + estimated; zero/negative limits disable the guard. Nil price under an enforced budget fails closed. IDs must be globally unique per attempt across restarts. Identical reserves are idempotent even after settlement; they are not permission to resend an upstream attempt.
- `Settle(attemptID, *actualMicros, fromUsage)`: actual usage replaces the reserve; missing usage moves the reserve to estimated spending. An actual amount is recorded even for an initially unpriced attempt. Identical settlements are idempotent; conflicting settlements fail. Actual cost may exceed the original estimate and daily budget: recording incurred cost must remain possible.
- `Release(attemptID)`: use only when generation definitely never started. Network failures/timeouts with uncertain upstream execution must settle estimated, not release.
- `Snapshot()`: amounts and per-source totals belong to the settlement day; unresolved reservations carry across days and restarts. `Unpriced` counts reservations made on the current day with unknown price, including subsequently completed or released ones. Reads serialize with the writer and return a caller-owned source map.
- `Close()`: releases the writer lock. Failed writes/syncs poison the active writer, requiring close and reopen before further mutations. Callers must fail closed on every persistence error and must not start a new upstream attempt.

A single writer consumes a bounded queue of 256 mutations and combines at most 64 already-queued operations into one write/fsync. There is no timer or deliberate batching delay. Validation and budget accounting remain sequential under the ledger mutex; snapshots cannot see staged totals. Success is acknowledged only after the shared fsync succeeds. On a write/sync failure, staged state is restored, all otherwise-successful operations in that batch receive an error, and later mutations fail closed. Close stops new submissions and drains accepted ones before releasing the file lock. The checksummed per-event WAL format is unchanged; records from a failed or interrupted batch can still be present on recovery, so an error never proves that a reservation was absent from disk.

Crash recovery retains every fully committed reservation. Only an unterminated final record is discarded; a corrupt newline-terminated record, checksum mismatch, or invalid sequence prevents opening. A reservation whose settlement was lost remains pending conservatively. Operators must reconcile unresolved attempts against upstream evidence; there is no automatic expiration or refund. Budget pressure is conservative, not an exact provider invoice or a guarantee against actual usage exceeding estimates.

The in-memory attempt cache is capped at 4096 records after each batch, including pending, settled and released attempts. During a batch it may temporarily include up to 64 additional touched records; readers serialize with the writer. Eviction does not expire an ID or release a reservation: cold lookups use a derived disk hash index with 65536 fixed bucket heads (512 KiB), compare complete IDs and preserve the same indefinite idempotency/conflict semantics. The cache map is replaced when over its bound to release its backing allocation. No mmap or new library is used.

`<WAL path>.attempt-index` is a disposable local sidecar. The WAL remains the sole durable authority and its format is unchanged; every Open rebuilds the index by streaming the validated WAL with the same bounded cache. Index records checksum their chain metadata and content. Mutations sync the WAL before updating the index and acknowledging callers; index errors also poison the writer. A failed call can therefore already exist in the WAL, and recovery/idempotent retry remain required. The index is never used to recover billing totals, and it need not be backed up; retain the WAL. Do not modify either file while open. An unrelated file or symlink at the sidecar path is rejected.

The WAL and disk index still grow with history; disk compaction and bounded startup time are not implemented. Fixed hash buckets bound RAM, not lookup chain length or disk I/O at arbitrary scale. Plan disk capacity and backups; do not equate the bounded cache with a proof that the whole process has no leaks. This format does not import the Node JSON ledger automatically; use the explicit offline opening-balance API below with verified inputs so existing daily spending is not reset. OS permissions are best effort on Windows; deploy under a dedicated service identity with private directory ACLs.

## Explicit offline migration API

`ImportOpeningBalance(sourceID, date string, actual, estimated, pending int64) error` accepts the lowercase SHA256 digest of a frozen source ledger and integer microyuan totals. It imports exactly once into an empty WAL. Repeating the identical tuple remains idempotent after restart and after subsequent business records; changing any field is rejected. Date must equal the ledger's current accounting date. Stop the Node writer and verify date/totals before invoking this helper. It does not read source files or perform automatic production migration.

Map Node `settledActualSpendYuan` to actual, `settledEstimatedSpendYuan` to estimated, and `estimatedSpendYuan` to pending. All imported values are attributed to `legacy`; old pending goes into estimated settled spending because Node has no durable attempt identity and cannot safely be released. Reject negative, malformed, stale-day or overflowing inputs. Keep the frozen source file as migration evidence. Do not run a second independent ledger against the same budget after migration.

## Observation mode (budget disabled)

`Options{Observation: true}` uses a dedicated journal plus `.observation-checkpoint`.
It rejects positive `dailyLimit` values. The default protected mode remains unchanged,
with permanent historical attempt identity semantics. Observation statistics are
operational cost estimates, not user balances or compute-bean billing records.

An empty observation journal gets a checksummed mode checkpoint before accepting
requests. A nonempty protected journal cannot be implicitly converted. A protected
open refuses an observation checkpoint. Switching modes therefore requires controlled
restart and separately retained paths; never delete the old protected history to
force a conversion.

After every 4096 committed events (up to one additional 64-request writer batch),
the writer atomically replaces a synced checkpoint, syncs its parent directory on
Unix, then truncates and syncs the original locked WAL. The checkpoint contains the
sequence, current-day totals/source aggregates, opening import identity, every
unresolved attempt, and completed attempts touched in the last 4096 events. The
derived attempt index is rebuilt. WAL and index disk growth is thus bounded for
ordinary traffic; unresolved attempts are never silently released. At 20000 pending
attempts, new reservations fail closed with `ErrPendingLimit`; settlement/release
remain available. Pending amounts survive day rollover; spend aggregates roll over
according to the configured accounting timezone. This is not permanent raw history:
ship request logs to the existing collector if historical analysis is required.

Idempotency is guaranteed for all unresolved attempts and the retained recent
window. Older terminal IDs can be forgotten after checkpointing; callers must
always use globally fresh IDs and must not retry ancient completed attempts as new
reservations. Recovered recent duplicate settlements do not add spend twice.

Recovery verifies checkpoint checksums and retained state, rebuilds the index,
validates any old WAL prefix left by a crash before truncation, skips checkpointed
sequence numbers, and requires contiguous new records. A checkpoint, truncate,
sync, or index failure poisons the writer and returns an error; reopening determines
the durable result, so an errored mutation can already be durable and must be retried
with its original ID. The WAL lock remains held across checkpoint replacement.
Windows retains the existing `syncParent` no-op; tests cover process-level restart,
not a guarantee against arbitrary filesystem/controller power loss.

Checkpoint staging uses only `<wal>.observation-checkpoint.tmp`, so repeated process
crashes cannot accumulate random staging files. While holding the WAL writer lock,
the writer checks that an existing staging path is a regular file with the dedicated
`AMROBS01` header (or its interrupted-write prefix, including an empty new file).
Unknown contents and non-regular paths are refused without alteration. The next
checkpoint reuses this one staging file; unrelated files are never enumerated or
removed. New checkpoints carry the same header; earlier JSON checkpoints remain
readable. Recovery without new calls may leave the old, bounded WAL prefix intact;
it is verified and skipped and does not duplicate either totals or index entries.
