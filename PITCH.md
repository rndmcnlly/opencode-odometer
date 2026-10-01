# opencode-odometer

Historical design pitch. The current [README](README.md) documents setup and behavior: thresholds now use total recorded tokens, and delivery uses durable synthetic messages.

**Token mileage, quietly brought into context.**

An independent OpenCode V2 plugin that gives an agent occasional, factual awareness of its cumulative token usage. It measures the journey without implying that the journey was wasteful or should stop.

## The problem

The agent does not ordinarily receive a live cumulative usage counter. It can see its current context, but not the total footprint of repeatedly replaying that context across model steps or running subagents.

In one measured 30-day workload, cached input made up approximately 96% of token volume: 2.33 billion cached input tokens, compared with 94 million noncached input tokens and 9 million output tokens. A typical step replayed roughly 100k tokens of cached context. The highest-volume 10% of sessions accounted for about 68% of cached traffic.

That does not make cached context waste. Long conversations preserve mood, shared vocabulary, exploratory intent, and accumulated judgment. More frequent compaction can lose those qualities. A replay model suggested roughly 17% savings at frontier-model prices from earlier compaction, before accounting for any extra work caused by lost context.

The opportunity is not to nag the agent into compacting. It is to make the accumulating footprint legible, so the agent can exercise better judgment about where work belongs.

## The idea

At a few configurable cumulative **main-session cached-input milestones**, bring a compact usage note into the agent's context.

Default stops:

```json
["4M", "16M", "64M"]
```

These are explicit stops, not parameters to a growth formula. Each stop is eligible once per session. After the last configured stop, no further automatic notices are generated. Someone wanting more stops can simply add them.

Applied to the motivating workload, these stops would have produced at most about 156 notices across the month: 115 sessions reached 4M, 37 reached 16M, and four reached 64M. Most sessions would see no notice; most notified sessions would see only one.

## Easy configuration, in the file that loads the plugin

Use OpenCode's existing plugin options rather than introducing another configuration file, environment variables, or a formula language.

Proposed configuration after the package is available, in global `~/.config/opencode/opencode.json(c)` or a project's `opencode.json(c)`:

```jsonc
{
  "plugins": ["opencode-odometer"]
}
```

That uses the default stops. To customize them, use the object form in the same file:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-odometer",
      "options": {
        "stops": ["2M", "8M", "32M", "128M"]
      }
    }
  ]
}
```

The package field can instead identify the eventual GitHub package or a local plugin directory. The examples describe the intended interface, not a package that has already been published.

`M` should mean one million tokens. Invalid stops should produce a useful configuration error. An empty list should disable automatic notices. Prefer a small, understandable configuration surface; do not require users to configure accounting internals to get sensible behavior.

## What the agent hears

A harness-authored usage note, not a counterfeit human request:

```text
[opencode-odometer: usage telemetry, not a new task]
Cumulative tokens:
  main: cached 4.3M; uncached 180k; output+reasoning 22k
  descendants: cached 900k; uncached 75k; output+reasoning 18k
Recent main cached input: approximately 110k/step.

Preserve main-thread continuity. For upcoming bounded investigations,
consider subagents with focused briefs and concise returns, where authorized.
No acknowledgement or usage commentary needed; continue the task.
```

The numbers are illustrative. The note should be generated deterministically from recorded usage, without another LLM call.

The first notice can establish the intent. Later notices should be almost entirely numerical. Avoid guilt, warnings about "waste," requests for explanations, or ceremonial acknowledgements.

## Behavior that matters

- **Token-triggered, not price-triggered.** Changing providers or prices should not change the stops. Cached input dominates the motivating workload by volume, not necessarily by monetary cost.
- **Main usage drives this intervention.** Child and recursive descendant usage is reported separately, but does not advance the main-session stops. Successful delegation should not itself trigger another suggestion to delegate.
- **No telemetry-only model turns.** Deliver at the next already-needed primary model request. If the session is idle, wait for genuine work to resume. Do not wake the agent to tell it how much it has used.
- **No interruption storm.** Coalesce multiple crossed stops into one current report rather than delivering a backlog. Do not repeat a delivered stop after a plugin reload.
- **No automatic mitigation.** Do not compact, switch models, spawn agents, or split sessions. The note supplies awareness, not new authorization.
- **Preserve task authority.** User instructions and existing delegation permissions still govern what the agent may do. "Consider subagents" is a conditional suggestion, not a mandate.
- **Account honestly.** Include relevant compaction usage; make the treatment of cache writes explicit; include reasoning in output; deduplicate usage updates; avoid counting copied fork history as fresh execution. Missing telemetry should not silently become zero usage.

The recent per-step figure matters because cumulative consumption is already spent. It helps the agent see the footprint of another investigation in the main thread, where choosing a bounded subagent may still make a difference.

## Intended effect

**Preserve continuity; isolate excursions; split at meaningful boundaries.**

The main thread holds goals, taste, interpretation, and decisions. Subagents can absorb bounded searches, test runs, inventories, and independent investigations, returning concise findings and evidence rather than their entire working history.

Delegation is not automatically cheaper. Briefs duplicate context, child agents consume tokens, and their outputs can enlarge the main thread. Odometer should make both sides visible without turning subagent use into a score to optimize.

Success means the agent has useful situational awareness with almost no extra conversation devoted to accounting. Fewer tokens are desirable only when the work and continuity remain good.

## Relationship to opencode-monitor

[opencode-monitor](https://github.com/rndmcnlly/opencode-monitor) is a useful precedent: it brings live events into conversations and provides occasional actionable guidance about foreground shell use. Odometer should be a **distinct plugin**, independently installable and configurable, with no dependency on monitor.

Monitor's immediate synthetic-message delivery is appropriate for command output. Usage telemetry needs a quieter delivery policy. OpenCode V2's request-context hooks are a promising route; the specification should verify how best to provide the synthetic note without admitting an extra task or disturbing cached prefixes unnecessarily.

## Handoff

This is a pitch, not a detailed specification or implementation. The next agent should verify the current OpenCode V2 plugin contract and specify accounting, session ancestry, delivery, persistence, and tests before implementing a small proof of concept.

Keep the literal `stops` list and same-file plugin configuration central. Replay the policy against representative session histories to check notice frequency, and test that notices do not create autonomous response loops. Evaluate whether the agent actually stays on task rather than acknowledging or debating telemetry.
