# LifeOS State — Phase #2: real closeness-to-ideal (the gap engine)

> **Audience:** an agent picking this up cold. Everything you need is here — no re-research required. Companion doc: `docs/LIFEOS-STATE-PHASE1-AUTHOR-IDEALSTATE.md` (authoring the source files this phase scores). Background: `docs/LIFEOS-STATE-UPDATE-PLAN.md` (original research), `docs/TELOS-IMPLEMENTATION-PLAN.md`.
> **Goal:** move a dimension's `pct` from *"how fully articulated"* (setup %, what ships for most dims today) to *"how close are you to your ideal"* (real coverage / gap) — Miessler's actual A–F-grade intent.
>
> ### ⚠️ Refresh note (2026-07-06) — what changed under this doc
> Corrected inline below, same drift as the Phase #1 doc:
> 1. **Live tree renamed `PAI/` → `LIFEOS/`** (claude-config `a7662ce` + `f0e1738`; see `docs/LIVE-PAI-TO-LIFEOS-MIGRATION-PLAN.md`, now executed history). Every `~/.claude/PAI/...` / `PAI/TOOLS/...` / `PAI/PULSE/...` path is stale.
> 2. **Scorer tool is `UpdateLifeosState.ts`**, not `UpdatePaiState.ts`.
> 3. **Phase 2 is substantially DONE — #2a, #2b, #2c(grades), and UI labeling all shipped on both trees (2026-07-06).**
>    - **#2a (real coverage):** `CURRENT_STATE/` files authored for **five** dims — HEALTH 50%, FREEDOM 67%, CREATIVE 60%, RELATIONSHIPS 67%, RHYTHMS 50% — all `mode: coverage`. `money` + `infrastructure` are deliberate **opt-outs** (`type: opt-out` → null, "not tracked", never a misleading grade). **Zero untracked dims remain** (5/7 score by reality, 2/7 opted out).
>    - **#2b (semantic gap):** the Haiku gap engine shipped + refined on both trees (alias-tolerant parser for haiku schema drift; verified live via headroom→Bedrock). `ComputeGap.ts` is no longer a stub.
>    - **#2c (grades):** deterministic life-calibrated A–F letter grade per dim (A≥85/B≥70/C≥55/D≥40/F<40) — health **D**, freedom/creative/relationships **C**, rhythms **D**, opt-outs null. Rendered as a `.dim-grade` badge on `/telos` (client rebuilt, Pulse restarted, live-verified). The prescriptive **next-action** half of #2c is the one deferred piece (see #2c below).
>    - **UI honest-labeling:** `/telos` renders per-dim `mode` language ("covered" vs "articulated") + the grade badge; Interceptor-verified ("59% tracked on average… rhythms the least at 50% covered").
>    - The "MOSTLY ABSENT" framing throughout the body below is **superseded** — it describes the pre-2026-07-06 starved state. **Remaining frontier:** the #2c next-action wiring, an optional capture cadence (propose/approve), and a fork `bun install` so its `observability.ts` fully typechecks.

---

## 0. Orientation — the two trees and how state flows (read first)

**Two divergent repos, no shared git history:**
- **Live install:** `~/.claude/` → remote `origin` = `atabisz/claude-config` (private, the RUNNING system; Pulse :31337 serves from here). Paths `~/.claude/LIFEOS/...`; resolve via `LIFEOS_DIR`/`PAI_DIR` or `process.env.HOME ?? process.env.USERPROFILE ?? homedir()` (Windows HOME is unset under Pulse autostart — keep the fallback).
- **Fork (canonical/public):** `c:/src/LifeOS/` → remote `fork` = `atabisz/Personal_AI_Infrastructure` (push here), `origin` = `danielmiessler/LifeOS` (**NEVER push**). Paths `LifeOS/install/LifeOS/...` (resolve via `LIFEOS_DIR`).
- **Rule:** live-first, then mirror to fork (state code is byte-identical across trees today — keep it so).

**The state data flow:**
```
USER/TELOS/IDEAL_STATE/<DIM>.md   (target prose)
USER/TELOS/CURRENT_STATE/<DIM>.md (have/partial/missing rows) ◀── the input #2 needs. HEALTH.md exists (2026-07-05); other dims absent
        │
        ▼  (SessionStart hook + Pulse cron "derived-sync" */15)
   DerivedSync.ts ─▶ UpdateLifeosState.ts ─▶ LIFEOS_STATE.json ─▶ observability.ts reader ─▶ /telos rings + summary
```

**Miessler intent (already researched — do NOT re-fetch):** "Managing State" = periodic inventory of current-vs-desired (Personal AI Maturity Model, AS2). Scoring vision = **A–F letter grades + a prescriptive next action to raise each grade** ("The Real Internet of Things", 2016 — *"Row 500 meters, do one set of push-ups"*). Corrections: SPQA = State/**Policy/Questions/Actions**; the 7-dim taxonomy is a LifeOS extension; his gap is **AI-computed at read-time**, not a stored score. Full sourcing: `docs/LIFEOS-STATE-UPDATE-PLAN.md` §1.

---

## Why most dims still show only a "setup %"

`UpdateLifeosState.ts` scores a `target` dimension by **authored substance** (`sections×10 + bullets×5`, excluding not-scored headings) — i.e. *how fully written the IDEAL file is*, NOT how close reality is to it. That's honest (the ring is labeled "Dimension setup", summary prose says "articulated"), but it's not the gap. Real coverage requires a **CURRENT_STATE source** describing where the principal actually is. **Both `health` and `freedom` now have one** (`CURRENT_STATE/HEALTH.md` authored 2026-07-05, `CURRENT_STATE/FREEDOM.md` authored 2026-07-06) so both score coverage — proof the path works on more than one dim. Any OTHER target dim added later is setup-% until its CURRENT_STATE file exists.

**The existing machinery that's ready for real coverage:**
- `UpdateLifeosState.computeFromCurrent(file)` — ALREADY computes real coverage: `pct = (have + 0.5·partial)/total × 100` from `- <item>: status: have|partial|missing` rows in `CURRENT_STATE/<DIM>.md` (`UpdateLifeosState.ts:87`). **This is pure regex — no LLM. Live-proven on HEALTH.md.**
- `LIFEOS/TOOLS/ComputeGap.ts` — a computed gap VIEW (not stored). Reads IDEAL vs CURRENT; emits `GapEntry{metric, current, target, direction:"above"|"below"|"at"|"unknown", severity:"critical"|"warning"|"info"|"none", note}` per dimension; `--log` appends `MEMORY/OBSERVABILITY/gap-history.jsonl`. **⚠️ SUPERSEDED (2026-07-06): this description of a "v1 STUB that only counts TBD markers" is history — #2b shipped.** ComputeGap now runs a real Haiku semantic extraction: a shared `extractGap()` reads `IDEAL_STATE/<DIM>.md` + `CURRENT_STATE/<DIM>.md`, sends both to `Inference.ts` (live `level:"fast"` / fork `level:"low"`, ~$0.01/run), and returns a validated, alias-tolerant `GapEntry[]`; `money` opt-out is gated; failures degrade safely. See #2b below.
- `LIFEOS/TOOLS/ProposeCurrentStateEntry.ts` + `ApproveCurrentStateEntries.ts` — the **capture pipeline** to populate CURRENT_STATE without hand-typing: pollers (`ALLOWED_SOURCES = lifelog,calendar,gmail,homebridge,manual,amazon,bills`; `ALLOWED_TARGETS = CONSUMPTION,ACTIVITY,SOCIAL,FINANCIAL,SIGNALS,SNAPSHOT`) enqueue to `CURRENT_STATE/proposals.jsonl`; `--approve <id>` commits into `CURRENT_STATE/<TARGET>.md`. **Principle (Miessler decision #5): no auto-capture — every entity requires explicit approval.**

⚠️ **Verification-status caveat (from the prior Cato audit, still partly open):** `ComputeGap.ts` / `ProposeCurrentStateEntry.ts` / `ApproveCurrentStateEntries.ts` were originally described from the GitHub research digest. The 2026-07-06 refresh confirmed they exist live at `LIFEOS/TOOLS/` and re-read `ComputeGap.ts`'s header + stub status (v1 TBD-counter, Haiku upgrade noted). The propose/approve internals still merit a line-by-line read before building on them.

---

## The path (three sub-steps, increasing fidelity)

### #2a — Populate CURRENT_STATE so the existing regex path fires (smallest real-gap step, no LLM) — DONE for health, freedom, creative, relationships, rhythms (money + infrastructure opted out)
`computeFromCurrent` already does real coverage; it just needs input per dimension. **Done for five dims:** `CURRENT_STATE/HEALTH.md` → 50% (2026-07-05), `CURRENT_STATE/FREEDOM.md` → 67% (2026-07-06), `CURRENT_STATE/CREATIVE.md` → 60% (3 have / 2 missing), `CURRENT_STATE/RELATIONSHIPS.md` → 67% (2 have / 1 missing), `CURRENT_STATE/RHYTHMS.md` → 50% (2 have / 2 missing) — all 2026-07-06. All five are `mode: coverage` in LIFEOS_STATE.json, verified via `bun UpdateLifeosState.ts` and the live `/api/telos/overview`. Note CREATIVE + RELATIONSHIPS IDEAL files are `type: north-star` — authoring a CURRENT_STATE file makes them score by real coverage (CURRENT wins over the north-star `null`). `money` + `infrastructure` are deliberate `type: opt-out` (→ null, "not tracked"). **Zero untracked dims remain.** **Remaining:** optionally wire propose/approve into a cadence for semi-automated capture (respect the approval-gate).

### #2b — Semantic gap via Haiku (ComputeGap's intended upgrade) — DONE + REFINED (both trees)
**Shipped.** `ComputeGap.ts` replaced its TBD-count stub with a shared `extractGap()` that reads `IDEAL_STATE/<DIM>.md` + `CURRENT_STATE/<DIM>.md`, sends both to Haiku via `Inference.ts` (fork `level: "low"`; live `level: "fast"` — the two trees have divergent Inference APIs, low/medium/high/max vs fast/standard/smart), and returns validated `GapEntry[]`. HOME resolution hardened (`HOME ?? USERPROFILE ?? homedir()`), `money` opt-out gated, safe degradation on inference failure. **Refinement (2026-07-06):** the haiku-tier model reasons well but will NOT obey a strict JSON key schema even with a worked example (it emits `gap_narrative`/`priority`/`current_status`/`ideal_row`), so `validateEntry` was made alias-tolerant (`pick` across key variants, `normSeverity`/`normDirection`, `severityFromStatus`, drop `have` rows) rather than fighting the prompt. Result: `target` now reliably populated, `direction`/`severity` derived from status (missing→below/critical, partial→below/warning). **Verified live end-to-end via headroom→Bedrock** (health 2 gaps, freedom 3 gaps). Commits — fork: `8f35d00` (+ engine `44aa164`, inference-gateway `b3025cb`); live: `d2a5df0` (+ engine `db4643a`). **Auth prereq surfaced + fixed:** this machine authenticates `claude` through a local **headroom proxy** (`ANTHROPIC_BASE_URL=127.0.0.1:8787` → Bedrock), so `Inference.ts` had to STOP scrubbing `ANTHROPIC_API_KEY` on a gateway/proxy path (env-aware scrub; live already had its own `isLocalProxyBaseUrl` variant). **Note:** `money` opt-out is respected; narrative dims are handled by scoring their CURRENT_STATE coverage (see #2a) rather than being excluded.

### #2c — A–F grades (full Miessler fidelity) — GRADES DONE; next-action deferred
**Grades shipped (2026-07-06).** A deterministic `gradeForPct(pct)` (pure, no LLM) maps coverage → a **life-calibrated** letter: A≥85, B≥70, C≥55, D≥40, F<40 (user-chosen — rewards partial progress vs punishing academic bands). `DimensionState.grade` is emitted per dim in `LIFEOS_STATE.json`; a null pct (opt-out/untracked) gets a null grade — never a misleading "F". Current grades: health **D**(50), freedom **C**(67), creative **C**(60), relationships **C**(67), rhythms **D**(50); money + infrastructure null. Surfaced through `buildDimensionsFromIdealState` → `/api/telos/overview` → a `.dim-grade` badge beside each dimension on `/telos` (Next client rebuilt, Pulse restarted, live-verified: API returns grades, badge in the built bundle). Both trees carry the scorer grade (live `736f4f3`, fork `c404916`); live UI `d96427f`, fork UI mirrored. Band boundaries unit-checked.

**Deferred (the "next-action" half):** map each dimension's real gap (ComputeGap `note`s already produce gap-derived actions) into the existing UI `Recommendation` slot so each grade carries a "next action to raise it." The rendering slot + the gap data both exist; the wiring between them is the remaining #2c work. This is the AS2→AS3 step (display → the DA proposing an action).

---

## Cross-cutting: reverse the honest-labeling once `pct` is real

When `pct` stops being a setup % and becomes real closeness-to-ideal, the honest-labeling done in commits `1406e9f` (live) / `d325aeb` (fork) should be **reversed** so the UI matches the new meaning:
- `LIFEOS/PULSE/Observability/src/app/telos/_v7/hero.tsx` — ring label "Dimension setup" → back to "Current vs Ideal".
- `_v7/summary.ts` `buildHeadline`/`buildPosition` — articulation prose ("X% articulated / left to articulate") → back to achievement framing ("X% of ideal / gaps to close").
These were intentionally written to be cheap to flip. **Don't flip them globally until the number is genuinely coverage/gap** — otherwise you reintroduce the "articulated masquerading as achieved" dishonesty. **Subtlety now that dims are mixed-mode:** both `health` and `freedom` are already `mode: coverage`, while any un-authored target dim is `mode: setup`, so the label must key off each dim's `mode` field, not a single global flip. **Fork caveat:** the public fork (`c:/src/LifeOS`) ships an OLDER `UpdateLifeosState.ts` whose `DimensionState` does NOT emit the `mode` field — live drifted ahead. Before the per-dim label work lands in the fork, mirror the `mode`-emitting scorer (and the `type:`-frontmatter IDEAL files) from live.

Also coordinate the reader: `LIFEOS/PULSE/Observability/observability.ts` `buildDimensionsFromIdealState` currently reads `pct` (+ `velo`, `mode`) and hardcodes `ideal:100`. If #2b adds a separate `coverage` field rather than overriding `pct`, teach the reader/UI which one to surface.

---

## Verify (per step)

- #2a: author a `CURRENT_STATE/<DIM>.md`, run `bun ~/.claude/LIFEOS/TOOLS/UpdateLifeosState.ts`, confirm that dim's `source_file` becomes `CURRENT_STATE/...`, `mode` becomes `coverage`, and its pct reflects have/partial/missing (not substance). (Health is the reference: `source_file: CURRENT_STATE/HEALTH.md`, `mode: coverage`, 50%.)
- Restart Pulse (not watch-mode); the client is a static export — `bun run build` in `LIFEOS/PULSE/Observability/` after any `_v7/*` edit.
- Cato cross-vendor audit any scorer/label change (user-facing number). Verify on a scratch HOME (Rule 1b), then Interceptor on `/telos`.

## Acceptance

A dimension with real CURRENT_STATE coverage scores by reality-vs-ideal (not articulation); the number and its ring-label + summary prose all agree per that dim's `mode`; narrative dims stay reminders; nothing fabricated.

## Working agreements

- Live-first then fork-mirror; sign commits (`alex@tabisz.org`); push live→`origin`(claude-config), fork→`fork`; never push `origin`(danielmiessler).
- `LIFEOS_STATE.json` is derived — never hand-edit; regenerate via `UpdateLifeosState.ts`/`DerivedSync.ts`.
- Pulse is not watch-mode (restart after `observability.ts` edits); client is a static export (rebuild after `_v7/*` edits).

---
*Written 2026-07-04; refreshed 2026-07-06 (PAI→LIFEOS rename, `UpdateLifeosState.ts` tool name, #2a started via CURRENT_STATE/HEALTH.md). Companion: `docs/LIFEOS-STATE-PHASE1-AUTHOR-IDEALSTATE.md`. This doc changes no code.*
