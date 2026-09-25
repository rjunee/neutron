/** Read native operation receipts; never execute transcript content or infer whole-turn phases. */
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { DirectPhaseObservation } from './build-timeline-sources.ts'

type Link = { repository: string; prNumber: number }
export interface CodexOperationBinding {
  /** Explicitly attested worktree interval. Session cwd alone is never a binding. */
  cwd: string
  startedAt: number
  endedAt: number
  links: Link[]
}
export interface CodexImportOptions {
  repositories: string[]
  bindings?: CodexOperationBinding[]
  /** Opaque private evidence reference, not transcript text or an absolute path. */
  evidenceRef: string
  maxBytes?: number
  maxLines?: number
}
export interface CodexImportCoverage {
  lines: number
  commandReceipts: number
  emitted: number
  unsupportedCommands: number
  unbound: number
  incomplete: number
  malformed: number
  duplicate: number
  tokenCoverage: 'unknown'
}
type Obj = Record<string, unknown>
const object = (x: unknown): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x)
const stamp = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0
const repository = (x: string): boolean => /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(x)
function cwd(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try { return value.startsWith('file:') ? fileURLToPath(value) : value } catch { return null }
}

/** Intentionally small shell grammar. Reject compound commands, substitution and redirection. */
function words(command: string): string[] | null {
  const result: string[] = []
  let token = '', quote = '', active = false
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (c === '\n' || c === '\r' || c === '$' || c === '`') return null
    if (quote) {
      if (c === quote) quote = ''
      else if (c === '\\' && quote === '"') { if (++i === command.length) return null; token += command[i]! }
      else token += c
    } else if (c === "'" || c === '"') { quote = c; active = true }
    else if (/[;&|<>()]/.test(c)) return null
    else if (c === '\\') { if (++i === command.length) return null; token += command[i]!; active = true }
    else if (/\s/.test(c)) { if (active) result.push(token); token = ''; active = false }
    else { token += c; active = true }
  }
  if (quote) return null
  if (active) result.push(token)
  return result
}
function argv(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) return null
  if (value.length === 3 && /(?:^|\/)(?:ba|z)?sh$/.test(value[0]!) && /^-[a-z]*c[a-z]*$/.test(value[1]!)) return words(value[2]!)
  return value
}
function classify(args: string[]): { phase: string; label: string } | null {
  let a = args
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0] ?? '')) a = a.slice(1)
  if ((a[0] === 'bun' && a[1] === 'test') || (['npm', 'pnpm', 'yarn'].includes(a[0] ?? '') && a[1] === 'test')) return { phase: 'test', label: 'Local test command' }
  if (['bash', 'sh'].includes(a[0] ?? '') && a[1] === 'scripts/run-tests.sh') return { phase: 'test', label: 'Host test suite' }
  if (a[0] === 'gh' && a[1] === 'pr' && ['create', 'merge'].includes(a[2] ?? '')) return { phase: a[2] === 'merge' ? 'merge' : 'publish', label: a[2] === 'merge' ? 'PR merge command' : 'PR create command' }
  return null
}
function directLink(args: string[], item: Obj, allowed: Set<string>): Link | null {
  if (args[0] !== 'gh' || args[1] !== 'pr' || item.exit_code !== 0) return null
  const repoAt = args.findIndex(a => a === '--repo' || a === '-R')
  const repo = repoAt >= 0 ? args[repoAt + 1] : args.find(a => a.startsWith('--repo='))?.slice(7)
  if (args[2] === 'merge' && repo && allowed.has(repo) && /^[1-9]\d*$/.test(args[3] ?? '')) return { repository: repo, prNumber: Number(args[3]) }
  if (args[2] !== 'create' || typeof item.stdout !== 'string') return null
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)$/.exec(item.stdout.trim())
  if (!match || !allowed.has(match[1]!) || (repo !== undefined && repo !== match[1])) return null
  return { repository: match[1]!, prNumber: Number(match[2]) }
}

export async function importCodexOperations(lines: AsyncIterable<string> | Iterable<string>, options: CodexImportOptions): Promise<{ observations: DirectPhaseObservation[]; coverage: CodexImportCoverage }> {
  if (!options.repositories.length || !options.repositories.every(repository) || !/^[\w:./-]{1,240}$/.test(options.evidenceRef) || options.evidenceRef.startsWith('/')) throw new Error('Invalid import scope or opaque evidence reference')
  const allowed = new Set(options.repositories)
  const bindings = options.bindings ?? []
  for (const b of bindings) {
    if (!b.cwd || !stamp(b.startedAt) || !stamp(b.endedAt) || b.endedAt < b.startedAt || !b.links.length || !b.links.every(l => allowed.has(l.repository) && Number.isSafeInteger(l.prNumber) && l.prNumber > 0)) throw new Error('Invalid explicit worktree binding')
  }
  const maxBytes = options.maxBytes ?? 512 * 1024 * 1024, maxLines = options.maxLines ?? 1_000_000
  if (!stamp(maxBytes) || !stamp(maxLines) || !maxBytes || !maxLines) throw new Error('Invalid import bounds')
  const coverage: CodexImportCoverage = { lines: 0, commandReceipts: 0, emitted: 0, unsupportedCommands: 0, unbound: 0, incomplete: 0, malformed: 0, duplicate: 0, tokenCoverage: 'unknown' }
  const observations: DirectPhaseObservation[] = [], seen = new Set<string>()
  const contexts = new Map<string, Array<{ at: number; model: string }>>()
  let sessionId: string | undefined, parentSessionId: string | undefined, bytes = 0
  for await (const line of lines) {
    coverage.lines++
    bytes += Buffer.byteLength(line) + 1
    if (coverage.lines > maxLines || bytes > maxBytes || Buffer.byteLength(line) > 8 * 1024 * 1024) throw new Error('Codex import exceeds bounded input limits')
    if (!line.trim()) continue
    let r: unknown
    try { r = JSON.parse(line) } catch { coverage.malformed++; continue }
    if (!object(r) || !object(r.payload)) { coverage.malformed++; continue }
    const p = r.payload
    if (r.type === 'session_meta') {
      if (sessionId !== undefined || typeof p.id !== 'string' || !p.id) throw new Error('Repeated or invalid native session identity')
      sessionId = p.id
      const spawn = object(p.source) && object(p.source.subagent) && object(p.source.subagent.thread_spawn) ? p.source.subagent.thread_spawn : null
      if (spawn && typeof spawn.parent_thread_id === 'string') parentSessionId = spawn.parent_thread_id
      continue
    }
    if (r.type === 'turn_context' && typeof p.turn_id === 'string' && typeof p.model === 'string' && p.model) {
      const at = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN
      if (stamp(at)) { const history = contexts.get(p.turn_id) ?? []; history.push({ at, model: p.model }); contexts.set(p.turn_id, history) }
      continue
    }
    if (r.type !== 'event_msg' || p.type !== 'item_completed' || !object(p.item) || p.item.type !== 'CommandExecution') continue
    coverage.commandReceipts++
    const item = p.item
    if (!sessionId || p.thread_id !== sessionId || typeof p.turn_id !== 'string' || typeof item.id !== 'string' || !item.id) { coverage.malformed++; continue }
    const args = argv(item.command), classification = args && classify(args)
    if (!args || !classification) { coverage.unsupportedCommands++; continue }
    // No end guessed from observation time, polling, or the last file modification.
    if (!stamp(p.started_at_ms) || !stamp(p.completed_at_ms) || p.completed_at_ms < p.started_at_ms || !['completed', 'failed'].includes(String(item.status)) || !Number.isInteger(item.exit_code)) { coverage.incomplete++; continue }
    const id = `codex:${sessionId}:${item.id}`
    if (seen.has(id)) { coverage.duplicate++; continue }
    seen.add(id)
    const exact = directLink(args, item, allowed)
    const start = p.started_at_ms, end = p.completed_at_ms
    const candidates = bindings.filter(b => cwd(item.cwd) === b.cwd && start >= b.startedAt && end <= b.endedAt)
    const links = exact ? [exact] : candidates.length === 1 ? candidates[0]!.links : []
    if (!links.length || (!exact && classification.phase !== 'test')) { coverage.unbound++; continue }
    const model = (contexts.get(p.turn_id) ?? []).filter(c => c.at <= (p.started_at_ms as number)).sort((a, b) => b.at - a.at)[0]?.model ?? null
    observations.push({
      eventId: id, phaseId: id, links, ...classification, model,
      startedAt: p.started_at_ms, endedAt: p.completed_at_ms,
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, costUsd: null,
      source: { kind: 'codex-log', sessionId, turnId: p.turn_id, ...(parentSessionId ? { parentSessionId } : {}), sourceEventId: item.id,
        evidenceRef: `${options.evidenceRef}:${coverage.lines}`, attribution: 'reconstructed',
        basis: `${exact ? 'Successful native GitHub command identifies PR' : 'Explicit time-bounded worktree-to-PR binding'}; native operation timestamps; model is invoking Codex model; exit ${item.exit_code}; shell-operation token attribution unknown` },
      observedAt: p.completed_at_ms,
    })
  }
  coverage.emitted = observations.length
  return { observations, coverage }
}

if (import.meta.main) {
  try {
    const [rollout, config, ...extra] = process.argv.slice(2)
    if (!rollout || !config || extra.length) throw new Error('Usage: bun scripts/build-timeline-codex-import.ts ROLLOUT.jsonl PRIVATE-CONFIG.json')
    const options: CodexImportOptions = JSON.parse(await readFile(config, 'utf8'))
    const input = createInterface({ input: createReadStream(rollout), crlfDelay: Infinity })
    try {
      const result = await importCodexOperations(input, options)
      for (const observation of result.observations) process.stdout.write(JSON.stringify(observation) + '\n')
      process.stderr.write(JSON.stringify(result.coverage) + '\n')
    } finally { input.close() }
  } catch { process.stderr.write('Codex operation import refused: check scope, native input, and bounds.\n'); process.exitCode = 1 }
}
