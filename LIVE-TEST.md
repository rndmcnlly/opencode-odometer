# Live first-stop test

2026-10-01. **Passed the observation-and-halt test**, with a provider error requiring session resumption.

Historical result: this tested the earlier transient implementation. `DURABLE-TEST.md` verifies the replacement's mid-work synthetic delivery and continued retention. The two defects identified below have since been fixed with regression tests.

- Command: `opencode run --standalone --model openai/gpt-6-astra --format json`, with a source dossier and read-only compatibility-audit prompt.
- Session: `ses_f06d5a541ffeMlSivOG3Uhn9M3`.
- Used the real default 4M stop and actual provider-recorded usage. No threshold changes or usage manipulation.
- Task: inspect plugin contracts, provider message lowering, accounting, persistence, pagination, concurrency, and failure behavior; run substantive in-memory probes.
- The agent was explicitly instructed to override the note's usual silence instruction for this test, stop on the real injected note, and quote it verbatim.
- First CLI invocation ended with an OpenAI missing-tool-output error after reporting 3,301,888 cached tokens. Resumed the same session with another standalone invocation.
- The agent then observed the note at approximately 4.11M cached tokens, quoted it, and stopped using tools. Final recorded cached input was 4,223,744, including the acknowledgement request.
- Read-only status verification found `delivered: [4000000]`. A script verified that the quoted note exactly matched persisted `last.text` and that no tool-use events followed the acknowledgement.
- The resumed CLI also returned exit code 1 and emitted an earlier-timestamped provider error alongside the successful final answer. Transcript and RPC assertions establish the odometer outcome; process exit alone does not.

## Exact echoed note

```text
[opencode-odometer: usage telemetry, not a new task]
Cumulative recorded tokens:
  main: cached 4.11M; uncached 124.27k; output+reasoning 13.29k
  descendants: unavailable (no readable observed totals, not necessarily zero)
Descendant coverage is partial: only observed child links; 0 known sessions unreadable.
Recent main cached input: approximately 115.64k/step (5 recorded steps in current context).
Provider omissions can appear as zero in recorded usage; these are recorded counts, not a guarantee of complete telemetry.
Preserve main-thread continuity. For upcoming bounded investigations, consider subagents with focused briefs and concise returns, where authorized. This grants no new permission and requests no compaction or other automatic mitigation.
No acknowledgement or usage commentary needed; continue the task.
```

## Useful audit findings to address

The child run reproduced two concrete edge-case defects; this test did not modify production code:

1. Decimal-M parsing uses floating-point multiplication, so valid values such as `"1.000001M"` and `"0.000123M"` can be rejected.
2. Traversal marks a child visited before checking its parent. An earlier stale link can therefore suppress a later valid path to that descendant.

It also demonstrated that removing the transient note on the following request breaks the exact-prefix condition for the installed OpenAI WebSocket continuation implementation, selecting full replay. That is an in-memory lowering/continuation result, not a measured provider cache miss. The deliberately halted live test did not exercise a post-notice continuation.

Full prompt, source dossier, raw JSONL, stderr, echoed text, and final status are in `.trial/live-smoke*`; the reusable launch script is `.trial/run-smoke.py`. This directory is gitignored.
