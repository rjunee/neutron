/**
 * @neutronai/reminders — the ritual REGISTRY + fire-time validation.
 *
 * Spec of record: `docs/plans/executor-mode-reminders-2026-07-20.md` (plan task
 * 2). A ritual is an executor-mode reminder: at fire time the tick loop (plan
 * task 4) spawns a scoped sub-agent REPL instead of composing a one-shot nudge.
 * This module is the PURE, side-effect-free half — the registry of known ritual
 * definitions and the fail-CLOSED fire-time verdict. It performs NO logging and
 * NO spawn; the tick branch that consumes `validateRitualFire` logs the verdict
 * and decides to spawn or skip.
 *
 * The security model is charset-by-construction + fail-closed:
 *  - A ritual `id` is guarded by {@link RITUAL_ID_RE}: lowercase alnum + hyphen,
 *    1-64 chars, must start alnum. This makes path traversal IMPOSSIBLE by
 *    construction — the prompt path is `<root>/rituals/<id>.md` and no `id` that
 *    passes the guard can contain `/`, `.`, `..`, or a leading dash.
 *  - `tool_surface` is NEVER empty (the #361 "toolless class" pin: a ritual with
 *    no tools is a silent no-op that looks like it ran). Egress (WebSearch /
 *    WebFetch) and the mcp bridge are SEPARATELY-approved capability CLASSES
 *    carried by the `egress` / `bridge` booleans — never smuggled in as tool
 *    names — so the approval surface (task 3) can render them distinctly.
 *  - `validateRitualFire` returns a SKIP verdict for unknown id / missing prompt
 *    / unapproved. A failed verdict means log + SKIP the spawn — NEVER degrade to
 *    the nudge composer (Vajra's rationale holds verbatim: a ritual that can't
 *    run must not silently become a chat message), and NEVER spawn with an empty
 *    tool set.
 *
 * There is DELIBERATELY no `requires_approval` field on the def: anything that
 * can write the def could clear its own approval bit, so approval lives in a
 * SEPARATE content-hash-keyed record (task 3), reached through the injected
 * {@link RitualFireDeps.isApproved} seam. There is also no `prompt_path` (it is
 * derived) and no `model`/`timeout` field (they are the constants below — a
 * TIER, not a raw model id).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Ritual id charset guard: lowercase alphanumeric + hyphen, 1-64 chars, must
 * start with an alphanumeric. Path traversal is impossible by construction — no
 * conforming id contains `/`, `.`, or a leading `-`.
 */
export const RITUAL_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Model TIER (not a raw model id) — resolved via `getBestModel()` at spawn time
 * (task 4). Rituals run on the best available tier; the spec anchors this so the
 * ritual model choice tracks the chat agent's rather than pinning a stale id.
 */
export const RITUAL_MODEL_TIER = 'best' as const

/**
 * Ritual spawn timeout — 45 min, parity with Vajra's
 * `REMINDER_EXECUTOR_TIMEOUT_SEC=2700`. A ritual REPL that has not reached a
 * terminal event by this deadline is reaped `timed_out` (task 5).
 */
export const RITUAL_TIMEOUT_MS = 45 * 60_000

/**
 * A ritual definition — the ENGINE-side contract for an executor-mode reminder.
 * See the module header for the security rationale behind each field.
 */
export interface RitualDef {
  /** Charset-guarded id ({@link RITUAL_ID_RE}); also the prompt file basename. */
  id: string
  /**
   * cwd + write-containment root CLASS: 'project' runs rooted at the project
   * folder, 'instance' at the instance root. Resolution is task 4; this only
   * declares the class.
   */
  scope: 'project' | 'instance'
  /**
   * Built-in tool names granted at spawn. NEVER empty (the #361 toolless-class
   * pin). MUST NOT contain egress tools ('WebSearch'/'WebFetch' — ride `egress`)
   * or bridge tools (`mcp__*` — ride `bridge`); those are capability classes,
   * not surface entries.
   */
  tool_surface: readonly string[]
  /**
   * Grants the WebSearch/WebFetch egress capability — a SEPARATELY-approved
   * class. Never appears in `tool_surface`.
   */
  egress: boolean
  /**
   * Grants the `mcp__neutron` ToolRegistry bridge at spawn (task 4 maps it to the
   * substrate). Never appears in `tool_surface`.
   */
  bridge: boolean
  /** No completion post when true (task 5 consumes this). */
  silent: boolean
}

/** Frozen registry of ritual defs. */
export interface RitualRegistry {
  /** The def for `id`, or undefined if unknown. */
  get(id: string): RitualDef | undefined
  /** Every registered def. */
  list(): readonly RitualDef[]
}

/**
 * Egress tools that must ride the `egress` capability flag, never `tool_surface`.
 */
const EGRESS_TOOLS = new Set(['WebSearch', 'WebFetch'])

/**
 * Validate a ritual definition. Returns `[]` when valid; otherwise a list of
 * human-readable reasons (all failures reported, not just the first). Rules:
 *  - `id` must match {@link RITUAL_ID_RE};
 *  - `tool_surface` must be non-empty (the #361 pin), have no duplicates, and
 *    every entry must be an alpha-only built-in name (`/^[A-Za-z]+$/`) that is
 *    NOT an egress tool (must ride `egress`) and does NOT start with `mcp__`
 *    (must ride `bridge`).
 */
export function validateRitualDef(def: RitualDef): string[] {
  const reasons: string[] = []
  if (!RITUAL_ID_RE.test(def.id)) {
    reasons.push(`id ${JSON.stringify(def.id)} fails RITUAL_ID_RE (^[a-z0-9][a-z0-9-]{0,63}$)`)
  }
  if (def.tool_surface.length === 0) {
    // #361 toolless-class pin: a ritual with no tools is a silent no-op that
    // looks like it ran. A ritual MUST declare at least one built-in tool.
    reasons.push('tool_surface is empty (#361 toolless class — a ritual must grant at least one tool)')
  }
  const seen = new Set<string>()
  for (const t of def.tool_surface) {
    if (seen.has(t)) {
      reasons.push(`tool_surface has duplicate entry ${JSON.stringify(t)}`)
    }
    seen.add(t)
    if (t.startsWith('mcp__')) {
      reasons.push(`tool_surface entry ${JSON.stringify(t)} is an mcp bridge tool — set bridge:true instead`)
    } else if (EGRESS_TOOLS.has(t)) {
      reasons.push(`tool_surface entry ${JSON.stringify(t)} is an egress tool — set egress:true instead`)
    } else if (!/^[A-Za-z]+$/.test(t)) {
      reasons.push(`tool_surface entry ${JSON.stringify(t)} is not a plain built-in name (/^[A-Za-z]+$/)`)
    }
  }
  return reasons
}

/**
 * Build a frozen ritual registry from a list of defs. THROWS on any invalid def
 * (see {@link validateRitualDef}) or duplicate id — a bad registry is a
 * programming error caught at composition time, not a runtime skip.
 */
export function createRitualRegistry(defs: readonly RitualDef[]): RitualRegistry {
  const byId = new Map<string, RitualDef>()
  for (const def of defs) {
    const reasons = validateRitualDef(def)
    if (reasons.length > 0) {
      throw new Error(`invalid ritual def ${JSON.stringify(def.id)}: ${reasons.join('; ')}`)
    }
    if (byId.has(def.id)) {
      throw new Error(`duplicate ritual id ${JSON.stringify(def.id)}`)
    }
    byId.set(def.id, Object.freeze({ ...def, tool_surface: Object.freeze([...def.tool_surface]) }))
  }
  const frozen = Object.freeze([...byId.values()])
  return Object.freeze({
    get: (id: string) => byId.get(id),
    list: () => frozen,
  })
}

/**
 * Resolve the prompt file path for a ritual: `<promptRoot>/rituals/<id>.md`.
 * Defense-in-depth: THROWS if `id` fails {@link RITUAL_ID_RE} even though the
 * registry already guards it — no caller can reach the filesystem with an
 * unguarded id.
 */
export function resolveRitualPromptPath(promptRoot: string, id: string): string {
  if (!RITUAL_ID_RE.test(id)) {
    throw new Error(`resolveRitualPromptPath: id ${JSON.stringify(id)} fails RITUAL_ID_RE`)
  }
  return join(promptRoot, 'rituals', `${id}.md`)
}

/**
 * The fire-time verdict. `ok: true` carries the resolved def + the prompt bytes;
 * `ok: false` carries the single SKIP reason. A failed verdict means the tick
 * branch logs it and SKIPS the spawn — it NEVER degrades to the nudge composer
 * and NEVER spawns with an empty tool set.
 */
export type RitualFireVerdict =
  | { ok: true; ritual: RitualDef; promptText: string }
  | { ok: false; reason: 'unknown_ritual' | 'missing_prompt' | 'unapproved' }

/** Injected dependencies for {@link validateRitualFire}. */
export interface RitualFireDeps {
  registry: RitualRegistry
  /** Root under which `rituals/<id>.md` prompt files live. */
  promptRoot: string
  /**
   * Approval seam — task 3 implements content-hash checking. REQUIRED (no
   * default): composition can never accidentally fail OPEN. Called ONLY after
   * the prompt is read (the hash needs the bytes). Semantics: fail CLOSED —
   * return false ⇒ 'unapproved' ⇒ skip.
   */
  isApproved: (ritual: RitualDef, promptText: string) => boolean
}

/**
 * Fail-CLOSED fire-time validation. Order:
 *   1. registry.get(ritualId) miss ⇒ { ok:false, reason:'unknown_ritual' }.
 *   2. read `<promptRoot>/rituals/<id>.md`; a missing / unreadable / whitespace-
 *      only file ⇒ { ok:false, reason:'missing_prompt' } (a 0-byte prompt is a
 *      silent no-op ritual — skip it, never spawn an empty run).
 *   3. isApproved(ritual, promptText) === false ⇒ { ok:false, reason:'unapproved' }.
 *   4. else ⇒ { ok:true, ritual, promptText }.
 *
 * Pure: no logger side effects (the tick branch, task 4, logs the verdict). A
 * failed verdict is ALWAYS a skip — never a degrade-to-nudge, never a tools:[]
 * spawn.
 */
export function validateRitualFire(ritualId: string, deps: RitualFireDeps): RitualFireVerdict {
  const ritual = deps.registry.get(ritualId)
  if (ritual === undefined) {
    return { ok: false, reason: 'unknown_ritual' }
  }
  let promptText: string
  try {
    promptText = readFileSync(resolveRitualPromptPath(deps.promptRoot, ritual.id), 'utf8')
  } catch {
    return { ok: false, reason: 'missing_prompt' }
  }
  if (promptText.trim().length === 0) {
    return { ok: false, reason: 'missing_prompt' }
  }
  if (!deps.isApproved(ritual, promptText)) {
    return { ok: false, reason: 'unapproved' }
  }
  return { ok: true, ritual, promptText }
}
