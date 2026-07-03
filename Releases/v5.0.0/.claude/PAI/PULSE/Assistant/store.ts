/**
 * DA Scheduled-Task Store — shared read/write for the JSONL task file.
 *
 * Single source of truth for the DA task store. Extracted so BOTH
 * `PAI/TOOLS/DASchedule.ts` (the CLI) and `Assistant/module.ts` (the daemon
 * endpoints) read/write the SAME file via the SAME path expression. Before this
 * extraction the CLI used `join(PAI_DIR, "Pulse", ...)` and the daemon dir is
 * `join(PAI_DIR, "PULSE", ...)`; identical on Windows (case-insensitive FS) but
 * TWO different directories on Linux — the exact divergent-copy bug the
 * auto-extract-shared-helper rule exists to prevent. One path, one store.
 */

import { join } from "path"
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "fs"
import { homedir } from "os"

// Portable HOME: HOME (Git Bash) → USERPROFILE (native Windows autostart, where
// HOME is unset) → os.homedir(). Never a bare "~". Mirrors pulse.ts / lib.ts.
const HOME = process.env.HOME ?? process.env.USERPROFILE ?? homedir()
const PAI_DIR = join(HOME, ".claude", "PAI")

// Canonical DA runtime dir. Uses "Pulse" to match the on-disk data DASchedule
// already writes; on Windows this === pulse.ts's "PULSE/state". One expression
// shared by both consumers = no cross-platform divergence.
export const TASKS_DIR = join(PAI_DIR, "Pulse", "state", "da")
export const TASKS_PATH = join(TASKS_DIR, "scheduled-tasks.jsonl")

export interface ScheduledTask {
  id: string
  created_at: string
  created_by: string
  description: string
  schedule: {
    type: "once" | "recurring"
    at?: string
    cron?: string
    until?: string
  }
  action: {
    type: "notify" | "prompt" | "script"
    message?: string
    channel?: string
    prompt?: string
    model?: string
    command?: string
  }
  // "pending_approval" = a must_ask action queued but NOT runnable; a fire-executor
  // iterating "active" tasks skips it (fail-closed autonomy gate). See module.ts.
  status: "active" | "completed" | "cancelled" | "pending_approval"
  last_fired?: string
  fire_count: number
}

export function ensureDir(): void {
  if (!existsSync(TASKS_DIR)) {
    mkdirSync(TASKS_DIR, { recursive: true })
  }
}

export function readTasks(): ScheduledTask[] {
  try {
    if (!existsSync(TASKS_PATH)) return []
    const content = readFileSync(TASKS_PATH, "utf-8")
    return content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as ScheduledTask)
  } catch {
    return []
  }
}

export function writeTasks(tasks: ScheduledTask[]): void {
  ensureDir()
  const content = tasks.map((t) => JSON.stringify(t)).join("\n") + "\n"
  writeFileSync(TASKS_PATH, content)
}

export function appendTask(task: ScheduledTask): void {
  ensureDir()
  appendFileSync(TASKS_PATH, JSON.stringify(task) + "\n")
}
