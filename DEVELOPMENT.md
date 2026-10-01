# Development and inspection

The README describes the user-facing behavior. These notes cover the implementation and trial limits.

## Checkpoint delivery

After ordinary tool completion, the plugin reads OpenCode's committed main-session totals and compares their sum with configured stops. The five recorded usage buckets are disjoint: input, output, reasoning, cache read, and cache write. This matches the installed `@opencode/schema` total function; it is not interchangeable with a provider's potentially inclusive token counters.

Crossed stops are reserved in plugin storage before admitting a native synthetic message with `delivery: "steer"` and `resume: false`. The note stays in chronological history rather than disappearing from the next request. OpenCode owns its replay and normal compaction. The tested host lowers synthetic messages to user-role model input, while retaining their distinct synthetic identity in stored history.

Comments are optional strings. Empty or whitespace-only strings retain the silent default. Nonempty comments are labeled as coming from the user's configuration and replace the no-acknowledgement instruction.

## Inspect a session

The read-only RPC reports configured stops and comment, main token buckets, `mainTotal`, reserved stops, the latest note, and observed descendant totals:

```sh
opencode api rpc.call --param rpcID=odometer --param method=status \
  --param 'location[directory]=/absolute/path/to/your/project' \
  --data '{"input":{"sessionID":"ses_YOUR_SESSION"}}'
```

Use a directory where the plugin is loaded. With OpenChamber's private server, pass `--server` with that server's current URL; the shared service can be a different process. Status reads neither deliver notes nor consume stops.

`last.at` is the reservation time, not proof that the model saw the note. `last.messageID` is the intended synthetic message ID. Old state without that field describes the former request-only implementation.

## Limits

- **Tool boundaries:** an active agent sees checkpoints between tool-driven steps. Committed usage may lag the current step. Tool-free sessions wait for a tool completion, and idle sessions are not woken.
- **Best-effort at-most-once admission:** a crash or admission failure after reservation can lose a note. Per-session callbacks are serialized within each plugin instance. Stable message IDs deduplicate admissions with the same first crossed stop, but storage has no cross-instance transaction.
- **Recorded usage:** omitted provider telemetry can appear as zero. The main total includes auxiliary usage recorded by OpenCode. Cache writes appear with uncached input in the displayed breakdown; reasoning appears with output. Token totals do not imply equal costs across categories or providers.
- **Partial descendants:** only locally observed parent links are available. Forks are excluded. A traversal examines at most 100 links and 100 storage pages, with at most 100 session reads. `truncated` means additional coverage is unknown; `missing` counts unreadable attempted sessions. `unavailable` flags a failed link scan or non-advancing cursor.
- **Recent mileage:** the mean cached input over up to five assistant usage records in active context. It may be unavailable after compaction and is omitted for forks to avoid treating copied history as fresh work.
- **Failure handling:** main-accounting or notice-state errors skip the note; optional child-link failures retain the main notice and disclose missing coverage. Warning deduplication retains at most 100 keys. Host calls have no wall-clock deadline. A failed event stream logs a warning but does not reconnect automatically.
- **Persistence:** durable notes are subject to normal compaction. Consumed stop values remain consumed across configuration edits and reloads. Moving the trigger from cached input to total tokens does not reset old stops; newly crossed, unconsumed values become eligible normally.

The plugin does not export external telemetry. Stored data consists of stop state, the latest rendered note (including any configured comment), and observed child links. Native synthetic notes are also part of OpenCode's session history.

## Verification history

- [`DURABLE-TEST.md`](DURABLE-TEST.md): live mid-work delivery, prefix retention, reload persistence, and idle non-wakeup. This test preceded the switch to total-token triggering.
- [`LIVE-TEST.md`](LIVE-TEST.md): historical first-stop observation test of the earlier transient implementation.
- [`REVIEW.md`](REVIEW.md): initial quality review and subsequent corrections.
- [`DATA-ACCESS.md`](DATA-ACCESS.md): historical API investigation.
- [`PITCH.md`](PITCH.md): original research motivation and design pitch, not the current implementation specification.

Run `npm run check` and `npm test`. Tests include all-category and mixed-category total triggers, comment behavior, admission failures, state compatibility, concurrent callbacks, decimal parsing, and bounded descendant traversal. Local live-test traces under `.trial/` are intentionally untracked.
