/**
 * @neutronai/skill-forge — the `/skills` chat command.
 *
 * The owner-facing twin of the `skill_forge_*` tools (`tool.ts`). Agent-native
 * parity: this command and the tools call the SAME `SkillForgeBackend`
 * (`backend.ts`) — neither owns lifecycle logic. Shaped as a `ChatCommandFilter`
 * (`gateway/http/app-ws-surface.ts`) so it chains into the Open chat path
 * exactly like the free-Core `/cal` / `/email` / `/remind` filters: a typed
 * `/skills` is handled BEFORE the LLM turn; anything else falls through (`null`).
 *
 * Grammar:
 *   /skills                       → list pending proposals (same as `list`)
 *   /skills list                  → list pending proposals
 *   /skills approve <id> [name]   → approve a proposal (optional rename)
 *   /skills decline <id>          → decline a proposal
 *   /skills help                  → help
 */

import type { SkillForgeBackend } from './backend.ts'
import type { ProposalEdits, ProposalRecord } from './types.ts'

/** What the gateway's app-ws filter passes to `match`. Mirrors (structurally,
 *  no gateway dependency) the `ChatCommandFilter` shape in
 *  `gateway/http/app-ws-surface.ts` — the same pattern the free-Core filters use
 *  (`cores/free/notes/src/chat-bridge.ts`). */
export interface SkillForgeChatCommandFilterInput {
  user_id: string
  project_slug: string
  channel_topic_id: string
  project_id?: string
  body: string
}

/** What the filter returns when the inbound matches `/skills`. */
export type ChatCommandFilterResult = {
  text: string
  data?: unknown
  deep_link?: string
  error?: { code: string; message: string }
}

export interface SkillForgeChatCommandFilter {
  match(
    input: SkillForgeChatCommandFilterInput,
  ): Promise<ChatCommandFilterResult | null>
}

export type SkillForgeCommand =
  | { kind: 'list' }
  | { kind: 'approve'; id: string; name?: string }
  | { kind: 'decline'; id: string }
  | { kind: 'help' }
  | { kind: 'unrecognized'; reason: string }

const VERB = '/skills'

/**
 * Pure parser. `/skills` alone → list; `/skills approve|decline <id>` →
 * a decision; `/skills help` → help. Returns `unrecognized` with
 * `not_a_skills_command` for any body that isn't a `/skills` command so the
 * filter falls through to the LLM.
 */
export function parseSkillForgeCommand(raw: string): SkillForgeCommand {
  const trimmed = raw.trimStart()
  if (!trimmed.startsWith(VERB)) return { kind: 'unrecognized', reason: 'not_a_skills_command' }
  const after = trimmed.slice(VERB.length)
  // `/skillsfoo` is not the command; require end-of-token after the verb.
  if (after.length > 0 && !/^\s/.test(after)) {
    return { kind: 'unrecognized', reason: 'not_a_skills_command' }
  }
  const body = after.trim()
  if (body.length === 0) return { kind: 'list' }

  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(body)
  if (m === null) return { kind: 'unrecognized', reason: 'malformed' }
  const sub = (m[1] ?? '').toLowerCase()
  const rest = (m[2] ?? '').trim()

  if (sub === 'help') return { kind: 'help' }
  if (sub === 'list' || sub === 'ls' || sub === 'pending') return { kind: 'list' }
  if (sub === 'approve' || sub === 'accept' || sub === 'decline' || sub === 'reject') {
    const parts = rest.split(/\s+/).filter((p) => p.length > 0)
    const id = parts[0] ?? ''
    if (id.length === 0) {
      return {
        kind: 'unrecognized',
        reason: `\`/skills ${sub}\` needs a proposal id — try \`/skills list\` first.`,
      }
    }
    if (sub === 'approve' || sub === 'accept') {
      const name = parts.length > 1 ? parts.slice(1).join(' ') : undefined
      return name !== undefined ? { kind: 'approve', id, name } : { kind: 'approve', id }
    }
    return { kind: 'decline', id }
  }
  return {
    kind: 'unrecognized',
    reason: `unknown \`/skills\` subcommand "${sub}" — try \`/skills help\`.`,
  }
}

/** Execute the parsed command against the shared backend. */
export async function executeSkillForgeCommand(
  cmd: SkillForgeCommand,
  backend: SkillForgeBackend,
): Promise<ChatCommandFilterResult> {
  switch (cmd.kind) {
    case 'help':
      return { text: HELP_TEXT }
    case 'unrecognized':
      return {
        text: `Sorry, I couldn't parse that \`/skills\` command (${cmd.reason}).`,
        error: { code: 'malformed', message: cmd.reason },
      }
    case 'list':
      return executeList(backend)
    case 'approve':
      return executeApprove(cmd, backend)
    case 'decline':
      return executeDecline(cmd, backend)
  }
}

async function executeList(backend: SkillForgeBackend): Promise<ChatCommandFilterResult> {
  let pending: ProposalRecord[]
  try {
    pending = await backend.listPending()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { text: `🛠 Couldn't read Skill Forge proposals: ${message}`, error: { code: 'backend_error', message } }
  }
  if (pending.length === 0) {
    return { text: '🛠 *Skill Forge* — no pending proposals.', data: { proposals: [] } }
  }
  const lines: string[] = ['🛠 *Skill Forge* — pending proposals:']
  for (const p of pending) {
    lines.push(`• \`${p.id}\` — *${p.proposed_name}*: ${p.what_it_does}`)
  }
  lines.push('')
  lines.push('Approve with `/skills approve <id>` or decline with `/skills decline <id>`.')
  return {
    text: lines.join('\n'),
    data: { proposals: pending.map((p) => ({ id: p.id, proposed_name: p.proposed_name })) },
  }
}

async function executeApprove(
  cmd: Extract<SkillForgeCommand, { kind: 'approve' }>,
  backend: SkillForgeBackend,
): Promise<ChatCommandFilterResult> {
  try {
    const edits: ProposalEdits | undefined = cmd.name !== undefined ? { name: cmd.name } : undefined
    const result = await backend.approve(cmd.id, edits)
    return {
      text:
        `🛠 Approved proposal \`${cmd.id}\` → saved skill *${result.proposal.proposed_name}*. ` +
        `It's now agent-discoverable on every turn.`,
      data: { id: result.proposal.id, skill_path: result.skill_path },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { text: `🛠 \`/skills approve\` failed: ${message}`, error: { code: 'backend_error', message } }
  }
}

async function executeDecline(
  cmd: Extract<SkillForgeCommand, { kind: 'decline' }>,
  backend: SkillForgeBackend,
): Promise<ChatCommandFilterResult> {
  try {
    const declined = await backend.decline(cmd.id)
    return { text: `🛠 Declined proposal \`${cmd.id}\`. Nothing was saved.`, data: { id: declined.id } }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { text: `🛠 \`/skills decline\` failed: ${message}`, error: { code: 'backend_error', message } }
  }
}

/**
 * Build the `ChatCommandFilter` for `/skills`, backed by the shared backend.
 * Returns `null` for any body that isn't a `/skills` command so the chat path
 * falls through to the LLM turn — the same contract the free-Core filters use.
 */
export function buildSkillForgeChatCommandFilter(
  backend: SkillForgeBackend,
): SkillForgeChatCommandFilter {
  return {
    async match(
      input: SkillForgeChatCommandFilterInput,
    ): Promise<ChatCommandFilterResult | null> {
      const cmd = parseSkillForgeCommand(input.body)
      if (cmd.kind === 'unrecognized' && cmd.reason === 'not_a_skills_command') return null
      return executeSkillForgeCommand(cmd, backend)
    },
  }
}

const HELP_TEXT = `Manage saved skills — \`/skills\` cheatsheet:

- \`/skills\` (or \`/skills list\`) — show pending Skill Forge proposals.
- \`/skills approve <id>\` — save a proposal as a skill (optional: \`/skills approve <id> <new-name>\`).
- \`/skills decline <id>\` — discard a proposal (nothing is saved).

Skill Forge proposes a skill after you complete a repeatable multi-step workflow. Nothing is ever saved until you approve.`
