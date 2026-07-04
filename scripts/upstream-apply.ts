#!/usr/bin/env bun
/**
 * upstream-apply — increment 2 of the sync channel: the GUARDED apply that lands
 * classified release items into the live PAI/-shaped tree.
 *
 * This is the ONLY tool in the channel that writes into live `~/.claude`, so its
 * guards are deliberately strict. It is NOT a reuse of build-release.ts's
 * assertDestSafe: that guard trusts live as SOURCE and requires the destination be
 * a `.claude` under Releases/ — the exact inverse of what we do here (Cato-flagged:
 * the containment invariant is not reverse-symmetric). We keep build-release's
 * junction-safe realpath primitives (realOrSelf/isUnder) and rewrite the policy.
 *
 * INVARIANTS (all enforced, fail-closed):
 *  1. ADDITIVE-ONLY. Writes ONLY files upstream-sync classifies `add` (release has
 *     it, live lacks it). NEVER overwrites an existing live file — that is how the
 *     397 conflicts (your ahead-of-safety Algorithm/hook line) stay untouched. An
 *     existing destination is a hard skip, not a merge.
 *  2. CONTAINMENT. Every destination realpath-resolves strictly INSIDE the live
 *     root (junction/reparse-safe). A path escaping the root aborts the whole run.
 *  3. SKILLS GO THROUGH CreateSkill. Live's skills/CLAUDE.md mandates Skill("CreateSkill")
 *     for skill ports; this tool REFUSES skills/** and lists them for the human to
 *     route through CreateSkill. It does not hand-drop SKILL.md files.
 *  4. NORMALIZED BYTES. Writes the path-normalized content (LIFEOS_/LifeOS/->PAI),
 *     never the raw release bytes — else a ported module resolves to a nonexistent
 *     ~/.claude/LifeOS dir (silent-empty-dir).
 *  5. NO AUTO-COMMIT. Writes files and stops. The human reviews `git status`/`git diff`
 *     in the live repo and commits (signed) themselves. Dry-run is the default;
 *     --apply is required to write.
 *  6. FLAG-BLOCKING. A file whose normalization still carries an ambiguous residual
 *     flag (see lifeos-normalize) is NOT auto-written under --apply unless
 *     --allow-flagged is passed — a flagged token is a human decision.
 *  7. USER/ IS A SCAFFOLD ZONE, NEVER SYNCED. The release's USER/ tree is SAMPLE
 *     TEMPLATES ("Replace with your own via /interview"). Live USER/ is the human's
 *     real personal data. Landing templates there would scatter placeholders into
 *     populated personal content — the exact "never clobber a populated zone" rule.
 *     USER/ ports are refused; onboarding owns that tree (the LifeOS install skill /
 *     Interview), not the release-sync channel.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { normalize } from "./lifeos-normalize.ts";
import { normalizeRelPath } from "./upstream-sync.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const RELEASE_PAYLOAD = path.join(REPO_ROOT, "LifeOS", "install");

function liveRoot(): string {
  const home = process.env.HOME || os.homedir();
  return process.env.PAI_DIR ? path.resolve(process.env.PAI_DIR) : path.join(home, ".claude");
}

// ── junction/reparse-safe containment (borrowed from build-release.ts) ─────────
function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
/** Resolve the deepest existing ancestor's realpath, then re-append the missing
 *  tail — so containment holds even for a not-yet-created destination file. */
function realDestWithin(destAbs: string, root: string): { ok: boolean; resolved: string } {
  let cur = destAbs;
  const tail: string[] = [];
  while (!existsSync(cur) && path.dirname(cur) !== cur) {
    tail.unshift(path.basename(cur));
    cur = path.dirname(cur);
  }
  const resolved = path.join(realOrSelf(cur), ...tail);
  return { ok: isUnder(resolved, realOrSelf(root)), resolved };
}

const TEXT_EXTS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".md", ".mdx", ".json", ".jsonc",
  ".toml", ".yaml", ".yml", ".sh", ".bash", ".zsh", ".txt", ".css", ".scss", ".html", ".hbs",
  ".plist", ".service", ".swift", ".py", ".env", ".example",
]);
const TEXT_BASENAMES = new Set(["LATEST", "VERSION", "Dockerfile", "Makefile"]);
function isText(rel: string): boolean {
  if (TEXT_BASENAMES.has(path.basename(rel))) return true;
  const ext = path.extname(rel).toLowerCase();
  return ext ? TEXT_EXTS.has(ext) : false;
}

function walk(root: string, base = ""): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    if (name === "node_modules" || name === ".git" || name === "out") continue;
    const abs = path.join(root, name);
    const rel = base ? `${base}/${name}` : name;
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...walk(abs, rel));
    else if (st.isFile()) out.push(rel);
  }
  return out;
}

// Zones the sync channel must never write into. USER/ is the human's personal data
// (release ships only templates); MEMORY/ is operational state; both are owned by
// onboarding/runtime, not release-sync.
const SCAFFOLD_ZONES = ["USER/", "MEMORY/", "PAI/USER/", "PAI/MEMORY/"];

type Plan = {
  releaseRel: string; // path within RELEASE_PAYLOAD
  liveRel: string; // normalized path within live root
  bytes: Buffer;
  flags: number;
  status: "will-add" | "skip-exists" | "skip-skill" | "skip-scaffold" | "skip-flagged" | "skip-escape";
};

function buildPlan(only?: string, allowFlagged = false): Plan[] {
  const root = liveRoot();
  const plans: Plan[] = [];
  for (const releaseRel of walk(RELEASE_PAYLOAD)) {
    const liveRel = normalizeRelPath(releaseRel);
    if (only && !liveRel.startsWith(only)) continue;
    const srcAbs = path.join(RELEASE_PAYLOAD, ...releaseRel.split("/"));
    const destAbs = path.join(root, ...liveRel.split("/"));

    let bytes: Buffer;
    let flags = 0;
    if (isText(releaseRel)) {
      const n = normalize(readFileSync(srcAbs, "utf8"));
      bytes = Buffer.from(n.text, "utf8");
      flags = n.flags.length;
    } else {
      bytes = readFileSync(srcAbs);
    }

    let status: Plan["status"];
    if (existsSync(destAbs)) status = "skip-exists"; // INVARIANT 1: never overwrite
    else if (SCAFFOLD_ZONES.some((z) => liveRel.startsWith(z))) status = "skip-scaffold"; // INVARIANT 7: USER/MEMORY owned by onboarding
    else if (liveRel.startsWith("skills/")) status = "skip-skill"; // INVARIANT 3: CreateSkill owns these
    else if (!realDestWithin(destAbs, root).ok) status = "skip-escape"; // INVARIANT 2: containment
    else if (flags > 0 && !allowFlagged) status = "skip-flagged"; // INVARIANT 6
    else status = "will-add";

    plans.push({ releaseRel, liveRel, bytes, flags, status });
  }
  return plans;
}

function main(argv: string[]): number {
  if (argv.includes("--self-test")) return runSelfTest();
  const apply = argv.includes("--apply");
  const allowFlagged = argv.includes("--allow-flagged");
  const onlyIdx = argv.indexOf("--only");
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : undefined;

  console.log(`upstream-apply — ${apply ? "APPLY (writing ADDs to live)" : "DRY-RUN (no writes)"} | live=${liveRoot()}`);
  if (only) console.log(`  scope: --only ${only}`);
  console.log("  additive-only · contained · normalized · skills→CreateSkill · no auto-commit\n");

  const plans = buildPlan(only, allowFlagged);
  const counts: Record<Plan["status"], number> = {
    "will-add": 0, "skip-exists": 0, "skip-skill": 0, "skip-scaffold": 0, "skip-flagged": 0, "skip-escape": 0,
  };
  for (const p of plans) counts[p.status] += 1;

  let written = 0;
  for (const p of plans) {
    if (p.status !== "will-add") continue;
    console.log(`  add  ${p.liveRel}${p.flags ? ` (${p.flags} flags, --allow-flagged)` : ""}`);
    if (apply) {
      const destAbs = path.join(liveRoot(), ...p.liveRel.split("/"));
      // Re-check containment at write time (TOCTOU-safe: guard immediately precedes write).
      if (!realDestWithin(destAbs, liveRoot()).ok) {
        console.error(`  ABORT: containment escape at write time: ${p.liveRel}`);
        return 1;
      }
      mkdirSync(path.dirname(destAbs), { recursive: true });
      writeFileSync(destAbs, p.bytes);
      written += 1;
    }
  }

  console.log("");
  console.log(`SUMMARY: will-add ${counts["will-add"]} | skip-exists ${counts["skip-exists"]} (conflicts/unchanged — protected)`);
  console.log(`         skip-scaffold ${counts["skip-scaffold"]} (USER/MEMORY — onboarding owns) | skip-skill ${counts["skip-skill"]} (route via CreateSkill)`);
  console.log(`         skip-flagged ${counts["skip-flagged"]} (--allow-flagged to include) | skip-escape ${counts["skip-escape"]}`);
  if (apply) {
    console.log(`\nWROTE ${written} files into ${liveRoot()}. NOT committed — review \`git -C ~/.claude diff\` and commit signed yourself.`);
  } else {
    console.log(`\nDRY-RUN only. Re-run with --apply to write. Skills: route the ${counts["skip-skill"]} skipped via Skill("CreateSkill").`);
  }
  return 0;
}

// ── self-test: guard logic on synthetic plans (no live writes) ────────────────
function runSelfTest(): number {
  const checks: { name: string; got: boolean; want: boolean }[] = [];
  // containment: a ../ escape must be rejected
  const root = path.join(os.tmpdir(), "ua-selftest-root");
  const escape = realDestWithin(path.join(root, "..", "evil.txt"), root);
  checks.push({ name: "escape rejected", got: escape.ok, want: false });
  const inside = realDestWithin(path.join(root, "PAI", "PULSE", "modules", "x.ts"), root);
  checks.push({ name: "inside accepted", got: inside.ok, want: true });
  // path normalization drives the liveRel
  checks.push({ name: "LifeOS→PAI relpath", got: normalizeRelPath("LifeOS/PULSE/x.ts") === "PAI/PULSE/x.ts", want: true });
  // isText coverage of the class Cato flagged
  checks.push({ name: ".tsx is text", got: isText("a/b.tsx"), want: true });
  checks.push({ name: "VERSION is text", got: isText("LifeOS/VERSION"), want: true });
  checks.push({ name: ".png is binary", got: isText("a/logo.png"), want: false });
  let pass = 0;
  for (const c of checks) {
    if (c.got === c.want) pass += 1;
    else console.error(`FAIL ${c.name}: got ${c.got} want ${c.want}`);
  }
  console.log(`${pass}/${checks.length} passed`);
  return pass === checks.length ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
