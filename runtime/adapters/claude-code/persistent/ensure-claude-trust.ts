/**
 * ensure-claude-trust.ts — suppress the interactive first-run dialogs that
 * would otherwise wedge a headless REPL forever.
 *
 * THE PROBLEM (discovered during the Sprint-1 live round-trip proof): a fresh
 * interactive `claude` in an untrusted cwd renders TWO blocking Ink dialogs
 * BEFORE it loads MCP servers — so the dev-channel never boots and the spawn
 * fails `no-channel-ready`:
 *   1. "Is this a project you trust?"  (folder-trust gate)
 *   2. "Bypass Permissions mode … accept?"  (the --dangerously-skip-permissions
 *      first-use disclaimer)
 * `--dangerously-skip-permissions` does NOT bypass either dialog. There is no
 * keystroke path to a headless PTY, so an un-dismissed dialog wedges the
 * session permanently — exactly the failure class `repl-agent-base.md`'s
 * "never open an interactive prompt" rule guards against, but these fire before
 * our system prompt is even in effect.
 *
 * THE FIX: pre-seed the on-disk state both dialogs consult, in the SAME config
 * file the child will read:
 *   • top-level `bypassPermissionsModeAccepted: true`
 *   • `projects[<realpath cwd>].hasTrustDialogAccepted: true`
 *     + `hasCompletedProjectOnboarding: true`
 * The cwd MUST be realpath'd — claude keys trust by the resolved path
 * (`/tmp` → `/private/tmp` on macOS would otherwise mismatch).
 *
 * Config-file location: `<CLAUDE_CONFIG_DIR>/.claude.json` when a per-instance
 * config dir is given (Managed isolation — auth then flows via the
 * `CLAUDE_CODE_OAUTH_TOKEN` env the substrate already scrubs in), else the
 * user's default `~/.claude.json` (Open self-host — inherits the local login).
 * The write is a read-merge-write so existing config/login state is preserved.
 */

import { flockAvailable, withFlockSync } from './registry-lock.ts'
import { SpawnConfigurationError } from './spawn-configuration-error.ts'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, realpathSync, lstatSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

let warnedUnavailable = false

export interface EnsureClaudeTrustInput {
  /** The REPL cwd to mark trusted (realpath'd internally). */
  cwd: string
  /** Per-instance `CLAUDE_CONFIG_DIR`. When set, the trust is seeded in
   *  `<configDir>/.claude.json` (and the substrate sets the env var on the
   *  child). When undefined, the user's default `~/.claude.json` is used. */
  configDir?: string
}

interface ClaudeConfig {
  hasCompletedOnboarding?: boolean
  bypassPermissionsModeAccepted?: boolean
  projects?: Record<string, Record<string, unknown>>
  [k: string]: unknown
}

function resolveRealCwd(cwd: string): string {
  try {
    return realpathSync(cwd)
  } catch {
    return cwd
  }
}

const retentionKey = 'neutronSeededProjectParentV1'

// Record the immediate parent while a newly owned project is live. Its identity
// distinguishes child deletion from an unavailable or replaced volume.
function projectParentIdentity(cwd: string): string | undefined {
  const parent = dirname(cwd)
  try {
    const stat = lstatSync(parent, { bigint: true })
    if (!stat.isDirectory()) return undefined
    return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
  } catch {
    return undefined
  }
}

function pruneRemovedProjects(projects: NonNullable<ClaudeConfig['projects']>, current: string): void {
  for (const [path, project] of Object.entries(projects)) {
    if (path === current) continue
    const identity = project[retentionKey]
    if (typeof identity !== 'string') continue
    try {
      // lstat preserves dangling links and unmounted mount-point directories.
      lstatSync(path)
    } catch (error) {
      // EACCES, ENOTDIR, IO errors, etc. are uncertainty, never deletion proof.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT'
        && projectParentIdentity(path) === identity) delete projects[path]
    }
  }
}

/**
 * Pre-seed trust + bypass acceptance for `cwd` in the claude config the child
 * will read. Idempotent. Returns the config-file path written (for logging).
 */
export function ensureClaudeTrust(input: EnsureClaudeTrustInput): string {
  const dir = input.configDir ?? homedir()
  if (input.configDir !== undefined && !existsSync(input.configDir)) {
    mkdirSync(input.configDir, { recursive: true })
  }
  const file = join(realpathSync(dir), '.claude.json')
  const realCwd = resolveRealCwd(input.cwd)

  // A separate, stable inode: locking the config itself would lose exclusion
  // when rename replaces it. Seeds serialize whenever FFI is available.
  return withFlockSync(`${file}.neutron.lock`, () => {
    let config: ClaudeConfig = {}
    if (existsSync(file)) {
      try {
        config = JSON.parse(readFileSync(file, 'utf8')) as ClaudeConfig
      } catch {
        throw new SpawnConfigurationError('persistent-repl: cannot read Claude trust config')
      }
    }

    if (config === null || typeof config !== 'object' || Array.isArray(config)
      || (config.projects !== undefined && (config.projects === null
        || typeof config.projects !== 'object' || Array.isArray(config.projects)
        || Object.values(config.projects).some(p => p === null || typeof p !== 'object' || Array.isArray(p))))) {
      throw new SpawnConfigurationError('persistent-repl: invalid Claude trust config shape')
    }

    config.hasCompletedOnboarding = true
    config.bypassPermissionsModeAccepted = true
    const projects = config.projects ?? {}
    pruneRemovedProjects(projects, realCwd)
    const newlySeeded = !Object.hasOwn(projects, realCwd)
    const existing = projects[realCwd] ?? {}
    projects[realCwd] = {
      ...existing,
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    }
    const identity = projectParentIdentity(realCwd)
    if (newlySeeded && identity !== undefined) {
      try {
        if (lstatSync(realCwd).isDirectory()) projects[realCwd]![retentionKey] = identity
      } catch { /* An unavailable cwd cannot establish retention provenance. */ }
    }
    config.projects = projects

    // Atomic write so a concurrent reader never sees a truncated file.
    const tmp = `${file}.neutron-${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
    return file
  }, (acquired) => {
    if (!acquired && flockAvailable()) {
      throw new SpawnConfigurationError('persistent-repl: cannot acquire Claude trust config lock')
    }
    // Missing FFI is not a denied lock. Accept possible concurrent lost updates
    // (#751) rather than make every launch a non-retryable spawn_configuration
    // failure. Like the sink token, warn once and proceed without serialization.
    if (!acquired && !warnedUnavailable) {
      warnedUnavailable = true
      process.stderr.write('[claude-trust] flock unavailable; seeding without serialization; concurrent trust updates may be lost\n')
    }
  })
}
