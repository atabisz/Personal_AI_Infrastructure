/**
 * Assistant module — contract + safety tests.
 *
 * Covers: the 4 exported daemon functions, response-shape contracts against the
 * frontend interfaces, the heartbeat NO_ACTION default + routing, and the
 * autonomy must_ask gate (the correctness-critical safety surface).
 */

import { test, expect, describe } from "bun:test"
import {
  startAssistant,
  handleAssistantRequest,
  assistantHealth,
  stopAssistant,
  classifyAction,
  requiresConfirmation,
} from "./module"
import { gatherContext, evaluate, parseDecision } from "./heartbeat"

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost:31337${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

// Boot the module the way pulse.ts does.
startAssistant({ enabled: true, heartbeat_cost_ceiling: 0.1, heartbeat_model: "fast" }, [
  { name: "test-cron", schedule: "0 9 * * *", enabled: true },
])

describe("exported contract (matches pulse.ts call-sites)", () => {
  test("all four functions are exported and callable", () => {
    expect(typeof startAssistant).toBe("function")
    expect(typeof handleAssistantRequest).toBe("function")
    expect(typeof assistantHealth).toBe("function")
    expect(typeof stopAssistant).toBe("function")
  })

  test("handleAssistantRequest returns null for unhandled paths (falls through)", async () => {
    const resp = await handleAssistantRequest(req("GET", "/assistant/nope"), "/assistant/nope")
    expect(resp).toBeNull()
  })
})

describe("/health", () => {
  test("returns all 7 keys", () => {
    const h = assistantHealth()
    for (const k of ["status", "primary_da", "identity_loaded", "scheduled_tasks", "last_heartbeat", "diary_entries_today", "opinions_count"]) {
      expect(h).toHaveProperty(k)
    }
  })

  test("identity_loaded true → status ok when garry identity present", () => {
    const h = assistantHealth()
    // In the live tree garry exists; if a CI env lacks it, status is 'degraded'.
    if (h.identity_loaded) expect(h.status).toBe("ok")
    else expect(h.status).toBe("degraded")
  })
})

describe("/identity + /personality shapes", () => {
  test("/identity has all 9 keys", async () => {
    const resp = await handleAssistantRequest(req("GET", "/assistant/identity"), "/assistant/identity")
    if (resp && resp.status === 200) {
      const j = await resp.json()
      for (const k of ["name", "full_name", "display_name", "color", "role", "origin_story", "has_avatar", "principal", "uptime_ms"]) {
        expect(j).toHaveProperty(k)
      }
    }
  })

  test("/personality synthesizes preferences/anchors/companion (crash-prevention)", async () => {
    const resp = await handleAssistantRequest(req("GET", "/assistant/personality"), "/assistant/personality")
    if (resp && resp.status === 200) {
      const j = await resp.json()
      // The frontend hard-dereferences these — they MUST always be present.
      expect(j.preferences).toBeDefined()
      expect(Array.isArray(j.preferences.what_i_love)).toBe(true)
      expect(Array.isArray(j.preferences.what_i_dislike)).toBe(true)
      expect(Array.isArray(j.anchors)).toBe(true)
      expect(j).toHaveProperty("companion") // null is valid
      expect(Array.isArray(j.autonomy.can_initiate)).toBe(true)
      expect(Array.isArray(j.autonomy.must_ask)).toBe(true)
    }
  })

  test("/personality never fabricates a voice_id", async () => {
    const resp = await handleAssistantRequest(req("GET", "/assistant/personality"), "/assistant/personality")
    if (resp && resp.status === 200) {
      const j = await resp.json()
      // voice is either null or {provider} — never an object carrying a made-up id.
      if (j.voice !== null) {
        expect(Object.keys(j.voice)).toEqual(["provider"])
      }
    }
  })
})

describe("/diary + /opinions envelopes (crash-prevention)", () => {
  test("/diary returns { entries: [] } envelope, not a bare array", async () => {
    const resp = await handleAssistantRequest(req("GET", "/assistant/diary"), "/assistant/diary")
    const j = await resp!.json()
    expect(Array.isArray(j)).toBe(false)
    expect(Array.isArray(j.entries)).toBe(true)
  })

  test("/opinions returns { raw: string } envelope", async () => {
    const resp = await handleAssistantRequest(req("GET", "/assistant/opinions"), "/assistant/opinions")
    const j = await resp!.json()
    expect(typeof j.raw).toBe("string")
  })
})

describe("/tasks", () => {
  test("GET returns { tasks, count, by_source }", async () => {
    const resp = await handleAssistantRequest(req("GET", "/assistant/tasks"), "/assistant/tasks")
    const j = await resp!.json()
    expect(Array.isArray(j.tasks)).toBe(true)
    expect(typeof j.count).toBe("number")
    expect(j.by_source).toHaveProperty("da")
    expect(j.by_source).toHaveProperty("pulse")
    expect(j.by_source).toHaveProperty("claude-code")
  })

  test("POST with no schedule → stored as type:'once', then DELETE cancels it", async () => {
    const createResp = await handleAssistantRequest(
      req("POST", "/assistant/tasks", { description: "unit-test one-time task", action: { type: "notify", channel: "voice" } }),
      "/assistant/tasks",
    )
    const created = await createResp!.json()
    expect(created.ok).toBe(true)
    expect(typeof created.id).toBe("string")

    // The task is now in the GET list with source 'da'.
    const listResp = await handleAssistantRequest(req("GET", "/assistant/tasks"), "/assistant/tasks")
    const list = await listResp!.json()
    const found = list.tasks.find((t: { details?: { id?: string } }) => t.details?.id === created.id)
    expect(found).toBeDefined()
    expect(found.source).toBe("da")
    expect(String(found.schedule)).toContain("once")

    // DELETE cancels it.
    const delResp = await handleAssistantRequest(req("DELETE", `/assistant/tasks/${created.id}`), `/assistant/tasks/${created.id}`)
    const del = await delResp!.json()
    expect(del.ok).toBe(true)
    expect(del.cancelled).toBe(created.id)
  })
})

describe("PATCH traits (bounded drift)", () => {
  test("change within 5-pt bound is accepted or (if identity absent) 503", async () => {
    const h = assistantHealth()
    if (!h.identity_loaded) return
    // A within-bound PATCH mutates the REAL identity yaml, so snapshot + restore
    // to keep the test non-destructive to committed user data.
    const { readFileSync, writeFileSync } = await import("fs")
    const { join } = await import("path")
    const { homedir } = await import("os")
    const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir()
    // primary_da comes from health so we hit the same file the module writes.
    const idPath = join(home, ".claude", "PAI", "USER", "DA", String(h.primary_da), "DA_IDENTITY.yaml")
    const snapshot = readFileSync(idPath, "utf-8")
    try {
      const current = Number((snapshot.match(/precision:\s*(\d+)/) ?? [])[1] ?? 50)
      const target = current + 1 // within the 5-pt bound
      const resp = await handleAssistantRequest(req("PATCH", "/assistant/personality/traits", { precision: target }), "/assistant/personality/traits")
      expect([200, 503]).toContain(resp!.status)
    } finally {
      writeFileSync(idPath, snapshot, "utf-8") // restore byte-for-byte
    }
  })

  test("change exceeding 5-pt bound is rejected (422)", async () => {
    const h = assistantHealth()
    if (!h.identity_loaded) return
    // garry precision 95 → 50 is a 45-pt jump, must be rejected.
    const resp = await handleAssistantRequest(req("PATCH", "/assistant/personality/traits", { precision: 50 }), "/assistant/personality/traits")
    expect(resp!.status).toBe(422)
  })
})

describe("autonomy gate (SAFETY SURFACE)", () => {
  const autonomy = {
    can_initiate: ["send_notification", "create_reminder", "log_learning", "update_diary", "routine_checks"],
    must_ask: ["send messages to others", "modify code", "spend money", "delete data", "publish content"],
  }

  test("a notify to the principal's own voice channel is can_initiate (does not require confirmation)", () => {
    expect(requiresConfirmation({ type: "notify", channel: "voice" }, autonomy)).toBe(false)
  })

  test("a script action is must_ask (modify code) → requires confirmation, does NOT auto-fire", () => {
    expect(classifyAction({ type: "script" })).toBe("modify code")
    expect(requiresConfirmation({ type: "script" }, autonomy)).toBe(true)
  })

  test("a prompt action (spends budget) requires confirmation", () => {
    expect(requiresConfirmation({ type: "prompt" }, autonomy)).toBe(true)
  })

  test("a notify to an external channel (messages others) requires confirmation", () => {
    expect(requiresConfirmation({ type: "notify", channel: "telegram" }, autonomy)).toBe(true)
  })

  test("fail-safe: unknown action category requires confirmation", () => {
    expect(requiresConfirmation({ type: "detonate" }, autonomy)).toBe(true)
  })

  test("ntfy is NOT a principal-only channel — notify+ntfy requires confirmation (Cato)", () => {
    // ntfy topics are publicly subscribable → reaches others → must_ask.
    expect(classifyAction({ type: "notify", channel: "ntfy" })).toBe("send messages to others")
    expect(requiresConfirmation({ type: "notify", channel: "ntfy" }, autonomy)).toBe(true)
  })

  test("a must_ask task (type:script) is stored INERT — status pending_approval, NOT active (advisor guardrail)", async () => {
    // A script action → "modify code" → must_ask. It must NOT land as runnable.
    const resp = await handleAssistantRequest(
      req("POST", "/assistant/tasks", { description: "dangerous script task", action: { type: "script", command: "echo hi" } }),
      "/assistant/tasks",
    )
    const created = await resp!.json()
    expect(created.requires_confirmation).toBe(true)
    expect(created.status).toBe("pending_approval") // fail-closed: not "active"
    // cleanup
    await handleAssistantRequest(req("DELETE", `/assistant/tasks/${created.id}`), `/assistant/tasks/${created.id}`)
  })
})

describe("DELETE task id validation (Forge audit)", () => {
  test("empty id is rejected (400), does not cancel tasks[0]", async () => {
    // Seed a task, then attempt an empty-id delete — it must NOT be cancelled.
    const createResp = await handleAssistantRequest(
      req("POST", "/assistant/tasks", { description: "guard-task", action: { type: "notify", channel: "voice" } }),
      "/assistant/tasks",
    )
    const created = await createResp!.json()
    const delResp = await handleAssistantRequest(req("DELETE", "/assistant/tasks/"), "/assistant/tasks/")
    expect(delResp!.status).toBe(400)
    // The seeded task is still active.
    const listResp = await handleAssistantRequest(req("GET", "/assistant/tasks"), "/assistant/tasks")
    const list = await listResp!.json()
    const found = list.tasks.find((t: { details?: { id?: string } }) => t.details?.id === created.id)
    expect(found.status).toBe("active")
    // cleanup
    await handleAssistantRequest(req("DELETE", `/assistant/tasks/${created.id}`), `/assistant/tasks/${created.id}`)
  })
})

describe("heartbeat (AS1 proactivity)", () => {
  test("empty context → NO_ACTION without an LLM call", async () => {
    const ctx = { active_work: [], pending_tasks: 0, next_task: null, gathered_at: "2026-07-03T00:00:00Z" }
    const decision = await evaluate(ctx, { costCeiling: 0.1 })
    expect(decision.action).toBe("NO_ACTION")
    expect(decision.ran_layer2).toBe(false)
    expect(decision.cost_estimate).toBe(0)
  })

  test("non-empty context routes to Layer 2 (injected spawn) and can yield notify", async () => {
    const ctx = { active_work: ["ship the DA module"], pending_tasks: 1, next_task: { description: "meeting in 10 min", at: "2026-07-03T00:10:00Z" }, gathered_at: "2026-07-03T00:00:00Z" }
    const fakeSpawn = async () => '{"action":"notify","message":"Meeting in 10 minutes","reason":"imminent task"}'
    const decision = await evaluate(ctx, { costCeiling: 0.1, spawn: fakeSpawn })
    expect(decision.action).toBe("notify")
    expect(decision.message).toContain("Meeting")
    expect(decision.ran_layer2).toBe(true)
  })

  test("cost ceiling exceeded → NO_ACTION", async () => {
    const ctx = { active_work: ["x"], pending_tasks: 1, next_task: null, gathered_at: "2026-07-03T00:00:00Z" }
    const fakeSpawn = async () => '{"action":"notify","message":"hi","reason":"test"}'
    const decision = await evaluate(ctx, { costCeiling: 0.0001, spawn: fakeSpawn })
    expect(decision.action).toBe("NO_ACTION")
    expect(decision.reason).toContain("cost ceiling")
  })

  test("parseDecision defaults to NO_ACTION on garbage", () => {
    expect(parseDecision("not json").action).toBe("NO_ACTION")
    expect(parseDecision('{"action":"notify","message":"hi","reason":"r"}').action).toBe("notify")
  })

  test("gatherContext is deterministic and returns the expected shape", () => {
    const ctx = gatherContext(new Date("2026-07-03T12:00:00Z"))
    expect(Array.isArray(ctx.active_work)).toBe(true)
    expect(typeof ctx.pending_tasks).toBe("number")
    expect(ctx.gathered_at).toBe("2026-07-03T12:00:00.000Z")
  })
})

stopAssistant()
