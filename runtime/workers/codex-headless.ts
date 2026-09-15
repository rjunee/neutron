import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type {
  BoundedWorkOutcome,
  Effort,
  Placement,
  RefusalReason,
  Unsupported,
  WorkerHandle,
  WorkerRole,
  WorkerRunner,
} from '../bounded-work.ts'
import { unknownCause } from '../refusal-cause.ts'

type Probe = { ok: true } | { ok: false; reason: RefusalReason; detail: string }

export interface CodexHeadlessRunnerOptions {
  readonly buildScript?: string
  readonly env?: NodeJS.ProcessEnv
  readonly probe?: Probe
}

// Keep the selected contract value intact when passing it to the exec wrapper.
const CLI_EFFORTS: Record<Effort, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }

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

type TrailerClaim = { head: string; diff: string; pr: null }
type TrailerMapping = { kind: 'mapped'; result: TrailerClaim } | Extract<BoundedWorkOutcome, { kind: 'unknown' }>

// The wrapper names a diff artifact, not inline diff text. Both remain claims;
// only the driver can corroborate them with its independent measurement.
async function mapTrailer(text: string, cwd: string, runId: string): Promise<TrailerMapping> {
  const fields = new Map<string, string>()
  for (const line of text.split('\n')) {
    if (line === '') continue
    const separator = line.indexOf('=')
    if (separator <= 0) return { kind: 'unknown', detail: 'Codex wrapper wrote a malformed trailer' }
    const key = line.slice(0, separator)
    if (fields.has(key)) return { kind: 'unknown', detail: `Codex trailer repeats ${key}` }
    fields.set(key, line.slice(separator + 1))
  }
  for (const field of ['HEAD', 'DIFF', 'PR']) {
    if (!fields.has(`NEUTRON_CODEX_BUILD_${field}`)) {
      return { kind: 'unknown', detail: `Codex trailer is missing NEUTRON_CODEX_BUILD_${field}` }
    }
  }
  const head = fields.get('NEUTRON_CODEX_BUILD_HEAD')!
  const diffPath = fields.get('NEUTRON_CODEX_BUILD_DIFF')!
  const pr = fields.get('NEUTRON_CODEX_BUILD_PR')!
  if (head === '') return { kind: 'unknown', detail: 'Codex trailer has empty NEUTRON_CODEX_BUILD_HEAD' }
  if (diffPath === '') return { kind: 'unknown', detail: 'Codex trailer has empty NEUTRON_CODEX_BUILD_DIFF' }
  // The current wrapper asserts no PR with an explicit empty value. A number
  // alone cannot supply the PR head and state required by the driver.
  if (pr !== '') return { kind: 'unknown', detail: 'Codex trailer is missing pr.head and pr.state for NEUTRON_CODEX_BUILD_PR' }
  try {
    const diff = await readFile(resolve(cwd, diffPath), 'utf8')
    return { kind: 'mapped', result: { head, diff, pr: null } }
  } catch (error) {
    return { kind: 'unknown', detail: unknownCause('Codex trailer NEUTRON_CODEX_BUILD_DIFF artifact is unreadable', error, runId) }
  }
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

      const effort = req.effort === null ? '' : CLI_EFFORTS[req.effort]
      const env = scrubGithubEnv({
        ...baseEnv,
        CODEX_BUILD_MODEL: req.model_id,
        CODEX_BUILD_EFFORT: effort,
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
      } catch (error) {
        return { kind: 'unknown', detail: unknownCause('Codex wrapper exited successfully without a readable trailer', error, req.run_id) }
      }
      const mapped = await mapTrailer(trailerText, req.cwd, req.run_id)
      if (mapped.kind === 'unknown') return mapped
      return {
        kind: 'completed',
        result: mapped.result,
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
