/**
 * @neutronai/runtime — substrate-agnostic system-prompt assembler.
 *
 * Combines persona base, role block, instance context files (CLAUDE.md /
 * AGENTS.md / USER.md / TOOLS.md / IDENTITY.md / BOOTSTRAP.md from the
 * instance home), per-instance SOUL extensions, channel-specific platform hints,
 * an XML <available_skills> reference list, optional memory pointers and
 * heartbeat blocks, into the final system prompt.
 *
 * Concat order is locked so the cacheable prefix stays stable:
 *
 *   1. base_persona
 *   2. role_block
 *   3. owner_context_files
 *   4. instance_fragments
 *   5. platform_hints
 *   6. skill_block
 *   7. memory_pointer_block
 *   8. heartbeat_block
 *   9. tool_capability_hints
 *
 * Items 1-4 are invariant across turns within a session (cacheable prefix);
 * items 5-9 may vary turn-to-turn (channel switch, skill activation, etc.).
 *
 * Lift sources:
 *   - OpenClaw `system-prompt.ts` (assembler shape, skill XML format)
 *   - Hermes `prompt_builder.py` (per-channel hint table, persona/role split)
 */

import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

import { getPlatformHint, selectPlatformHints, type ChannelKind } from './platform-hints.ts'

export interface SkillRef {
  name: string
  description: string
  /** Absolute path. The assembler converts to a `~`-prefixed compact form. */
  path: string
}

export interface SystemPromptInput {
  /** Persona content (e.g. SOUL.md). Kept opaque — caller decides what goes here. */
  base_persona: string
  /** Role tag — `<role>${agent_kind}</role>` is appended before context files. */
  agent_kind: string
  /** Owner home directory. Context files are read from here. */
  owner_home: string
  /** Per-instance overrides — appended verbatim after context files, before hints. */
  instance_fragments: ReadonlyArray<string>
  /** Channel kind drives `selectPlatformHints`. */
  channel: ChannelKind
  /** Skills available this turn — emitted as XML <available_skills>. */
  active_skills: ReadonlyArray<SkillRef>
  /** Optional pointer-shape index of MEMORY.md (NOT full memory contents). */
  memory_pointers?: string
  /** Optional HEARTBEAT.md content describing current operational status. */
  heartbeat?: string
  /** Optional per-channel tool-capability hints (e.g. "this channel supports inline approval buttons"). */
  tool_capability_hints?: string
}

/** Files the assembler reads from `owner_home` in fixed order. */
const CONTEXT_FILES = ['CLAUDE.md', 'AGENTS.md', 'USER.md', 'TOOLS.md', 'IDENTITY.md', 'BOOTSTRAP.md'] as const

/**
 * Owner-Settings Core (2026-06-03) — the tool-mention fragment that
 * makes the onboarding "tweak later" promise real. The final-handoff
 * tells the user they can rename / delete / merge projects, switch
 * personality, and update the agent's name later just by asking — and
 * (Item 3, 2026-06-10) connect a Telegram bot at any time. For the
 * instance CC subprocess to honour that, it MUST know these seven tools
 * exist + when to call them. This fragment is appended to every instance's
 * system prompt (step 4.5 in `assembleSystemPrompt`) so the names are
 * always surfaced — independent of whether the owner has any projects
 * yet. The capability-gated handlers + the persistent REPL's `--tools`
 * allow-list are the actual dispatch path; this fragment is the
 * model-facing instruction that triggers a call.
 */
export const AGENT_SETTINGS_TOOLS_FRAGMENT = [
  '<agent_settings_tools>',
  'You can change the user\'s context settings at any time when they ask, using these tools:',
  '- list_projects() — list the current projects (call this first when the user references a project by name, so you have the exact current name).',
  '- rename_project(old_name, new_name) — rename a project (also retitles its Telegram topic). Use when the user says e.g. "rename 123 Main St to Home Base".',
  '- delete_project(name) — soft-delete a project and archive its Telegram topic. Use when the user says e.g. "delete the Old Stuff project".',
  '- archive_project(name) — archive a project: it leaves the rail but stays in the Admin tab and can be restored later (reversible, unlike delete). Use when the user says e.g. "archive this project" or "put the Summer Trip project away".',
  '- restore_project(name) — restore a previously archived project back to the rail. Use when the user says e.g. "restore the Summer Trip project" or "bring back the archived Foo".',
  '- merge_projects(from_name, into_name) — merge one project into another. Use when the user says e.g. "merge Side Notes into Main Work".',
  '- update_personality(new_archetype?, new_description?) — change your personality. Use when the user says e.g. "be more playful" or "switch to a calm strategist".',
  '- update_agent_name(new_name) — change your own display name. Use when the user says e.g. "call yourself Nova".',
  '- connect_telegram() — mint a fresh one-time Telegram bind link (t.me/...?start=bind_...). Use when the user says e.g. "connect a telegram bot", "link telegram", or their previous link expired. Reply with the returned deep_link and tell them it expires in expires_in_minutes minutes; on failure relay the error verbatim.',
  'Each tool returns {success, ...} and sends the user a plain-text confirmation. If a project name does not match, call list_projects() and ask the user to pick the exact one rather than guessing.',
  '</agent_settings_tools>',
].join('\n')

/**
 * Read + concatenate an instance's context files. Each present file is wrapped
 * in `<context_file name="...">…</context_file>` so the model can identify
 * sources. Missing files are silently skipped — instances need not ship every file.
 */
async function readOwnerContextFiles(owner_home: string): Promise<string[]> {
  const blocks: string[] = []
  for (const fname of CONTEXT_FILES) {
    const content = await tryReadFile(join(owner_home, fname))
    if (content !== null) {
      blocks.push(`<context_file name="${fname}">\n${content.trim()}\n</context_file>`)
    }
  }
  return blocks
}

async function tryReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Compact `~/...` rendering of an absolute path. Saves prompt tokens AND
 * keeps the path stable across hosts when the same skill is installed under
 * different home directories. Per-owner resolved values for `{{OWNER_HOME}}`
 * are also folded back to `~`.
 */
function compactHomePath(p: string): string {
  const home = (typeof process !== 'undefined' ? process.env['HOME'] : '') ?? ''
  let out = p
  if (home && out.startsWith(home)) out = `~${out.slice(home.length)}`
  out = out.replace(/\{\{OWNER_HOME\}\}/g, '~')
  return out
}

/**
 * Build the final system prompt. Returns a single string suitable for the
 * Anthropic Messages API `system` field, the OpenAI Responses API
 * `instructions` field, or the Codex CLI `--system` flag.
 */
export async function assembleSystemPrompt(input: SystemPromptInput): Promise<string> {
  const parts: string[] = []
  // 1. Persona
  parts.push(input.base_persona.trim())
  // 2. Role block
  parts.push(`<role>${input.agent_kind}</role>`)
  // 3. Instance context files
  const wsBlocks = await readOwnerContextFiles(input.owner_home)
  parts.push(...wsBlocks)
  // 4. Instance fragments — per-instance SOUL extensions, custom instructions
  for (const frag of input.instance_fragments) {
    if (frag.trim().length > 0) parts.push(frag.trim())
  }
  // 4.5 Owner-Settings tools — always-on mention of the six "tweak
  // later" tools so the instance CC honours the onboarding promise that
  // the user can rename / delete / merge projects, switch personality,
  // and rename the agent later just by asking. Part of the cacheable
  // prefix (invariant across turns) since it's a fixed string.
  parts.push(AGENT_SETTINGS_TOOLS_FRAGMENT)
  // 5. Platform hints
  const hintNames = selectPlatformHints(input.channel)
  if (hintNames.length > 0) {
    const body = hintNames.map((n) => `- ${getPlatformHint(n)}`).join('\n')
    parts.push(`<platform_hints channel="${input.channel}">\n${body}\n</platform_hints>`)
  }
  // 6. Skill block — XML reference list, NOT the skill bodies
  if (input.active_skills.length > 0) {
    const xml = input.active_skills
      .map(
        (s) =>
          `  <skill>\n    <name>${escapeXml(s.name)}</name>\n    <description>${escapeXml(s.description)}</description>\n    <location>${escapeXml(compactHomePath(s.path))}</location>\n  </skill>`,
      )
      .join('\n')
    parts.push(`<available_skills>\n${xml}\n</available_skills>`)
  }
  // 7. Memory pointers
  if (input.memory_pointers && input.memory_pointers.trim().length > 0) {
    parts.push(`<memory_pointers>\n${input.memory_pointers.trim()}\n</memory_pointers>`)
  }
  // 8. Heartbeat
  if (input.heartbeat && input.heartbeat.trim().length > 0) {
    parts.push(`<heartbeat>\n${input.heartbeat.trim()}\n</heartbeat>`)
  }
  // 9. Tool-capability hints
  if (input.tool_capability_hints && input.tool_capability_hints.trim().length > 0) {
    parts.push(`<tool_capabilities>\n${input.tool_capability_hints.trim()}\n</tool_capabilities>`)
  }
  return parts.join('\n\n')
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
