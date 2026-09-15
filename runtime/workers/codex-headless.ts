import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type {
  BoundedWorkOutcome,
  BoundedWorkRequest,
  Placement,
  RefusalReason,
  Unsupported,
  WorkerHandle,
  WorkerRole,
  WorkerRunner,
} from '../bounded-work.ts'

type Probe = { ok: true } | { ok: false; reason: RefusalReason; detail: string }

export interface CodexHeadlessRunnerOptions {
  readonly buildScript?: string
  readonly env?: NodeJS.ProcessEnv
  readonly probe?: Probe
}

const SUPPORTED_ROLES = new Set<WorkerRole>(['build', 'fix'])

function startupProbe(env: NodeJS.ProcessEnv): Probe {
  const childEnv = scrubGithubEnv(env)
  const found = spawnSync('codex', ['--version'], { env: childEnv, stdio: 'ignore' })
  if (found.error || found.status !== 0) {
    return { ok: false, reason: 'provider-not-connected', detail: 'Codex CLI is unavailable' }
  }
  const login = spawnSync('codex', ['login', 'status'], { env: childEnv, stdio: 'ignore' })
  return login.status === 0
    ? { ok: true }
    : { ok: false, reason: 'provider-not-connected', detail: 'Codex login is unavailable' }
}

function scrubGithubEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([name]) => name !== 'GH_TOKEN' && !name.startsWith('GH_') && !name.startsWith('GITHUB_')),
  )
}

function parseTrailer(text: string): Record<string, string> | null {
  const result: Record<string, string> = {}
  for (const line of text.split('\n')) {
    if (line === '') continue
    const separator = line.indexOf('=')
    if (separator <= 0) return null
    result[line.slice(0, separator)] = line.slice(separator + 1)
  }
  return Object.keys(result).length > 0 ? result : null
}

function waitFor(child: ChildProcess, signal: AbortSignal): Promise<{ code: number | null; killed: boolean }> {
  return new Promise((resolveResult) => {
    let aborted = false
    const abort = () => {
      aborted = true
      child.kill('SIGTERM')
    }
    signal.addEventListener('abort', abort, { once: true })
    child.once('error', () => {
      signal.removeEventListener('abort', abort)
      resolveResult({ code: null, killed: aborted })
    })
    child.once('exit', (code) => {
      signal.removeEventListener('abort', abort)
      resolveResult({ code, killed: aborted })
    })
  })
}

export function createCodexHeadlessRunner(options: CodexHeadlessRunnerOptions = {}): WorkerRunner {
  const baseEnv = options.env ?? process.env
  const probe = options.probe ?? startupProbe(baseEnv)
  const buildScript = options.buildScript ?? resolve(import.meta.dir, '../../trident/codex-build.sh')
  const live = new Map<string, ChildProcess>()

  const unsupported = (role: WorkerRole, placement: Placement): Unsupported | null => {
    if (placement !== 'headless') {
      return { ok: false, reason: 'placement-unavailable', detail: 'Codex runner only hosts cross-provider headless work' }
    }
    if (!SUPPORTED_ROLES.has(role)) {
      return { ok: false, reason: 'capability-unsupported', detail: `Codex runner does not support role ${role}` }
    }
    return probe.ok ? null : probe
  }

  return {
    provider: 'openai-codex',
    supports(role, placement) {
      return unsupported(role, placement) ?? { ok: true }
    },
    async run(req, placement, signal): Promise<BoundedWorkOutcome> {
      const refusal = unsupported(req.role, placement)
      if (refusal) return { kind: 'refused', reason: refusal.reason }

      const env = scrubGithubEnv({
        ...baseEnv,
        CODEX_BUILD_MODEL: req.model_id,
        CODEX_BUILD_EFFORT: req.effort ?? '',
        CODEX_REVIEW_MODEL: req.model_id,
        NEUTRON_CODEX_BUILD_BRIEF_FILE: req.brief.path,
        NEUTRON_CODEX_BUILD_BRIEF_INTEGRITY: req.brief.integrity,
        NEUTRON_CODEX_BUILD_TRAILER_FILE: req.result.path,
        NEUTRON_CODEX_THREAD_ID: req.thread?.id ?? '',
      })
      const child = spawn('/bin/bash', [buildScript], { cwd: req.cwd, env, stdio: 'ignore' })
      live.set(req.step_id, child)
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
      }, req.budget.wall_ms)
      const settled = await waitFor(child, signal)
      clearTimeout(timer)
      live.delete(req.step_id)
      if (settled.killed || signal.aborted) return { kind: 'failed', class: 'killed', detail: 'Codex worker was cancelled' }
      if (timedOut) return { kind: 'failed', class: 'timeout', detail: 'Codex worker exceeded its wall-clock budget' }
      if (settled.code !== 0) {
        if (settled.code === 10 || settled.code === 11) return { kind: 'refused', reason: 'provider-not-connected' }
        if (settled.code === 3) return { kind: 'refused', reason: 'cli-contract' }
        return { kind: 'failed', class: 'infra', detail: `Codex wrapper exited ${settled.code ?? 'without status'}` }
      }
      let trailerText: string
      try {
        trailerText = await readFile(req.result.path, 'utf8')
      } catch {
        return { kind: 'unknown', detail: 'Codex wrapper exited successfully without a readable trailer' }
      }
      const result = parseTrailer(trailerText)
      if (!result) return { kind: 'unknown', detail: 'Codex wrapper wrote a malformed trailer' }
      return {
        kind: 'completed',
        result,
        usage: { input_tokens: 0, output_tokens: 0 },
        model_reported: req.model_id,
        thread_id: req.thread?.id ?? null,
      }
    },
    async liveness(handle: WorkerHandle) {
      const child = live.get(handle.step_id)
      return child && child.exitCode === null ? 'activity' : 'nothing'
    },
  }
}
