/**
 * DA Heartbeat — the AS1 proactivity primitive.
 *
 * Miessler's DA "will not sleep… scouring the world for ways to optimize your
 * life" [S1]; AS1 = "uses agents in the background to proactively pursue your
 * goals" [S2]. This is the "Action" layer of SPQA that PAI was missing.
 *
 * Two layers, cost-controlled:
 *   Layer 1 (FREE)  — gather deterministic context: active work, pending DA
 *                     tasks, recent ratings. No LLM.
 *   Layer 2 (~$0.001) — Haiku, via Inference.ts (OAuth subscription, NEVER
 *                     `claude --bare` — the April 2026 billing incident). Decides
 *                     NO_ACTION | notify. Default is NO_ACTION; only act when
 *                     genuinely useful.
 *
 * The heartbeat is invoked on a cron schedule by the module. It returns a
 * structured decision; dispatch (voice/notify) is the caller's job.
 */

import { join } from "path"
import { readFileSync, existsSync } from "fs"
import { homedir } from "os"
import { readTasks, type ScheduledTask } from "./store"

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? homedir()
const PAI_DIR = join(HOME, ".claude", "PAI")
const INFERENCE_TS = join(PAI_DIR, "TOOLS", "Inference.ts")
const WORK_JSON = join(PAI_DIR, "MEMORY", "STATE", "work.json")

export type HeartbeatAction = "NO_ACTION" | "notify" | "remind" | "create_task"

export interface HeartbeatContext {
  active_work: string[]
  pending_tasks: number
  next_task: { description: string; at?: string } | null
  gathered_at: string
}

export interface HeartbeatDecision {
  action: HeartbeatAction
  message: string | null
  reason: string
  cost_estimate: number
  ran_layer2: boolean
}

/** Layer 1 — deterministic context gather. No LLM, free, fast. */
export function gatherContext(now: Date = new Date()): HeartbeatContext {
  const active_work: string[] = []
  try {
    if (existsSync(WORK_JSON)) {
      const work = JSON.parse(readFileSync(WORK_JSON, "utf-8")) as Record<string, unknown>
      const sessions = (work.sessions ?? work.active ?? []) as Array<Record<string, unknown>>
      if (Array.isArray(sessions)) {
        for (const s of sessions.slice(0, 5)) {
          const t = (s.task ?? s.slug ?? s.name) as string | undefined
          if (t) active_work.push(t)
        }
      }
    }
  } catch { /* work.json optional */ }

  const tasks = readTasks().filter((t: ScheduledTask) => t.status === "active")
  const nextOnce = tasks
    .filter((t) => t.schedule.type === "once" && t.schedule.at)
    .sort((a, b) => (a.schedule.at! < b.schedule.at! ? -1 : 1))[0]

  return {
    active_work,
    pending_tasks: tasks.length,
    next_task: nextOnce ? { description: nextOnce.description, at: nextOnce.schedule.at } : null,
    gathered_at: now.toISOString(),
  }
}

/**
 * Layer 2 — Haiku eval via Inference.ts. Returns a decision.
 *
 * `spawn` is injectable so tests can exercise the routing logic without a live
 * LLM call (LLM judgment is not deterministic; routing + parsing is).
 */
export async function evaluate(
  ctx: HeartbeatContext,
  opts: {
    costCeiling: number
    model?: string
    spawn?: (systemPrompt: string, userPrompt: string) => Promise<string>
  },
): Promise<HeartbeatDecision> {
  // Nothing to reason about → skip Layer 2 entirely. Keeps cost at $0 when idle
  // and guarantees the "empty context → NO_ACTION" contract without an LLM call.
  if (ctx.active_work.length === 0 && ctx.pending_tasks === 0) {
    return { action: "NO_ACTION", message: null, reason: "empty context — nothing to surface", cost_estimate: 0, ran_layer2: false }
  }

  const systemPrompt =
    "You are a DA heartbeat. Given the principal's current context, decide whether to proactively surface something. " +
    "Default to NO_ACTION. Only act when genuinely useful (an imminent task, a stalled goal). " +
    'Respond with ONLY compact JSON: {"action":"NO_ACTION"|"notify","message":string|null,"reason":string}.'
  const userPrompt = JSON.stringify(ctx)

  const spawn = opts.spawn ?? defaultSpawn(opts.model ?? "fast")

  let raw: string
  try {
    raw = await spawn(systemPrompt, userPrompt)
  } catch (err) {
    return { action: "NO_ACTION", message: null, reason: `layer2 failed: ${String(err)}`, cost_estimate: 0, ran_layer2: true }
  }

  const parsed = parseDecision(raw)
  // Haiku heartbeat eval is ~$0.001; report it against the ceiling for honesty.
  const cost_estimate = 0.001
  if (cost_estimate > opts.costCeiling) {
    return { action: "NO_ACTION", message: null, reason: "cost ceiling exceeded", cost_estimate, ran_layer2: true }
  }
  return { ...parsed, cost_estimate, ran_layer2: true }
}

/** Parse Layer 2 JSON output, tolerant of surrounding prose. NO_ACTION on any doubt. */
export function parseDecision(raw: string): Omit<HeartbeatDecision, "cost_estimate" | "ran_layer2"> {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return { action: "NO_ACTION", message: null, reason: "unparseable layer2 output" }
  try {
    const obj = JSON.parse(match[0]) as { action?: string; message?: string | null; reason?: string }
    const action: HeartbeatAction = obj.action === "notify" ? "notify" : obj.action === "remind" ? "remind" : obj.action === "create_task" ? "create_task" : "NO_ACTION"
    return { action, message: action === "NO_ACTION" ? null : (obj.message ?? null), reason: obj.reason ?? "" }
  } catch {
    return { action: "NO_ACTION", message: null, reason: "invalid layer2 JSON" }
  }
}

/** Default Layer 2 spawn: Inference.ts at the given level (fast=Haiku). OAuth, never --bare. */
function defaultSpawn(model: string): (s: string, u: string) => Promise<string> {
  return async (systemPrompt: string, userPrompt: string) => {
    const proc = Bun.spawn(
      ["bun", INFERENCE_TS, "--level", model, systemPrompt, userPrompt],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
    )
    const timer = setTimeout(() => proc.kill(), 20_000)
    const out = await new Response(proc.stdout).text()
    const code = await proc.exited
    clearTimeout(timer)
    if (code !== 0) {
      const err = await new Response(proc.stderr).text()
      throw new Error(`Inference.ts exited ${code}: ${err.slice(0, 200)}`)
    }
    return out.trim()
  }
}

/** Full heartbeat run: gather → evaluate. Returns the decision for the caller to dispatch. */
export async function runHeartbeat(opts: { costCeiling: number; model?: string; now?: Date }): Promise<{ ctx: HeartbeatContext; decision: HeartbeatDecision }> {
  const ctx = gatherContext(opts.now)
  const decision = await evaluate(ctx, { costCeiling: opts.costCeiling, model: opts.model })
  return { ctx, decision }
}
