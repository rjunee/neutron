/**
 * trident/auto-mode.ts — Trident v2 Phase 3: autonomous permissioning ("auto mode").
 *
 * REPLACES the reckless `--dangerously-skip-permissions` (`bypassPermissions`)
 * the inner-loop launcher would otherwise run under. The launcher is ONE turn on
 * the INTERACTIVE persistent-REPL substrate (the billing-exempt path — there is
 * no `claude -p`); this auto-mode settings object is folded into that REPL's
 * `--settings` and its `--permission-mode dontAsk` flag. A headless trident run
 * has no human to answer a permission prompt, but a blanket skip removes EVERY
 * guardrail. Auto mode is the middle path (spec `docs/specs/trident-auto-mode.md`):
 *
 *   1. `--permission-mode dontAsk` — anything NOT in `permissions.allow` is
 *      IMMEDIATELY DENIED (no prompt, no hang). The denial returns to the agent,
 *      which adapts/reports rather than stalling. This is the never-stuck
 *      guarantee at the mode level (and, unlike `auto`, dontAsk has NO model
 *      gate — the model floor below is an extra belt-and-suspenders guard).
 *   2. A complete `permissions.allow` ALLOWLIST of the op-set the build loop
 *      legitimately needs (git/gh/bun/sqlite/coreutils + Read/Edit/Write/Agent/
 *      Workflow), so legitimate ops are not needlessly denied.
 *   3. A `permissions.deny` list for the dangerous shapes the allowlist CAN
 *      express (force-push / reset --hard) + protected-path writes (.git/.claude).
 *      Deny ALWAYS beats allow (and beats a hook `allow`), so these are hard.
 *   4. A `PreToolUse` DENY-GUARD hook (`hooks/auto-mode-deny-guard.ts`) for the
 *      nuanced destructive shapes the coarse allow/deny globs CANNOT express —
 *      push-to-main (vs push-to-feature both match `git push origin *`), rm -rf
 *      outside the worktree, history rewrites, force-deleting a protected branch.
 *
 * INHERITANCE: a CC Dynamic Workflow's `agent()` subagents INHERIT the LAUNCHER
 * session's permission mode (proto-2 Q2, 2026-06-28 — verified on a real run);
 * a subagent's own frontmatter `permissionMode` is IGNORED. So the mode is set
 * ONCE here at the interactive launcher REPL and every Forge/Argus worker runs
 * under the same dontAsk + allowlist + deny-guard. MERGE stays the OUTER/human gate
 * (`trident/merge.ts`) — the one irreversible action is never inside the loop.
 *
 * This module is PURE (settings object + deny-guard decision + model-floor
 * check) so it is exhaustively unit-tested without a live `claude`. The thin
 * hook wrapper that runs at PreToolUse time lives in
 * `hooks/auto-mode-deny-guard.ts` and delegates to `evaluateBashDenyGuard` here.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Absolute path to the PreToolUse deny-guard hook (run as `bun <path>`). */
export const DENY_GUARD_HOOK_PATH = join(HERE, 'hooks', 'auto-mode-deny-guard.ts')

/** The launcher permission mode. `dontAsk` = non-allowlisted ⇒ immediate deny
 *  (never a prompt, never a hang). The CC flag is `--permission-mode dontAsk`. */
export const AUTO_MODE_PERMISSION_MODE = 'dontAsk' as const

// ── Model floor ───────────────────────────────────────────────────────────────
//
// Auto mode is only sanctioned on Opus 4.6+ / Sonnet 4.6+ (older models are
// unsupported for `auto`; we use `dontAsk` which has no hard gate, but the brief
// requires a floor guard regardless — an under-floor model is far likelier to
// fumble a denied op into a wedge). The guard is PERMISSIVE: it FAILS only on a
// model we can positively identify as below floor; aliases (`opus`/`sonnet`) and
// unknown ids pass (we never block boot on uncertainty).

/** Model ids/aliases positively known to be BELOW the auto-mode floor. */
const BELOW_FLOOR_PATTERNS: RegExp[] = [
  /haiku/i, // Haiku is unsupported for auto mode at any version.
  /claude-[0-3]\b/i, // claude-1/2/3 families.
  /\bopus-3\b/i,
  /\bsonnet-3\b/i,
  /\bopus-4-[0-5]\b/i, // Opus 4.0–4.5 (floor is 4.6).
  /\bsonnet-4-[0-5]\b/i, // Sonnet 4.0–4.5 (floor is 4.6).
]

/** True iff `model` is at/above the auto-mode floor (or not identifiable as below). */
export function isAutoModeModelAtFloor(model: string): boolean {
  const m = (model ?? '').trim()
  if (m === '') return true // empty → caller default ('opus') applies; don't block.
  return !BELOW_FLOOR_PATTERNS.some((re) => re.test(m))
}

/**
 * Throw a clear error when `model` is positively below the auto-mode floor.
 * Callers turn the throw into a LOUD launch failure (never a silent bad run).
 */
export function assertAutoModeModelFloor(model: string): void {
  if (!isAutoModeModelAtFloor(model)) {
    throw new Error(
      `trident auto-mode requires Opus 4.6+/Sonnet 4.6+ but the launcher model is "${model}" (below floor). ` +
        `Use "opus"/"sonnet" (current top tier) or a 4.6+ id.`,
    )
  }
}

// ── Allow / deny lists (the trident op-set) ────────────────────────────────────
//
// Under dontAsk the allow list is the GRANT surface: a tool/command not matched
// here is denied. It is enumerated (not a blanket `Bash(*)`) so it doubles as
// documentation of exactly what trident agents may do — but generous enough that
// a normal build (git/gh/bun + the coreutils that appear in piped commands like
// `git worktree list | awk …`) is never needlessly denied. CC evaluates compound
// commands (`a | b`, `a && b`) sub-command-by-sub-command, so the coreutils used
// inside the inner-workflow's pipes (awk/sed/grep/…) MUST be listed too.

/** Bash command prefixes the trident build loop legitimately needs. */
const ALLOWED_BASH_PREFIXES: string[] = [
  // Git / GitHub — the build + PR mechanics.
  'git',
  'gh',
  // Package managers / runtimes / build + test.
  'bun',
  'bunx',
  'npm',
  'npx',
  'node',
  'pnpm',
  'yarn',
  'make',
  'tsc',
  // The checkpoint Bash step.
  'sqlite3',
  // The inner-loop DRAIN cadence — the interactive-substrate launcher holds its
  // turn open by polling the background `Workflow` to terminal, pausing between
  // polls with `sleep`. Under dontAsk an unlisted `sleep` would be DENIED and the
  // launcher could not pace its poll loop (it would busy-spin or end the turn).
  'sleep',
  // Coreutils that show up inside the inner-workflow's piped commands +
  // ordinary build steps. (dontAsk denies anything unlisted, and CC checks each
  // sub-command of a pipe, so these must be granted explicitly.)
  'awk',
  'sed',
  'grep',
  'rg',
  'cat',
  'tee',
  'head',
  'tail',
  'sort',
  'uniq',
  'wc',
  'cut',
  'tr',
  'date',
  'echo',
  'printf',
  'ls',
  'pwd',
  'cd',
  'mkdir',
  'touch',
  'cp',
  'mv',
  'rm', // recursive/destructive shapes are blocked by the deny-guard hook.
  'find',
  'xargs',
  'jq',
  'env',
  'true',
  'false',
  'test',
  'which',
  'dirname',
  'basename',
  'realpath',
  'diff',
]

/**
 * The `permissions.allow` list. Read is unrestricted; Edit/Write are granted
 * broadly because `isolation:'worktree'` relocates each agent's edit surface to
 * a harness-chosen worktree path that is NOT known at settings-gen time —
 * protected paths are instead pinned by the `permissions.deny` list + the
 * deny-guard hook (Bash-level destructive writes). Agent + Workflow are required
 * for the inner workflow's fan-out.
 *
 * DRAIN tools (`Monitor` + the `Task*` family) are granted because the inner
 * launcher runs as ONE interactive-substrate turn that must keep itself alive
 * until the BACKGROUND `Workflow` drains: it invokes `Workflow` (which returns a
 * runId immediately and completes later) and then POLLS that run to terminal —
 * via `TaskList`/`TaskGet`/`TaskOutput` (or a `Monitor` until-loop) — WITHOUT
 * settling the turn, only then emitting the final `TRIDENT_RESULT` reply. Under
 * dontAsk every one of those poll tools must be on the allowlist or the launcher
 * could not observe completion and would have to end its turn early (the exact
 * abort the billing-fix interactive path exists to prevent).
 */
export function tridentAllowList(): string[] {
  return [
    'Read',
    'Edit',
    'Write',
    'Glob',
    'Grep',
    'Agent',
    'Workflow',
    'TodoWrite',
    // Background-task drain/poll surface (see docstring) — the launcher waits on
    // the background Workflow run to terminal within its own turn.
    'Monitor',
    'TaskCreate',
    'TaskGet',
    'TaskList',
    'TaskOutput',
    'TaskUpdate',
    'TaskStop',
    ...ALLOWED_BASH_PREFIXES.map((p) => `Bash(${p}:*)`),
  ]
}

/**
 * The `permissions.deny` list — the dangerous shapes the coarse glob CAN express
 * (deny beats allow + hook, so these are unconditional) + protected-path writes.
 * The nuanced shapes (push-to-main, rm -rf outside worktree) live in the hook.
 */
export function tridentDenyList(): string[] {
  return [
    'Bash(git push --force:*)',
    'Bash(git push -f:*)',
    'Bash(git push --force-with-lease:*)',
    'Bash(git reset --hard:*)',
    'Bash(git clean -f:*)',
    'Bash(git clean -fd:*)',
    'Bash(git filter-branch:*)',
    'Bash(git filter-repo:*)',
    'Bash(sudo:*)',
    // Protected paths — never auto-written even under the allowlist. Both the
    // cwd-relative form (`.git/**`) AND the nested/absolute form (`**/.git/**`)
    // are listed: the Edit/Write tools usually supply an ABSOLUTE worktree path
    // (e.g. `/work/tree/.git/config`), which a relative-only pattern misses
    // (Codex P2). The nested glob matches `.git`/`.claude` at any path depth.
    'Edit(.git/**)',
    'Write(.git/**)',
    'Edit(**/.git/**)',
    'Write(**/.git/**)',
    'Edit(.claude/**)',
    'Write(.claude/**)',
    'Edit(**/.claude/**)',
    'Write(**/.claude/**)',
  ]
}

// ── Settings object ────────────────────────────────────────────────────────────

export interface TridentAutoModeSettings {
  permissions: {
    defaultMode: typeof AUTO_MODE_PERMISSION_MODE
    allow: string[]
    deny: string[]
  }
  hooks: {
    PreToolUse: Array<{
      matcher: string
      hooks: Array<{ type: 'command'; command: string }>
    }>
  }
}

export interface BuildTridentAutoModeSettingsOptions {
  /** Shell command CC runs for the PreToolUse guard. Default `bun <DENY_GUARD_HOOK_PATH>`. */
  denyGuardCommand?: string
  /** Override the `bun` binary used to run the hook. Default `bun`. */
  bunBin?: string
}

/**
 * Build the trident auto-mode `--settings` object: dontAsk + the allowlist +
 * the deny list + the PreToolUse Bash deny-guard hook. Pure — the launcher
 * serialises this to a file and passes it as `--settings`.
 */
export function buildTridentAutoModeSettings(
  opts: BuildTridentAutoModeSettingsOptions = {},
): TridentAutoModeSettings {
  const bunBin = opts.bunBin ?? 'bun'
  const denyGuardCommand = opts.denyGuardCommand ?? `${bunBin} ${DENY_GUARD_HOOK_PATH}`
  return {
    permissions: {
      defaultMode: AUTO_MODE_PERMISSION_MODE,
      allow: tridentAllowList(),
      deny: tridentDenyList(),
    },
    hooks: {
      // Matcher scoped to Bash — the destructive SHAPES the guard catches are
      // all Bash commands; protected-path Edit/Write are covered by the deny
      // list above (no per-call hook spawn needed).
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: denyGuardCommand }] }],
    },
  }
}

// ── Deny-guard decision (the PreToolUse Bash hook's core) ──────────────────────

export interface DenyGuardContext {
  /** The run's isolated worktree root (rm -rf targets under it are allowed). */
  worktreeRoot?: string
  /** The repo of record (also an allowed rm -rf root). */
  repoPath?: string
  /** The invoking user's home dir (default `process.env.HOME`); rm -rf of it is denied. */
  homeDir?: string
}

export interface DenyGuardDecision {
  /** True ⇒ DENY the tool call. */
  deny: boolean
  /** Human-readable reason (surfaced to the agent as the denial message). */
  reason?: string
}

const ALLOW: DenyGuardDecision = { deny: false }
const deny = (reason: string): DenyGuardDecision => ({ deny: true, reason })

/** Does the push/branch SUBSTRING target the protected main/master ref?
 *  Matches a standalone `main`/`master` arg or refspec dst (`HEAD:main`,
 *  `origin main`) but NOT a branch that merely contains it (`trident/main-fix`). */
function targetsProtectedRef(segment: string): boolean {
  return /(^|[\s:/])(main|master)(\s|$)/.test(segment)
}

/** The recursive-force `rm` flag shapes (`-rf`, `-fr`, `-r -f`, `--recursive --force`, …). */
function isRecursiveForceRm(command: string): boolean {
  if (!/(^|[\s;&|])rm(\s|$)/.test(command)) return false
  const hasRecursive = /(\s-[a-z]*r[a-z]*\b|\s--recursive\b|\s-[a-z]*R[a-z]*\b)/.test(command)
  const hasForce = /(\s-[a-z]*f[a-z]*\b|\s--force\b)/.test(command)
  return hasRecursive && hasForce
}

/** Catastrophic absolute SYSTEM roots an `rm -rf` must never touch: a bare
 *  `/`/`~`/`$HOME`/`/*`, or a top-level system dir. (Home dirs under
 *  `/Users`/`/home` are handled separately so a DEEP path inside a worktree —
 *  e.g. `/Users/x/repos/proj/dist` — is NOT over-blocked; Codex P2.) */
const CATASTROPHIC_RM_RE =
  /(^|\s)(\/|~|\$HOME|\$\{HOME\}|\/\*)(\s|\/?$)|(^|\s)\/(usr|etc|var|bin|sbin|lib|lib64|boot|dev|sys|proc|root|opt|System|Library|Applications)(\b|\/)/

/** A WHOLE home directory (`/Users`, `/Users/<user>`, `/home/<user>`) — but NOT
 *  a deeper project path under it (`/Users/<user>/repos/…`), which is a normal
 *  worktree-internal cleanup target and stays allowed. */
const WHOLE_HOME_RM_RE = /(^|\s)\/(Users|home)(\/[^/\s]+)?(\s|\/?$)/

/**
 * Evaluate a Bash command against the trident auto-mode deny-guard. Returns a
 * deny decision for the destructive shapes the coarse allow/deny globs cannot
 * express; otherwise ALLOW (deferring to the dontAsk allowlist). Pure + total.
 */
export function evaluateBashDenyGuard(
  command: string,
  ctx: DenyGuardContext = {},
): DenyGuardDecision {
  const cmd = (command ?? '').trim()
  if (cmd === '') return ALLOW

  // 1. Force-push (any variant) — trident never force-pushes.
  if (/\bgit\s+push\b/.test(cmd) && /(^|\s)(--force|--force-with-lease|-f)(\s|=|$)/.test(cmd)) {
    return deny('force-push is blocked in trident auto-mode (push the feature branch normally)')
  }

  // 2. Push to main/master (or delete it) — merge is the OUTER/human gate.
  if (/\bgit\s+push\b/.test(cmd)) {
    const pushSeg = cmd.slice(cmd.search(/\bgit\s+push\b/)).split(/[|&;]/)[0] ?? ''
    if (targetsProtectedRef(pushSeg)) {
      return deny('push to main/master is blocked — merge is the OUTER/human gate, never the inner loop')
    }
  }

  // 3. `git reset --hard` — destroys uncommitted/committed work.
  if (/\bgit\s+reset\b/.test(cmd) && /--hard\b/.test(cmd)) {
    return deny('`git reset --hard` is blocked in trident auto-mode')
  }

  // 4. `git clean -f[d]` — wipes untracked files.
  if (/\bgit\s+clean\b/.test(cmd) && /\s-[a-z]*f/.test(cmd)) {
    return deny('`git clean -f` is blocked in trident auto-mode')
  }

  // 5. History rewrites / ref surgery.
  if (
    /\bgit\s+filter-branch\b/.test(cmd) ||
    /\bgit\s+filter-repo\b/.test(cmd) ||
    (/\bgit\s+push\b/.test(cmd) && /--mirror\b/.test(cmd)) ||
    (/\bgit\s+update-ref\b/.test(cmd) && /\s-d\b/.test(cmd)) ||
    /\bgit\s+reflog\s+expire\b/.test(cmd)
  ) {
    return deny('history-rewrite / ref-surgery is blocked in trident auto-mode')
  }

  // 6. Force-deleting the PROTECTED main/master branch (a normal `git branch -D
  //    trident/<slug>` is part of cleanup, so only main/master is blocked).
  if (/\bgit\s+branch\b/.test(cmd) && /(\s-D\b|\s-d\b.*\s-f\b|\s--delete\b)/.test(cmd)) {
    const branchSeg = cmd.slice(cmd.search(/\bgit\s+branch\b/)).split(/[|&;]/)[0] ?? ''
    if (targetsProtectedRef(branchSeg)) {
      return deny('force-deleting main/master is blocked in trident auto-mode')
    }
  }

  // 7. `rm -rf` of a catastrophic system root or a WHOLE home dir (outside the
  //    worktree). A deep path inside the worktree (e.g.
  //    `<worktreeRoot>/dist`, `/Users/x/repos/proj/node_modules`) is NOT blocked.
  if (isRecursiveForceRm(cmd)) {
    const home = ctx.homeDir ?? process.env['HOME'] ?? ''
    if (CATASTROPHIC_RM_RE.test(cmd)) {
      return deny('`rm -rf` of a system root is blocked in trident auto-mode')
    }
    if (WHOLE_HOME_RM_RE.test(cmd)) {
      return deny('`rm -rf` of a whole home directory is blocked in trident auto-mode')
    }
    if (home !== '' && new RegExp(`(^|\\s)${escapeRe(home)}(\\s|/?$)`).test(cmd)) {
      return deny('`rm -rf` of the home directory is blocked in trident auto-mode')
    }
  }

  // 8. `curl … | bash` / `wget … | sh` — remote-code exfil/exec.
  if (/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(bash|sh|zsh)\b/.test(cmd)) {
    return deny('piping a remote download into a shell is blocked in trident auto-mode')
  }

  return ALLOW
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
