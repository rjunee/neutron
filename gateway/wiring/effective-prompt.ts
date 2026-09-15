/** Exact harness dispatch inputs, not a reconstruction from mutable persona files. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { AgentSpec } from '@neutronai/runtime/substrate.ts'

export class PromptCaptureError extends Error {
  constructor() { super('prompt_capture_failed: Could not record the effective prompt; this turn was not dispatched.') }
}

export interface EffectivePrompt {
  format_version: 1
  observed_at: number
  session_start: AgentSpec | null
  latest_dispatch: AgentSpec
}

export function effectivePromptPath(home: string, project: string, topic: string): string {
  const key = createHash('sha256').update(JSON.stringify([project, topic])).digest('hex')
  return join(home, '.effective-prompts', `${key}.json`)
}

export function readEffectivePrompt(path: string): EffectivePrompt | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as EffectivePrompt
    if (value?.format_version !== 1 || !Number.isFinite(value.observed_at) ||
        !isSpec(value.latest_dispatch) || (value.session_start !== null && !isSpec(value.session_start))) {
      throw new Error('Invalid effective prompt record')
    }
    return value
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

function isSpec(value: AgentSpec | null | undefined): boolean {
  return value !== null && value !== undefined && typeof value.prompt === 'string' &&
    Array.isArray(value.tools) && Array.isArray(value.model_preference)
}

export function recordEffectivePrompt(path: string, spec: AgentSpec, cold: boolean): void {
  try {
    const prior = cold ? null : readEffectivePrompt(path)
    const record: EffectivePrompt = {
      format_version: 1,
      observed_at: Date.now(),
      session_start: cold ? spec : prior?.session_start ?? null,
      latest_dispatch: spec,
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const tmp = `${path}.${randomUUID()}.tmp`
    writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600, flag: 'wx' })
    renameSync(tmp, path)
  } catch { throw new PromptCaptureError() }
}
