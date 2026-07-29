/**
 * @neutronai/runtime — GPT-5.5 Codex CLI substrate adapter.
 *
 * Implements the locked `Substrate` interface by shelling out to the `codex`
 * CLI in `--json` mode. `tool_resolution = 'internal'` because Codex's MCP
 * machinery (configured in `~/.codex/config.toml`) resolves tools server-side.
 * `respondToTool` THROWS on this adapter — same shape as the CC adapter.
 *
 * Auth: ChatGPT subscription OAuth (device-code) OR `OPENAI_API_KEY` per
 * `auth.ts`.
 *
 * Resume: pass `spec.session.id` and the adapter forwards it as `--resume`.
 * Codex re-reads its on-disk transcript at `$CODEX_HOME/sessions/<id>.jsonl`
 * (mirrors CC's pattern). Caller persists the `thread_id` from the first
 * `thread.started` envelope (surfaced as `completion.substrate_instance_id`).
 */

import type { AgentSpec, Substrate } from '../../substrate.ts'
import type { SessionHandle } from '../../session-handle.ts'
import type { Event } from '../../events.ts'
import { resolveCodexAuth } from './auth.ts'
import { startCodexExec } from './exec.ts'
import type { CodexSpawnLike } from './exec.ts'

export interface CodexCliSubstrateOptions {
  /**
   * Credential env the resolver reads from. ONLY auth-relevant keys
   * (`OPENAI_API_KEY`, `CODEX_HOME`) are meaningful — see `auth.ts`.
   *
   * ISSUES #67 (2026-05-28) — defaults to `{}`, NOT `process.env`. The
   * caller (production composer, Open self-hoster boot, test) is
   * responsible for explicitly passing instance-scoped credentials. A
   * Codex-CLI `auth_source = codex_oauth` instance relies on the persisted
   * `$CODEX_HOME/auth.json` file, NOT any env-var path; if this default
   * inherited host `process.env` and the host happened to have
   * `OPENAI_API_KEY` set (managed-tier fallback, dev shim, leftover
   * export), the resolver would silently flip the instance onto the
   * `api_key` path and bill the HOST's quota for the instance's calls.
   * The exec-time env-overlay delete in `exec.ts` only protects against
   * UNSELECTED variants — it cannot rescue an instance whose selected
   * credential was wrong-sourced at resolve time. Hence: explicit env,
   * no fallback to `process.env`. Single-user Open self-hosters who
   * want the BYO-key path pass `env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY }`
   * at substrate-construction time.
   */
  env?: Readonly<Record<string, string | undefined>>
  /** Override CODEX_HOME (tests use a tmpdir). */
  codex_home?: string
  /** Override the `codex` binary path (tests inject a stub script). */
  bin?: string
  /**
   * Spawn implementation. Defaults to `node:child_process.spawn`. Tests
   * inject a fake that captures argv + env so the env-overlay regression
   * suite (ISSUES #67) can pin the merged-env shape end-to-end through
   * `createCodexCliSubstrate → resolveCodexAuth → startCodexExec`.
   */
  spawnImpl?: CodexSpawnLike
}

export function createCodexCliSubstrate(options: CodexCliSubstrateOptions = {}): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      return startCodexSession(spec, options)
    },
  }
}

function startCodexSession(spec: AgentSpec, options: CodexCliSubstrateOptions): SessionHandle {
  const ac = new AbortController()
  // ISSUES #67 (2026-05-28) — empty default. See the doc-comment on
  // `CodexCliSubstrateOptions.env` for why this is NOT `process.env`:
  // host env vars must not influence per-instance credential selection.
  // Callers explicitly pass instance-scoped env.
  const env = options.env ?? {}
  const model = spec.model_preference[0]
  if (!model) {
    throw new Error('codex-cli adapter: model_preference is empty; at least one model required')
  }

  const events = (async function* (): AsyncGenerator<Event, void, void> {
    let auth
    try {
      const authOpts: Parameters<typeof resolveCodexAuth>[0] = { env }
      if (options.codex_home !== undefined) authOpts.codex_home = options.codex_home
      auth = await resolveCodexAuth(authOpts)
    } catch (err) {
      yield {
        kind: 'error',
        message: `auth_resolution_failed: ${(err as Error).message}`,
        retryable: false,
      }
      return
    }

    const execOpts: Parameters<typeof startCodexExec>[0] = {
      prompt: spec.prompt,
      spawn_env: auth.spawn_env,
      signal: ac.signal,
      model,
    }
    if (spec.session?.id !== undefined) execOpts.resume_id = spec.session.id
    if (options.bin !== undefined) execOpts.bin = options.bin
    if (options.spawnImpl !== undefined) execOpts.spawnImpl = options.spawnImpl

    try {
      for await (const ev of startCodexExec(execOpts)) {
        if (ev.kind === 'completion') {
          // Carry forward Codex thread_id as session.id for callers — Codex's
          // own resume primitive is the thread_id, so attribute it here.
          const out: Event = {
            ...ev,
            session: { id: ev.substrate_instance_id, last_active_at: Date.now() },
          }
          yield out
          return
        }
        yield ev
      }
    } finally {
      try {
        ac.abort()
      } catch {
        // best-effort
      }
    }
  })()

  const handle: SessionHandle = {
    events,
    respondToTool() {
      return Promise.reject(
        new Error(
          'codex-cli adapter: respondToTool called on tool_resolution=internal substrate (caller bug; Codex resolves MCP tools server-side)',
        ),
      )
    },
    async cancel(): Promise<void> {
      try {
        ac.abort()
      } catch {
        // best-effort
      }
    },
    tool_resolution: 'internal',
  }
  return handle
}
