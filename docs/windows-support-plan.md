# Windows support — recommended implementation plan

This is the plan for making LifeOS (PAI) work on a fresh native Windows install. It builds on the triage in [windows-support-audit.md](windows-support-audit.md) and the conclusions of a four-member council debate (Hale, Vance, Reese, Quill). The audit is the map; this is the route.

**Date:** 2026-06-30
**Source audit:** [windows-support-audit.md](windows-support-audit.md)
**Decision basis:** Council debate, 3 rounds. Strong convergence on sequencing; one honest tension on scope (recorded below).

> **Live-install verification — 2026-06-30.** The plan's "the live tree already carries this fix" assumptions were checked against the live install at `C:\Users\AlexTabisz\.claude`. Result: **two of three hold, one does not.** Hook interpreter prefixes (✅) and `voice.ts` (✅) are fixed and suitable in the live tree — those steps really are back-ports. But the **HOME-resolution sweep is barely started even in the live tree** (33 files still throwing `process.env.HOME!`, 26 on `\|\| ""`/`?? ""`, only 18 on the correct chain), there is **no shared helper module to promote**, and **no lint rule exists**. Also: the two `.sh` blockers (`ContextReduction.hook.sh`, statusline) are **release-snapshot artifacts** — the live `settings.json` registers no `.sh` hook and uses an inline bash statusline. Inline corrections below are dated. Full evidence: the "Live-install verification" table in the audit.

## The core finding

One blocker hides every other blocker. The release `settings.json` registers every hook as a bare `*.hook.ts` path with no interpreter prefix, relying on a `#!/usr/bin/env bun` shebang plus the exec bit. Windows has neither. So on a fresh native install, **no hook fires at all** — security pipeline, memory writes, context loading, every Bash/Write/Edit/Read hook is dead. Nothing else in the system is even observable until this is fixed.

A second trap compounds it: `PAI-Install/engine/validate.ts` smoke-tests hooks by spawning them through `process.execPath` (the bun binary directly), which succeeds — while Claude Code on Windows launches hooks via the bare command string, which fails. The installer can report a green install on a machine where every hook silently fails to launch. (Verified live 2026-06-30: `validate.ts:60` does call `spawnSync(process.execPath, [hookPath])`.)

The remaining ~70 files share three mechanical patterns (HOME with no fallback, hardcoded `/tmp`, Unix-only binary spawns) that the audit already documents. Those matter, but they are fixable in blast-radius order once hooks run. **Verified live 2026-06-30:** this category is *not* yet swept in the live tree either — 33 files still use throwing `process.env.HOME!`, 26 use `\|\| ""`/`?? ""`, and `/tmp` literals persist in `ConfigAudit.hook.ts:45`, `lib/notifications.ts:15`, and `TaskGovernance.hook.ts:48`.

## Plan: four steps, front-loaded

### Step 1 — The unlock ✅ DONE (2026-07-01)

Everything a Windows user needs to get productive lands in this step. The rest is invisible until it does.

> **Shipped 2026-07-01** (uncommitted, scoped to `Releases/v5.0.0/.claude/` + repo-root `Tools/`). All four sub-tasks landed; 38/38 ISCs verified. ISA: `~/.claude/PAI/MEMORY/WORK/windows-step1-unlock/ISA.md`.
>
> **Key divergence from the original plan:** sub-task 1 is **not** a verbatim back-port of the live tree's `"$HOME/.bun/bin/bun.exe"` prefix. Alex confirmed the release must stay installable on **macOS, Linux, and Windows** (not personal-only), and that absolute `.exe` path would kill every hook on Unix. Instead the **installer rewrites hook interpreter prefixes per-OS** at config-generation time — an extension-driven (`.ts`/`.js`→bun, `.sh`→bash), allowlist-gated (from the pristine *bundle* template, so a user's custom hooks are never touched on re-install), Windows-add-only + Unix-byte-identical-no-op, idempotent normalization. See `PAI/PAI-Install/engine/actions.ts` (`normalizeHookCommand` / `normalizePaiHookCommands` / `collectTemplateHookAllowlist`), fixture `actions.normalize.test.ts` (23 tests green).
>
> **Bugs caught during execution that a green test suite missed** (recorded so the method carries forward): the audit's "no `.sh` in live hooks" claim was false (corrected in the audit); a cross-family producer left a double-prefix allowlist bug + a duplicate import; the commitment-boundary advisor caught a live user-hook-normalization bug on the re-install path plus two false-completions (a backwards parse-check and an un-enforcing lint). All fixed and re-verified.

1. **Hook interpreter prefixes.** ✅ **DONE — installer per-OS rewrite (not a verbatim back-port).** The release `settings.json` keeps its bare `*.hook.ts` commands; the installer normalizes each PAI hook's interpreter per-OS when it generates `settings.json` (`actions.ts` `normalizePaiHookCommands`). On Windows a `"$HOME/.bun/bin/bun.exe"` prefix is added (bash for `.sh`); on macOS/Linux it is a byte-identical no-op (shebang + exec-bit still work). The `.sh` entries: `ContextReduction.hook.sh` gets a `bash` prefix when bash resolves, else is dropped on Windows (it self-guards as a pure optimization); the statusline `.sh` is normalized the same way. *Correction to the original note:* the live `hooks/` **does** contain `.sh` files (`ContextReduction.hook.sh` + 3 GSD `.sh`) — the audit's "no `.sh` in live hooks" claim was wrong and has been corrected there.
2. **One shared portable helper.** ✅ **DONE.** Created `hooks/lib/portable.ts` exporting `home()` (`process.env.HOME ?? process.env.USERPROFILE ?? os.homedir()`) and `tmp()` (`os.tmpdir()`), generalizing the inline pattern from `algorithm.ts:58` / `pulse.ts:24` / `ComposeAgent.ts:37` (explicitly not `hooks/lib/paths.ts`). Verified `home()` returns non-empty even with HOME+USERPROFILE unset.
3. **Startup-critical sweep only.** ✅ **DONE — 9 files.** Routed off bare `process.env.HOME!`/`/tmp`: `hooks/lib/{identity,observability-transport,notifications}.ts`, `hooks/{PromptProcessing,SatisfactionCapture,WorkCompletionLearning,SessionCleanup,ConfigAudit,TaskGovernance}.hook.ts`. All parse-clean. Long tail (skills, recon, art, banners — 434 offenders across the tree incl. `Packs/Utilities/` + `Packs/Media/` duplicates) deferred to Step 3, guarded by the lint below.
4. **Lint rule that errors — lands alongside the sweep.** ✅ **DONE — `Tools/lint-portable-paths.ts` (whole-tree).** Errors (exit 1) on bare `process.env.HOME` and `/tmp` literals across the whole tree including both Packs duplicates. Runs in **baseline mode** by default: the 434 pre-existing offenders are recorded in `Tools/.portable-paths-baseline.json` and it fails only on *new* offenses — proven to catch a synthetic new offender while passing the baselined tail. `--strict` shows the full tail. **Step 3 dependency:** as Step 3 clears the tail, re-run `--update-baseline`; when the tree hits zero, delete the baseline file (or wire `--strict` into CI) to flip it to zero-tolerance.

Why these four together: items 1-3 are the minimum that makes the system run; item 4 is the cheap insurance that stops the deferred work from rotting before Step 3 lands.

### Step 2 — Verify on real Windows (same or next day)

1. **Launch-parity smoke test.** Replace `validate.ts`'s false green with a test that spawns each hook via `cmd.exe /c` using the *exact* bare command string from `settings.json`, then asserts the hook fires and writes to the expected path. This is the real invocation path, not `process.execPath`. Roughly 80% of the proof in an afternoon.
2. **Run it once, manually, on a real Windows box.** Automated CI adoption comes later (Step 4); one manual run now gives the confidence without the infrastructure yak-shave.
3. **Scope the claim honestly.** After Step 2 passes, the true statement is: "verified on the live Windows install; release-artifact regeneration pending." It is **not** yet "Windows supported" — that label waits for Step 4.

### Step 3 — Skills sweep and graceful degradation

1. **Finish the HOME sweep** across the remaining files the lint rule now flags.
2. **Per-tool binary decisions:**
   - `Prompting/Tools/RenderTemplate.ts` — `Bun.spawnSync(['ls', dir])` → `fs.readdirSync`. Trivial, do first.
   - `which` / `command -v` gates → `where` or a PATH probe (`Webdesign/Tools/*`, `AudioEditor/Tools/Transcribe.ts`, `hooks/lib/tab-setter.ts`).
   - Heavy external binaries (whisper, ffmpeg, magick, interceptor, GNU `timeout`) → **graceful-degrade with a visible console warning**. Never silent. A silent audio or transcription failure makes the system look broken with no explanation; a one-line warning tells the user exactly what's missing.
3. **Back-port `voice.ts`.** Bring the live tree's Piper TTS + `play-mp3.ps1`/`play-wav.ps1` + Windows notification branch into the release. **Verified live 2026-06-30:** the live `voice.ts` already has a real `win32` branch (`powershell.exe -File play-mp3.ps1`/`play-wav.ps1`), the Piper provider, `tmpdir()` instead of `/tmp`, and an `osascript` notification that early-returns off-darwin — suitable as-is, so this is a clean back-port. ElevenLabs TTS is already portable `fetch`; only local playback and the `osascript` notification were broken in the release.

### Step 4 — Structural drift fix (fast-follow: scheduled, owned, dated)

This is the one real strategic decision left, and it is the council's only point of dissent (see below).

1. **Generate the release from the canonical tree.** A documented build step (e.g. `scripts/build-release.ts`) with a single entry point and no hand-copying. The live-vs-release drift the audit calls out — fixes the field report declares done but that never reach the snapshot — is a *structural* guarantee of a hand-maintained snapshot, not a discipline failure. A build step is the only durable fix.
2. **Collapse the duplicate Packs.** Fold `Packs/Utilities/` and `Packs/Media/` duplicate copies back to a single source in the same pipeline pass. Same un-DRY-source bug class.
3. **Add a `windows-latest` CI job** running the Step 2 smoke test, once it's proven manually.

Gate the public **"Windows supported"** label on Step 4 — not on the first productive install.

## The one decision Alex owns

All four council members agree the drift is real and the build-from-canonical-tree step is the correct fix. They disagree only on *when*:

- **Reese / Hale (pragmatists):** Step 4 is next-sprint fast-follow. Gating the first productive install on a week of release-pipeline infrastructure stalls momentum for zero user benefit — the live tree already works.
- **Vance / Quill (skeptics):** A hand-maintained snapshot gets *worse* with time, not better. The build step belongs in initial scope, and the risk of "fast-follow" is that "release verification pending" quietly becomes permanent.

The resolution both sides accept: don't gate the *first install* on Step 4, but **commit a date and an owner** for it, and don't apply the "supported" label until it ships. The lint rule (Step 1) running across the whole tree is what makes that deferral safe rather than negligent.

## Sequencing rationale

The cheapest high-coverage path, in order:

1. Hook prefixes + HOME/tmpdir helper + lint rule — clears the bulk of the BLOCKER/MAJOR count with near-zero behavioral risk, and is the only thing that makes the system observable at all.
2. Smoke test — proves it, honestly scoped.
3. Skills and binaries — per-tool availability calls, graceful-degrade with warnings.
4. Build-from-canonical-tree + Packs collapse — the structural fix that stops the debt recurring.

Step 1 is the whole game for getting a Windows user productive. Everything after it is either invisible until it lands or insurance against regression.
