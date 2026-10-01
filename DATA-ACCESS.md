# Odometer data-access investigation

Investigated 2026-10-01. This is a feasibility note, not an implemented plugin or a finished specification. `PITCH.md` remains unchanged.

Follow-up: an implementation now exists in `src/index.ts`, with trial instructions in `README.md`. Delivery was subsequently corrected to use `ctx.session.synthetic({ delivery: "steer", resume: false })` after tool completion, retaining native history while the agent continues working. `DURABLE-TEST.md` records live verification. The current V2 documentation became reachable and confirms that `context` is exclusively the primary agent loop. Version 2.0.21 plugin declarations still lack session/message listing. The earlier investigation below is retained as evidence, not the current implementation status.

## Evidence and limits

- Running OpenCode: **2.0.21**. Inspected its live `/openapi.json` and read existing session data through `opencode api`.
- Available plugin package: **@opencode/plugin 2.0.15**, installed in `../opencode-monitor/node_modules`. Its published declarations establish the capabilities below, but need checking against 2.0.21 before implementation.
- The V2 plugin documentation at <https://opencode.ai/v2/docs/build/plugins> was unreachable (DNS failure). The existing `../opencode` checkout does not contain the current V2 service/docs layout and is not a reliable substitute.
- No plugin was installed, no sessions were created, and no model requests were initiated for this investigation.

## The smallest useful access path

The plugin does not need database access, provider credentials, transcript scraping, or another LLM call to obtain **main-session cumulative usage**.

In `Plugin.define({ id, setup(ctx) { ... } })`, register:

```ts
await ctx.session.hook("context", async (request) => {
  const session = await ctx.session.get({ sessionID: request.sessionID })
  // Compare session.tokens.cache.read with configured stops.
  // Read persistent delivery state; append a telemetry note only when due.
})
```

This illustrates the verified declaration-level access path, not a runnable implementation. The context hook exposes `sessionID`, `agent`, `model`, mutable `messages`, `system`, `options`, and `tools`. Separate hooks exist for `compaction`, `title`, and `generate`. Verify the host's actual hook call sites before asserting that `context` runs exclusively on primary requests.

Reading fresh session totals at the request boundary avoids an asynchronously consumed event stream being one step behind. Treat totals as **snapshots**, never as increments to add on each read.

## Capability map

| Need | Available interface | Qualification |
| --- | --- | --- |
| Main lifetime usage | `ctx.session.get({ sessionID })` → `session.tokens` | Verify lifetime semantics for forks, revert, failures, and compaction. |
| Current model context | `ctx.session.context({ sessionID })` | Returns session messages, but is not guaranteed to contain lifetime history after compaction. |
| Live per-step usage | `ctx.event.subscribe()` → `session.step.ended` | Includes session ID, assistant message ID, tokens, and durable event identity. |
| Failed-step usage | `session.step.failed` | Tokens are optional. Missing is not zero. |
| Auxiliary usage | `session.usage.recorded` | In 2.0.15 schemas, source is `title` or `compaction`. Do not add this on top of cumulative session totals. |
| Live cumulative updates | `session.usage.updated` | Ephemeral snapshot, not an accounting delta. |
| Parent relationship | `session.get().parentID`, `session.created` | Follow recursively for delegated descendants. |
| Fork provenance | `session.get().fork`, `session.forked` | Distinguish copying from delegation; test actual projection behavior. |
| Plugin options | `ctx.options` | Supports the pitch's same-file `options.stops`; live config schema confirms string/object plugin entries. |
| Persistent notice state | `ctx.storage.get/set/remove/scan` | Verify namespace, location scope, durability, and concurrency behavior. No transaction/CAS method in inspected declarations. |

The live HTTP API also exposes paginated `session.list` (including a `parentID` filter) and `session.message.list`. **Neither is exposed on `ctx.session` in the inspected plugin package.** There is no generic `ctx.client` in that package's context declaration.

## Accounting categories

Recorded session usage has this shape:

```ts
{ input, output, reasoning, cache: { read, write } }
```

The schema's `TokenUsage.total()` sums all five buckets. That indicates a non-overlapping recorded breakdown. Proposed display:

- cached input: `cache.read` (also the milestone driver)
- uncached input: `input + cache.write`, with cache writes disclosed separately when nonzero
- output + reasoning: `output + reasoning`

Confirm the service conversion before implementing these labels. The lower-level `@opencode/ai` provider usage contract is different: its input includes cache and its output includes reasoning. Mixing those two contracts would double count.

On the existing pitch-writing session, 109 messages contained 79 usage records. Their sum was:

| Bucket | Message sum | Session total |
| --- | ---: | ---: |
| input | 206,849 | 207,431 |
| cached read | 3,679,104 | 3,679,104 |
| output | 15,350 | 15,371 |
| reasoning | 8,065 | 8,065 |
| cache write | 0 | 0 |

The discrepancy is consistent with auxiliary usage, but its exact source was not verified. This establishes that summing message history is not interchangeable with reading the session total.

The recorded schema requires numeric buckets, whereas provider-level telemetry can be absent. Thus a recorded zero alone does not prove the provider actually measured zero. Honest coverage reporting may need a service change or provider-level observation.

## Descendants and recent steps: the real access gap

A plugin-only approach can observe child creation, persist child IDs, and refresh known children's totals with `session.get`. Follow `parentID` transitively; do not treat `fork.sessionID` as delegation. Observe step-ended events to maintain a small deduplicated recent-step window. Persist it for reloads. A proposed recent figure is the mean cached read over the last five recorded primary steps, reporting the available sample size.

But that does not recover children created before installation, or events missed while unloaded. It also needs testing across session moves, location-scoped plugin instances, child deletion, event disconnects, and forks that inherit parent IDs.

Three possible routes:

1. **Preferred contract:** expose read-only session listing and message listing on the plugin context, backed by the existing service APIs. Backfill then becomes possible without another connection.
2. **Standalone local workaround:** use `@opencode/client` service discovery and authentication to connect to the local service. This exists, but must not silently connect to a different service from the host (remote, standalone, or embedded). It is not a universally correct plugin solution.
3. **Bounded proof of concept:** plugin-context APIs only; label descendant coverage as partial when it cannot be recovered, and omit recent estimates until enough observed steps exist.

The HTTP session log endpoint was also probed with `after=0` and `follow=false`; it returned only a `log.synced` marker. That did not establish historical replay. Do not base recovery on replay until cursor/retention semantics are verified.

## Quiet delivery

`@opencode/ai` exposes `Message.system(text)`, documented as an operator-authored instruction at a chronological point, distinct from the initial system prompt. Appending this to `request.messages` is a promising request-only delivery mechanism:

```ts
request.messages.push(Message.system(renderTelemetry(snapshot)))
```

This is more suitable than changing the initial system prefix or calling `session.synthetic()` to steer/wake a session. It creates no turn by itself. Provider lowering, cache behavior, retries, and whether an append-only historical representation is needed still require tests. A request-only note is not automatically preserved in session history or later requests.

Keep the decision synchronous with the existing primary request: calculate all crossed, undelivered stops, deliver one current report, and mark those stops together. Store actual stop values rather than just a list index so option edits are understandable.

There is no verified atomic transaction between persistent plugin state and provider dispatch. A crash between marking and dispatch can lose a notice; marking later can duplicate it after a crash. Choose and document a best-effort policy, with serialized per-session handling and tests for reloads/retries. Do not claim exactly-once delivery from the interfaces inspected here.

## Recommendation

Prove **main totals + literal stops + persisted state + request-only system note** first, without installing it globally. The remaining production blocker is reliable historical descendant discovery through the host's own connection. Verify the current V2 docs/host and request that narrow read-only capability if still absent. Missing provider telemetry is a separate honesty limitation, not something an event ledger can fix.
