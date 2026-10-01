# Durable, mid-work checkpoint verification

2026-10-01. This supersedes the delivery behavior tested in `LIVE-TEST.md`.

## Contract

During uninterrupted tool-driven work, notice crossed stops between steps, keep the note in subsequent context, and continue the task. Do not wait for a human turn, wake an idle session, or remove the note on the next request. Keep native OpenCode synthetic-message conventions, including current UI visibility behavior.

## Implementation

`ctx.tool.hook("execute.after", ...)` reads committed main-session usage. A crossed stop reserves durable plugin state, then calls `ctx.session.synthetic` with `delivery: "steer"` and `resume: false`. OpenCode owns the durable history and chronological replay. No context-overlay hook remains.

The message is a distinct `synthetic` record in OpenCode history. The tested 2.0.21 host lowers it to user-role input; its text explicitly identifies harness authorship. This is not a claim that every provider receives a system-role message.

## Live evidence

Model: `openai/gpt-6-astra`. All runs used `opencode run --standalone`.

1. **Mechanism probe**, session `ses_f06c66a1fffej54iCREXpxGDI6`: admitted a diagnostic note after tool 2. It appeared in request 3 and every remaining request while the agent completed all six assigned tool calls.
2. **Actual plugin**, session `ses_f06c313acffeTRYI788sDuwlsL`: isolated project options set stops to `[1, 20000, 50000]`. The task was four file inspections followed by type-check and tests, each a separate shell call.
   - Exactly six tool calls and seven model requests.
   - Checkpoint counts in successive requests: `0, 0, 0, 1, 2, 2, 3`.
   - The final answer reported three genuine checkpoints and completed all assigned work.
   - RPC state contained exactly the three configured stops.
   - Every admitted checkpoint retained its ID and exact text in every later request. Subsequent standalone API reads verified all three in persisted context after host reload.
   - A further assertion compared complete outgoing message arrays: every subsequent request retained the entire earlier message prefix unchanged, including across standalone reload and the genuine follow-up.
3. **Idle behavior**, same session: a separate diagnostic synthetic message with `resume: false` remained pending in the inbox. Token totals were unchanged across admission. A genuine later user request delivered it, and the agent completed that one-tool task normally.

Both working runs and the follow-up exited successfully. The small thresholds were confined to `.trial/durable-smoke/opencode.json`; global defaults were not changed.

## Artifacts

- `.trial/durable-probe/`: mechanism fixture, raw run events, and request trace.
- `.trial/durable-smoke/`: low-stop configuration, observer plugin, raw events, request trace, RPC status, persisted context, and idle-admission verification.
- Traces capture actual outgoing message arrays and projected history, rather than relying only on the model's self-report.

## Scope

This verifies normal mid-work delivery, subsequent retention, reload persistence, and idle non-wakeup on the tested host/model. It does not establish provider cache-hit rates, behavior through compaction, or cross-instance transactional delivery. Tool-free sessions wait until a tool completes before receiving new checkpoints. Reserved stops from the old request-only implementation remain consumed rather than being replayed.
