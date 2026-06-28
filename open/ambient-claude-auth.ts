/**
 * Ambient / Keychain `claude` auth detection (single-owner Open).
 *
 * THE BUG THIS FIXES. On a Mac where the owner already has `claude` logged in
 * (OAuth creds in the macOS Keychain item "Claude Code-credentials"), a fresh
 * Open install served `GET /chat` as a 503 "Authenticate Claude" page and booted
 * the box LLM-less — EVEN THOUGH `claude -p "..."` works headlessly via the
 * Keychain. The chat auth-gate (`open/composer.ts:resolveOpenLlmPool`) only
 * recognised an EXPLICIT `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` in env
 * and rejected a perfectly-usable Keychain-authed `claude`.
 *
 * This probe lets the single-owner gate ALSO accept ambient/Keychain auth. It is
 * deliberately CHEAP, CACHED, and NEVER-HANGING:
 *   - macOS: a short-timeout `security find-generic-password -s
 *     "Claude Code-credentials"` (exit 0 → the login item exists).
 *   - other platforms: a non-empty `~/.claude/.credentials.json` (where the
 *     `claude` CLI persists its OAuth creds on Linux self-hosts).
 *   - ANY error / timeout / signal → `false` (treat as NOT authed → keep the 503
 *     gate). This function MUST NOT throw and MUST NOT hang.
 *
 * SCOPE: single-owner only. It is wired solely into `resolveOpenLlmPool`, the
 * Open single-owner credential resolver — the one place where an ambient
 * Keychain login unambiguously belongs to the box's sole owner. No other
 * surface in this repo consults it, so accepting ambient auth here cannot widen
 * any shared/multi-user credential path (there is none in this tree).
 */

import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** macOS Keychain generic-password service name the `claude` CLI stores under. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials'

/** Hard ceiling on the probe subprocess so a wedged `security` can never hang us. */
const PROBE_TIMEOUT_MS = 1500

/** Memoize for this long so we do NOT probe on every `/chat` hit. */
const CACHE_TTL_MS = 5 * 60_000

/**
 * Low-level, UNCACHED probe. Returns `true` iff `claude` appears to be
 * ambient/Keychain-authed for the current user. Never throws; any failure,
 * timeout, or signal resolves to `false`.
 *
 * The `deps` seam exists so tests can drive every branch hermetically without
 * relying on the runner actually having a Keychain item or a creds file.
 */
export interface AmbientAuthProbeDeps {
  platform: NodeJS.Platform
  /** macOS branch — returns true if the Keychain login item exists. */
  hasKeychainItem: () => boolean
  /** non-macOS branch — returns true if a non-empty creds file exists. */
  hasCredentialsFile: () => boolean
}

function defaultHasKeychainItem(): boolean {
  try {
    const res = spawnSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE], {
      timeout: PROBE_TIMEOUT_MS,
      stdio: 'ignore',
    })
    // `error` is set on spawn failure (ENOENT) or timeout; a non-zero status
    // means "no such item". Both → not authed.
    if (res.error !== undefined && res.error !== null) return false
    if (res.signal !== null) return false
    return res.status === 0
  } catch {
    return false
  }
}

function defaultHasCredentialsFile(env: NodeJS.ProcessEnv): boolean {
  try {
    const home = (typeof env['HOME'] === 'string' && env['HOME'].length > 0 ? env['HOME'] : undefined) ?? homedir()
    const path = join(home, '.claude', '.credentials.json')
    const st = statSync(path)
    return st.isFile() && st.size > 0
  } catch {
    return false
  }
}

export function detectAmbientClaudeAuth(
  env: NodeJS.ProcessEnv = process.env,
  deps?: AmbientAuthProbeDeps,
): boolean {
  const resolved: AmbientAuthProbeDeps = deps ?? {
    platform: process.platform,
    hasKeychainItem: defaultHasKeychainItem,
    hasCredentialsFile: () => defaultHasCredentialsFile(env),
  }
  try {
    if (resolved.platform === 'darwin') return resolved.hasKeychainItem()
    return resolved.hasCredentialsFile()
  } catch {
    return false
  }
}

interface CacheEntry {
  value: boolean
  at: number
}
let cache: CacheEntry | null = null

/**
 * Cached wrapper around {@link detectAmbientClaudeAuth}. The result is memoized
 * for {@link CACHE_TTL_MS} so the gate predicate (consulted per `/chat` request)
 * does not spawn a probe on every hit. Auth state rarely flips within a process,
 * and an explicit token (checked BEFORE this probe in `resolveOpenLlmPool`)
 * short-circuits anyway.
 */
export function detectAmbientClaudeAuthCached(
  env: NodeJS.ProcessEnv = process.env,
  deps?: AmbientAuthProbeDeps,
): boolean {
  const now = Date.now()
  if (cache !== null && now - cache.at < CACHE_TTL_MS) return cache.value
  const value = detectAmbientClaudeAuth(env, deps)
  cache = { value, at: now }
  return value
}

/** Test-only: clear the memo so each case starts from a cold cache. */
export function __resetAmbientAuthCacheForTests(): void {
  cache = null
}
