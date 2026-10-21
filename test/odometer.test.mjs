import test from "node:test"
import assert from "node:assert/strict"
import plugin, { parseStops, due, tokens, totalTokens, render } from "../src/index.ts"

const usage = (read, input = 100, write = 0) => ({ input, output: 20, reasoning: 10, cache: { read, write } })

async function harness({ stops, comment, store = new Map(), read = 4_300_000, fork, events = [], failWrite = false, invalid = false } = {}) {
  const hooks = new Map()
  const notices = []
  const sessions = new Map([["ses_main", { id: "ses_main", tokens: invalid ? undefined : usage(read), fork }]])
  let handlers
  let calls = 0
  let scans = 0
  const ctx = {
    options: { stops, comment },
    location: { directory: "/project" },
    session: {
      hook: async () => assert.fail("must not modify request context"),
      get: async ({ sessionID }) => { calls++; if (!sessions.has(sessionID)) throw new Error("missing"); return sessions.get(sessionID) },
      context: async () => Array.from({ length: 8 }, (_, i) => ({ id: `msg_${i}`, type: "assistant", tokens: usage(100_000 + i * 1_000) })),
      synthetic: async (input) => { notices.push(structuredClone(input)); return { id: input.id } },
      prompt() { assert.fail("must not create prompts") },
      compact() { assert.fail("must not compact") },
    },
    tool: {
      hook: async (name, callback) => { hooks.set(name, callback); return { dispose: async () => hooks.delete(name) } },
    },
    storage: {
      get: async (key) => store.get(key),
      set: async (key, value) => { if (failWrite) throw new Error("storage unavailable"); store.set(key, structuredClone(value)) },
      scan: async ({ prefix, after, limit }) => {
        scans++
        const matches = [...store.entries()].filter(([key]) => key.startsWith(prefix) && (!after || key > after)).sort(([a], [b]) => a.localeCompare(b))
        const entries = matches.slice(0, limit).map(([key, value]) => ({ key, value }))
        return { entries, next: matches.length > entries.length ? entries.at(-1).key : undefined }
      },
    },
    rpc: { register: async (_definition, h) => { handlers = h; return { dispose: async () => {} } } },
    event: {
      async *subscribe({ signal }) {
        for (const event of events) yield event
        await new Promise((resolve) => signal.aborted ? resolve() : signal.addEventListener("abort", resolve, { once: true }))
      },
    },
  }
  const cleanup = await plugin.setup(ctx)
  const request = () => ({ sessionID: "ses_main", messages: [], system: [], options: {}, tools: {}, model: {}, agent: "build" })
  return { ctx, store, hooks, notices, sessions, cleanup, handlers, request, calls: () => calls, scans: () => scans }
}

test("literal default stops, customization, and empty disable", () => {
  assert.deepEqual(parseStops(), [4e6, 16e6, 64e6])
  assert.deepEqual(parseStops(["0.001M", 2000]), [1000, 2000])
  assert.deepEqual(parseStops([]), [])
  for (const value of [null, "4M", ["4MB"], [0], [Infinity], [1.5], ["-1M"], ["1e6"], ["1M", "1M"], [2, 1]]) assert.throws(() => parseStops(value), /opencode-odometer/)
})

test("decimal millions are exact at token and safe-integer boundaries", () => {
  assert.deepEqual(parseStops(["0.000123M", "1.000001M", "9007199254.740991M"]), [123, 1_000_001, Number.MAX_SAFE_INTEGER])
  assert.deepEqual(parseStops(["0.0000010M", "1.00000000M"]), [1, 1_000_000])
  for (const value of [["0.0000001M"], ["9007199254.740992M"], Array(1)]) assert.throws(() => parseStops(value), /opencode-odometer/)
})

test("a count has many spellings and one value", () => {
  const distinct = (...spellings) => new Set(spellings.map((s) => parseStops([s])[0])).size
  assert.equal(distinct("1000", "1k", "1K"), 1)
  assert.equal(distinct("1000000", "1000k", "1M", "1m"), 1)
  assert.equal(distinct("1000000000", "1000M", "1B"), 1)
  assert.equal(distinct("1000000000000", "1000B", "1T"), 1)
  assert.equal(distinct("4000000000000000", "4000T", "4Q"), 1)
})

test("a bare digit string is a whole-token count", () => {
  assert.deepEqual(parseStops(["10000"]), [10_000])
  for (const value of [["1000.5"], ["1e3"], ["0x10"], [" 1000"], ["1 k"]]) assert.throws(() => parseStops(value), /opencode-odometer/)
})

test("scaled decimals stay exact and never fall below a whole token", () => {
  assert.deepEqual(parseStops(["0.1k"]), [100])
  assert.deepEqual(parseStops(["9.007199254740991Q"]), [Number.MAX_SAFE_INTEGER])
  for (const value of [["0.0001k"], ["0.0000001M"], ["9.007199254740992Q"]]) assert.throws(() => parseStops(value), /opencode-odometer/)
})

test("parser and formatter agree on every unit, and totals promote only on round numbers", () => {
  const T = (n) => ({ input: 0, output: 0, reasoning: 0, cache: { read: n, write: 0 } })
  const total = (n) => render(T(n), { total: T(0), count: 0, missing: 0 }, [], false).match(/main: total ([^;]+);/)[1]
  for (const suffix of ["k", "M", "B", "T", "Q"]) {
    assert.equal(total(parseStops([`1${suffix}`])[0]), `1${suffix}`)
    assert.equal(total(parseStops([`1${suffix.toLowerCase()}`])[0]), `1${suffix}`)
  }
  assert.equal(total(999), "999")
  assert.equal(total(1_000_000 - 1), "1000k") // units are chosen before rounding; the seam is deliberate
  assert.equal(total(1_000_000), "1M")
  assert.equal(total(1e15 - 1), "1000T")
  assert.equal(total(1e15), "1Q")
})

test("coalesces crossed stops without an endless growth formula", () => {
  assert.deepEqual(due([4e6, 16e6, 64e6], [4e6], 100e6), [16e6, 64e6])
  assert.deepEqual(due([4e6], [4e6], 1e12), [])
})

test("missing or negative telemetry is not silently zero", () => {
  assert.throws(() => tokens(undefined))
  assert.throws(() => tokens(usage(-1)))
  assert.throws(() => tokens({ ...usage(1), output: NaN }))
  assert.deepEqual(tokens(usage(0)), usage(0))
})

test("total counts all five recorded categories once and rejects arithmetic overflow", () => {
  assert.equal(totalTokens({ input: 1, output: 2, reasoning: 4, cache: { read: 8, write: 16 } }), 31)
  assert.throws(() => totalTokens({ input: Number.MAX_VALUE, output: Number.MAX_VALUE, reasoning: 0, cache: { read: 0, write: 0 } }), /total overflowed/)
})

test("every token category can independently advance the odometer", async () => {
  for (const category of ["input", "output", "reasoning", "read", "write"]) {
    const h = await harness({ stops: [1000], read: 0 })
    const t = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    if (category === "read" || category === "write") t.cache[category] = 1000
    else t[category] = 1000
    h.sessions.get("ses_main").tokens = t
    try {
      await h.hooks.get("execute.after")(h.request())
      assert.equal(h.notices.length, 1, category)
      assert.match(h.notices[0].text, /main: total 1k;/)
      const status = await h.handlers.status({ sessionID: "ses_main" })
      assert.equal(status.mainTotal, 1000)
      assert.deepEqual(status.state.delivered, [1000])
    } finally { await h.cleanup() }
  }
})

test("combined usage crosses a stop even when no individual category does", async () => {
  const h = await harness({ stops: [1000], read: 0 })
  const t = { input: 200, output: 200, reasoning: 199, cache: { read: 200, write: 200 } }
  h.sessions.get("ses_main").tokens = t
  try {
    await h.hooks.get("execute.after")(h.request())
    assert.equal(h.notices.length, 0)
    t.reasoning++
    await h.hooks.get("execute.after")(h.request())
    assert.equal(h.notices.length, 1)
    assert.deepEqual(h.store.get("v1/session/ses_main").delivered, [1000])
  } finally { await h.cleanup() }
})

test("renders cache writes and reasoning once with honest descendant coverage", () => {
  const text = render(usage(4e6, 100, 50), { total: usage(0), count: 0, missing: 0 }, [100e3], true)
  assert.match(text, /uncached 150; output\+reasoning 30/)
  assert.match(text, /50 cache writes/)
  assert.match(text, /not necessarily zero/)
  assert.match(text, /where authorized/)
  assert.doesNotMatch(render(usage(16e6), { total: usage(0), count: 0, missing: 0 }, [], false), /consider subagents/)
})

test("absent or blank comments retain the silent default", async () => {
  for (const comment of [undefined, "", " \n\t "]) {
    const h = await harness({ comment })
    try {
      await h.hooks.get("execute.after")(h.request())
      assert.match(h.notices[0].text, /No acknowledgement or usage commentary needed/)
      assert.doesNotMatch(h.notices[0].text, /Note from user's opencode-odometer configuration/)
      assert.equal((await h.handlers.status({ sessionID: "ses_main" })).comment, null)
    } finally { await h.cleanup() }
  }
})

test("configured comments appear only in the first checkpoint without later silence instructions", async () => {
  const comment = "I'm interested to know when these thresholds are passed, so please actively remark on them.\nKeep the remark brief."
  const h = await harness({ comment })
  try {
    await h.hooks.get("execute.after")(h.request())
    h.sessions.get("ses_main").tokens = usage(17e6)
    await h.hooks.get("execute.after")(h.request())
    assert.equal(h.notices.length, 2)
    assert.ok(h.notices[0].text.endsWith(`Note from user's opencode-odometer configuration:\n${comment}`))
    assert.doesNotMatch(h.notices[1].text, /Note from user's|Keep the remark brief|Provider omissions|consider focused subagents/)
    assert.equal(h.notices[1].text.split("\n").length, 4)
    for (const note of h.notices) {
      assert.doesNotMatch(note.text, /No acknowledgement or usage commentary needed/)
      assert.equal(note.resume, false)
    }
    const status = await h.handlers.status({ sessionID: "ses_main" })
    assert.equal(status.comment, comment)
    assert.equal(status.state.last.text, h.notices[1].text)
  } finally { await h.cleanup() }
})

test("first-checkpoint comments are per session and stay consumed across reloads", async () => {
  const comment = "Please remark briefly on checkpoints."
  const h = await harness({ comment })
  await h.hooks.get("execute.after")(h.request())
  await h.cleanup()
  const reloaded = await harness({ comment, store: h.store, read: 17e6 })
  try {
    await reloaded.hooks.get("execute.after")(reloaded.request())
    assert.equal(reloaded.notices.length, 1)
    assert.doesNotMatch(reloaded.notices[0].text, /Please remark|Note from user's|No acknowledgement/)
    reloaded.sessions.set("ses_other", { id: "ses_other", tokens: usage(4e6) })
    await reloaded.hooks.get("execute.after")({ sessionID: "ses_other" })
    assert.equal(reloaded.notices.length, 2)
    assert.ok(reloaded.notices[1].text.endsWith(comment))
  } finally { await reloaded.cleanup() }
})

test("non-string comments produce a useful configuration error", async () => {
  for (const comment of [null, false, 123, [], {}]) await assert.rejects(harness({ comment }), /comment must be a string/)
})

test("tool completion admits a durable steering note without scheduling execution or editing context", async () => {
  const h = await harness()
  try {
    assert.deepEqual([...h.hooks.keys()], ["execute.after"])
    assert.equal(h.notices.length, 0)
    const request = h.request()
    const prefix = { role: "user", content: [{ type: "text", text: "the task" }] }
    request.messages.push(prefix)
    await h.hooks.get("execute.after")(request)
    assert.equal(request.messages[0], prefix)
    assert.equal(request.messages.length, 1)
    assert.equal(h.notices.length, 1)
    assert.equal(h.notices[0].resume, false)
    assert.equal(h.notices[0].delivery, "steer")
    assert.match(h.notices[0].text, /105k\/step \(5 recorded steps/)
    assert.equal(h.notices[0].id, h.store.get("v1/session/ses_main").last.messageID)
    assert.deepEqual(request.system, [])
    assert.deepEqual((await h.handlers.status({ sessionID: "ses_main" })).state.delivered, [4e6])
  } finally { await h.cleanup() }
})

test("reload and concurrent calls do not repeat; multiple stops coalesce", async () => {
  const h = await harness({ read: 70e6 })
  const requests = [h.request(), h.request(), h.request()]
  await Promise.all(requests.map(h.hooks.get("execute.after")))
  assert.equal(h.notices.length, 1)
  assert.deepEqual(h.store.get("v1/session/ses_main").delivered, [4e6, 16e6, 64e6])
  await h.cleanup()
  const reloaded = await harness({ store: h.store, read: 100e6 })
  try {
    const request = reloaded.request()
    await reloaded.hooks.get("execute.after")(request)
    assert.equal(reloaded.notices.length, 0)
    assert.equal(reloaded.calls(), 0)
  } finally { await reloaded.cleanup() }
})

test("child traffic does not advance main stops; forks are excluded", async () => {
  const h = await harness({ read: 3e6 })
  h.store.set("v1/child/ses_main/ses_child", true)
  h.store.set("v1/child/ses_child/ses_grandchild", true)
  h.store.set("v1/child/ses_main/ses_fork", true)
  h.sessions.set("ses_child", { id: "ses_child", parentID: "ses_main", tokens: usage(80e6) })
  h.sessions.set("ses_grandchild", { id: "ses_grandchild", parentID: "ses_child", tokens: usage(10e6) })
  h.sessions.set("ses_fork", { id: "ses_fork", parentID: "ses_main", fork: { sessionID: "ses_main" }, tokens: usage(100e6) })
  try {
    const request = h.request()
    await h.hooks.get("execute.after")(request)
    assert.equal(h.notices.length, 0)
    const status = await h.handlers.status({ sessionID: "ses_main" })
    assert.equal(status.descendants.count, 2)
    assert.equal(status.descendants.total.cache.read, 90e6)
  } finally { await h.cleanup() }
})

test("a stale direct link cannot hide a valid grandchild", async () => {
  const h = await harness()
  h.store.set("v1/child/ses_main/ses_a", true)
  h.store.set("v1/child/ses_main/ses_b", true)
  h.store.set("v1/child/ses_b/ses_a", true)
  h.sessions.set("ses_b", { id: "ses_b", parentID: "ses_main", tokens: usage(2e6) })
  h.sessions.set("ses_a", { id: "ses_a", parentID: "ses_b", tokens: usage(3e6) })
  try {
    const status = await h.handlers.status({ sessionID: "ses_main" })
    assert.equal(status.descendants.count, 2)
    assert.equal(status.descendants.total.cache.read, 5e6)
  } finally { await h.cleanup() }
})

test("empty stops do no tool-boundary accounting work", async () => {
  const h = await harness({ stops: [] })
  try { await h.hooks.get("execute.after")(h.request()); assert.equal(h.calls(), 0); assert.equal(h.notices.length, 0) } finally { await h.cleanup() }
})

test("fork context is not used as fresh recent history", async () => {
  const h = await harness({ fork: { sessionID: "ses_source" } })
  let contextReads = 0
  h.ctx.session.context = async () => { contextReads++; return [] }
  try {
    const request = h.request()
    await h.hooks.get("execute.after")(request)
    assert.match(h.notices[0].text, /Recent main cached input: unavailable/)
    assert.equal(contextReads, 0)
  } finally { await h.cleanup() }
})

test("storage failure, corrupted state, or missing telemetry fail open without notices", async () => {
  const original = console.warn
  console.warn = () => {}
  try {
    for (const options of [{ failWrite: true }, { invalid: true }, { store: new Map([["v1/session/ses_main", { version: 99 }]]) }]) {
      const h = await harness(options)
      try { const r = h.request(); await h.hooks.get("execute.after")(r); assert.equal(h.notices.length, 0) } finally { await h.cleanup() }
    }
  } finally { console.warn = original }
})

test("option edits track token values rather than list positions", async () => {
  const h = await harness({ stops: ["2M", "8M"] })
  await h.hooks.get("execute.after")(h.request())
  await h.cleanup()
  const next = await harness({ stops: ["2M", "4M", "8M"], store: h.store })
  try {
    const r = next.request(); await next.hooks.get("execute.after")(r)
    assert.equal(next.notices.length, 1)
    assert.doesNotMatch(next.notices[0].text, /consider subagents/)
    assert.deepEqual(next.store.get("v1/session/ses_main").last.stops, [4e6])
  } finally { await next.cleanup() }
})

test("large descendant trees bound both session reads and storage scans", async () => {
  const h = await harness()
  for (let i = 0; i < 250; i++) {
    const id = `ses_child${String(i).padStart(3, "0")}`
    h.store.set(`v1/child/ses_main/${id}`, true)
    h.sessions.set(id, { id, parentID: "ses_main", tokens: usage(1e6) })
  }
  try {
    const status = await h.handlers.status({ sessionID: "ses_main" })
    assert.equal(status.descendants.count, 100)
    assert.equal(status.descendants.total.cache.read, 100e6)
    assert.equal(status.descendants.truncated, true)
    assert.equal(status.descendants.missing, 0)
    assert.equal(h.calls(), 101)
    assert.equal(h.scans(), 1)
  } finally { await h.cleanup() }
})

test("paginated traversal handles cycles and missing ancestors without double counting", async () => {
  const h = await harness()
  const scan = h.ctx.storage.scan
  h.ctx.storage.scan = (input) => scan({ ...input, limit: 1 })
  for (const [parent, child] of [["main", "a"], ["main", "missing"], ["a", "main"], ["missing", "b"]]) h.store.set(`v1/child/ses_${parent}/ses_${child}`, true)
  h.sessions.set("ses_a", { id: "ses_a", parentID: "ses_main", tokens: usage(2e6) })
  h.sessions.set("ses_b", { id: "ses_b", parentID: "ses_missing", tokens: usage(3e6) })
  try {
    const status = await h.handlers.status({ sessionID: "ses_main" })
    assert.equal(status.descendants.count, 2)
    assert.equal(status.descendants.missing, 1)
    assert.equal(status.descendants.total.cache.read, 5e6)
    assert.equal(status.descendants.truncated, false)
  } finally { await h.cleanup() }
})

test("optional descendant failures preserve a valid main notice and disclose missing coverage", async () => {
  const h = await harness()
  const original = console.warn
  console.warn = () => {}
  h.sessions.get("ses_main").parentID = "ses_parent"
  const set = h.ctx.storage.set
  h.ctx.storage.set = (key, value) => key.startsWith("v1/child/") ? Promise.reject(new Error("link write failed")) : set(key, value)
  h.ctx.storage.scan = async () => { throw new Error("scan failed") }
  try {
    const request = h.request()
    await h.hooks.get("execute.after")(request)
    assert.equal(h.notices.length, 1)
    assert.match(h.notices[0].text, /child links unavailable/)
    assert.deepEqual(h.store.get("v1/session/ses_main").delivered, [4e6])
  } finally { console.warn = original; await h.cleanup() }
})

test("failed reservation leaves stops eligible and does not poison the session queue", async () => {
  const h = await harness()
  const original = console.warn
  console.warn = () => {}
  const set = h.ctx.storage.set
  h.ctx.storage.set = async () => { throw new Error("temporary failure") }
  try {
    const first = h.request()
    await h.hooks.get("execute.after")(first)
    assert.equal(h.notices.length, 0)
    assert.equal(h.store.size, 0)
    h.ctx.storage.set = set
    const next = h.request()
    await h.hooks.get("execute.after")(next)
    assert.equal(h.notices.length, 1)
  } finally { console.warn = original; await h.cleanup() }
})

test("unload during accounting does not reserve or admit a notice", async () => {
  const h = await harness()
  let release
  let entered
  const started = new Promise((resolve) => { entered = resolve })
  h.ctx.session.context = () => { entered(); return new Promise((resolve) => { release = resolve }) }
  const request = h.request()
  const pending = h.hooks.get("execute.after")(request)
  await started
  const cleanup = h.cleanup()
  release([])
  await Promise.all([pending, cleanup])
  assert.equal(h.notices.length, 0)
  assert.equal(h.store.has("v1/session/ses_main"), false)
})

test("malformed last notice is preserved and rejected by status", async () => {
  const corrupt = { version: 1, delivered: [4e6], last: { at: "yesterday", stops: [16e6], text: 42 } }
  const h = await harness({ store: new Map([["v1/session/ses_main", corrupt]]) })
  try {
    await assert.rejects(h.handlers.status({ sessionID: "ses_main" }), /invalid stored last notice/)
    assert.deepEqual(h.store.get("v1/session/ses_main"), corrupt)
    await assert.rejects(h.handlers.status({ sessionID: "session/invalid" }), /expected an OpenCode session ID/)
  } finally { await h.cleanup() }
})

test("a non-advancing storage cursor cannot loop forever", async () => {
  const h = await harness()
  let scans = 0
  h.ctx.storage.scan = async () => { scans++; return { entries: [], next: "stuck" } }
  try {
    const status = await h.handlers.status({ sessionID: "ses_main" })
    assert.equal(scans, 2)
    assert.equal(status.descendants.unavailable, true)
  } finally { await h.cleanup() }
})

test("empty advancing pages are also bounded", async () => {
  const h = await harness()
  let scans = 0
  h.ctx.storage.scan = async () => ({ entries: [], next: String(++scans) })
  try {
    const status = await h.handlers.status({ sessionID: "ses_main" })
    assert.equal(scans, 100)
    assert.equal(status.descendants.truncated, true)
  } finally { await h.cleanup() }
})

test("reservation precedes admission and admission failure never fails the real tool", async () => {
  const h = await harness()
  const original = console.warn
  console.warn = () => {}
  let admissions = 0
  h.ctx.session.synthetic = async (input) => {
    admissions++
    assert.deepEqual(h.store.get("v1/session/ses_main").delivered, [4e6])
    assert.equal(input.id, h.store.get("v1/session/ses_main").last.messageID)
    throw new Error("admission failed")
  }
  try {
    await h.hooks.get("execute.after")({ sessionID: "ses_main", status: "completed" })
    await h.hooks.get("execute.after")({ sessionID: "ses_main", status: "error" })
    assert.equal(admissions, 1)
  } finally { console.warn = original; await h.cleanup() }
})

test("new checkpoints use distinct IDs while old request-only stops stay consumed", async () => {
  const h = await harness({
    read: 17e6,
    store: new Map([["v1/session/ses_main", { version: 1, delivered: [4e6], last: { at: new Date().toISOString(), stops: [4e6], text: "legacy request-only note" } }]]),
  })
  try {
    await h.hooks.get("execute.after")({ sessionID: "ses_main", status: "completed" })
    h.sessions.get("ses_main").tokens = usage(70e6)
    await h.hooks.get("execute.after")({ sessionID: "ses_main", status: "error" })
    assert.equal(h.notices.length, 2)
    assert.notEqual(h.notices[0].id, h.notices[1].id)
    assert.deepEqual(h.notices.map((n) => n.metadata.stops), [[16e6], [64e6]])
    assert.ok(h.notices.every((n) => n.resume === false && n.delivery === "steer"))
    assert.ok(h.notices.every((n) => !n.text.includes("consider subagents")))
  } finally { await h.cleanup() }
})
