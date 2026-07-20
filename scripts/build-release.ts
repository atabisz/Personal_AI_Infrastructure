#!/usr/bin/env bun
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { normalize as normalizeTokens } from "./lifeos-normalize";

type Args = { apply: boolean; only?: string; release?: string; prune: boolean; selfTest: boolean; help: boolean };
type Action = "add" | "change" | "unchanged";
type Entry = { relPath: string; srcAbs: string; destAbs: string; action: Action; bytes: Buffer };
type ScanResult = { hit: boolean; pattern?: string };

// SOURCE shape is the live tree, which was renamed PAI/ -> LIFEOS/ (framework
// root) while the public RELEASE stays PAI/-shaped. So the allowlist walks the
// LIFEOS/-shaped SOURCE; toDestRel() below remaps each path to the PAI/-shaped
// DEST, and normalize() (lifeos-normalize.ts) rewrites LIFEOS->PAI tokens inside
// file CONTENT. The non-framework top-level dirs (hooks/skills/commands/agents)
// and root files (settings.json/CLAUDE.md) were never renamed, so they map 1:1.
const ALLOW_DIRS = [
  "hooks/",
  "LIFEOS/PULSE/",
  "LIFEOS/TOOLS/",
  "LIFEOS/ALGORITHM/",
  "LIFEOS/DOCUMENTATION/",
  "LIFEOS/PAI-Install/",
  "skills/",
  "commands/",
  "agents/",
];
const ALLOW_FILES = new Set(["settings.json", "CLAUDE.md", "LIFEOS/LIFEOS_SYSTEM_PROMPT.md"]);
const KNOWN_BINARY_EXTS = new Set([
  ".mp3",
  ".wav",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".pdf",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".onnx",
  ".bin",
  ".zip",
  ".gz",
]);
const USERNAME = path.basename(os.homedir());
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function usage(): string {
  return [
    "Usage: bun scripts/build-release.ts [--apply] [--only <subpath>] [--release <path>] [--prune] [--self-test] [--help]",
    "Default mode is DRY-RUN and writes nothing.",
  ].join("\n");
}

function fail(message: string): never {
  throw new Error(message);
}

function normalizeRel(input: string, flagName: string): string {
  if (!input.trim()) fail(`${flagName} requires a non-empty relative path.\n${usage()}`);
  if (path.isAbsolute(input)) fail(`${flagName} must be relative to .claude.\n${usage()}`);
  const normalized = path.posix.normalize(input.replace(/\\/g, "/").replace(/^\.\//, ""));
  if (normalized === "." || normalized === "") fail(`${flagName} requires a non-empty relative path.\n${usage()}`);
  if (normalized === ".." || normalized.startsWith("../")) fail(`${flagName} cannot escape .claude.\n${usage()}`);
  return normalized.replace(/\/+$/, "");
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, prune: false, selfTest: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--prune") args.prune = true;
    else if (arg === "--self-test") args.selfTest = true;
    else if (arg === "--help") args.help = true;
    else if (arg === "--only") {
      const value = argv[i + 1];
      if (!value) fail(`Missing value for --only.\n${usage()}`);
      args.only = normalizeRel(value, "--only");
      i += 1;
    } else if (arg === "--release") {
      const value = argv[i + 1];
      if (!value) fail(`Missing value for --release.\n${usage()}`);
      args.release = path.resolve(value);
      i += 1;
    } else {
      fail(`Unknown argument: ${arg}\n${usage()}`);
    }
  }
  return args;
}

function relWithin(relPath: string, scope?: string): boolean {
  return !scope || relPath === scope || relPath.startsWith(`${scope}/`);
}

function scopesIntersect(left: string, right?: string): boolean {
  return !right || relWithin(left, right) || relWithin(right, left);
}

function isAllowed(relPath: string): boolean {
  if (ALLOW_FILES.has(relPath)) return true;
  return ALLOW_DIRS.some((prefix) => relPath.startsWith(prefix));
}

function isDenied(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  const base = path.posix.basename(lower);
  const segments = lower.split("/");
  // SOURCE is LIFEOS/-shaped: the private zones are LIFEOS/USER and LIFEOS/MEMORY.
  if (lower === "lifeos/user" || lower.startsWith("lifeos/user/")) return true;
  if (lower === "lifeos/memory" || lower.startsWith("lifeos/memory/")) return true;
  if (base === "settings.local.json" || base === ".checkpoint-state.json") return true;
  if (base === ".env" || base.startsWith(".env") || base.endsWith(".env")) return true;
  if (base.endsWith(".key") || base.endsWith(".pem")) return true;
  if (base.includes("secret") || base.includes("credential")) return true;
  return segments.some((segment) =>
    // `.cursor` = IDE-only rule dirs. They carry symlinks (rules/*.mdc -> ../../CLAUDE.md)
    // that `cp -r` cannot recreate on unprivileged Windows, breaking both the windows-latest
    // CI staging step and a real Windows install. A cross-platform release must be symlink-free.
    // (build-bundles.ts already excludes .cursor for the same reason.)
    [".git", "node_modules", "projects", "test-results", "pai_updates", "pai_backups", ".pai-sync-history", ".cursor"].includes(segment),
  );
}

// A walk "view" — the allow/deny shape for a given tree. The SOURCE view is
// LIFEOS-shaped (above); the DEST view is the same allowlist mapped through
// toDestRel() to PAI-shape, so prune can walk the PAI-shaped release with the
// same guards. isDenied's non-framework rules (.env/.key/settings.local/…) are
// shape-independent, so only the LIFEOS/USER|MEMORY private-zone check is remapped.
type AllowView = {
  dirs: string[];
  files: Set<string>;
  isAllowed: (relPath: string) => boolean;
  isDenied: (relPath: string) => boolean;
};

const SOURCE_VIEW: AllowView = { dirs: ALLOW_DIRS, files: ALLOW_FILES, isAllowed, isDenied };

const DEST_VIEW: AllowView = (() => {
  const dirs = ALLOW_DIRS.map((d) => toDestRel(d.slice(0, -1)) + "/");
  const files = new Set([...ALLOW_FILES].map(toDestRel));
  const isAllowedDest = (relPath: string): boolean =>
    files.has(relPath) || dirs.some((prefix) => relPath.startsWith(prefix));
  const isDeniedDest = (relPath: string): boolean => {
    const lower = relPath.toLowerCase();
    if (lower === "pai/user" || lower.startsWith("pai/user/")) return true;
    if (lower === "pai/memory" || lower.startsWith("pai/memory/")) return true;
    // Delegate the shape-independent rules (secrets, .env, .cursor, vcs) to isDenied.
    return isDenied(relPath);
  };
  return { dirs, files, isAllowed: isAllowedDest, isDenied: isDeniedDest };
})();

// A directory entry that is a symlink/junction/reparse point is NEVER followed or copied
// (Cato 3): the denylist checks path STRINGS, but readdir/stat FOLLOW links, so an
// allowlisted link pointing into PAI/USER or PAI/MEMORY would leak.
//
// lstat().isSymbolicLink() alone is NOT enough on Windows — directory JUNCTIONS and mount
// points are reparse points that Node reports as plain directories (Cato re-audit finding 3).
// So we ALSO enforce realpath containment: the entry's resolved real target must stay under
// the root's resolved real path. A junction/symlink escaping the tree resolves elsewhere and
// is refused. Unresolvable → refuse. This one check subsumes symlinks, junctions, and `..`.
function isSymlink(abs: string): boolean {
  try { return lstatSync(abs).isSymbolicLink(); } catch { return true; } // unreadable → refuse
}
function escapesRoot(abs: string, root: string): boolean {
  try {
    return !isUnder(realpathSync(abs), realpathSync(root));
  } catch {
    return true; // unresolvable (broken link, race) → refuse, fail-closed
  }
}

// Walk a tree under a given AllowView. SOURCE uses SOURCE_VIEW (LIFEOS-shaped);
// prune walks the DEST under DEST_VIEW (PAI-shaped). Defaults to SOURCE_VIEW so
// existing call sites are unchanged.
function walkAllowlisted(root: string, only?: string, view: AllowView = SOURCE_VIEW): string[] {
  const out = new Set<string>();
  const visit = (dirAbs: string, dirRel: string): void => {
    for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
      const childRel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      const normalized = childRel.replace(/\\/g, "/");
      if (!scopesIntersect(normalized, only)) continue;
      const childAbs = path.join(dirAbs, entry.name);
      // Refuse links AND junctions/reparse points: string-check + realpath containment.
      if (entry.isSymbolicLink() || isSymlink(childAbs) || escapesRoot(childAbs, root)) continue;
      if (entry.isDirectory()) visit(childAbs, normalized);
      else if (entry.isFile()) {
        if (relWithin(normalized, only) && view.isAllowed(normalized) && !view.isDenied(normalized)) out.add(normalized);
      } else {
        // No action: non-file, non-directory entries are intentionally ignored.
      }
    }
  };

  for (const prefix of view.dirs) {
    const relDir = prefix.slice(0, -1);
    if (!scopesIntersect(relDir, only)) continue;
    const absDir = path.join(root, ...relDir.split("/"));
    if (existsSync(absDir) && !isSymlink(absDir) && !escapesRoot(absDir, root) && statSync(absDir).isDirectory()) visit(absDir, relDir);
    else {
      // No action: missing, linked, or out-of-tree allowlisted directories are skipped.
    }
  }
  for (const relFile of view.files) {
    if (!scopesIntersect(relFile, only)) continue;
    const absFile = path.join(root, ...relFile.split("/"));
    if (existsSync(absFile) && !isSymlink(absFile) && !escapesRoot(absFile, root) && statSync(absFile).isFile() && !view.isDenied(relFile)) out.add(relFile);
    else {
      // No action: missing, linked, or out-of-tree allowlisted files are skipped.
    }
  }
  return [...out].sort();
}

// Dest-shape walk for prune (PAI-shaped release tree).
function walkAllowlistedDest(root: string, only?: string): string[] {
  return walkAllowlisted(root, only, DEST_VIEW);
}

function filterGitIgnored(sourceRoot: string, relPaths: string[]): Set<string> {
  if (relPaths.length === 0) return new Set();
  const result = spawnSync("git", ["check-ignore", "--stdin"], {
    cwd: sourceRoot,
    input: relPaths.join("\n"),
    encoding: "utf8",
  });
  if (result.error) return new Set();
  if (result.status === 0 || result.status === 1) {
    const ignored = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/\\/g, "/"))
      .filter(Boolean);
    return new Set(ignored);
  }
  return new Set();
}

function resolveRepoRoot(): string {
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: import.meta.dir, encoding: "utf8" });
  if (git.status === 0 && git.stdout.trim()) return path.resolve(git.stdout.trim());
  return path.dirname(import.meta.dir);
}

function parseVersion(name: string): number[] | null {
  if (!/^v\d+(?:\.\d+)*$/.test(name)) return null;
  return name.slice(1).split(".").map((part) => Number(part));
}

function compareVersionDesc(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const delta = (b[i] ?? 0) - (a[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function resolveDestRoot(repoRoot: string, override?: string): string {
  if (override) return override;
  const releasesRoot = path.join(repoRoot, "Releases");
  if (!existsSync(releasesRoot) || !statSync(releasesRoot).isDirectory()) fail(`No Releases directory found at ${releasesRoot}.`);
  const candidates = readdirSync(releasesRoot)
    .map((name) => ({ name, version: parseVersion(name), abs: path.join(releasesRoot, name, ".claude") }))
    .filter((entry) => entry.version && existsSync(entry.abs) && statSync(entry.abs).isDirectory())
    .sort((left, right) => compareVersionDesc(left.version as number[], right.version as number[]));
  if (candidates.length === 0) fail(`No release .claude directory found under ${releasesRoot}.`);
  return candidates[0].abs;
}

// Containment guard (Cato 5): the destination MUST be a `.claude` dir under
// <repoRoot>/Releases/, and MUST NOT overlap the source tree. Without this, a
// `--release <arbitrary path> --apply --prune` could delete files anywhere — the
// "one-way live→release, never destructive elsewhere" guarantee lived only in comments.
function realOrSelf(p: string): string {
  try { return realpathSync(p); } catch { return path.resolve(p); }
}
function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
function assertDestSafe(repoRoot: string, sourceRoot: string, destRoot: string, prune: boolean): void {
  const releasesRoot = realOrSelf(path.join(repoRoot, "Releases"));
  const dest = realOrSelf(destRoot);
  const src = realOrSelf(sourceRoot);
  if (!isUnder(dest, releasesRoot)) {
    fail(`Refusing: destination ${destRoot} is not under ${releasesRoot}. --release must point inside Releases/.`);
  }
  if (path.basename(dest) !== ".claude") {
    fail(`Refusing: destination ${destRoot} must be a ".claude" directory (got "${path.basename(dest)}").`);
  }
  if (dest === src || isUnder(dest, src) || isUnder(src, dest)) {
    fail(`Refusing: destination and source overlap (dest=${dest}, source=${src}). This must be one-way live→release.`);
  }
  if (prune && !existsSync(path.join(dest, "..", ".."))) {
    fail(`Refusing --prune: destination parent looks wrong (${destRoot}).`);
  }
}

function isKnownBinary(relPath: string): boolean {
  return KNOWN_BINARY_EXTS.has(path.posix.extname(relPath).toLowerCase());
}

function scanBytes(relPath: string, buf: Buffer): ScanResult {
  // FAIL-CLOSED: "can't cleanly decode" must never mean "safe" (Cato 1a). Binary-ext
  // or NUL-containing files are still scanned — as latin1 over the raw bytes, which
  // surfaces any ASCII-range secret/username embedded in a binary or after a stray NUL.
  // A single 0x00 can no longer disable scanning for a whole file.
  const hasNul = buf.includes(0);
  const isBinary = isKnownBinary(relPath) || hasNul;
  let text: string;
  if (isBinary) {
    text = buf.toString("latin1");
    // Cato re-audit 1a: latin1 leaves NULs in place, so an interleaved-NUL UTF-16 file
    // (common on Windows) hides `A\0K\0I\0A...` from every regex. Also scan a NUL-STRIPPED
    // projection so the underlying ASCII run (and username) is contiguous and matchable.
    if (hasNul) text += "\n" + buf.toString("latin1").replace(/\0/g, "");
  } else {
    try {
      text = UTF8.decode(buf);
    } catch {
      // Undecodable-but-not-flagged-binary: still scan as latin1 rather than trust it.
      text = buf.toString("latin1");
    }
  }
  const patterns: Array<[string, RegExp]> = [
    [`username:${USERNAME}`, new RegExp(escapeRegExp(USERNAME), "i")],
    // Real API keys start at a token boundary and are long. A word boundary drops the
    // "task-notification" substring class (…ta|sk-notification…); the 20-char floor drops
    // short standalone words like "sk-notification". Real sk-ant-/sk-proj-/OpenAI keys pass.
    ["sk-token", /\bsk-[A-Za-z0-9_-]{20,}/],
    // Real embedded PEM key: BEGIN marker + ≥40 chars of body + END. A bare
    // "-----BEGIN ... PRIVATE KEY-----" regex/doc mention (no key material) does not match.
    ["private-key", /-----BEGIN[^\n]*PRIVATE KEY-----[\s\S]{40,}?-----END/i],
  ];
  for (const [label, pattern] of patterns) {
    if (pattern.test(text)) return { hit: true, pattern: label };
  }
  // Named-secret assignment: only fire when the QUOTED value looks like a real
  // credential, not env-var-handling code (API_KEY=")) {), a var-name flag
  // (OPENAI_API_KEY_OPTIN), or a placeholder (your_key, sk-ant-...). See looksLikeRealSecret.
  const secretAssign = /(api[_-]?key|secret|password|token)\s*[:=]\s*['"]([^'"]{8,})['"]/gi;
  for (const m of text.matchAll(secretAssign)) {
    if (looksLikeRealSecret(m[2])) return { hit: true, pattern: "named-secret" };
  }
  // HARD-FAIL (Cato 4): a user-home path naming a real person — the current user OR anyone
  // else — is PII and blocks the release. Placeholders (<name>, ${USER}) and a small
  // reviewed set of well-known teaching examples are the only exemptions.
  const pathHit = findRealUserPath(text);
  if (pathHit) return { hit: true, pattern: pathHit };
  return { hit: false };
}

// A quoted assignment value is a real secret only if it has key-like entropy and is
// not an obvious placeholder. Kills the false-positive class: env-var-handling snippets,
// var-name flags (OPENAI_API_KEY_OPTIN), and docs (your_key / <key> / sk-ant-...).
const PLACEHOLDER_VALUE = /^(your|my|the|example|test|dummy|fake|placeholder|xxx+|<|\$\{|%|\.\.\.|changeme|redacted|none|null|env\.)/i;

// NAME-INTENT model (Cato re-audit 1b): the assignment already matched a high-risk NAME
// (password/secret/api_key/token). That name signals intent, so we FAIL CLOSED on the value
// unless it is provably a non-secret. We only clear a value that is: a placeholder, a bare
// env-var-NAME reference, or an obvious code fragment. This catches short (12–15 char),
// low-entropy-by-construction, and all-alpha keys that an entropy floor let through —
// while still passing the real false-positive classes (docs placeholders, env-handling code).
function looksLikeRealSecret(value: string): boolean {
  const v = value.trim();
  if (v.length < 8) return false;                   // too short to be a credential of concern
  if (PLACEHOLDER_VALUE.test(v)) return false;      // your_key, <key>, ${X}, %X%, env.X (prefix-anchored)
  // A known key prefix with a real body is unambiguously a secret — tested FIRST so a real
  // prefixed key is never cleared by a later placeholder heuristic (Forge audit 2026-07-02).
  if (/^(sk|pk|xoxb|xoxp|ghp|gho|AKIA|AIza)[-_]?[A-Za-z0-9]{16,}/.test(v)) return true;
  // A value ENDING in `...` is a redacted doc placeholder (`sk-ant-...`, `sk-...`), never a real
  // contiguous secret: PLACEHOLDER_VALUE only anchors `^\.\.\.`, so an ellipsis-SUFFIXED form
  // fell through and fail-closed to "secret". Anchored to endsWith (not includes) so a diceware
  // passphrase with a mid-value ellipsis is NOT cleared; and placed AFTER the positive prefix
  // test above so a real prefixed key carrying a trailing `...` is still caught first.
  if (v.endsWith("...")) return false;
  // Code fragment, not a literal value: real secret values never contain code punctuation or
  // newlines. Rejects captures like `")) {\n envContent = ...` WITHOUT rejecting space-
  // separated passphrases (a diceware value has spaces but no code punctuation).
  if (/[)(}{;=]|\r|\n|\/\//.test(v)) return false;
  // A bare ENV_VAR_NAME reference (SCREAMING_SNAKE with an underscore, e.g. OPENAI_API_KEY) is
  // a variable name, not its value.
  if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(v)) return false;
  // Survived every non-secret filter under a high-risk name ⇒ treat as a secret (fail-closed).
  return true;
}

// Vetted teaching-example / system home-dir segments allowed through the hard user-path gate.
// Cato re-audit 4: common REAL given names (john, jane, admin) were dropped — they collide
// with real people and would launder actual PII. Kept: the upstream author's documented
// example (`daniel`) and non-personal system/CI account names that are never a private
// individual (root, ubuntu, kali, vagrant, ec2-user, runner). Add here only after review.
const REVIEWED_EXAMPLE_NAMES = new Set([
  "daniel", "kali", "ubuntu", "root", "vagrant", "ec2-user", "runner",
]);

const PLACEHOLDER_SEGMENTS = new Set([
  "user", "users", "username", "you", "yourname", "your-name", "name",
  "home", "me", "someone", "example", "test", "foo", "bar",
]);

// Returns a pattern label if the text contains a user-home path whose first segment
// looks like a real account name (not a template placeholder or generic example).
function findRealUserPath(text: string): string | null {
  // Distinguishing a real home-dir root from the REST-API `/users/` convention turns on TWO
  // signals — casing AND drive-anchoring (Forge cross-family audit 2026-07-02):
  //   • A *drive/UNC/mount-anchored* `users` is a real home root at ANY casing — Windows NTFS is
  //     case-insensitive (`c:\users\carol` ≡ `C:\Users\carol`), and Git-Bash/Cygwin (`/c/users/…`)
  //     and WSL (`/mnt/c/users/…`) serialize the root lowercase. These matchers are case-INSENSITIVE
  //     on `users`, but the drive/server/mount prefix anchors them so no REST path can match (a
  //     REST `/api/users/…` has a multi-char segment, never a bare drive letter, before `users`).
  //   • A *bare* POSIX `/Users/` (macOS, capital) or `/home/` (Linux, lowercase) is a real root; a
  //     bare lowercase `/users/…` is the REST convention (`GET /users/:id`, ffuf `/users/FUZZ`,
  //     `/oauth/users/icon-uri`) — so the bare-POSIX matcher stays case-SENSITIVE to drop those.
  // Net: every real third-party home path (incl. lowercased Windows/WSL/Git-Bash) is still caught;
  // only the bare-lowercase-`/users/` REST false-positive class is dropped.
  const matchers: Array<[string, RegExp]> = [
    ["windows-user-path", /[A-Za-z]:[\\/][Uu]sers[\\/]([^\\/\r\n\t ]+)/g], // c:\users\ ≡ C:\Users\
    ["unc-user-path", /\\\\[^\\/\r\n\t ]+\\[Uu]sers\\([^\\/\r\n\t ]+)/g], // \\server\users\alice
    ["wsl-user-path", /\/(?:mnt\/)?[a-z]\/[Uu]sers\/([^/\r\n\t ]+)/g], // /c/users/ , /mnt/c/users/
    ["unix-user-path", /\/(?:Users|home)\/([^\/\r\n\t ]+)/g], // macOS /Users/ , Linux /home/ (exact case)
  ];
  for (const [label, re] of matchers) {
    for (const m of text.matchAll(re)) {
      // The matcher captures the run up to the next slash/space, but in SOURCE text that run
      // carries surrounding code/prose: a template interpolation (`…/users/me${path}` → `me${path}`),
      // a string delimiter (`/Users/daniel\";` → `daniel\"`), or trailing punctuation from prose
      // (`/Users/daniel,` → `daniel,`). Extract the LEADING path-legal prefix — the longest run of
      // characters a real home-dir username can actually contain: a letter or digit of ANY script
      // (Unicode `\p{L}`/`\p{N}`, so `/home/Иван`, `C:\Users\Ómar`, `/Users/张伟` for real
      // non-Latin-named people are still caught) plus `.`/`_`/`-`. Everything else (`:` `*` `<`
      // `$` `{` `,` `"` …) terminates the name, so a REST route param (`/api/users/:id`), a
      // template (`${USER}`), and trailing prose/code punctuation all collapse to their real
      // prefix — which is empty for a pure-metachar capture (dropped) and the true name otherwise.
      //
      // This is NOT a narrowing: a real name glued to interpolation still flags — `/Users/bob${x}`
      // → prefix `bob` → caught. Only a non-name prefix (`me` endpoint, `${USER}` template) drops.
      // (Forge cross-family audit 2026-07-01: a `/^[<${%:*]/` blocklist checked only seg[0] so a
      // punctuation-cloaked name could slip; an ASCII-only `[A-Za-z0-9._-]` allowlist then dropped
      // non-ASCII usernames. This leading-Unicode-prefix extraction is neither too loose nor too
      // tight, and subsumes both the first-char allowlist and the trailing-punctuation strip.)
      const prefix = m[1].match(/^[\p{L}\p{N}._-]+/u);
      if (!prefix) continue; // capture had no real-name prefix (`:id`, `${USER}`) — not a leak
      const seg = prefix[0];
      const lower = seg.toLowerCase();
      if (PLACEHOLDER_SEGMENTS.has(lower)) continue;
      if (REVIEWED_EXAMPLE_NAMES.has(lower)) continue; // vetted public teaching examples
      return label;
    }
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// SOURCE→DEST relPath remap. The live SOURCE is LIFEOS/-shaped; the public
// RELEASE is PAI/-shaped. The framework-root dir renamed LIFEOS/ -> PAI/ and the
// system-prompt file LIFEOS_SYSTEM_PROMPT.md -> PAI_SYSTEM_PROMPT.md. Every other
// path (hooks/, skills/, settings.json, …) is identical in both shapes. This is
// the PATH complement to lifeos-normalize's CONTENT-token rewrite; the two are
// applied together so a ported file lands at the right path AND resolves inside.
function toDestRel(relPath: string): string {
  if (relPath === "LIFEOS/LIFEOS_SYSTEM_PROMPT.md") return "PAI/PAI_SYSTEM_PROMPT.md";
  if (relPath === "LIFEOS" || relPath.startsWith("LIFEOS/")) return "PAI" + relPath.slice("LIFEOS".length);
  return relPath;
}

// A file is text (content-normalized) unless it's a known-binary extension.
function isTextFile(relPath: string): boolean {
  return !isKnownBinary(relPath);
}

function displayPath(relPath: string, only?: string): string {
  if (!only) return relPath;
  if (relPath === only) return path.posix.basename(relPath);
  if (relPath.startsWith(`${only}/`)) return relPath.slice(only.length + 1);
  return relPath;
}

function decodeForDiff(relPath: string, buf: Buffer | null): string[] | null {
  if (!buf || isKnownBinary(relPath) || buf.includes(0)) return null;
  try {
    return UTF8.decode(buf).split(/\r?\n/);
  } catch {
    return null;
  }
}

function renderDiff(relPath: string, before: Buffer | null, after: Buffer): string[] {
  const right = decodeForDiff(relPath, after);
  if (!right) return ["  diff: binary content skipped"];
  // Add case: no prior dest bytes, so every line of the new file is added.
  if (!before) {
    const added = right.slice(0, 60).map((line) => `  + ${line}`);
    if (right.length > 60) added.push("  diff: truncated");
    return added.length > 0 ? added : ["  diff: empty file"];
  }
  const left = decodeForDiff(relPath, before);
  if (!left) return ["  diff: binary content skipped"];
  if (left.length + right.length > 400 || left.length * right.length > 20000) return ["  diff: omitted for large file"];
  const dp: number[][] = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      i += 1;
      j += 1;
    } else if (j === right.length || (i < left.length && dp[i + 1][j] >= dp[i][j + 1])) {
      lines.push(`  - ${left[i]}`);
      i += 1;
    } else {
      lines.push(`  + ${right[j]}`);
      j += 1;
    }
    if (lines.length >= 60) {
      lines.push("  diff: truncated");
      break;
    }
  }
  return lines.length > 0 ? lines : ["  diff: no line changes"];
}

function stageEntries(sourceRoot: string, destRoot: string, relPaths: string[]): Entry[] {
  return relPaths.map((relPath) => {
    const srcAbs = path.join(sourceRoot, ...relPath.split("/"));
    // relPath is the SOURCE (LIFEOS-shaped) path; the DEST is PAI-shaped.
    const destRel = toDestRel(relPath);
    const destAbs = path.join(destRoot, ...destRel.split("/"));
    const raw = readFileSync(srcAbs);
    // Content-normalize text files (LIFEOS->PAI tokens) so a ported file resolves
    // against the PAI-shaped release; binaries pass through untouched. The scan and
    // the diff both run on these FINAL bytes, so what ships is what is scanned.
    const bytes = isTextFile(relPath) ? Buffer.from(normalizeTokens(raw.toString("utf8")).text, "utf8") : raw;
    let action: Action = "add";
    if (existsSync(destAbs)) {
      if (!statSync(destAbs).isFile()) fail(`Destination path is not a file: ${destAbs}`);
      const current = readFileSync(destAbs);
      action = Buffer.compare(current, bytes) === 0 ? "unchanged" : "change";
    } else {
      // No action: missing destination file remains an add.
    }
    return { relPath, srcAbs, destAbs, action, bytes };
  });
}

// Prune walks the DEST tree (PAI-shaped) and deletes anything the SOURCE no longer
// produces. Since SOURCE is LIFEOS-shaped and DEST is PAI-shaped, the source set is
// remapped through toDestRel() to DEST shape before the comparison — otherwise every
// LIFEOS-shaped source path would look "absent" from the PAI dest and prune would
// delete the entire release. The dest walk uses the PAI-shaped allowlist view.
//
// SCOPE (Forge audit 2026-07-20, pre-existing behavior — NOT introduced by the remap):
// prune only removes source-absent ALLOWLISTED files; it does NOT scrub private dest
// zones (PAI/USER, PAI/MEMORY), because DEST_VIEW.isDenied excludes them from the walk
// so they never become targets. This is safe by construction — staging never copies
// USER/MEMORY from the source (isAllowed rejects them), and release tooling overlays
// the PUBLIC USER scaffold separately — so a private zone can't arrive here via this
// tool in the first place. Prune is not the private-zone gate; the source allowlist +
// scanBytes are. If you ever need active scrubbing of stale private dest dirs, add a
// dedicated fail-closed sweep AFTER the containment checks rather than widening prune.
function collectPruneTargets(destRoot: string, sourceRelPaths: Set<string>, only?: string): string[] {
  const destSourceSet = new Set([...sourceRelPaths].map(toDestRel));
  const destOnly = only ? toDestRel(only) : undefined;
  return walkAllowlistedDest(destRoot, destOnly).filter((relPath) => !destSourceSet.has(relPath));
}

function runSelfTest(): number {
  // Generic fixture (no real username baked into this public tool): a user-home path with a
  // non-placeholder segment must hard-fail, and the current runtime username must hit.
  const seeded = Buffer.from("C:\\Users\\notarealperson\\secret", "utf8");
  const runtime = Buffer.from(`user=${USERNAME}`, "utf8");
  const seededHit = scanBytes("self-test.txt", seeded).hit;
  const runtimeHit = scanBytes("runtime-user.txt", runtime).hit;

  // Shape-remap regression guard: the LIFEOS-shaped SOURCE must map to the
  // PAI-shaped DEST, and the DEST_VIEW must accept the remapped paths. A future
  // rename that desyncs these would otherwise silently emit 0 files (exit 0).
  const remapCases: Array<[string, string]> = [
    ["LIFEOS/ALGORITHM/LATEST", "PAI/ALGORITHM/LATEST"],
    ["LIFEOS/LIFEOS_SYSTEM_PROMPT.md", "PAI/PAI_SYSTEM_PROMPT.md"],
    ["hooks/SecurityPipeline.hook.ts", "hooks/SecurityPipeline.hook.ts"],
    ["settings.json", "settings.json"],
  ];
  let remapOk = true;
  for (const [src, wantDest] of remapCases) {
    const gotDest = toDestRel(src);
    if (gotDest !== wantDest) { console.error(`REMAP FAIL ${src} -> ${gotDest} (want ${wantDest})`); remapOk = false; }
    if (!DEST_VIEW.isAllowed(wantDest)) { console.error(`DEST_VIEW rejects ${wantDest}`); remapOk = false; }
  }
  // The private zones must be denied in BOTH shapes.
  const denyOk = SOURCE_VIEW.isDenied("LIFEOS/USER/secrets.md") && DEST_VIEW.isDenied("PAI/USER/secrets.md")
    && SOURCE_VIEW.isDenied("LIFEOS/MEMORY/x") && DEST_VIEW.isDenied("PAI/MEMORY/x");
  if (!denyOk) console.error("DENY FAIL: LIFEOS/USER|MEMORY or PAI/USER|MEMORY not denied");

  if (seededHit && runtimeHit && remapOk && denyOk) {
    console.log("PASS");
    return 0;
  }
  console.error("FAIL");
  return 1;
}

function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (args.selfTest) return runSelfTest();

  console.error("WARN: SOURCE is the live/uncommitted working tree and may contain half-edited code.");
  // LIFEOS_DIR is the current override; PAI_DIR kept for back-compat with older invocations.
  const sourceOverride = process.env.LIFEOS_DIR ?? process.env.PAI_DIR;
  const sourceRoot = sourceOverride ? path.resolve(sourceOverride) : path.join(os.homedir(), ".claude");
  const repoRoot = resolveRepoRoot();
  const destRoot = resolveDestRoot(repoRoot, args.release);
  assertDestSafe(repoRoot, sourceRoot, destRoot, args.prune);
  const sourceCandidates = walkAllowlisted(sourceRoot, args.only);
  const ignored = filterGitIgnored(sourceRoot, sourceCandidates);
  const relPaths = sourceCandidates.filter((relPath) => !ignored.has(relPath));

  // Silent-false-all-clear guard: a full run (no --only scope) that surfaces ZERO
  // source files means the allowlist no longer matches the source tree shape — the
  // exact PAI/->LIFEOS/ rename regression this tool hit. Fail loudly, don't exit 0.
  if (relPaths.length === 0 && !args.only) {
    console.error(`REFUSING: 0 source files matched under ${sourceRoot}. The allowlist shape may not match the source tree (expected LIFEOS/-shaped). Set LIFEOS_DIR or check ALLOW_DIRS.`);
    return 1;
  }
  const entries = stageEntries(sourceRoot, destRoot, relPaths);

  for (const entry of entries) {
    try {
      const scan = scanBytes(entry.relPath, entry.bytes);
      if (scan.hit) {
        console.error(`SCAN-FAIL ${entry.relPath} pattern=${scan.pattern}`);
        return 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "scan-error";
      console.error(`SCAN-FAIL ${entry.relPath} pattern=${message}`);
      return 1;
    }
  }

  const pruneTargets = args.prune ? collectPruneTargets(destRoot, new Set(relPaths), args.only) : [];
  console.log(args.apply ? "APPLY (writing files)" : "DRY-RUN (no files written) — pass --apply to write");
  let adds = 0;
  let changes = 0;
  let unchanged = 0;
  for (const entry of entries) {
    if (entry.action === "add") adds += 1;
    else if (entry.action === "change") changes += 1;
    else unchanged += 1;
    if (entry.action === "unchanged") continue;
    console.log(`${entry.action}: ${displayPath(entry.relPath, args.only)}`);
    const before = existsSync(entry.destAbs) && statSync(entry.destAbs).isFile() ? readFileSync(entry.destAbs) : null;
    for (const line of renderDiff(entry.relPath, before, entry.bytes)) console.log(line);
  }
  if (args.prune) {
    for (const relPath of pruneTargets) console.log(`delete: ${displayPath(relPath, args.only)}`);
  } else {
    // No action: deletion is intentionally disabled unless --prune is supplied.
  }
  console.log(`summary add=${adds} change=${changes} unchanged=${unchanged}${args.prune ? ` delete=${pruneTargets.length}` : ""}`);

  if (!args.apply) return 0;
  for (const entry of entries) {
    if (entry.action === "unchanged") continue;
    mkdirSync(path.dirname(entry.destAbs), { recursive: true });
    // Write-path containment (Cato re-audit 5b): the resolved parent dir must stay under the
    // validated destRoot, so a junction under .claude can't redirect a write outside the tree.
    if (escapesRoot(path.dirname(entry.destAbs), destRoot)) {
      console.error(`SKIP write (escapes dest): ${entry.relPath}`);
      continue;
    }
    writeFileSync(entry.destAbs, entry.bytes);
  }
  if (args.prune) {
    for (const relPath of pruneTargets) {
      const target = path.join(destRoot, ...relPath.split("/"));
      if (escapesRoot(path.dirname(target), destRoot)) { // never unlink through a junction
        console.error(`SKIP prune (escapes dest): ${relPath}`);
        continue;
      }
      unlinkSync(target);
    }
  } else {
    // No action: prune writes are intentionally skipped.
  }
  return 0;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
