# opencode-odometer

**Token mileage, quietly brought into context.**

An OpenCode V2 plugin that lets the model notice accumulated token usage within a session. It injects synthetic messages when the session's total recorded token count passes configured thresholds, called stops. The agent receives these during ongoing work, even if it has been working for an hour without yielding to you.

You can ask your agent to talk with you about token use and ways to reduce it. You can also use stops as soft triggers: ask the agent to consider handing off ongoing work, delegating a bounded investigation, or starting a fresh session. These are nudges. The plugin leaves the decision to the agent and user, under their existing instructions and permissions.

By default, the agent is asked to keep working without acknowledging the note. Add a comment to request a different response.

## Set up

Tested with OpenCode V2 2.0.21. Add the GitHub package to `plugins` in your global `~/.config/opencode/opencode.json(c)`, or in a project's `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:rndmcnlly/opencode-odometer#main",
      "options": {
        "stops": ["4M", "16M", "64M"]
      }
    }
  ]
}
```

Merge this entry into your existing plugin list, then reload the project. OpenCode installs the package from this repository. Use a full commit hash in place of `main` to pin a revision. To update a branch-based installation later:

```sh
opencode plugin update github:rndmcnlly/opencode-odometer#main
```

### Choose your stops

Start with `["4M", "16M", "64M"]`, the defaults if you omit `stops`. Most short sessions will never reach a stop. For more frequent checkpoints, try powers of two: `["1M", "2M", "4M", "8M", "16M", "32M", "64M", "128M", "256M"]`.

- A stop is a token count, either a plain positive integer (`10000`) or a number with a scale suffix: `k`, `M`, `B`, `T`, `Q` for thousands through quadrillions (10^3, 10^6, 10^9, 10^12, 10^15). Suffixes accept either case, so `4M` and `4m` are the same, and decimals are allowed where they land on whole tokens (`1.5M`, `0.5B`).
- Stops count the main session's cumulative total: uncached input, cached input, cache writes, output, and reasoning. Repeated processing of context counts again. A session can pass a 4M stop while its context window is much smaller. Token counts also differ from dollar costs.
- Child-session usage does not advance the main session's stops.
- List stops in increasing order, without duplicates. Each is eligible once per session. If several stops have passed, one note covers them together. Existing sessions keep their accumulated usage.
- There are no automatic stops beyond your list. An empty list disables notes; removing the plugin entry uninstalls it.

### Add a comment

Synthetic messages may not appear in OpenCode or OpenChamber's ordinary transcript. If you want to hear about checkpoints, ask the agent to remark on them. Set `comment` alongside `stops`:

```jsonc
{
  "package": "github:rndmcnlly/opencode-odometer#main",
  "options": {
    "stops": ["4M", "16M", "64M"],
    "comment": "I'm interested to know when these thresholds are passed, so please actively remark on them."
  }
}
```

Every checkpoint then includes:

```text
Note from user's opencode-odometer configuration:
I'm interested to know when these thresholds are passed, so please actively remark on them.
```

A comment replaces the default instruction to remain silent. For a handoff nudge, you could write:

> At this checkpoint, briefly discuss whether to continue here or prepare a handoff. If a bounded piece of work would suit a subagent, suggest that. Keep useful context in this conversation, and follow the existing delegation permissions. You don't have to stop or hand anything off.

Omit `comment`, or leave it empty, to keep checkpoints quiet. Edits apply to future checkpoints after reload; they do not repeat earlier stops or rewrite earlier notes.

## Development

```sh
npm ci
npm run check
npm test
```

The implementation is in [`src/index.ts`](src/index.ts). See [development notes](DEVELOPMENT.md) for inspection commands and current limitations, and [durable-delivery verification](DURABLE-TEST.md) for the live test record.

## Research motivation

*Adam Smith*

I started this project after looking at a 30-day sample of my OpenCode workload. Cached input accounted for about 96% of token volume: 2.33 billion cached-input tokens, compared with 94 million uncached-input tokens and 9 million output tokens. A typical step replayed roughly 100,000 cached tokens. The highest-volume 10% of sessions accounted for about 68% of cached traffic.

I initially made the stops count only cached input. Now they count all recorded token categories, so the odometer ticks on weirdly shaped workloads too. With cached input accounting for so much of my sample, the change makes little difference there. My own configuration uses powers-of-two stops from 1M through 256M and asks the agent to actively remark on them.

I value long conversations. They preserve shared vocabulary, mood, exploratory intent, and accumulated judgment. A replay model suggested roughly 17% savings at frontier-model prices from earlier compaction, but it didn't account for the extra work that losing context might cause. I haven't demonstrated those savings with this plugin. Delegation has costs too: briefing a subagent takes tokens, and its work and returned findings add more.

I want an occasion to notice the work and talk about where it belongs. A handoff might help. Staying in the same conversation might be better. The [original pitch](PITCH.md) records the estimates that led me here; I'm still trying out whether the reminders help.

I'm uncomfortable with how we talk about “burning tokens” as if they were money in some simple and direct way. If we think of tokens like words, the labor of reading a word is different from writing a word, and reading unfamiliar words is different from re-reading familiar words. I didn't “burn words” in a meeting today: I listened, re-skimmed an old report, and spoke a bit. It's almost a coincidence that each kind of labor could be measured in units of words.

“Burning tokens” is trying to reference a kind of model labor, so we should distinguish the kinds of labor involved. This plugin leans on the problematic idea of total token count to set up some natural points in a session for the actual breakdown of model labor to get noticed.
