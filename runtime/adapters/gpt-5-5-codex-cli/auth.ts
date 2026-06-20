/**
 * @neutronai/runtime — GPT-5.5 Codex CLI adapter: auth resolution.
 *
 * The Codex CLI offers two authentication paths:
 *
 *   (a) ChatGPT subscription OAuth (device-code flow). The CLI persists tokens
 *       under `$CODEX_HOME` (default `~/.codex/`). Adapter consumers do NOT
 *       handle the OAuth dance themselves — `codex login` does it interactively.
 *
 *   (b) `OPENAI_API_KEY` (BYO platform key). Symmetric to the CC adapter's
 *       tier-(3) ANTHROPIC_API_KEY. This is the unambiguously ToS-clean path
 *       for hosted deployments per the OpenAI ToS analysis at
 *       internal design notes.
 *
 * This module's job is small: detect which path is configured, surface a
 * clear actionable error when neither is, and pass the resolution result
 * back to the adapter index so `exec.ts` can spawn `codex` with the right env.
 */

import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

export type CodexAuthSource = 'codex_oauth' | 'api_key'

/**
 * ISSUES #67 (2026-05-28) — every Codex-CLI-shaped auth env var that the
 * spawn must NOT inherit from the host `process.env`. The primary path is
 * `OPENAI_API_KEY` (the only env-var path the resolver below selects on).
 * `OPENAI_AUTH_TOKEN` / `OPENAI_API_TOKEN` are defensive variants — OpenAI
 * tooling forks and the Codex CLI itself are under active development; pre-
 * deleting the informal variants too matches PR #332's three-Anthropic-vars
 * defense-in-depth pattern. The list is the single source of truth; the
 * resolver below and the regression suite both consume it so adding a
 * future variant flips both sites at once.
 */
export const CODEX_CLI_AUTH_ENV_VARS = [
  'OPENAI_API_KEY',
  'OPENAI_AUTH_TOKEN',
  'OPENAI_API_TOKEN',
] as const

export interface CodexResolvedAuth {
  source: CodexAuthSource
  /**
   * Env vars to merge into the Codex spawn. Keys are uppercase env names.
   *
   * ISSUES #67 (2026-05-28) — values are typed `string | undefined` so the
   * resolver can explicitly UNSET unused Codex auth variants that would
   * otherwise inherit from the host `process.env` via the spawn merge.
   * `exec.ts` treats `undefined` as "delete from parentEnv" during merge
   * (per-spawn copy only; host `process.env` is never mutated). Without
   * this, a `codex_oauth` instance on a host with `OPENAI_API_KEY` set
   * would see BOTH `CODEX_HOME` (set here) AND the host's API key — and
   * the `codex` binary's documented auth precedence puts `OPENAI_API_KEY`
   * above persisted OAuth, billing the host's quota rather than the
   * instance's OAuth credential. Same shape as PR #332 / ISSUES #49.
   */
  spawn_env: Record<string, string | undefined>
  /** Path to CODEX_HOME we used. Set so observability / portability tests can pin it. */
  codex_home: string
}

export interface CodexResolveAuthOptions {
  env: Readonly<Record<string, string | undefined>>
  /** Override for `~/.codex`; tests inject a tmp dir. */
  codex_home?: string
}

/**
 * Build the per-spawn env scaffold with all Codex auth variants pre-set to
 * `undefined`. The caller then sets the selected variant (or leaves them
 * all undefined for the OAuth path). `exec.ts`'s merge step interprets
 * `undefined` as "delete from parentEnv" so any inherited host variant
 * gets dropped before the subprocess sees its env.
 */
function buildAuthEnvScaffold(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const k of CODEX_CLI_AUTH_ENV_VARS) {
    env[k] = undefined
  }
  return env
}

/**
 * Resolve auth for a Codex CLI invocation. Precedence:
 *
 *   (1) `OPENAI_API_KEY` set in env — pass through. Forces the CLI into BYO
 *       API mode regardless of any persisted OAuth state.
 *   (2) Persisted device-code OAuth — file `auth.json` under `$CODEX_HOME`.
 *
 * Throws when neither resolves. Error message names both fallback paths so
 * the operator can pick (and surfaces the "device-code not enabled by your
 * workspace admin" hint per § Q9(A) of the GPT-5.5 hosting research).
 */
export async function resolveCodexAuth(opts: CodexResolveAuthOptions): Promise<CodexResolvedAuth> {
  const codex_home = opts.codex_home ?? opts.env['CODEX_HOME'] ?? join(homedir(), '.codex')

  const apiKey = opts.env['OPENAI_API_KEY']
  if (apiKey) {
    const spawn_env = buildAuthEnvScaffold()
    spawn_env['OPENAI_API_KEY'] = apiKey
    spawn_env['CODEX_HOME'] = codex_home
    return {
      source: 'api_key',
      spawn_env,
      codex_home,
    }
  }

  const oauthPath = join(codex_home, 'auth.json')
  try {
    await access(oauthPath)
    const spawn_env = buildAuthEnvScaffold()
    spawn_env['CODEX_HOME'] = codex_home
    return {
      source: 'codex_oauth',
      spawn_env,
      codex_home,
    }
  } catch {
    // fall through to throw
  }

  throw new Error(
    [
      'codex-cli adapter: no auth resolved.',
      `Set OPENAI_API_KEY (BYO platform key) or run \`codex login\` to persist a device-code OAuth token under ${JSON.stringify(codex_home)}.`,
      'If \`codex login\` errors with "device-code auth not enabled", contact your ChatGPT workspace admin to enable it, then fall back to OPENAI_API_KEY.',
    ].join(' '),
  )
}
