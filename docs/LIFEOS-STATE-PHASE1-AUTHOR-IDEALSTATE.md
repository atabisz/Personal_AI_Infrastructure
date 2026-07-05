# LifeOS State — Phase #1: author the IDEAL_STATE (and CURRENT_STATE) dimensions

> **Audience:** an agent picking this up cold. Everything you need is here — you should NOT have to re-research Miessler's intent or re-audit the code. Companion doc: `docs/LIFEOS-STATE-PHASE2-REAL-COVERAGE.md` (the closeness-to-ideal engine). Background: `docs/LIFEOS-STATE-UPDATE-PLAN.md` (original research), `docs/TELOS-IMPLEMENTATION-PLAN.md` (the /telos build).
> **Status when written (2026-07-04), REFRESHED 2026-07-06:** the state pipeline (port, trigger, honest scorer) is SHIPPED + live. What #1 covers = content the principal must author so more dimensions light up. **This is content the principal owns — an agent FACILITATES, never fabricates their targets.**
>
> ### ⚠️ Refresh note (2026-07-06) — what changed under this doc
> Two things drifted since the original 2026-07-04 draft, both now corrected inline below:
> 1. **The live tree was renamed `PAI/` → `LIFEOS/`** (claude-config commits `a7662ce` "the cut" + `f0e1738` "repoint live surfaces"; see `docs/LIVE-PAI-TO-LIFEOS-MIGRATION-PLAN.md`, which is now executed history). Every `~/.claude/PAI/...` path is stale → use `~/.claude/LIFEOS/...`.
> 2. **The scorer tool is `UpdateLifeosState.ts`, not `UpdatePaiState.ts`** — the latter name never existed as a live tool (it survives only in old log/memory artifacts).
> Verified live 2026-07-06: `/api/telos/overview` renders **`health = 50%` (mode `coverage`)** and **`freedom = 70%` (mode `setup`)**. Health is now coverage-mode because `CURRENT_STATE/HEALTH.md` was authored 2026-07-05 (2 have / 2 missing = 50%). The earlier "65%/80%" numbers in this doc were pre-CURRENT_STATE and are gone.

---

## 0. Orientation — the two trees and how state flows (read first)

**Two divergent repos, no shared git history:**
- **Live install:** `~/.claude/` → git remote `origin` = `atabisz/claude-config` (private). The RUNNING system (Pulse on :31337 serves from here). Paths: `~/.claude/LIFEOS/...` (renamed from `PAI/` on 2026-07-05). Resolve via `PAI_DIR`/`LIFEOS_DIR` env or `process.env.HOME ?? process.env.USERPROFILE ?? homedir()` (Windows — HOME is unset under Pulse VBS-autostart, so ALWAYS keep the USERPROFILE/homedir fallback).
- **Fork (canonical/public):** `c:/src/LifeOS/` → remote `fork` = `atabisz/Personal_AI_Infrastructure` (push here), `origin` = `danielmiessler/LifeOS` (upstream — **NEVER push**). Paths under `LifeOS/install/LifeOS/...`.
- **Rule:** changes **live-first, then mirror to the fork**.

**The state data flow (all live-working today):**
```
USER/TELOS/IDEAL_STATE/<DIM>.md   (authored prose, per dimension)      ← #1 fills these
USER/TELOS/CURRENT_STATE/<DIM>.md (authored have/partial/missing rows)  ← #1 optionally fills; feeds #2
        │
        ▼  (trigger: SessionStart hook + Pulse cron "derived-sync" */15 — cross-platform, no launchd)
   DerivedSync.ts ─runs─▶ UpdateLifeosState.ts ─writes─▶ USER/TELOS/LIFEOS_STATE.json
        ▼
   observability.ts buildDimensionsFromIdealState() → /api/telos/overview → dimension rings + hero summary
```

**How the scorer treats a dimension today** (`LIFEOS/TOOLS/UpdateLifeosState.ts`, honest v2 — `scorer_version: substance-v2-exclude-notscored`):
- If `CURRENT_STATE/<DIM>.md` has `status: have|partial|missing` rows → `pct = (have + 0.5·partial)/total × 100` (real coverage, `mode: "coverage"`). **This is live for `health` today.**
- Else the `IDEAL_STATE/<DIM>.md` frontmatter `type:` decides:
  - `type: opt-out` or `type: north-star` → `pct: null` → renders **"not tracked"** (a choice, not a failing 0%).
  - `type: target` (or unset) → substance score `min(100, sections×10 + bullets×5)` counting only SCORABLE sections (a heading marked "not scored"/"aspirational" and its bullets are excluded), `mode: "setup"` (a *setup %*, headroom-tuned so a fully-set-up file lands ~80).
- The reader **drops null-pct dims** so opt-out/directional/absent dimensions don't render as 0%/failing rings. **Verified live:** only `health` + `freedom` render; the other five are absent, not zero.

**Miessler intent (already researched — do NOT re-fetch):** "Managing State" = the DA takes periodic inventory of current-vs-desired state (Personal AI Maturity Model, AS2). His TELOS is section-based; the 7-dim taxonomy (health/money/freedom/creative/relationships/rhythms/infrastructure) is a **LifeOS extension, not canonical Miessler**. Dimensions can be prose/directional by choice — he does NOT mandate a score per dimension. Full sourcing: `docs/LIFEOS-STATE-UPDATE-PLAN.md` §1.

---

## Current state of the 7 dimension files (verified live 2026-07-06)

`~/.claude/LIFEOS/USER/TELOS/IDEAL_STATE/`:

| Dim | file | `type:` | status | renders on /telos? |
|-----|------|---------|--------|--------------------|
| health | HEALTH.md | target | authored + `CURRENT_STATE/HEALTH.md` exists → **coverage-mode** (2 have / 2 missing) | ✅ 50% (coverage) |
| freedom | FREEDOM.md | target | authored, no CURRENT_STATE yet → setup-mode | ✅ 70% (setup) |
| money | MONEY.md | opt-out | deliberate opt-out (2026-07-03 — do NOT prompt for financial targets) | — not tracked |
| creative | CREATIVE.md | north-star | directional | — not tracked |
| relationships | RELATIONSHIPS.md | north-star | directional | — not tracked |
| rhythms | (absent) | — | no file | — not tracked |
| infrastructure | (absent) | — | no file | — not tracked |

`~/.claude/LIFEOS/USER/TELOS/CURRENT_STATE/` now has `README.md` + `SNAPSHOT.md` + **`HEALTH.md`** (authored 2026-07-05). Health is therefore the first dimension scored by real coverage. The other target dims (freedom) still fall to the setup-% path until their CURRENT_STATE file is authored — that authoring IS the bridge to Phase #2.

---

## What to do

1. **Facilitate authoring (don't fabricate).** Via `/interview` Phase 2 (the intended path) or hand-authoring, help the principal fill the dimensions they want tracked. The Interview skill (`~/.claude/skills/Interview/SKILL.md`) covers HEALTH/MONEY/FREEDOM/RELATIONSHIPS/CREATIVE in Phase 2; `LIFEOS/TOOLS/InterviewScan.ts` is the completeness scanner (its REGISTRY already targets IDEAL_STATE + CURRENT_STATE). RHYTHMS is Phase 9 (deferred, principal said not needed at first) and INFRASTRUCTURE isn't scanned — add them to `InterviewScan.ts` targets if the principal wants them tracked.
2. **Frontmatter contract (drives the scorer):** each `IDEAL_STATE/<DIM>.md` needs:
   ```
   ---
   dimension: <NAME>
   type: target | north-star | opt-out
   ---
   ```
   `target` = scored (substance now; real coverage once CURRENT_STATE exists). `north-star`/`opt-out` = intentionally not scored → "not tracked", NOT 0%.
3. **For a REAL coverage score (this is the bridge to #2), author `CURRENT_STATE/<DIM>.md`** with `- <item>: status: have|partial|missing` rows — exactly the shape `CURRENT_STATE/HEALTH.md` already uses live. `computeFromCurrent` (in `UpdateLifeosState.ts`) reads exactly these. **`/interview` does NOT write these today** (it writes narrative prose) — so either author by hand (as health was) or use the propose/approve capture pipeline (see the Phase #2 doc).
4. **No backend code needed for #1** beyond optionally extending `InterviewScan.ts` targets to include RHYTHMS/INFRASTRUCTURE.

## Verify

- Run `bun ~/.claude/LIFEOS/TOOLS/UpdateLifeosState.ts` → new/edited dims get a pct (or "—" if opt-out/north-star); a dim with a CURRENT_STATE file gets `mode: "coverage"`, else `mode: "setup"`.
- Restart Pulse (`bun run pulse.ts` — not watch-mode), then `curl -s localhost:31337/api/telos/overview | jq '.dimensions'` → the dims render (today: health 50/coverage, freedom 70/setup).
- `Skill("Interceptor")` on `/telos` → rings show the dimensions honestly (no fabricated numbers, opt-outs absent not 0%).

## Acceptance

The principal's chosen dimensions render on `/telos` with an honest number (coverage % where a CURRENT_STATE file exists, setup % otherwise); opt-out/directional ones stay "not tracked"; nothing fabricated.

## Working agreements

- Live-first then fork-mirror; sign commits (`alex@tabisz.org`); push live→`origin`(claude-config), fork→`fork`; never push `origin`(danielmiessler).
- `LIFEOS_STATE.json` is **derived** — never hand-edit; regenerate via `UpdateLifeosState.ts`.
- Content is the principal's — an agent proposes structure and asks; it does not invent health/money/relationship targets.

---
*Written 2026-07-04; refreshed 2026-07-06 (PAI→LIFEOS rename, `UpdateLifeosState.ts` tool name, health now coverage-mode). Companion: `docs/LIFEOS-STATE-PHASE2-REAL-COVERAGE.md`. This doc changes no code.*
