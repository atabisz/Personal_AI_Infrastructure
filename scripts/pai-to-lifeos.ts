#!/usr/bin/env bun
/**
 * pai-to-lifeos — the INVERSE of scripts/lifeos-normalize.ts. Where normalize
 * rewrites a public LIFEOS release back to the maintainer's PAI/-shaped live tree,
 * this rewrites the fork's install PAYLOAD from the legacy PAI identity to the
 * public LIFEOS identity, mirroring upstream danielmiessler/LifeOS.
 *
 * SCOPE (hard): LifeOS/install/** ONLY. The repo-root scripts/ + Tools/ and the
 * live ~/.claude tree DELIBERATELY stay PAI-shaped — they read the live tree as
 * the build SOURCE (build-release.ts:PAI_DIR ?? ~/.claude; upstream-sync.ts header).
 * Renaming those would break the live→release pipeline. This tool never touches them.
 *
 * WHY THIS IS NOT A GLOBAL sed (same lesson normalize learned, in reverse): the
 * token `PAI`/`Pai`/`LifeOS` appears in roles that must be PRESERVED —
 *   1. PATH / ENV / SYMBOL (rewrite) — `PAI/…`, `PAI_*` env, quoted `'LifeOS'`
 *      dir segments, and the payload symbols PaiConfig/UpdatePaiState/PaiUpgrade/
 *      paiUserDir. These are runtime filesystem + code constants.
 *   2. SERVICE / ASSET (keep) — `com.pai.*` plist ids, `pai-logo`/`pai-icon`
 *      kebab asset ids. Renaming breaks service names / asset references.
 *   3. SUBSTRING (keep) — `Pairwise`, `repair`, `impair`, `paint`… `\bPai`/`\bPAI`
 *      word boundaries guard these, and the preserve-list is a second net.
 *   4. BRAND PROSE (flag, don't rewrite) — a bare "PAI" naming the old project in
 *      a historical doc/changelog. Emitted as a FLAG for human review.
 *
 * DOCTRINE: transform only the UNAMBIGUOUS role-1 tokens. Everything else is
 * PRESERVED (silently) or FLAGGED (for review). A silent wrong rename is worse
 * than a flag. Pure + deterministic. `--self-test` proves it.
 *
 * MODES (mirror lifeos-normalize + build-release conventions):
 *   (default file arg)  print transformed content to stdout, flags to stderr. READ-ONLY.
 *   --self-test         run the fixture suite; exit nonzero on any miss.
 *   --apply <glob>      rewrite files IN PLACE under LifeOS/install/** (only). Guarded.
 *   --help
 */

export type Flag = {
  line: number;
  col: number;
  token: string;
  reason: string;
  context: string;
};

export type TransformResult = {
  text: string;
  rewrites: number;
  flags: Flag[];
};

/**
 * Ordered rewrite rules — the inverse of lifeos-normalize's REWRITE_RULES, plus the
 * payload symbol renames. Order matters: longest / most-specific first so a broad
 * rule never eats a token a specific rule should own. Case-SENSITIVE by construction.
 */
type Rule = { re: RegExp; replace: string; label: string };

const REWRITE_RULES: Rule[] = [
  // Env var + system-prompt filename: specific compound tokens first so the generic
  // PAI_ prefix rule below doesn't split them.
  { re: /\bPAI_SYSTEM_PROMPT\b/g, replace: "LIFEOS_SYSTEM_PROMPT", label: "system-prompt token/filename" },
  { re: /\bPAI_CONFIG_DIR\b/g, replace: "LIFEOS_CONFIG_DIR", label: "env: config dir" },
  { re: /\bPAI_CONFIG\b/g, replace: "LIFEOS_CONFIG", label: "env: config" },
  { re: /\bPAI_RELEASES\b/g, replace: "LIFEOS_RELEASES", label: "env: releases" },
  { re: /\bPAI_DIR\b/g, replace: "LIFEOS_DIR", label: "env: dir" },
  // Any remaining ALL-CAPS PAI_<WORD> env var -> LIFEOS_<WORD>.
  { re: /\bPAI_([A-Z][A-Z0-9_]*)/g, replace: "LIFEOS_$1", label: "env: generic PAI_ prefix" },
  // Path token: `PAI/` or `/PAI/` inside a doc-relative or absolute ref.
  { re: /\bPAI\//g, replace: "LIFEOS/", label: "path: PAI/ segment" },
  // Quoted path-array segment in join()/path calls: 'LifeOS' or "LifeOS" — the
  // mixed-case legacy dir literal -> "LIFEOS". Only inside quotes, so brand prose is untouched.
  { re: /(['"])LifeOS\1/g, replace: "$1LIFEOS$1", label: "path: quoted 'LifeOS' dir segment" },
  // Payload symbol renames (the framework is now Lifeos, not Pai). Word-bounded.
  { re: /\bloadPaiConfig\b/g, replace: "loadLifeosConfig", label: "symbol: loadPaiConfig" },
  { re: /\bclearPaiConfigCache\b/g, replace: "clearLifeosConfigCache", label: "symbol: clearPaiConfigCache" },
  { re: /\bPaiConfig\b/g, replace: "LifeosConfig", label: "symbol: PaiConfig" },
  { re: /\bUpdatePaiState\b/g, replace: "UpdateLifeosState", label: "symbol: UpdatePaiState" },
  { re: /\bGeneratePaiState\b/g, replace: "GenerateLifeosState", label: "symbol: GeneratePaiState" },
  { re: /\bPaiUpgrade\b/g, replace: "LifeosUpgrade", label: "symbol: PaiUpgrade" },
  { re: /\bpaiUserDir\b/g, replace: "lifeosUserDir", label: "symbol: paiUserDir" },
  // ── Class 2 + Class 5 code identifiers (NEW). Each rename is VERIFIED against
  // origin's live install/LIFEOS content — upstream renamed these exact tokens.
  // Order: longest/derivative-first so a base name doesn't eat a suffix.
  // getPaiDir -> getLifeosDir (hooks/lib/paths.ts:43). NOTE paiPath() is KEPT by upstream (see PRESERVE).
  { re: /\bgetPaiDir\b/g, replace: "getLifeosDir", label: "symbol: getPaiDir" },
  { re: /\bbuildPaiContextBlock\b/g, replace: "buildLifeosContextBlock", label: "symbol: buildPaiContextBlock" },
  // PAIAgentAdapter (+Options derivative first)
  { re: /\bPAIAgentAdapterOptions\b/g, replace: "LifeosAgentAdapterOptions", label: "symbol: PAIAgentAdapterOptions" },
  { re: /\bPAIAgentAdapter\b/g, replace: "LifeosAgentAdapter", label: "symbol: PAIAgentAdapter" },
  // PAIEvent family (Row/Events derivatives first, then the hook, then the base type)
  { re: /\bPAIEventRow\b/g, replace: "LifeosEventRow", label: "symbol: PAIEventRow" },
  { re: /\busePAIEvents\b/g, replace: "useLifeosEvents", label: "symbol: usePAIEvents" },
  { re: /\bPAIEvents\b/g, replace: "LifeosEvents", label: "symbol: PAIEvents" },
  { re: /\bPAIEvent\b/g, replace: "LifeosEvent", label: "symbol: PAIEvent" },
  // Pai* interfaces / React identifiers (derivatives first)
  { re: /\bPaiLogoProps\b/g, replace: "LifeosLogoProps", label: "symbol: PaiLogoProps" },
  { re: /\bPaiLogo\b/g, replace: "LifeosLogo", label: "symbol: PaiLogo" },
  { re: /\bPaiPageInner\b/g, replace: "LifeosPageInner", label: "symbol: PaiPageInner" },
  { re: /\bPaiPage\b/g, replace: "LifeosPage", label: "symbol: PaiPage" },
  { re: /\bPaiLayout\b/g, replace: "LifeosLayout", label: "symbol: PaiLayout" },
  { re: /\bPaiPrincipal\b/g, replace: "LifeosPrincipal", label: "symbol: PaiPrincipal" },
  { re: /\bPaiVoiceSettings\b/g, replace: "LifeosVoiceSettings", label: "symbol: PaiVoiceSettings" },
  { re: /\bPaiIntegrations\b/g, replace: "LifeosIntegrations", label: "symbol: PaiIntegrations" },
  { re: /\bPaiPaths\b/g, replace: "LifeosPaths", label: "symbol: PaiPaths" },
  { re: /\bPaiState\b/g, replace: "LifeosState", label: "symbol: PaiState" },
  { re: /\bPaiDa\b/g, replace: "LifeosDa", label: "symbol: PaiDa" },
  // PAIConfig (all-caps variant, distinct from PaiConfig above)
  { re: /\bPAIConfig\b/g, replace: "LifeosConfig", label: "symbol: PAIConfig" },
];

/**
 * Occurrences we deliberately PRESERVE — matching one of these near a residual PAI
 * token suppresses the flag (it is an intentional keep, not a miss).
 */
const PRESERVE_RES: { re: RegExp; why: string }[] = [
  { re: /com\.pai\./, why: "service/plist id (com.pai.*) — must not rename" },
  { re: /pai-[a-z0-9-]/, why: "asset/kebab id (pai-logo, pai-icon) — must not rename" },
  // Substrings where 'pai'/'PAI' is not the project token.
  { re: /Pairwise|pairwise|repair|impair|despair|paint|Sinai|campaign/, why: "substring — not the PAI token" },
  // Code identifiers upstream KEPT (verified live in origin install/LIFEOS) — must NOT rename.
  { re: /\bpaiPath\b/, why: "kept by upstream (hooks/lib/paths.ts exports paiPath)" },
  { re: /PAIColors|PAITheme|PAITypography|PAIAnimation/, why: "kept by upstream (Remotion Theme.ts constants)" },
  { re: /PAISYSTEMARCHITECTURE|PAISystemArchitecture|PAISECURITYSYSTEM|PAISYSTEMUPDATES|PAIAGENTSYSTEM|PAIMM/, why: "kept by upstream (doc heading/anchor constants)" },
  { re: /PAIIntegrityCheck/, why: "kept by upstream (doc/hook constant)" },
];

/**
 * After rewrites, any surviving standalone PAI/Pai token is ambiguous → flag for
 * human review. Word-bounded so it doesn't fire on Pairwise/repair/etc.
 */
const RESIDUAL_RE = /\bPAI\b|\bPai\b|\bpai\b/g;

export function paiToLifeos(text: string): TransformResult {
  let rewrites = 0;
  let out = text;
  for (const rule of REWRITE_RULES) {
    out = out.replace(rule.re, (...m) => {
      rewrites += 1;
      const groups = m.slice(1, -2); // drop full-match head and (offset, whole) tail
      return rule.replace.replace(/\$(\d)/g, (_s, d) => groups[Number(d) - 1] ?? "");
    });
  }
  // Flag residual PAI/Pai tokens for human review, line/col located, preserve-list suppressed.
  const flags: Flag[] = [];
  const lines = out.split("\n");
  lines.forEach((lineText, i) => {
    let match: RegExpExecArray | null;
    RESIDUAL_RE.lastIndex = 0;
    while ((match = RESIDUAL_RE.exec(lineText)) !== null) {
      const token = match[0];
      const around = lineText.slice(Math.max(0, match.index - 14), match.index + token.length + 14);
      const preserved = PRESERVE_RES.find((p) => p.re.test(around));
      if (preserved) continue; // intentional keep — not a flag
      flags.push({
        line: i + 1,
        col: match.index + 1,
        token,
        reason: "residual PAI token after rewrite — brand prose (keep) OR a missed path/symbol (rewrite): review manually",
        context: lineText.trim().slice(0, 120),
      });
    }
  });
  return { text: out, rewrites, flags };
}

// ── Self-test ────────────────────────────────────────────────────────────────
function runSelfTest(): number {
  type Case = { name: string; in: string; wantText: string; wantRewrites: number; wantFlags: number };
  const cases: Case[] = [
    {
      name: "env var PAI_DIR -> LIFEOS_DIR",
      in: "const d = process.env.PAI_DIR",
      wantText: "const d = process.env.LIFEOS_DIR",
      wantRewrites: 1,
      wantFlags: 0,
    },
    {
      name: "system prompt filename",
      in: "load PAI_SYSTEM_PROMPT.md",
      wantText: "load LIFEOS_SYSTEM_PROMPT.md",
      wantRewrites: 1,
      wantFlags: 0,
    },
    {
      name: "generic PAI_ prefix env",
      in: "PAI_STATE=1",
      wantText: "LIFEOS_STATE=1",
      wantRewrites: 1,
      wantFlags: 0,
    },
    {
      name: "config compound not split by generic rule",
      in: "process.env.PAI_CONFIG_DIR",
      wantText: "process.env.LIFEOS_CONFIG_DIR",
      wantRewrites: 1,
      wantFlags: 0,
    },
    {
      name: "path PAI/ segment",
      in: "see `PAI/DOCUMENTATION/Foo.md`",
      wantText: "see `LIFEOS/DOCUMENTATION/Foo.md`",
      wantRewrites: 1,
      wantFlags: 0,
    },
    {
      name: "quoted LifeOS dir segment in join()",
      in: "join(HOME, '.claude', 'LifeOS', 'MEMORY')",
      wantText: "join(HOME, '.claude', 'LIFEOS', 'MEMORY')",
      wantRewrites: 1,
      wantFlags: 0,
    },
    {
      name: "symbol PaiConfig -> LifeosConfig",
      in: 'import { loadPaiConfig } from "./PaiConfig"',
      wantText: 'import { loadLifeosConfig } from "./LifeosConfig"',
      wantRewrites: 2,
      wantFlags: 0,
    },
    {
      name: "symbol UpdatePaiState + paiUserDir",
      in: "UpdatePaiState reads paiUserDir()",
      wantText: "UpdateLifeosState reads lifeosUserDir()",
      wantRewrites: 2,
      wantFlags: 0,
    },
    {
      name: "clearPaiConfigCache not eaten by generic PaiConfig rule",
      in: "export function clearPaiConfigCache()",
      wantText: "export function clearLifeosConfigCache()",
      wantRewrites: 1,
      wantFlags: 0,
    },
    {
      name: "class2/5: PAIEvent family + hook renamed",
      in: "import { usePAIEvents, type PAIEvent } from '@/hooks/useLifeosEvents'",
      wantText: "import { useLifeosEvents, type LifeosEvent } from '@/hooks/useLifeosEvents'",
      wantRewrites: 2,
      wantFlags: 0,
    },
    {
      name: "class2/5: PAIEventRow derivative before base",
      in: "function PAIEventRow({ event }: { event: PAIEvent })",
      wantText: "function LifeosEventRow({ event }: { event: LifeosEvent })",
      wantRewrites: 2,
      wantFlags: 0,
    },
    {
      name: "class5: getPaiDir renamed, paiPath KEPT",
      in: "import { getPaiDir, paiPath } from './paths'",
      wantText: "import { getLifeosDir, paiPath } from './paths'",
      wantRewrites: 1,
      wantFlags: 0,
    },
    {
      name: "class5: Pai interfaces renamed",
      in: "interface PaiPrincipal {} interface PaiVoiceSettings {}",
      wantText: "interface LifeosPrincipal {} interface LifeosVoiceSettings {}",
      wantRewrites: 2,
      wantFlags: 0,
    },
    {
      name: "keep: PAITheme/PAIColors NOT renamed, no flag",
      in: "import { PAITheme, PAIColors } from './Theme'",
      wantText: "import { PAITheme, PAIColors } from './Theme'",
      wantRewrites: 0,
      wantFlags: 0,
    },
    {
      name: "keep: PAISYSTEMARCHITECTURE doc constant NOT renamed, no flag",
      in: "const wiki = PAISYSTEMARCHITECTURE",
      wantText: "const wiki = PAISYSTEMARCHITECTURE",
      wantRewrites: 0,
      wantFlags: 0,
    },
    {
      name: "keep: PAIAgentAdapter IS renamed (class 5), but PAIAGENTSYSTEM doc constant kept",
      in: "PAIAgentAdapter uses PAIAGENTSYSTEM",
      wantText: "LifeosAgentAdapter uses PAIAGENTSYSTEM",
      wantRewrites: 1,
      wantFlags: 0,
    },
    {
      name: "service id com.pai.* preserved, no flag",
      in: "label com.pai.pulse plist",
      wantText: "label com.pai.pulse plist",
      wantRewrites: 0,
      wantFlags: 0,
    },
    {
      name: "asset id pai-logo preserved, no flag",
      in: 'img src="pai-logo.svg"',
      wantText: 'img src="pai-logo.svg"',
      wantRewrites: 0,
      wantFlags: 0,
    },
    {
      name: "substring Pairwise NOT rewritten, no flag",
      in: "import { PairwiseComparison } from './Pairwise'",
      wantText: "import { PairwiseComparison } from './Pairwise'",
      wantRewrites: 0,
      wantFlags: 0,
    },
    {
      name: "substring repair NOT touched",
      in: "self-repair loop",
      wantText: "self-repair loop",
      wantRewrites: 0,
      wantFlags: 0,
    },
    {
      name: "brand prose bare PAI flagged, not rewritten",
      in: "PAI is the Personal AI Infrastructure.",
      wantText: "PAI is the Personal AI Infrastructure.",
      wantRewrites: 0,
      wantFlags: 1,
    },
    {
      name: "LifeOS brand prose (unquoted) NOT rewritten by quoted rule, no PAI flag",
      in: "LifeOS is the Life Operating System.",
      wantText: "LifeOS is the Life Operating System.",
      wantRewrites: 0,
      wantFlags: 0,
    },
    {
      name: "absolute .claude/PAI path",
      in: "~/.claude/PAI/TOOLS/Foo.ts",
      wantText: "~/.claude/LIFEOS/TOOLS/Foo.ts",
      wantRewrites: 1,
      wantFlags: 0,
    },
  ];
  let pass = 0;
  for (const c of cases) {
    const r = paiToLifeos(c.in);
    const ok = r.text === c.wantText && r.rewrites === c.wantRewrites && r.flags.length === c.wantFlags;
    if (ok) {
      pass += 1;
    } else {
      console.error(`FAIL ${c.name}`);
      console.error(`  in:    ${JSON.stringify(c.in)}`);
      console.error(`  want:  text=${JSON.stringify(c.wantText)} rewrites=${c.wantRewrites} flags=${c.wantFlags}`);
      console.error(`  got:   text=${JSON.stringify(r.text)} rewrites=${r.rewrites} flags=${r.flags.length}`);
    }
  }
  console.log(`${pass}/${cases.length} passed`);
  return pass === cases.length ? 0 : 1;
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  if (a.includes("--help")) {
    console.log("usage: bun scripts/pai-to-lifeos.ts <file>            # print transformed content, READ-ONLY");
    console.log("       bun scripts/pai-to-lifeos.ts --apply <file...> # rewrite in place (LifeOS/install/** only)");
    console.log("       bun scripts/pai-to-lifeos.ts --self-test");
    process.exit(0);
  }
  if (a.includes("--self-test")) {
    process.exit(runSelfTest());
  }
  const { readFileSync, writeFileSync } = await import("node:fs");
  const path = await import("node:path");
  const apply = a.includes("--apply");
  const files = a.filter((x) => !x.startsWith("--"));
  if (files.length === 0) {
    console.error("usage: bun scripts/pai-to-lifeos.ts <file> | --apply <file...> | --self-test");
    process.exit(2);
  }
  // Hard scope guard: --apply only inside LifeOS/install/**.
  if (apply) {
    for (const f of files) {
      const norm = path.resolve(f).replace(/\\/g, "/");
      if (!norm.includes("/LifeOS/install/")) {
        console.error(`REFUSING --apply outside LifeOS/install/: ${f}`);
        process.exit(3);
      }
    }
  }
  let totalRewrites = 0;
  let totalFlags = 0;
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const r = paiToLifeos(src);
    totalRewrites += r.rewrites;
    totalFlags += r.flags.length;
    if (apply) {
      if (r.rewrites > 0) writeFileSync(file, r.text);
      for (const f of r.flags) console.error(`FLAG ${file}:${f.line}:${f.col} "${f.token}" — ${f.reason}`);
    } else {
      process.stdout.write(r.text);
      for (const f of r.flags) console.error(`FLAG ${file}:${f.line}:${f.col} "${f.token}" — ${f.reason}`);
      console.error(`[${file}] rewrites=${r.rewrites} flags=${r.flags.length}`);
    }
  }
  if (apply) console.error(`[apply] ${files.length} files, rewrites=${totalRewrites}, flags=${totalFlags}`);
}
