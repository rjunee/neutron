/**
 * @neutronai/onboarding/overnight — STATUS.md `## Autonomous Overnight Work`
 * sync (agent-maintained, chat-driven).
 *
 * The AGENT renders this STATUS.md block from the `overnight_queue` rows;
 * the user never edits it. This is the Neutron-Open port of Vajra's
 * `overnight-table.ts` grammar:
 *
 *   ## Autonomous Overnight Work
 *
 *   - [ ] Add pagination [owk:owk-20260619-001] [agent:forge] \
 *         [owk-status:queued] [priority:P2] [context:docs/specs/pager.md]
 *   - [x] ~~Fix scribe regression~~ [owk:owk-20260618-014] [agent:forge] \
 *         [owk-status:completed] [priority:P2] [result:PR#36]
 *
 * Two Neutron divergences from Vajra (intentional):
 *   1. `[context:<path>]` resolves relative to the PROJECT REPO ROOT
 *      (`Projects/<slug>/`), not VAJRA_HOME — each project owns its context
 *      files.
 *   2. The bullets are RENDERED from the SQLite queue (runtime truth), so
 *      this module is render-first; parsing exists only for round-trip
 *      tests + the migration of any hand-seeded block.
 *
 * The `[context:]` HARD GATE is preserved verbatim from Vajra: a queued item
 * with no resolvable context file is rejected at dispatch (see
 * `partitionByContextGate`). 64 KB cap, no absolute paths, no `..`
 * traversal, symlink-escape rejected.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type {
  OvernightAgentRole,
  OvernightItem,
  OvernightPriority,
  OvernightStatus,
} from './queue-store.ts'

export const OVERNIGHT_SECTION_HEADING = '## Autonomous Overnight Work'
export const OVERNIGHT_OPT_IN_KEY = 'autonomous_overnight_enabled'

const BULLET_RE = /^- \[( |x|X)\]\s*(.*)$/
const TAG_RE = /\[([a-zA-Z0-9_-]+):([^\]]+)\]/g
const ID_RE = /^owk-\d{8}-\d{3,}$/

export function isValidOwkId(id: string): boolean {
  return ID_RE.test(id)
}

function asAgent(s: string | undefined): OvernightAgentRole | null {
  return s === 'forge' || s === 'atlas' ? s : null
}
function asPriority(s: string | undefined): OvernightPriority | null {
  return s === 'P1' || s === 'P2' || s === 'P3' ? s : null
}
function asStatus(s: string | undefined): OvernightStatus | null {
  if (s === 'queued' || s === 'in-flight' || s === 'completed' || s === 'failed') return s
  return null
}

// ---------------------------------------------------------------------------
// Parsing (round-trip / hand-seed migration)
// ---------------------------------------------------------------------------

/** A bullet parsed from STATUS.md. `id: ''` for a bare bullet (no `[owk:]`). */
export interface ParsedBullet {
  id: string
  agent_role: OvernightAgentRole
  status: OvernightStatus
  priority: OvernightPriority
  description: string
  context_relpath: string | null
  result: string | null
  created_at: string | null
}

export function parseOvernightLine(line: string): ParsedBullet | null {
  const m = BULLET_RE.exec(line.trimEnd())
  if (!m) return null
  const completedCheckbox = (m[1] ?? '').toLowerCase() === 'x'
  const body = m[2] ?? ''
  const tags = new Map<string, string>()
  for (const t of body.matchAll(TAG_RE)) {
    const key = t[1]
    const val = t[2]
    if (key === undefined || val === undefined) continue
    tags.set(key, val.trim())
  }

  let desc = body.replace(TAG_RE, '').trim()
  desc = desc.replace(/^~~(.+?)~~$/, '$1').trim().replace(/\s+/g, ' ')

  // A present-but-malformed agent/priority tag is a typo, not the default —
  // skip the bullet so a mistyped `[agent:atals]` doesn't misroute work.
  const agentTag = tags.get('agent')
  const agentParsed = asAgent(agentTag)
  let agent_role: OvernightAgentRole
  if (agentParsed) agent_role = agentParsed
  else if (agentTag !== undefined) return null
  else agent_role = 'forge'

  const priorityTag = tags.get('priority')
  const priorityParsed = asPriority(priorityTag)
  let priority: OvernightPriority
  if (priorityParsed) priority = priorityParsed
  else if (priorityTag !== undefined) return null
  else priority = 'P3'

  // Disk checkbox `[x]` wins over a stale `[owk-status:queued]` tag.
  const status: OvernightStatus = completedCheckbox
    ? 'completed'
    : asStatus(tags.get('owk-status')) ?? 'queued'

  const rawId = tags.get('owk')
  const id = rawId && isValidOwkId(rawId) ? rawId : ''

  return {
    id,
    agent_role,
    status,
    priority,
    description: desc,
    context_relpath: tags.get('context') ?? null,
    result: tags.get('result') ?? null,
    created_at: tags.get('created') ?? null,
  }
}

/** Parse every bullet under `## Autonomous Overnight Work`. */
export function parseOvernightSection(statusMd: string): ParsedBullet[] {
  const lines = statusMd.split('\n')
  const out: ParsedBullet[] = []
  let inSection = false
  for (const line of lines) {
    if (line.startsWith('## ')) {
      inSection = line.trim() === OVERNIGHT_SECTION_HEADING
      continue
    }
    if (!inSection) continue
    if (!line.trimStart().startsWith('- [')) continue
    const item = parseOvernightLine(line)
    if (item) out.push(item)
  }
  return out
}

// ---------------------------------------------------------------------------
// Opt-in frontmatter flag
// ---------------------------------------------------------------------------

/** Whether STATUS.md frontmatter carries `autonomous_overnight_enabled: true`. */
export function parseOptInFlag(statusMd: string): boolean {
  if (!statusMd.startsWith('---')) return false
  const end = statusMd.indexOf('\n---', 3)
  if (end === -1) return false
  for (const raw of statusMd.slice(3, end).split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf(':')
    if (eq === -1) continue
    if (line.slice(0, eq).trim() !== OVERNIGHT_OPT_IN_KEY) continue
    let val = line.slice(eq + 1)
    const hashIdx = val.search(/\s+#/)
    if (hashIdx >= 0) val = val.slice(0, hashIdx)
    val = val.trim().replace(/['"]/g, '').toLowerCase()
    return val === 'true' || val === 'yes' || val === '1'
  }
  return false
}

// ---------------------------------------------------------------------------
// [context:<path>] hard gate
// ---------------------------------------------------------------------------

/** Cap on the file pulled into a run prompt via `[context:<path>]`. */
export const MAX_CONTEXT_FILE_BYTES = 64 * 1024

export interface ContextResolution {
  text?: string
  error?: string
}

/**
 * Resolve `[context:<path>]` relative to `repoRoot` (the project repo).
 * Rejects absolute paths, `..` traversal, symlink-escape, missing files,
 * and files over the 64 KB cap. Verbatim port of Vajra's `resolveContextFile`
 * with the repo root re-pointed at the per-project repo.
 */
export function resolveContextFile(repoRoot: string, rawPath: string): ContextResolution {
  const candidate = rawPath?.trim()
  if (!candidate) return { error: 'empty context path' }
  if (candidate.startsWith('/')) {
    return { error: `absolute context path rejected: ${candidate}` }
  }
  if (candidate.split(/[\\/]/).some((seg) => seg === '..')) {
    return { error: `parent-directory segment rejected in context path: ${candidate}` }
  }
  const full = join(repoRoot, candidate)
  if (!existsSync(full)) return { error: `context file not found: ${candidate}` }
  let resolved: string
  let resolvedRoot: string
  try {
    resolved = realpathSync(full)
    resolvedRoot = realpathSync(repoRoot)
  } catch (e) {
    return { error: `realpath failed: ${candidate}: ${e}` }
  }
  const normalizedRoot = resolvedRoot.endsWith('/') ? resolvedRoot : `${resolvedRoot}/`
  if (!resolved.startsWith(normalizedRoot) && resolved !== resolvedRoot) {
    return { error: `context path escapes repo root (symlink): ${candidate}` }
  }
  let size: number
  try {
    size = statSync(resolved).size
  } catch (e) {
    return { error: `stat failed: ${candidate}: ${e}` }
  }
  if (size > MAX_CONTEXT_FILE_BYTES) {
    return { error: `context file too large (${size}B > ${MAX_CONTEXT_FILE_BYTES}B): ${candidate}` }
  }
  try {
    return { text: readFileSync(resolved, 'utf8') }
  } catch (e) {
    return { error: `read failed: ${candidate}: ${e}` }
  }
}

export type ContextGateRejectionReason = 'missing-context-tag' | 'context-file-unresolved'

export interface ContextGateResult {
  /** The resolved context text, when the gate passed. */
  context_text?: string
  ok: boolean
  reason?: ContextGateRejectionReason
  detail?: string
}

/**
 * The HARD GATE: an item is dispatchable only if it carries a
 * `[context:<path>]` that resolves to a real file inside the project repo.
 * Double-enforced (scan reconcile + dispatch); this is the canonical check.
 */
export function checkContextGate(repoRoot: string, item: OvernightItem): ContextGateResult {
  const path = item.context_relpath?.trim()
  if (!path) {
    return { ok: false, reason: 'missing-context-tag', detail: 'missing [context:<path>] tag' }
  }
  const res = resolveContextFile(repoRoot, path)
  if (res.error !== undefined || res.text === undefined) {
    return {
      ok: false,
      reason: 'context-file-unresolved',
      detail: res.error ?? 'context file unresolved',
    }
  }
  return { ok: true, context_text: res.text }
}

// ---------------------------------------------------------------------------
// Rendering (the agent's STATUS.md surface)
// ---------------------------------------------------------------------------

function escapeTagValue(v: string): string {
  return v.replace(/\]/g, '⟧')
}

/** Serialize one queue item to a bullet line (parser-compatible). */
export function renderOvernightLine(item: OvernightItem): string {
  const checkbox = item.status === 'completed' ? '[x]' : '[ ]'
  const desc = item.status === 'completed' ? `~~${item.description}~~` : item.description
  const tags: string[] = [
    `[owk:${item.id}]`,
    `[agent:${item.agent_role}]`,
    `[owk-status:${item.status}]`,
    `[priority:${item.priority}]`,
    `[created:${item.created_at}]`,
  ]
  if (item.finished_at) tags.push(`[finished:${item.finished_at}]`)
  if (item.result) tags.push(`[result:${escapeTagValue(item.result)}]`)
  if (item.context_relpath) tags.push(`[context:${item.context_relpath}]`)
  return `- ${checkbox} ${desc} ${tags.join(' ')}`
}

function sortItems(items: OvernightItem[]): OvernightItem[] {
  const order: Record<OvernightStatus, number> = {
    'in-flight': 0,
    queued: 1,
    failed: 2,
    completed: 3,
  }
  return [...items].sort((a, b) => {
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status]
    if (a.status === 'queued' && a.priority !== b.priority) {
      return a.priority.localeCompare(b.priority)
    }
    if (a.status === 'completed' || a.status === 'failed') {
      const aFin = a.finished_at ?? ''
      const bFin = b.finished_at ?? ''
      if (aFin !== bFin) return bFin.localeCompare(aFin)
    }
    return a.id.localeCompare(b.id)
  })
}

/** Render the full `## Autonomous Overnight Work` section text. */
export function renderOvernightSection(items: OvernightItem[]): string {
  const ordered = sortItems(items)
  let body = `${OVERNIGHT_SECTION_HEADING}\n\n`
  if (ordered.length > 0) {
    body += ordered.map(renderOvernightLine).join('\n') + '\n'
  } else {
    body += '_No overnight work queued._\n'
  }
  return body
}

/**
 * Splice the rendered section into a STATUS.md document, preserving every
 * byte outside the section. Appends the section (after a blank line) when
 * STATUS.md has no such heading yet.
 */
export function spliceOvernightSection(statusMd: string, newSection: string): string {
  const lines = statusMd.split('\n')
  let startIdx = -1
  let endIdx = lines.length
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() === OVERNIGHT_SECTION_HEADING) {
      startIdx = i
      for (let j = i + 1; j < lines.length; j++) {
        if ((lines[j] ?? '').startsWith('## ')) {
          endIdx = j
          break
        }
      }
      break
    }
  }
  const normalized = newSection.replace(/\n+$/, '\n')
  if (startIdx === -1) {
    const sep = statusMd.endsWith('\n') ? '\n' : '\n\n'
    return statusMd + sep + normalized
  }
  let precedingBlank = 0
  for (let i = startIdx - 1; i >= 0 && lines[i] === ''; i--) precedingBlank++
  const before = lines.slice(0, startIdx - precedingBlank).join('\n')
  let followingBlank = 0
  for (let i = endIdx - 1; i >= startIdx && lines[i] === ''; i--) followingBlank++
  const after = lines.slice(endIdx).join('\n')
  const joinerBefore = before.length > 0 ? '\n'.repeat(precedingBlank + 1) : ''
  const joinerAfter = after.length > 0 ? '\n'.repeat(followingBlank) : ''
  const beforeBlock = before + joinerBefore
  if (after.length === 0) {
    if (statusMd.endsWith('\n')) return `${beforeBlock}${normalized}${joinerAfter}`
    return `${beforeBlock}${normalized.replace(/\n$/, '')}${joinerAfter}`
  }
  return `${beforeBlock}${normalized}${joinerAfter}${after}`
}

/**
 * Read STATUS.md, render the section from the supplied queue items, and write
 * it back atomically. No-op when the file is missing or unchanged. The writer
 * is injected so tests can assert against an in-memory fs.
 */
export interface StatusMdIO {
  read(path: string): string | null
  write(path: string, content: string): void
}

export function syncStatusMdSection(
  statusMdPath: string,
  items: OvernightItem[],
  io: StatusMdIO,
): boolean {
  const body = io.read(statusMdPath)
  if (body === null) return false
  const next = spliceOvernightSection(body, renderOvernightSection(items))
  if (next === body) return false
  io.write(statusMdPath, next)
  return true
}
