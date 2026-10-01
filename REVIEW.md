# Pre-trial quality review

2026-10-01. Reviewed the implementation, product pitch, installed 2.0.21 declarations, and current V2 plugin documentation.

Follow-up: delivery now uses durable native synthetic messages at tool-completion boundaries, as verified in `DURABLE-TEST.md`. The live audit's decimal parsing and stale-edge traversal defects were also fixed. The original findings below record the earlier request-only implementation.

## Fixed

- **Unbounded traversal despite the advertised cap:** the original code limited session reads but continued scanning every stored child link. Traversals now bound links, pages, and session reads. Truncation is reported separately from unreadable sessions, without inventing an omitted count.
- **Optional accounting could suppress the main notice:** failed child-link writes or scans aborted the entire hook. Main-session notices now survive these failures; scan gaps are disclosed.
- **Unload race:** an in-flight callback could append a notice after cleanup started. Shutdown is now checked before reservation and before appending. A reservation already in flight can still consume a stop, consistent with the existing at-most-once policy.
- **Incomplete persisted-state validation:** malformed last-note metadata could pass through status and later be overwritten. It now fails explicitly and preserves the stored value.
- **Multi-day memory growth:** diagnostic deduplication retained every failed session ID indefinitely. It now retains at most 100 keys.
- **Unnecessary history reads:** forks fetched context only to discard it. Those reads are now skipped.

## Validation

`npm run check` and `npm test`: 19 tests. Added coverage includes large trees, real cursor pagination, cycles, missing ancestors, optional failures, reservation recovery, unload races, malformed state, and broken pagination. The test harness now honors storage cursors and page limits.

The earlier live check remains documented in README. This pass used automated checks; it did not restart the host or force another milestone into a real session.

## Remaining trial limits

- At-most-once reservation is scoped to a plugin instance's serialization, with no cross-instance storage transaction or provider receipt confirmation.
- Historical child discovery and cross-location coverage remain partial. An event-stream failure is logged but does not reconnect automatically.
- Host API calls are awaited without a wall-clock deadline. Traversal is count-bounded, but a stalled host call can still delay a request or cleanup.
- Fork recent-step estimates remain unavailable, including fresh post-fork work. Main totals use the host's projection.
- Superseded: request-only notes were not transcript history. The current implementation uses durable synthetic messages; provider cache-hit behavior remains unmeasured.
