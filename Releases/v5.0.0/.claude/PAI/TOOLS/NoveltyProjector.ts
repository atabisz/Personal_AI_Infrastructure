#!/usr/bin/env bun
/**
 * NoveltyProjector.ts — Ideate → Pulse Novelty dashboard bridge.
 *
 * The Pulse "Ideate" tab (PULSE/Observability/src/app/novelty/page.tsx) reads
 * MEMORY/STATE/novelty-state.json via /api/novelty. Nothing wrote that file, so
 * the tab was permanently empty. This tool projects an Ideate skill run's on-disk
 * artifacts (MEMORY/WORK/{slug}/ideate/) into the `NoveltyRun` shape the dashboard
 * renders, and writes/merges it into novelty-state.json keyed by run id.
 *
 * The render contract is the `NoveltyRun` interface in
 * PULSE/Observability/src/hooks/useNoveltyDashboard.ts — this file mirrors it.
 *
 * Usage:
 *   bun NoveltyProjector.ts <ideate-run-dir>     # project one run's ideate/ dir
 *   bun NoveltyProjector.ts --slug <work-slug>   # project MEMORY/WORK/<slug>/ideate
 *   bun NoveltyProjector.ts --all                # project every MEMORY/WORK/<slug>/ideate
 *
 * Resilient by contract: a missing/partial run never crashes and never writes
 * malformed JSON — it is skipped with a logged reason, and a valid (possibly
 * empty) { runs: [] } state file is always left on disk.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  renameSync,
  copyFileSync,
} from "node:fs";
import { join, basename, dirname } from "node:path";

// ─── Paths (never hardcoded — resolved from env) ─────────────────────────────

const PAI_DIR =
  process.env.PAI_DIR ||
  join(process.env.HOME || process.env.USERPROFILE || ".", ".claude", "PAI");
const MEMORY_DIR = join(PAI_DIR, "MEMORY");
const WORK_DIR = join(MEMORY_DIR, "WORK");
const STATE_DIR = join(MEMORY_DIR, "STATE");
const NOVELTY_STATE_PATH = join(STATE_DIR, "novelty-state.json");

// ─── NoveltyRun contract (mirror of useNoveltyDashboard.ts) ──────────────────

interface NoveltyPhase { name: string; status: "complete" | "running" | "pending"; }
interface NoveltyCheckpoint {
  status: "PASS" | "FAIL";
  percentage?: number;
  currentAvg?: number;
  previousAvg?: number;
  cycle: number;
}
interface FitnessPoint {
  cycle: number;
  avgScore: number;
  topScore: number;
  diversityIndex: number;
  ideasIn: number;
  ideasOut: number;
  survivalRate: number;
}
interface NoveltyCandidate {
  rank: number;
  title: string;
  description: string;
  compositeScore: number;
  scores: { feasibility: number; novelty: number; impact: number; elegance: number };
  confidence: number;
  lineage: string[];
  forIt: string;
  againstIt: string;
}
interface DomainFertility { pairing: string; avgScore: number; count: number; multiplier: number; }
interface PhaseMetric { phase: string; durationSeconds: number; outputCount: number; agentCount: number; }
interface NoveltyRun {
  id: string;
  problem: string;
  status: "running" | "complete";
  startedAt: string;
  updatedAt: string;
  timeScale: string;
  currentPhase: string | null;
  currentCycle: number;
  maxCycles: number;
  budgetSecondsTotal: number;
  budgetSecondsRemaining: number;
  strategyPivotsUsed: number;
  strategyPivotsMax: number;
  phases: NoveltyPhase[];
  checkpoints: { a: NoveltyCheckpoint; b: NoveltyCheckpoint };
  fitnessTrajectory: FitnessPoint[];
  phaseMetrics: PhaseMetric[];
  domainFertility: DomainFertility[];
  candidates: NoveltyCandidate[];
}
interface NoveltyState { runs: NoveltyRun[]; }

const PHASE_NAMES = [
  "CONSUME", "DREAM", "DAYDREAM", "CONTEMPLATE", "STEAL",
  "MATE", "TEST", "EVOLVE", "META-LEARN",
] as const;

// Time-scale → total budget seconds (SKILL.md § Time-Scale Configuration).
// Ideate emits budget_seconds_remaining but NOT budget_seconds_total, so we
// derive the total from the run's time_scale rather than defaulting it to 0.
const TIME_SCALE_BUDGET_SECONDS: Record<string, number> = {
  hours: 300,
  days: 720,
  weeks: 1500,
  months: 2700,
  years: 5400,
  decades: 10800,
};

// ─── Safe JSON read ──────────────────────────────────────────────────────────

function readJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch (e) {
    console.warn(`[NoveltyProjector] unreadable JSON at ${path}: ${(e as Error).message}`);
    return null;
  }
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function readText(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : null;
  } catch {
    return null;
  }
}

/** Stable ISO mtime of a path, or null — used so timestamps don't drift to "now" on every re-projection. */
function mtimeIso(path: string): string | null {
  try {
    return existsSync(path) ? statSync(path).mtime.toISOString() : null;
  } catch {
    return null;
  }
}

/**
 * Parse candidates from the Ideate skill's documented `final-output.md` template
 * (SKILL.md § "Final Output Format"). This is the REAL documented candidate source —
 * Ideate does not emit a candidates.json. The template per candidate:
 *
 *   ### 1. [Title] — Score: 85.2/100 (confidence: 0.91)
 *   **The idea:** [text]
 *   **Scores:** Feasibility: 78 | Novelty: 92 | Impact: 84 | Elegance: 87
 *   **For it:** [supporting]
 *   **Against it:** [counter]
 */
export function parseFinalOutputCandidates(md: string): NoveltyCandidate[] {
  const out: NoveltyCandidate[] = [];
  // Split on candidate headings: "### N. Title — Score: X/100 (confidence: Y)"
  const blocks = md.split(/^###\s+/m).slice(1);
  for (const block of blocks) {
    const head = block.split("\n", 1)[0] ?? "";
    const headMatch = head.match(/^(\d+)\.\s*(.+?)\s*(?:—|-|–)\s*Score:\s*([\d.]+)/i);
    if (!headMatch) continue; // not a candidate heading (e.g. "Evolution Summary")
    const rank = num(parseInt(headMatch[1], 10), out.length + 1);
    const title = headMatch[2].trim();
    const compositeScore = num(parseFloat(headMatch[3]));
    const confMatch = head.match(/confidence:\s*([\d.]+)/i);
    const confidence = confMatch ? num(parseFloat(confMatch[1])) : 0;

    const ideaMatch = block.match(/\*\*The idea:\*\*\s*(.+?)(?:\n\s*\n|\n\*\*)/s);
    const description = ideaMatch ? ideaMatch[1].trim() : "";

    const scoreLine = block.match(/\*\*Scores:\*\*\s*(.+)/i)?.[1] ?? "";
    const pick = (label: string) =>
      num(parseFloat(scoreLine.match(new RegExp(`${label}:\\s*([\\d.]+)`, "i"))?.[1] ?? "0"));
    const scores = {
      feasibility: pick("Feasibility"),
      novelty: pick("Novelty"),
      impact: pick("Impact"),
      elegance: pick("Elegance"),
    };

    const forIt = block.match(/\*\*For it:\*\*\s*(.+?)(?:\n\s*\n|\n\*\*|$)/s)?.[1]?.trim() ?? "";
    const againstIt = block.match(/\*\*Against it:\*\*\s*(.+?)(?:\n\s*\n|\n\*\*|$)/s)?.[1]?.trim() ?? "";
    const lineage = (block.match(/from\s+\w+\s+of\s+\[([^\]]+)\]/i)?.[1] ?? "")
      .split(/,\s*/)
      .map((s) => s.trim())
      .filter(Boolean);

    out.push({ rank, title, description, compositeScore, scores, confidence, lineage, forIt, againstIt });
  }
  return out;
}

// ─── Projection: one ideate/ dir → NoveltyRun | null ─────────────────────────

/**
 * @param ideateDir absolute path to a `.../ideate` directory
 * Returns null (with a logged reason) when the run is too incomplete to project.
 */
export function projectIdeateRun(ideateDir: string): NoveltyRun | null {
  if (!isDir(ideateDir)) {
    console.warn(`[NoveltyProjector] not a directory, skipping: ${ideateDir}`);
    return null;
  }

  const config = readJson<Record<string, any>>(join(ideateDir, "config.json")) ?? {};
  const loop = readJson<Record<string, any>>(join(ideateDir, "loop-state.json")) ?? {};

  // A run with neither config nor loop state is not projectable.
  if (!Object.keys(config).length && !Object.keys(loop).length) {
    console.warn(`[NoveltyProjector] no config.json or loop-state.json in ${ideateDir}, skipping`);
    return null;
  }

  // Run id = the work slug (parent of ideate/), stable across re-projections.
  const runId = basename(dirname(ideateDir)) || basename(ideateDir);

  const problem = str(config.problem, str(loop.problem, "(unknown problem)"));
  const timeScale = str(config.time_scale, "hours");
  const maxStrategyPivots = num(config?.loop_control?.max_strategy_pivots, num(loop.strategy_pivots_max, 2));

  // Loud schema-drift signal: if loop-state is present but lacks the documented
  // fitness_history key, warn rather than silently rendering an empty trajectory.
  // (Advisor gap: the fixture verified assumed keys, not real emitted keys.)
  if (Object.keys(loop).length && !("fitness_history" in loop)) {
    console.warn(
      `[NoveltyProjector] loop-state.json in ${ideateDir} has no 'fitness_history' key — ` +
        `Ideate output schema may have drifted; fitnessTrajectory will be empty.`,
    );
  }

  const fitnessHistory: any[] = Array.isArray(loop.fitness_history) ? loop.fitness_history : [];
  const fitnessTrajectory: FitnessPoint[] = fitnessHistory.map((f) => ({
    cycle: num(f?.cycle),
    avgScore: num(f?.avg_score ?? f?.avgScore),
    topScore: num(f?.top_score ?? f?.topScore),
    diversityIndex: num(f?.diversity_index ?? f?.diversityIndex),
    ideasIn: num(f?.ideas_in ?? f?.ideasIn),
    ideasOut: num(f?.ideas_out ?? f?.ideasOut),
    survivalRate: num(f?.survival_rate ?? f?.survivalRate),
  }));

  const cycleCount = num(loop.cycle_count, fitnessTrajectory.length);
  // C3 fix: wrap the fallback in num() too — loop.max_cycles is documented as null,
  // and a non-number config.loop_control.max_cycles must not leak into a number field.
  const maxCycles = num(loop.max_cycles, num(config?.loop_control?.max_cycles, 0));
  // C2 fix: no artifact emits budget_seconds_total — derive from time_scale so the
  // dashboard's remaining/total math is coherent instead of dividing by zero.
  const knownRemaining = num(loop.budget_seconds_remaining, NaN);
  const budgetTotal = num(
    config.budget_seconds_total,
    num(loop.budget_seconds_total, TIME_SCALE_BUDGET_SECONDS[timeScale] ?? 0),
  );
  const budgetRemaining = Number.isFinite(knownRemaining) ? knownRemaining : budgetTotal;

  // Candidates: the DOCUMENTED source is final-output.md (SKILL.md § Final Output
  // Format) — Ideate does not emit a candidates.json. Parse the markdown template.
  // A structured candidates.json / loop.candidates is honored IF a run ever emits
  // one (forward-compatible), but final-output.md is the real path.
  const finalMd = readText(join(ideateDir, "final-output.md"));
  const hasFinal = finalMd !== null;
  let candidates: NoveltyCandidate[] = finalMd ? parseFinalOutputCandidates(finalMd) : [];

  // Forward-compat / drift fallback: structured candidates if present.
  if (!candidates.length) {
    const candidatesRaw =
      readJson<any[]>(join(ideateDir, "candidates.json")) ??
      (Array.isArray(loop.candidates) ? loop.candidates : []);
    if (Array.isArray(candidatesRaw) && candidatesRaw.length) {
      candidates = candidatesRaw.map((c, i) => {
        const s = c?.scores ?? {};
        return {
          rank: num(c?.rank, i + 1),
          title: str(c?.title, str(c?.text, `Candidate ${i + 1}`)).slice(0, 200),
          description: str(c?.description, str(c?.text, "")),
          compositeScore: num(s?.composite ?? s?.adjusted_composite ?? c?.compositeScore),
          scores: {
            feasibility: num(s?.feasibility),
            novelty: num(s?.novelty),
            impact: num(s?.impact),
            elegance: num(s?.elegance),
          },
          confidence: num(s?.confidence ?? c?.confidence),
          lineage: Array.isArray(c?.provenance?.parents)
            ? c.provenance.parents.map(String)
            : Array.isArray(c?.lineage)
            ? c.lineage.map(String)
            : [],
          forIt: str(c?.arguments?.supporting ?? c?.forIt),
          againstIt: str(c?.arguments?.counter ?? c?.againstIt),
        };
      });
    } else if (hasFinal) {
      console.warn(
        `[NoveltyProjector] final-output.md in ${ideateDir} yielded no parseable candidates — ` +
          `the '### N. Title — Score:' template may have drifted; candidates will be empty.`,
      );
    }
  }

  // Status: complete when the loop decided to STOP or the run dir has final-output.md.
  const lastDecision = Array.isArray(loop.loop_decision_log) && loop.loop_decision_log.length
    ? String(loop.loop_decision_log[loop.loop_decision_log.length - 1]?.decision ?? "")
    : "";
  // Anchor to the decision token (STOP/PIVOT/CONTINUE) so "stopgap"/"unstoppable"
  // don't false-match. And only treat budget-exhaustion as complete when the budget
  // was actually KNOWN and remaining was actually observed as <= 0 (C2 fix — avoids
  // flipping a mid-run with no remaining key to false "complete").
  const decidedStop = /^\s*STOP\b/i.test(lastDecision);
  const budgetExhausted = budgetTotal > 0 && Number.isFinite(knownRemaining) && knownRemaining <= 0;
  const status: NoveltyRun["status"] =
    hasFinal || decidedStop || budgetExhausted ? "complete" : "running";

  // Normalize current_phase to the canonical uppercase phase name; null if unknown.
  const rawPhase = str(loop.current_phase).toUpperCase();
  const currentPhase =
    status === "complete"
      ? null
      : (PHASE_NAMES as readonly string[]).includes(rawPhase)
      ? rawPhase
      : null;

  // Phases: complete run → all complete. Running run → phases BEFORE the current one
  // are complete, the current one is running, later ones pending (progress semantics).
  const currentIdx = currentPhase ? (PHASE_NAMES as readonly string[]).indexOf(currentPhase) : -1;
  const phases: NoveltyPhase[] = PHASE_NAMES.map((name, i) => ({
    name,
    status:
      status === "complete"
        ? "complete"
        : currentIdx < 0
        ? "pending"
        : i < currentIdx
        ? "complete"
        : i === currentIdx
        ? "running"
        : "pending",
  }));

  // Checkpoints A (CONTEMPLATE gate) / B (TEST gate) — from loop state if present.
  const cp = (raw: any, cycle: number): NoveltyCheckpoint => ({
    status: str(raw?.status).toUpperCase() === "FAIL" ? "FAIL" : "PASS",
    percentage: raw?.percentage != null ? num(raw.percentage) : undefined,
    currentAvg: raw?.current_avg != null ? num(raw.current_avg) : undefined,
    previousAvg: raw?.previous_avg != null ? num(raw.previous_avg) : undefined,
    cycle,
  });
  const checkpoints = {
    a: cp(loop?.checkpoints?.a, cycleCount),
    b: cp(loop?.checkpoints?.b, cycleCount),
  };

  const domainFertility: DomainFertility[] = Array.isArray(loop.domain_fertility)
    ? loop.domain_fertility.map((d: any) => ({
        pairing: str(d?.pairing),
        avgScore: num(d?.avg_score ?? d?.avgScore),
        count: num(d?.count),
        multiplier: num(d?.multiplier, 1),
      }))
    : [];

  const phaseMetrics: PhaseMetric[] = Array.isArray(loop.phase_metrics)
    ? loop.phase_metrics.map((p: any) => ({
        phase: str(p?.phase),
        durationSeconds: num(p?.duration_seconds ?? p?.durationSeconds),
        outputCount: num(p?.output_count ?? p?.outputCount),
        agentCount: num(p?.agent_count ?? p?.agentCount),
      }))
    : [];

  // Timestamps: prefer values the artifacts carry; else fall back to file mtimes
  // (stable across re-projection) rather than "now" — which would reorder the
  // "newest first" dashboard on every projection. config.json ~ start; loop-state ~ update.
  const nowIso = new Date().toISOString();
  const startedAt = str(config.started_at, str(loop.started_at, mtimeIso(join(ideateDir, "config.json")) ?? nowIso));
  const updatedAt = str(
    loop.updated_at,
    mtimeIso(join(ideateDir, "loop-state.json")) ?? mtimeIso(join(ideateDir, "final-output.md")) ?? startedAt,
  );
  return {
    id: runId,
    problem,
    status,
    startedAt,
    updatedAt,
    timeScale,
    currentPhase,
    currentCycle: cycleCount,
    maxCycles,
    budgetSecondsTotal: budgetTotal,
    budgetSecondsRemaining: budgetRemaining,
    strategyPivotsUsed: num(loop.strategy_pivots_used, num(loop.strategy_version, 1) - 1),
    strategyPivotsMax: maxStrategyPivots,
    phases,
    checkpoints,
    fitnessTrajectory,
    phaseMetrics,
    domainFertility,
    candidates,
  };
}

// ─── State file merge (upsert by run id) ─────────────────────────────────────

/**
 * Load existing state. Distinguishes three cases (C1 fix — the old version
 * collapsed "corrupt" into "empty" and then overwrote, silently wiping prior runs):
 *   - file absent        → { runs: [] }        (fine, first write)
 *   - file valid         → parsed state
 *   - file present+bad   → throws StateCorruptError (caller must NOT wipe it)
 */
class StateCorruptError extends Error {}

function loadState(): NoveltyState {
  if (!existsSync(NOVELTY_STATE_PATH)) return { runs: [] };
  let raw: string;
  try {
    raw = readFileSync(NOVELTY_STATE_PATH, "utf-8");
  } catch (e) {
    throw new StateCorruptError(`cannot read ${NOVELTY_STATE_PATH}: ${(e as Error).message}`);
  }
  try {
    const parsed = JSON.parse(raw) as NoveltyState;
    if (parsed && Array.isArray(parsed.runs)) return parsed;
    throw new Error("missing runs[] array");
  } catch (e) {
    throw new StateCorruptError(`unparseable ${NOVELTY_STATE_PATH}: ${(e as Error).message}`);
  }
}

/** Atomic write: temp file + rename, so an interrupted/raced write never truncates. */
function writeState(state: NoveltyState): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  // newest first
  state.runs.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  const tmp = `${NOVELTY_STATE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmp, NOVELTY_STATE_PATH);
}

/**
 * Load state for a merge; on corruption, preserve the bad file (back it up) rather
 * than wiping it, and start fresh from empty so the run still records. Returns the
 * state to merge into.
 */
function loadStateForMerge(): NoveltyState {
  try {
    return loadState();
  } catch (e) {
    if (e instanceof StateCorruptError) {
      const backup = `${NOVELTY_STATE_PATH}.corrupt`;
      try {
        copyFileSync(NOVELTY_STATE_PATH, backup);
        console.warn(`[NoveltyProjector] ${e.message} — backed up to ${backup}, starting fresh`);
      } catch {
        console.warn(`[NoveltyProjector] ${e.message} — could not back up; starting fresh`);
      }
      return { runs: [] };
    }
    throw e;
  }
}

export function upsertRun(run: NoveltyRun): NoveltyState {
  const state = loadStateForMerge();
  const idx = state.runs.findIndex((r) => r.id === run.id);
  if (idx >= 0) state.runs[idx] = run;
  else state.runs.push(run);
  writeState(state);
  return state;
}

/** Guarded isDirectory — never throws on a race/permission error (contract: never crash). */
function isDir(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function findAllIdeateDirs(): string[] {
  if (!existsSync(WORK_DIR)) return [];
  const dirs: string[] = [];
  for (const entry of readdirSync(WORK_DIR)) {
    const ideate = join(WORK_DIR, entry, "ideate");
    if (isDir(ideate)) dirs.push(ideate);
  }
  return dirs;
}

/** Ensure a valid state file exists WITHOUT wiping existing content (leaves it as-is if present & valid). */
function ensureValidStateFile(): void {
  try {
    // Touch-through: re-persist whatever is currently valid; if absent, writes {runs:[]}.
    writeState(loadState());
  } catch (e) {
    if (e instanceof StateCorruptError) {
      // Corrupt file present — preserve it (back up) rather than overwrite.
      loadStateForMerge(); // backs up + logs
      writeState({ runs: [] });
    } else {
      throw e;
    }
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function main(argv: string[]): number {
  const args = argv.slice(2);
  let targets: string[] = [];

  if (args[0] === "--all") {
    targets = findAllIdeateDirs();
    if (!targets.length) console.warn("[NoveltyProjector] no MEMORY/WORK/*/ideate runs found");
  } else if (args[0] === "--slug" && args[1]) {
    targets = [join(WORK_DIR, args[1], "ideate")];
  } else if (args[0]) {
    // explicit dir; accept either the run dir or its ideate/ child
    const p = args[0];
    targets = [existsSync(join(p, "ideate")) ? join(p, "ideate") : p];
  } else {
    console.error("Usage: bun NoveltyProjector.ts <ideate-dir> | --slug <slug> | --all");
    // Guarantee a valid state file exists, without wiping existing content.
    ensureValidStateFile();
    return 2;
  }

  let projected = 0;
  for (const dir of targets) {
    const run = projectIdeateRun(dir);
    if (run) {
      upsertRun(run);
      projected++;
      console.log(`[NoveltyProjector] projected run '${run.id}' (${run.status}, ${run.candidates.length} candidates)`);
    }
  }

  // Always leave a valid state file — but never wipe existing runs when we projected none.
  if (!projected) ensureValidStateFile();
  console.log(`[NoveltyProjector] wrote ${NOVELTY_STATE_PATH} (${projected} run(s) projected)`);
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv));
}
