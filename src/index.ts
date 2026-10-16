import { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/plugin/rpc"
import { createHash } from "node:crypto"

type Tokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
type State = { version: 1; delivered: number[]; last?: { at: string; stops: number[]; text: string; messageID?: string } }
type Descendants = { total: Tokens; count: number; missing: number; truncated?: boolean; unavailable?: boolean }
const DEFAULT_STOPS = ["4M", "16M", "64M"]
// Suffix letters denote a power-of-ten multiplier. Both cases are accepted,
// following the SI convention of lowercase kilo and uppercase mega and above.
const SCALES: Record<string, number> = { k: 3, m: 6, b: 9, t: 12, q: 15 }
const PREFIX = "v1/session/"
const DESCENDANT_LIMIT = 100

export function parseStops(value: unknown = DEFAULT_STOPS): number[] {
  if (!Array.isArray(value)) throw new Error("opencode-odometer: stops must be an array such as [\"4M\", \"16M\", \"64M\"]")
  const stops = Array.from(value, (stop: unknown) => {
    // A stop string is digits with an optional fraction and an optional scale
    // suffix: "4000000", "4000k", "4M", "0.004B". No suffix means raw units.
    const match = typeof stop === "string" ? /^(\d+)(?:\.(\d+))?([kKmMbBtTqQ])?$/.exec(stop) : null
    const scale = match?.[3] ? SCALES[match[3].toLowerCase()] : 0
    const fraction = (match?.[2] ?? "").replace(/0+$/, "")
    // Parse scaled decimals exactly with integer arithmetic: floating
    // multiplication rejects values such as 0.000123M even though they denote
    // a whole number of tokens. A fraction longer than the scale is sub-unit.
    const count = typeof stop === "number" ? stop : match && fraction.length <= scale
      ? Number(BigInt(match[1]) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, "0") || "0")) : NaN
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error(`opencode-odometer: invalid stop ${JSON.stringify(stop)}; use positive integer tokens or strings like "4M" or "16k" (suffixes k, M, B, T, Q = 10^3 through 10^15, either case)`)
    return count
  })
  if (stops.some((stop, i) => i > 0 && stop <= stops[i - 1])) throw new Error("opencode-odometer: stops must be strictly increasing, without duplicates")
  return stops
}

export function parseComment(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new Error("opencode-odometer: comment must be a string")
  return value.trim() || undefined
}

export function tokens(value: unknown): Tokens {
  const t = value as Tokens | undefined
  if (!t || [t.input, t.output, t.reasoning, t.cache?.read, t.cache?.write].some((n) => typeof n !== "number" || !Number.isFinite(n) || n < 0)) {
    throw new Error("opencode-odometer: missing or invalid recorded token usage")
  }
  return t
}

// OpenCode's recorded usage buckets are disjoint, unlike some provider API totals.
export function totalTokens(t: Tokens): number {
  const total = t.input + t.output + t.reasoning + t.cache.read + t.cache.write
  if (!Number.isFinite(total)) throw new Error("opencode-odometer: recorded token total overflowed")
  return total
}

function state(value: unknown): State {
  if (value === undefined) return { version: 1, delivered: [] }
  const s = value as State
  if (!s || s.version !== 1 || !Array.isArray(s.delivered) || s.delivered.some((n) => !Number.isSafeInteger(n) || n <= 0)) {
    throw new Error("opencode-odometer: invalid stored notice state; refusing to repeat notices")
  }
  if (s.last !== undefined && (!s.last || typeof s.last.text !== "string" || typeof s.last.at !== "string" || !Number.isFinite(Date.parse(s.last.at)) || !Array.isArray(s.last.stops) || !s.last.stops.length || s.last.stops.some((n) => !s.delivered.includes(n)))) {
    throw new Error("opencode-odometer: invalid stored last notice; refusing to overwrite state")
  }
  if (s.last?.messageID !== undefined && (typeof s.last.messageID !== "string" || !/^msg_[A-Za-z0-9]+$/.test(s.last.messageID))) {
    throw new Error("opencode-odometer: invalid stored synthetic message ID")
  }
  return s
}

export function due(stops: number[], delivered: number[], total: number) {
  return stops.filter((stop) => stop <= total && !delivered.includes(stop))
}

// Largest-first so a value reports in its highest whole unit. The scale
// suffixes here mirror the ones parseStops accepts.
const UNITS: [number, string][] = [[1e15, "Q"], [1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "k"], [1, ""]]

function format(n: number) {
  const [divisor, suffix] = UNITS.find(([d]) => n >= d) ?? UNITS.at(-1)!
  return `${Number((n / divisor).toFixed(2))}${suffix}`
}

function buckets(t: Tokens) {
  return `cached ${format(t.cache.read)}; uncached ${format(t.input + t.cache.write)}; output+reasoning ${format(t.output + t.reasoning)}${t.cache.write ? ` (uncached includes ${format(t.cache.write)} cache writes)` : ""}`
}

export function render(main: Tokens, descendants: Descendants, recent: number[], first: boolean, comment?: string) {
  return [
    "[opencode-odometer: usage telemetry, not a new task]",
    "Harness-generated checkpoint, not a new human turn.",
    "Cumulative recorded tokens:",
    `  main: total ${format(totalTokens(main))}; ${buckets(main)}`,
    descendants.count ? `  observed descendants (${descendants.count}): ${buckets(descendants.total)}` : "  descendants: unavailable (no readable observed totals, not necessarily zero)",
    `Descendant coverage is partial: only observed child links; ${descendants.missing} known sessions unreadable.${descendants.truncated ? " Traversal capped at 100 links or storage pages; additional descendants may be omitted (count unknown)." : ""}${descendants.unavailable ? " Some child links could not be read." : ""}`,
    recent.length ? `Recent main cached input: approximately ${format(recent.reduce((a, b) => a + b, 0) / recent.length)}/step (${recent.length} recorded steps in current context).` : "Recent main cached input: unavailable.",
    "Provider omissions can appear as zero in recorded usage; these are recorded counts, not a guarantee of complete telemetry.",
    ...(first ? ["Preserve main-thread continuity. For upcoming bounded investigations, consider subagents with focused briefs and concise returns, where authorized. This grants no new permission and requests no compaction or other automatic mitigation."] : []),
    ...(comment ? ["", "Note from user's opencode-odometer configuration:", comment] : ["No acknowledgement or usage commentary needed; continue the task."]),
  ].join("\n")
}

export const Odometer = Rpc.define({
  id: "odometer",
  events: {},
  methods: {
    status: {
      input: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"], additionalProperties: false },
      output: { type: "object" },
    },
  },
})

export default Plugin.define({
  id: "opencode-odometer",
  async setup(ctx) {
    const stops = parseStops(ctx.options.stops)
    const comment = parseComment(ctx.options.comment)
    const controller = new AbortController()
    const locks = new Map<string, Promise<void>>()
    const warned = new Set<string>()
    const warn = (key: string, error: unknown) => {
      if (warned.has(key)) return
      // Keep diagnostics bounded during a multi-day, many-session service lifetime.
      if (warned.size >= 100) warned.delete(warned.values().next().value!)
      warned.add(key)
      console.warn(`opencode-odometer: ${key}`, error)
    }
    // Concurrent tool completions share per-session serialization. Rejected work never poisons the queue.
    async function serial<T>(id: string, work: () => Promise<T>): Promise<T> {
      const next = (locks.get(id) ?? Promise.resolve()).then(work)
      const settled = next.then(() => {}, () => {})
      locks.set(id, settled)
      try { return await next } finally { if (locks.get(id) === settled) locks.delete(id) }
    }

    async function descendants(id: string): Promise<Descendants> {
      const total: Tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
      const visited = new Set([id])
      const queue = [id]
      let count = 0
      let missing = 0
      let links = 0
      let pages = 0
      let unavailable = false
      while (queue.length) {
        const parent = queue.shift()!
        let after: string | undefined
        do {
          if (links >= DESCENDANT_LIMIT || pages >= DESCENDANT_LIMIT || controller.signal.aborted) return { total, count, missing, truncated: true, unavailable }
          let page
          try {
            page = await ctx.storage.scan({ prefix: `v1/child/${parent}/`, after, limit: DESCENDANT_LIMIT - links })
            pages++
          } catch (error) {
            unavailable = true
            warn("descendant links unavailable", error)
            break
          }
          for (const entry of page.entries) {
            if (links >= DESCENDANT_LIMIT) return { total, count, missing, truncated: true, unavailable }
            links++
            const childID = entry.key.split("/").at(-1)!
            if (visited.has(childID)) continue
            try {
              const child = await ctx.session.get({ sessionID: childID })
              if (child.fork || child.parentID !== parent) continue
              // A stale edge must not suppress a later edge from the real parent.
              visited.add(childID)
              const t = tokens(child.tokens)
              for (const key of ["input", "output", "reasoning"] as const) total[key] += t[key]
              total.cache.read += t.cache.read
              total.cache.write += t.cache.write
              count++
              queue.push(childID)
            } catch { visited.add(childID); missing++; queue.push(childID) }
          }
          if (page.next && page.next === after) {
            unavailable = true
            break
          }
          after = page.next
        } while (after)
      }
      return { total, count, missing, truncated: false, unavailable }
    }

    await ctx.rpc.register(Odometer, {
      status: async (input) => {
        const { sessionID } = input as { sessionID: string }
        if (!/^ses_[A-Za-z0-9]+$/.test(sessionID)) throw new Error("opencode-odometer: expected an OpenCode session ID")
        const main = await ctx.session.get({ sessionID })
        const usage = tokens(main.tokens)
        return {
          sessionID, stops, comment: comment ?? null, main: usage, mainTotal: totalTokens(usage),
          state: state(await ctx.storage.get(PREFIX + sessionID)),
          descendants: await descendants(sessionID),
          coverage: "Partial descendant discovery; provider omissions may be recorded as zero. last is reserved, not confirmed received by the model. last.messageID identifies a durable synthetic admission; older entries were request-only.",
        }
      },
    })

    // Admit only while ordinary tool work is completing: the next agent step is
    // already needed. No request overlay, event-triggered wakeup, or synthetic-only turn.
    const registration = await ctx.tool.hook("execute.after", (request) => serial(request.sessionID, async () => {
      if (!stops.length || controller.signal.aborted) return
      try {
        const previous = state(await ctx.storage.get(PREFIX + request.sessionID))
        if (stops.every((stop) => previous.delivered.includes(stop))) return
        const main = await ctx.session.get({ sessionID: request.sessionID })
        // Remember parent links for sessions active when the plugin was installed, too.
        if (main.parentID && !main.fork) {
          try { await ctx.storage.set(`v1/child/${main.parentID}/${main.id}`, true) }
          catch (error) { warn("active child link unavailable", error) }
        }
        const usage = tokens(main.tokens)
        const crossed = due(stops, previous.delivered, totalTokens(usage))
        if (!crossed.length) return
        const observed = await descendants(request.sessionID)
        let recent: number[] = []
        try {
          // Fork history is copied, not fresh execution. Avoid using it for the recent estimate.
          if (!main.fork) {
            const history = await ctx.session.context({ sessionID: request.sessionID })
            recent = history.filter((m) => m.type === "assistant" && m.tokens).slice(-5).map((m) => tokens((m as { tokens: Tokens }).tokens).cache.read)
          }
        } catch (error) { warn("recent context unavailable", error) }
        const text = render(usage, observed, recent, previous.delivered.length === 0, comment)
        // A stable ID also prevents duplicate admission of the same first stop
        // by concurrent plugin instances. Storage itself is not transactional.
        const messageID = `msg_${createHash("sha256").update(JSON.stringify(["odometer", request.sessionID, crossed[0]])).digest("hex").slice(0, 32)}`
        if (controller.signal.aborted) return
        // Reserve before admission: ordinary reloads do not repeat, but a crash can lose this notice.
        await ctx.storage.set(PREFIX + request.sessionID, {
          version: 1,
          delivered: [...previous.delivered, ...crossed],
          last: { at: new Date().toISOString(), stops: crossed, text, messageID },
        })
        if (!controller.signal.aborted) await ctx.session.synthetic({
          sessionID: request.sessionID,
          id: messageID,
          text,
          description: "Odometer checkpoint",
          metadata: { source: "opencode-odometer", stops: crossed },
          delivery: "steer",
          resume: false,
        })
      } catch (error) {
        // Telemetry must not prevent the user's actual model request.
        warn(`notice skipped for ${request.sessionID}`, error)
      }
    }))

    const stream = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (controller.signal.aborted) break
          if (event.location?.directory !== ctx.location.directory) continue
          if (event.type !== "session.created" || !event.data.parentID) continue
          const { parentID, sessionID } = event.data
          // Confirm fork provenance through the projection, not only the created event.
          try {
            const child = await ctx.session.get({ sessionID })
            if (!controller.signal.aborted && !child.fork && child.parentID === parentID) await ctx.storage.set(`v1/child/${parentID}/${sessionID}`, true)
          } catch (error) { warn(`child link unavailable for ${sessionID}`, error) }
        }
      } catch (error) { if (!controller.signal.aborted) warn("descendant observation stopped; coverage remains partial", error) }
    })()

    return async () => {
      controller.abort()
      await registration.dispose()
      await stream
      await Promise.all(locks.values())
    }
  },
})
