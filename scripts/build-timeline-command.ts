#!/usr/bin/env bun

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:os'
import { appendPhaseObservation, type DirectPhaseObservation } from './build-timeline-sources.ts'

export type CommandPhaseOptions = {
  output: string
  links: DirectPhaseObservation['links']
  phase: string
  /** Public display text, never a command or a local path. */
  label: string
  model: string | null
  argv: string[]
  /** Bounds the direct child; commands remain responsible for their descendants. */
  timeoutMs: number
}

export type CommandPhaseResult = {
  phaseId: string
  command: { outcome: 'exited' | 'signalled' | 'spawn-failed'; exitCode: number; signal: string | null }
  recording: { status: 'complete' } | { status: 'failed'; boundary: 'end' }
}

const phases = new Set(['plan', 'build', 'fix', 'review', 'test', 'ci', 'deploy'])

function publicText(value: unknown, field: string, spaces: boolean): void {
  const pattern = spaces ? /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,119}$/ : /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`invalid public ${field}`)
}

/** One explicitly attributed command, recorded before execution and at observed exit.
 * No signal handler guesses an end if this observer is killed. */
export async function recordCommandPhase(options: CommandPhaseOptions): Promise<CommandPhaseResult> {
  if (!phases.has(options.phase)) throw new Error('invalid command phase')
  publicText(options.label, 'label', true)
  if (options.model !== null) publicText(options.model, 'model', false)
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 86_400_000) {
    throw new Error('timeoutMs must be between 1 and 86400000')
  }
  if (!options.output || !Array.isArray(options.argv) || !options.argv.length ||
      options.argv.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !options.argv[0]) {
    throw new Error('output and a valid command argv are required')
  }
  const phaseId = `command:${randomUUID()}`
  const startedAt = Date.now()
  const start: DirectPhaseObservation = {
    eventId: randomUUID(), phaseId, links: options.links, phase: options.phase,
    label: options.label, model: options.model, startedAt, endedAt: null,
    inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, costUsd: null,
    source: { kind: 'orchestrator', attribution: 'explicit', evidenceRef: phaseId,
      basis: 'Explicit command attribution; start recorded before execution; end unknown' },
    observedAt: startedAt,
  }
  // The shared recorder validates provenance and links and locks the journal. A
  // refused start must prevent the command from running. Never expose its error's path.
  try { await appendPhaseObservation(options.output, start) }
  catch { throw new Error('command phase start recording refused; command not executed') }

  const command = await new Promise<CommandPhaseResult['command']>((resolve) => {
    try {
      const child = spawn(options.argv[0]!, options.argv.slice(1), {
        shell: false, stdio: 'inherit', timeout: options.timeoutMs, killSignal: 'SIGKILL',
      })
      child.once('error', () => resolve({ outcome: 'spawn-failed', exitCode: 127, signal: null }))
      child.once('exit', (code, signal) => resolve({
        outcome: signal ? 'signalled' : 'exited',
        exitCode: code ?? (signal ? 128 + constants.signals[signal] : 1), signal,
      }))
    } catch { resolve({ outcome: 'spawn-failed', exitCode: 127, signal: null }) }
  })
  const endedAt = Date.now()
  const end: DirectPhaseObservation = {
    ...start, eventId: randomUUID(), endedAt,
    // Millisecond-coincident snapshots need a strict ordering without inventing duration.
    observedAt: Math.max(endedAt, startedAt + 1),
    source: { ...start.source, basis: `Explicit command attribution; ${command.outcome}; exit code ${command.exitCode}${command.signal ? `; signal ${command.signal}` : ''}` },
  }
  try {
    await appendPhaseObservation(options.output, end)
    return { phaseId, command, recording: { status: 'complete' } }
  } catch {
    return { phaseId, command, recording: { status: 'failed', boundary: 'end' } }
  }
}

function parseOptions(args: string[]): CommandPhaseOptions {
  const separator = args.indexOf('--')
  if (separator < 0) throw new Error('expected options followed by -- and command argv')
  const options: CommandPhaseOptions = { output: '', links: [], phase: '', label: '', model: null,
    timeoutMs: NaN, argv: args.slice(separator + 1) }
  const seen = new Set<string>()
  for (let index = 0; index < separator; index += 2) {
    const flag = args[index]!, value = args[index + 1]
    if (!value || index + 1 >= separator || (flag !== '--pr' && seen.has(flag))) {
      throw new Error('missing or duplicate command phase option')
    }
    seen.add(flag)
    switch (flag) {
      case '--output': options.output = value; break
      case '--pr': {
        const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*)$/.exec(value)
        if (!match) throw new Error('PR must be owner/repository#number')
        options.links.push({ repository: match[1]!, prNumber: Number(match[2]) })
        break
      }
      case '--phase': options.phase = value; break
      case '--label': options.label = value; break
      case '--model': options.model = value === 'unknown' ? null : value; break
      case '--timeout-ms': options.timeoutMs = Number(value); break
      default: throw new Error('unknown command phase option')
    }
  }
  return options
}

if (import.meta.main) {
  try {
    const result = await recordCommandPhase(parseOptions(process.argv.slice(2)))
    // A separate receipt preserves the command exit even when the recorder failed.
    console.error(JSON.stringify({ type: 'command-phase-result', ...result }))
    process.exitCode = result.command.exitCode
  } catch (error) {
    console.error(JSON.stringify({ type: 'command-phase-refused', reason: error instanceof Error ? error.message : 'invalid command phase' }))
    process.exitCode = 125
  }
}
