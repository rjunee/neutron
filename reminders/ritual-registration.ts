/**
 * @neutronai/reminders — agent-callable ritual REGISTRATION service (plan task 8;
 * Ryan overturn 3, "ritual registration is AGENT-CALLABLE with in-chat approval —
 * the approval RENDERING carries the security").
 *
 * This is the HIGHEST-RISK surface in the executor-mode sprint: an agent can
 * PROPOSE a scheduled, unattended sub-agent that reads the owner's files and (for
 * `egress:'web'` defs) reaches the internet. The security therefore does NOT live
 * in who-can-call — the agent can call freely — it lives in the APPROVAL GATE:
 *
 *   1. `propose(input)` sanitizes + validates + never-clobber-writes the def to
 *      disk, registers it, requests a content-hash-bound `tool_approvals` grant,
 *      and emits a CODE-rendered, PREFORMATTED, fence-hardened approval prompt
 *      with Approve/Deny buttons. It creates NO reminder row and fires NOTHING
 *      (no register-and-fire).
 *   2. The ritual can only FIRE after the OWNER's explicit affirmative act —
 *      tapping Approve (or typing the exact opaque token). `handleOwnerButtonAnswer`
 *      is the deterministic turn-start capture: it resolves the approval ONLY on
 *      an exact match of the owner's `user_text` against the PERSISTED option set
 *      of the prior prompt (the `captureButtonBackedRequiredField` eligibility
 *      discipline, onboarding/interview/button-backed-answer.ts:207-209). An
 *      unrelated reply, a paraphrase, "yes", silence, a non-owner speaker, or
 *      agent traffic can NEVER flip the row (T8).
 *   3. Approval is bound to a CONTENT HASH (prompt bytes ‖ surface ‖ scope ‖
 *      cadence ‖ tier ‖ timeout — `reminders/ritual-approval.ts`), re-verified from
 *      the LIVE prompt bytes on approve AND every fire. Any byte/surface/cadence
 *      change drops the grant → re-approval. Egress is a SEPARATE grant.
 *   4. Agent-registered defs survive reboot via `<id>.def.json` (re-registered by
 *      `loadPersistedRitualDefs` at boot). Ritual CONTENT stays user data.
 *
 * RENDERING carries the security (deepened header §APPROVAL GATE): the approval
 * body is built by CODE (never agent text), speaks CAPABILITIES not tool names,
 * itemizes every URL/path/`mcp__*` reference, wraps the full prompt in a backtick
 * fence LONGER than any internal run (the button body IS Markdown-rendered today —
 * channels/button-primitive.ts:194 — so a preformatted fence is the injection
 * defense), NFC-normalizes then rejects bidi/zero-width/C0 controls, and REFUSES
 * an over-cap prompt (never truncates).
 *
 * Layering: `reminders` (services) importing `@neutronai/tools` (platform) and
 * `@neutronai/channels` (the ButtonOption shape) is a legal services→platform
 * edge; the reminders-CORE never imports this module (it derefs a narrow
 * structural interface via a late-bound getter — see cores/free/reminders).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ButtonOption } from '@neutronai/channels/button-primitive.ts'
import { VALUE_BYTE_CAP } from '@neutronai/channels/button-primitive.ts'
import type { ApprovalManager } from '@neutronai/tools/approval.ts'

import {
  createRitualApprovalCheck,
  requestRitualApproval,
  ritualApprovalToolName,
  ritualCadenceString,
  ritualEgressApprovalToolName,
} from './ritual-approval.ts'
import { isRitualScheduleConflict, type ReminderStore } from './store.ts'
import {
  GATED_WRITE_TOOLS,
  validateRitualDef,
  type RitualEgress,
  type RitualDef,
  type RitualRegistry,
  type RitualScope,
} from './rituals.ts'

// ── Constants ────────────────────────────────────────────────────────────────

/** Hard cap on a proposed ritual prompt. Over-cap = REFUSE (never truncate). */
export const RITUAL_PROPOSAL_MAX_PROMPT_BYTES = 16 * 1024

/** The opaque approval-token option-value prefix. */
export const RITUAL_APPROVAL_VALUE_PREFIX = 'rap:'

/**
 * The full opaque option value shape: `rap:<22-char base64url of the row UUID>:a|d`
 * (28 bytes ≤ {@link VALUE_BYTE_CAP} 37). `:a` = approve, `:d` = deny. The token
 * IS the routing — no side-table lookup. An eligibility match is BOTH this regex
 * AND membership in the prior prompt's persisted option set (T8).
 */
export const RITUAL_APPROVAL_VALUE_RE = /^rap:[A-Za-z0-9_-]{22}:(a|d)$/

/**
 * Characters a proposed prompt may NOT contain — rejected (never sanitized
 * silently) so a homograph/RTL-override/zero-width payload can't hide capability
 * text from the owner reading the approval prompt:
 *   - bidi controls           U+202A–U+202E (LRE/RLE/PDF/LRO/RLO), U+2066–U+2069
 *   - zero-width / format      U+200B–U+200F (ZWSP/ZWNJ/ZWJ/LRM/RLM), U+FEFF (BOM)
 *   - C0 controls             U+0000–U+001F EXCEPT \t (09) \n (0A) \r (0D)
 */
export const RITUAL_PROPOSAL_BANNED_CHARS_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/

/** Read-only built-ins → plain-words capability line. */
const READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep'])
/** Web-egress built-ins → the exfiltration-channel capability line. */
const WEB_TOOLS: ReadonlySet<string> = new Set(['WebSearch', 'WebFetch'])

// ── Token codec ──────────────────────────────────────────────────────────────

/**
 * Encode a canonical 36-char UUID as 22-char base64url (no padding). Mirrors
 * `channels/button-primitive.ts:encodePromptIdWire` but kept local so this
 * module owns the ritual approval token format end-to-end.
 */
export function uuidToToken(uuid: string): string {
  return Buffer.from(uuid.replaceAll('-', ''), 'hex').toString('base64url')
}

/**
 * Strict inverse of {@link uuidToToken}. Returns the canonical UUID, or `null`
 * when `token` is not exactly 22 base64url chars decoding to 16 bytes — so a
 * malformed/forged token can never resolve to a live approval row.
 */
export function tokenToUuid(token: string): string | null {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(token)) return null
  let bytes: Buffer
  try {
    bytes = Buffer.from(token, 'base64url')
  } catch {
    return null
  }
  if (bytes.length !== 16) return null
  const hex = bytes.toString('hex')
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20)
  )
}

// ── Typed proposal errors ────────────────────────────────────────────────────

export type RitualProposalErrorCode =
  | 'banned_characters'
  | 'empty_prompt'
  | 'prompt_too_large'
  | 'invalid_def'
  | 'unsupported_scope'
  | 'invalid_schedule'
  | 'duplicate_id'
  | 'exists_on_disk'
  | 'write_failed'
  | 'emit_failed'
  // enable() codes (bundled / already-registered defs):
  | 'unknown_ritual'
  | 'missing_prompt'
  | 'already_enabled'

export class RitualProposalError extends Error {
  override readonly name = 'RitualProposalError'
  constructor(
    readonly code: RitualProposalErrorCode,
    message: string,
  ) {
    super(message)
  }
}

// ── Input / output shapes ────────────────────────────────────────────────────

/** The schedule half of a proposal — first occurrence + optional cadence. */
export interface RitualProposalSchedule {
  /** Unix SECONDS of the first occurrence. Finite; the row's `fire_at`. */
  fire_at: number
  /** Coarse cadence label — mutually exclusive with `recurrence_spec`. */
  recurrence?: 'weekly' | 'monthly' | 'occasional'
  /** 5-field cron — mutually exclusive with `recurrence`. Non-empty. */
  recurrence_spec?: string
}

export interface RitualProposalInput {
  id: string
  description: string
  scope: RitualScope
  tool_surface: readonly string[]
  egress: RitualEgress
  silent: boolean
  prompt: string
  schedule: RitualProposalSchedule
}

export interface RitualProposalResult {
  /** Opaque handle for the agent — the base64url of the content grant row id. */
  proposal_id: string
  ritual_id: string
  status: 'pending_approval'
  requires_egress_approval: boolean
}

/**
 * ENABLE an already-registered ritual (a bundled example seeded + registered at
 * boot, or a previously-persisted def). The prompt + tool surface + scope are
 * OWNED by the registered def — the caller supplies ONLY a schedule; enable reads
 * the seeded/owner prompt from disk, writes the `<id>.def.json`, and requests the
 * same owner approval a fresh {@link RitualProposalInput} does. A brand-new ritual
 * still goes through `propose`.
 */
export interface RitualEnableInput {
  id: string
  schedule: RitualProposalSchedule
}

/** One row of `service.status()`. */
export interface RitualStatusRow {
  ritual_id: string
  description: string
  scope: RitualScope
  tool_surface: readonly string[]
  egress: RitualEgress
  approval: 'approved' | 'pending' | 'denied' | 'none'
  scheduled: boolean
}

export interface RitualOwnerAnswerInput {
  user_id: string
  user_text: string
  topic_id: string
  prior_option_values: readonly string[]
}

/** The persisted `<id>.def.json` shape. */
interface PersistedRitualRecord {
  def: RitualDef
  schedule: RitualProposalSchedule
  proposed_at: number
}

// ── Rendering (PURE, code-built) ─────────────────────────────────────────────

/** Human capability lines for a tool surface — never bare tool names. */
function capabilityLines(def: RitualDef): string[] {
  const lines: string[] = []
  let saidRead = false
  let saidWeb = false
  const gated: string[] = []
  for (const t of def.tool_surface) {
    if (READ_TOOLS.has(t)) {
      if (!saidRead) {
        lines.push('• Read any file in your Neutron home (all projects, docs, memory)')
        saidRead = true
      }
      continue
    }
    if (WEB_TOOLS.has(t)) {
      if (!saidWeb) {
        lines.push('• Reach the public internet — content from this instance could be sent out')
        saidWeb = true
      }
      continue
    }
    if (GATED_WRITE_TOOLS.has(t)) {
      gated.push(t)
      continue
    }
    // Unknown / bridge token — surface the raw token, labelled.
    lines.push(`• ${t} (bridge tool)`)
  }
  for (const g of gated) {
    lines.push(`• ${g} (CURRENTLY BLOCKED at fire time until sandboxing ships)`)
  }
  return lines
}

/** A plain-words cadence description for the runs-unattended line + footer. */
function cadenceWords(schedule: RitualProposalSchedule): string {
  if (typeof schedule.recurrence_spec === 'string' && schedule.recurrence_spec.length > 0) {
    return `on the schedule \`${schedule.recurrence_spec}\` (cron)`
  }
  if (schedule.recurrence === 'weekly') return 'about once a week'
  if (schedule.recurrence === 'monthly') return 'about once a month'
  if (schedule.recurrence === 'occasional') return 'occasionally'
  return 'once'
}

const URL_RE = /https?:\/\/[^\s)>\]]+/g
const PATH_RE = /(?:(?<![\w./~-])(?:~\/|\.\/|\/)[A-Za-z0-9._~/-]+)/g
const MCP_RE = /mcp__[A-Za-z0-9_]+/g

/** Deduped, itemized URLs / filesystem paths / mcp tokens found in the prompt. */
function itemizedReferences(prompt: string): string {
  const found = new Set<string>()
  for (const m of prompt.matchAll(URL_RE)) found.add(m[0])
  for (const m of prompt.matchAll(PATH_RE)) found.add(m[0])
  for (const m of prompt.matchAll(MCP_RE)) found.add(m[0])
  if (found.size === 0) return '(none)'
  return [...found].join('\n')
}

/**
 * The length of the backtick fence that safely wraps `body`: one longer than the
 * longest run of backticks INSIDE it, floored at 3. No prompt content can then
 * close the fence — the preformatted-injection defense (button-primitive.ts:194
 * renders the body as Markdown today).
 */
function safeFence(body: string): string {
  let longest = 0
  for (const m of body.matchAll(/`+/g)) longest = Math.max(longest, m[0].length)
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * Build the CODE-rendered ritual-approval prompt body. PURE + fixed structure:
 *   (1) title, (2) capability bullets (never bare tool names) + the
 *   runs-unattended line, (3) itemized references (own fenced block), (4) the
 *   FULL prompt inside a fence longer than any internal backtick run, (5) footer.
 * Never truncates — the byte cap is enforced upstream in {@link propose}.
 */
export function renderRitualApprovalBody(input: {
  def: RitualDef
  prompt: string
  cadence: string
  schedule: RitualProposalSchedule
}): string {
  const { def, prompt, schedule } = input
  const caps = capabilityLines(def)
  const refsFence = safeFence(itemizedReferences(prompt))
  const promptFence = safeFence(prompt)
  const parts: string[] = []
  parts.push(`Ritual approval needed: ${def.id}`)
  parts.push('')
  parts.push(`What "${def.id}" would be allowed to do:`)
  parts.push(...caps)
  parts.push(
    `• Runs UNATTENDED ${cadenceWords(schedule)}, up to 45 minutes per run, on the smart model tier, rooted at your Neutron home.`,
  )
  parts.push('')
  parts.push('References found in the prompt (URLs, file paths, bridge tools):')
  parts.push(`${refsFence}\n${itemizedReferences(prompt)}\n${refsFence}`)
  parts.push('')
  parts.push('The FULL prompt it will run, verbatim:')
  parts.push(`${promptFence}\n${prompt}\n${promptFence}`)
  parts.push('')
  parts.push(
    'Tap Approve or Deny. Typing anything else will NOT approve or deny this ritual.',
  )
  return parts.join('\n')
}

/** The SEPARATE network-egress grant prompt body (web defs only). */
function renderEgressGrantBody(def: RitualDef): string {
  return [
    `Network egress for ritual: ${def.id}`,
    '',
    'This is a SEPARATE grant from the content approval above. Approving the ' +
      'content does NOT approve network access.',
    '',
    'If you approve this, the ritual may reach the public internet — content from ' +
      'this instance (your files, memory) could be sent out. Deny to keep it ' +
      'offline.',
    '',
    'Tap Approve or Deny. Typing anything else will NOT approve or deny egress.',
  ].join('\n')
}

// ── Service factory ──────────────────────────────────────────────────────────

export interface RitualRegistrationEmit {
  body: string
  options: ButtonOption[]
  idempotency_key: string
  metadata: Record<string, unknown>
}

export interface RitualRegistrationServiceOptions {
  registry: RitualRegistry
  rituals_dir: string
  approvals: ApprovalManager
  store: ReminderStore
  project_slug: string
  owner_user_id: string
  approval_topic_id: string
  emit: (p: RitualRegistrationEmit) => Promise<void>
  log?: (msg: string) => void
}

export interface RitualRegistrationService {
  propose(input: RitualProposalInput): Promise<RitualProposalResult>
  /**
   * Enable an already-registered ritual (bundled example or persisted def) by
   * writing its `<id>.def.json` schedule and requesting the owner's approval.
   * This is the ONLY path by which a bundled ritual becomes approvable +
   * schedulable — `propose` refuses a bundled id as `exists_on_disk`/`duplicate_id`.
   */
  enable(input: RitualEnableInput): Promise<RitualProposalResult>
  handleOwnerButtonAnswer(input: RitualOwnerAnswerInput): Promise<{ body: string } | null>
  status(): RitualStatusRow[]
}

export function createRitualRegistrationService(
  opts: RitualRegistrationServiceOptions,
): RitualRegistrationService {
  const {
    registry,
    rituals_dir,
    approvals,
    store,
    project_slug,
    owner_user_id,
    approval_topic_id,
    emit,
  } = opts
  const log = opts.log ?? ((): void => undefined)

  const defJsonPath = (id: string): string => join(rituals_dir, `${id}.def.json`)

  function readSchedule(id: string): RitualProposalSchedule | null {
    try {
      const raw = readFileSync(defJsonPath(id), 'utf8')
      const parsed = JSON.parse(raw) as PersistedRitualRecord
      if (parsed && typeof parsed.schedule === 'object' && parsed.schedule !== null) {
        return parsed.schedule
      }
      return null
    } catch {
      return null
    }
  }

  function cadenceFor(schedule: RitualProposalSchedule): string {
    return ritualCadenceString({
      recurrence: schedule.recurrence ?? null,
      recurrence_spec: schedule.recurrence_spec ?? null,
    })
  }

  async function propose(input: RitualProposalInput): Promise<RitualProposalResult> {
    // ── (a) NFC-normalize — the NORMALIZED bytes are what gets hashed, rendered,
    // and written, so a fire-time recompute over the on-disk file matches.
    const normalized = input.prompt.normalize('NFC')

    // ── (b) reject banned characters (never sanitize silently).
    if (RITUAL_PROPOSAL_BANNED_CHARS_RE.test(normalized)) {
      throw new RitualProposalError(
        'banned_characters',
        'prompt contains disallowed control characters (bidi override / zero-width / C0 control) — remove them and re-propose',
      )
    }

    // ── (c) empty / over-cap — REFUSE, never truncate.
    if (normalized.trim().length === 0) {
      throw new RitualProposalError('empty_prompt', 'prompt is empty or whitespace-only')
    }
    const promptBytes = Buffer.byteLength(normalized, 'utf8')
    if (promptBytes > RITUAL_PROPOSAL_MAX_PROMPT_BYTES) {
      throw new RitualProposalError(
        'prompt_too_large',
        `prompt is ${promptBytes} bytes (> RITUAL_PROPOSAL_MAX_PROMPT_BYTES ${RITUAL_PROPOSAL_MAX_PROMPT_BYTES}) — it is REFUSED, never truncated; shorten it and re-propose`,
      )
    }

    // ── (d) validate the def (shared rule set with the registry).
    const def: RitualDef = {
      id: input.id,
      description: input.description,
      scope: input.scope,
      tool_surface: input.tool_surface,
      egress: input.egress,
      silent: input.silent,
    }
    try {
      validateRitualDef(def)
    } catch (err) {
      throw new RitualProposalError('invalid_def', (err as Error).message)
    }

    // ── (e) v1: only 'instance' scope can fire (scope 'project' throws in the
    // composer's scope_cwd until the OS-sandbox sprint lands per-project rooting).
    if (def.scope !== 'instance') {
      throw new RitualProposalError(
        'unsupported_scope',
        `scope '${def.scope}' cannot fire yet — v1 supports only scope 'instance' (per-project rooting is coupled to write-containment, deferred to the OS-sandbox sprint)`,
      )
    }

    // ── (f) validate the schedule.
    validateSchedule(input.schedule)

    // ── (g) never-clobber: registry OR either on-disk file already exists.
    if (registry.get(def.id) !== undefined) {
      throw new RitualProposalError(
        'duplicate_id',
        `ritual id ${JSON.stringify(def.id)} is already registered`,
      )
    }
    const mdPath = registry.promptPathFor(def.id)
    const defPath = defJsonPath(def.id)
    if (existsSync(mdPath) || existsSync(defPath)) {
      throw new RitualProposalError(
        'exists_on_disk',
        `ritual ${JSON.stringify(def.id)} already has files on disk — refusing to overwrite (${existsSync(mdPath) ? mdPath : defPath})`,
      )
    }

    // ── (h) write both files with 'wx' (fail if exists — never clobber). Roll
    // back the .md if the .def.json write fails so a half-written pair never
    // leaks a registerable-but-unscheduled artifact.
    try {
      mkdirSync(rituals_dir, { recursive: true })
      writeFileSync(mdPath, normalized, { encoding: 'utf8', flag: 'wx' })
    } catch (err) {
      throw new RitualProposalError('write_failed', `writing ${mdPath} failed: ${(err as Error).message}`)
    }
    const record: PersistedRitualRecord = {
      def,
      schedule: input.schedule,
      proposed_at: Date.now(),
    }
    try {
      writeFileSync(defPath, JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx' })
    } catch (err) {
      try {
        rmSync(mdPath, { force: true })
      } catch {
        /* best-effort rollback */
      }
      throw new RitualProposalError('write_failed', `writing ${defPath} failed: ${(err as Error).message}`)
    }

    // ── (i)–(k) register + request the approval grant(s) + emit the prompts, with
    // a FULL rollback (Argus r1 MAJOR). Every artifact from here on — registry
    // registration, the minted approval rows, and the two on-disk files — is torn
    // back down if ANY step throws (most importantly the awaited `emit`, which
    // reaches the channel adapter). Without this an emit rejection left a
    // registered-but-promptless ritual whose files + duplicate guard then blocked
    // every re-propose — an UNRECOVERABLE pending ritual.
    return await requestApprovalAndEmit({
      def,
      normalized,
      schedule: input.schedule,
      register: true,
      cleanup: () => {
        try {
          registry.unregister(def.id)
        } catch {
          /* best-effort */
        }
        for (const p of [mdPath, defPath]) {
          try {
            rmSync(p, { force: true })
          } catch {
            /* best-effort */
          }
        }
      },
    })
  }

  /**
   * ENABLE an already-registered ritual (bundled example or persisted def). The
   * BLOCKER this closes (Argus r2): the three bundled rituals (morning-brief /
   * evening-wrap / daily-delta) are seeded + registered at boot but have NO
   * approval or scheduling path — `propose` refuses their id as
   * `duplicate_id`/`exists_on_disk`, and they carry no `<id>.def.json` so
   * `readSchedule` dead-ends. `enable` is that missing path: it takes ONLY a
   * schedule (the prompt + surface + scope are owned by the registered def),
   * reads the seeded/owner prompt from disk, writes the `<id>.def.json`, and
   * requests the SAME content-hash-bound owner approval a fresh `propose` does.
   */
  async function enable(input: RitualEnableInput): Promise<RitualProposalResult> {
    // ── (a) must reference an ALREADY-REGISTERED def. A brand-new ritual goes
    // through propose(); enable never mints a def from caller input (the surface
    // + scope + prompt are engine/owner data, not agent-supplied here).
    const def = registry.get(input.id)
    if (def === undefined) {
      throw new RitualProposalError(
        'unknown_ritual',
        `ritual ${JSON.stringify(input.id)} is not registered — use rituals_propose to create a new ritual`,
      )
    }

    // ── (b) v1 scope gate (same rule as propose (e)).
    if (def.scope !== 'instance') {
      throw new RitualProposalError(
        'unsupported_scope',
        `scope '${def.scope}' cannot fire yet — v1 supports only scope 'instance'`,
      )
    }

    // ── (c) validate the schedule.
    validateSchedule(input.schedule)

    // ── (d) the seeded/owner prompt must be on disk — its LIVE bytes are what
    // get hashed, rendered in the approval prompt, and re-verified at every fire.
    const mdPath = registry.promptPathFor(def.id)
    let normalized: string
    try {
      normalized = readFileSync(mdPath, 'utf8').normalize('NFC')
    } catch (err) {
      throw new RitualProposalError(
        'missing_prompt',
        `ritual ${JSON.stringify(def.id)} has no prompt file on disk (${mdPath}) — its bundled template failed to seed; reinstall or re-propose it: ${(err as Error).message}`,
      )
    }

    // ── (e) a bundled template can be owner-edited after seeding, so re-run the
    // SAME content guards propose() applies — never trust the on-disk bytes blindly.
    if (RITUAL_PROPOSAL_BANNED_CHARS_RE.test(normalized)) {
      throw new RitualProposalError(
        'banned_characters',
        `prompt file ${mdPath} contains disallowed control characters (bidi override / zero-width / C0 control) — fix it before enabling`,
      )
    }
    if (normalized.trim().length === 0) {
      throw new RitualProposalError('empty_prompt', `prompt file ${mdPath} is empty or whitespace-only`)
    }
    const promptBytes = Buffer.byteLength(normalized, 'utf8')
    if (promptBytes > RITUAL_PROPOSAL_MAX_PROMPT_BYTES) {
      throw new RitualProposalError(
        'prompt_too_large',
        `prompt file ${mdPath} is ${promptBytes} bytes (> RITUAL_PROPOSAL_MAX_PROMPT_BYTES ${RITUAL_PROPOSAL_MAX_PROMPT_BYTES}) — shorten it before enabling`,
      )
    }

    // ── (f) never-clobber: a `<id>.def.json` means the ritual is already enabled
    // (approval pending or scheduled). Enabling is idempotency-guarded by the
    // file's existence, not silently re-run over a live grant.
    const defPath = defJsonPath(def.id)
    if (existsSync(defPath)) {
      throw new RitualProposalError(
        'already_enabled',
        `ritual ${JSON.stringify(def.id)} is already enabled (${defPath}) — check rituals_status; approve the pending prompt if you have not yet`,
      )
    }

    // ── (g) write ONLY the `<id>.def.json` (schedule + def). The `<id>.md` is the
    // seeded/owner prompt — NEVER written or clobbered here. 'wx' fails if a
    // concurrent enable already created it.
    try {
      mkdirSync(rituals_dir, { recursive: true })
      const record: PersistedRitualRecord = {
        def,
        schedule: input.schedule,
        proposed_at: Date.now(),
      }
      writeFileSync(defPath, JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx' })
    } catch (err) {
      throw new RitualProposalError('write_failed', `writing ${defPath} failed: ${(err as Error).message}`)
    }

    // ── (h) request approval + emit. The def is ALREADY registered (bundled at
    // boot), so `register:false` — the rollback removes ONLY the `<id>.def.json`
    // it just wrote and NEVER unregisters the bundled def or deletes the seeded .md.
    return await requestApprovalAndEmit({
      def,
      normalized,
      schedule: input.schedule,
      register: false,
      cleanup: () => {
        try {
          rmSync(defPath, { force: true })
        } catch {
          /* best-effort */
        }
      },
    })
  }

  /**
   * Shared tail of propose()/enable(): (optionally) register the def, request the
   * content-hash-bound approval grant(s), and emit the CODE-rendered approval
   * prompt(s). On ANY failure it cancels the minted grants and runs the caller's
   * `cleanup` (the caller-specific on-disk + registry teardown), then throws.
   *
   *   - propose(): `register:true` (def is new); `cleanup` unregisters + rm's BOTH
   *     the `.md` and `.def.json` it wrote.
   *   - enable():  `register:false` (a bundled/persisted def is ALREADY registered
   *     — never unregister it); `cleanup` rm's ONLY the `.def.json`, never the .md.
   */
  async function requestApprovalAndEmit(args: {
    def: RitualDef
    normalized: string
    schedule: RitualProposalSchedule
    register: boolean
    cleanup: () => void
  }): Promise<RitualProposalResult> {
    const { def, normalized, schedule, register, cleanup } = args
    const cadence = cadenceFor(schedule)

    const rollback = async (approvalIds: readonly string[]): Promise<void> => {
      cleanup()
      for (const aid of approvalIds) {
        try {
          await approvals.cancelPending(aid)
        } catch {
          /* best-effort */
        }
      }
    }

    // ── register (throws on duplicate — guarded upstream) + request the
    // content-hash-bound approval grant(s). The ids are minted inside
    // requestRitualApproval and returned so we can encode them into the button
    // tokens WITHOUT a side-table.
    let approval: ReturnType<typeof requestRitualApproval>
    try {
      if (register) registry.register(def)
      approval = requestRitualApproval(approvals, {
        project_slug,
        topic_id: approval_topic_id,
        def,
        prompt: normalized,
        cadence,
      })
    } catch (err) {
      await rollback([])
      throw new RitualProposalError(
        'write_failed',
        `registering ${JSON.stringify(def.id)} failed: ${(err as Error).message}`,
      )
    }

    try {
      // ── emit the CODE-rendered CONTENT approval prompt.
      const contentBody = renderRitualApprovalBody({ def, prompt: normalized, cadence, schedule })
      const contentOptions: ButtonOption[] = [
        { label: 'Approve', body: 'Approve this ritual', value: `rap:${uuidToToken(approval.content_id)}:a` },
        { label: 'Deny', body: 'Deny this ritual', value: `rap:${uuidToToken(approval.content_id)}:d` },
      ]
      await emit({
        body: contentBody,
        options: contentOptions,
        idempotency_key: `ritual-approval:${approval.content_id}`,
        metadata: { kind: 'ritual-approval', ritual_id: def.id },
      })

      // For a web def, emit a SEPARATE egress grant prompt (approving content never
      // implies egress — ritual-approval.ts contract).
      if (def.egress === 'web' && approval.egress_id !== undefined) {
        const egressOptions: ButtonOption[] = [
          { label: 'Approve', body: 'Approve network egress', value: `rap:${uuidToToken(approval.egress_id)}:a` },
          { label: 'Deny', body: 'Deny network egress', value: `rap:${uuidToToken(approval.egress_id)}:d` },
        ]
        await emit({
          body: renderEgressGrantBody(def),
          options: egressOptions,
          idempotency_key: `ritual-egress-approval:${approval.egress_id}`,
          metadata: { kind: 'ritual-egress-approval', ritual_id: def.id },
        })
      }
    } catch (err) {
      const approvalIds =
        approval.egress_id !== undefined
          ? [approval.content_id, approval.egress_id]
          : [approval.content_id]
      await rollback(approvalIds)
      throw new RitualProposalError(
        'emit_failed',
        `emitting the approval prompt for ${JSON.stringify(def.id)} failed — the proposal was fully rolled back; re-propose: ${(err as Error).message}`,
      )
    }

    log(`ritual pending_approval id=${def.id} (egress=${def.egress})`)
    return {
      proposal_id: uuidToToken(approval.content_id),
      ritual_id: def.id,
      status: 'pending_approval',
      requires_egress_approval: def.egress === 'web',
    }
  }

  async function handleOwnerButtonAnswer(
    input: RitualOwnerAnswerInput,
  ): Promise<{ body: string } | null> {
    const value = input.user_text.trim()

    // ── (a) eligibility: EXACT opaque-token shape AND membership in the prior
    // prompt's persisted option set. An unrelated reply, a paraphrase, "yes", or
    // silence is never eligible — T8 (button-backed-answer.ts:207-209 discipline).
    if (!RITUAL_APPROVAL_VALUE_RE.test(value)) return null
    if (!input.prior_option_values.includes(value)) return null

    // ── (b) owner-only: never self-approval / guest approval. No row is touched.
    if (input.user_id !== owner_user_id) {
      return { body: 'Only the owner can decide ritual approvals.' }
    }

    const token = value.slice(RITUAL_APPROVAL_VALUE_PREFIX.length, RITUAL_APPROVAL_VALUE_PREFIX.length + 22)
    const id = tokenToUuid(token)
    if (id === null) {
      return { body: 'That approval token is not recognized (stale or malformed) — nothing changed.' }
    }

    // ── (c) resolve the row + guard namespace / ownership.
    const row = approvals.get(id)
    if (
      row === null ||
      row.project_slug !== project_slug ||
      !(row.tool_name.startsWith('ritual:') || row.tool_name.startsWith('ritual-egress:'))
    ) {
      return { body: 'That ritual approval is unknown or no longer valid — nothing changed.' }
    }
    // Resolve the ritual id from the row args (present on both grants).
    const ritual_id = parseRitualId(row.args_json)

    if (row.status !== 'pending') {
      // ── RECONCILIATION (Argus r1 BLOCKER) — an already-APPROVED grant whose
      // scheduling never completed (a transient db/fs failure AFTER respondApproval
      // stranded it: the decision was durably recorded, but no reminder row exists,
      // and a re-tap previously dead-ended here). Re-tapping APPROVE now RE-DRIVES
      // scheduling, so the owner can self-heal a stranded ritual. Only the APPROVE
      // token reconciles: a DENY re-tap on an already-approved grant must NOT be
      // read as reconcile-and-schedule (Argus r2 minor — the :a/:d suffix was being
      // dropped once status left 'pending', so a Deny tap silently re-scheduled).
      // Deny/revoke of an already-approved ritual is not a button path in v1 — say
      // so plainly rather than acting on the wrong intent. A denied/expired grant is
      // terminal — nothing to reconcile.
      const retapped: 'approved' | 'denied' = value.endsWith(':a') ? 'approved' : 'denied'
      if (row.status === 'approved' && retapped === 'approved' && ritual_id !== null) {
        return await ensureScheduled(ritual_id)
      }
      if (row.status === 'approved' && retapped === 'denied') {
        return {
          body: `"${ritual_id ?? 'that ritual'}" is already approved — this Deny did nothing. To stop it, re-propose it (approval is bound to the exact content, so any edit drops the grant).`,
        }
      }
      return { body: `That ritual approval was already ${row.status} — nothing changed.` }
    }

    const decision: 'approved' | 'denied' = value.endsWith(':a') ? 'approved' : 'denied'

    // ── (d) record the decision (idempotent; owner-attributed). Isolated so a
    // respondApproval failure returns the TRUE "nothing recorded" message — the
    // scheduling steps below are separated (ensureScheduled) precisely so a
    // failure THERE does not mislabel a decision that WAS recorded.
    try {
      await approvals.respondApproval(id, decision, input.user_id)
    } catch (err) {
      log(`ritual respondApproval error id=${id}: ${(err as Error).message}`)
      return { body: 'Approval could not be recorded — nothing was changed.' }
    }

    if (ritual_id === null) {
      return { body: `Recorded (${decision}), but the ritual reference could not be read — nothing scheduled.` }
    }
    if (decision === 'denied') {
      return {
        body: `Denied. "${ritual_id}" stays registered but will never fire until you approve it.`,
      }
    }
    // ── (e) approved → schedule-on-approve IFF the content hash verifies over the
    // LIVE bytes (also requires the egress grant for web defs).
    return await ensureScheduled(ritual_id)
  }

  /**
   * Idempotent "make sure this approved ritual is scheduled". Verifies the content
   * hash over the LIVE prompt bytes (and, for a web def, the separate egress
   * grant), then creates the reminder row IFF one does not already exist. Never
   * throws OUT — a transient store failure returns a message telling the owner to
   * re-tap Approve, which re-enters via the reconciliation branch above (Argus r1
   * BLOCKER: an approved-but-unscheduled ritual is no longer permanently stranded).
   */
  async function ensureScheduled(ritual_id: string): Promise<{ body: string }> {
    const def = registry.get(ritual_id)
    const schedule = readSchedule(ritual_id)
    if (def === undefined || schedule === null) {
      return { body: `Approved, but "${ritual_id}" is no longer registered on disk — nothing scheduled.` }
    }
    const cadence = cadenceFor(schedule)
    const checker = createRitualApprovalCheck({ manager: approvals, project_slug, cadence })
    let liveBytes: string
    try {
      liveBytes = readFileSync(registry.promptPathFor(ritual_id), 'utf8')
    } catch (err) {
      log(`ritual schedule id=${ritual_id} prompt unreadable: ${(err as Error).message}`)
      return { body: `Recorded, but "${ritual_id}" could not be scheduled — its prompt file is unreadable; re-propose it.` }
    }
    let approved: boolean
    try {
      approved = await checker.isApproved(def, liveBytes)
    } catch (err) {
      // A broken approval store must fail closed — never schedule on an unverifiable grant.
      log(`ritual schedule id=${ritual_id} approval check threw: ${(err as Error).message}`)
      return { body: `Recorded, but "${ritual_id}" could not be verified for scheduling — tap Approve again to retry.` }
    }
    if (!approved) {
      // Content grant alone is not enough for a web def — the separate egress
      // grant is still pending (or a byte/cadence change dropped the hash).
      return {
        body:
          def.egress === 'web'
            ? `Recorded. "${ritual_id}" also needs the separate network-egress grant approved before it can be scheduled — tap Approve on that prompt.`
            : `Recorded, but "${ritual_id}" is not fully approved yet (its content changed since this request) — re-propose to schedule it.`,
      }
    }

    // Never schedule the same ritual twice. `hasScheduledRitualRow` counts any
    // NON-cancelled row (Argus r2 BLOCKER 1: a 'fired' one-shot row still holds
    // the slot, so a re-tapped Approve can't replay a completed ritual). This is
    // the friendly fast path; the partial UNIQUE index (0107) is the atomic
    // guarantee that also closes the concurrent-approval race below.
    try {
      if (store.hasScheduledRitualRow(ritual_id)) {
        return { body: `Approved — "${ritual_id}" is already scheduled.` }
      }
    } catch (err) {
      log(`ritual schedule id=${ritual_id} hasScheduledRitualRow threw: ${(err as Error).message}`)
      return { body: `Recorded, but "${ritual_id}" could not be scheduled right now — tap Approve again to retry.` }
    }

    // ── schedule-on-approve — the OWNER's act creates the reminder row.
    const base = {
      owner_slug: project_slug,
      topic_id: approval_topic_id,
      fire_at: schedule.fire_at,
      message: `ritual:${ritual_id}`,
      ritual_id,
    }
    try {
      if (schedule.recurrence !== undefined) {
        await store.createRecurring({ ...base, recurrence: schedule.recurrence })
      } else if (
        typeof schedule.recurrence_spec === 'string' &&
        schedule.recurrence_spec.length > 0
      ) {
        await store.createRecurring({ ...base, recurrence_spec: schedule.recurrence_spec })
      } else {
        await store.create(base)
      }
    } catch (err) {
      // Argus r2 BLOCKER 2 (double-schedule race): a concurrent approval answer
      // (e.g. the egress grant firing alongside the content grant for a web
      // ritual) already inserted the row between our pre-check and this INSERT,
      // tripping the partial UNIQUE index (0107). That is success, not failure —
      // the ritual IS scheduled; report it as such, never as a retry-able error.
      if (isRitualScheduleConflict(err)) {
        return { body: `Approved — "${ritual_id}" is already scheduled.` }
      }
      // Otherwise the decision is durably recorded; only the reminder-row write
      // failed. Tell the owner to re-tap Approve — reconciliation re-drives this.
      log(`ritual schedule id=${ritual_id} create failed: ${(err as Error).message}`)
      return { body: `Approved, but scheduling "${ritual_id}" hit a transient error — tap Approve again to finish scheduling it.` }
    }
    log(`ritual approve id=${ritual_id} scheduled cadence=${cadence}`)
    return { body: `Approved and scheduled: "${ritual_id}" will run ${cadenceWords(schedule)}.` }
  }

  function status(): RitualStatusRow[] {
    const rows: RitualStatusRow[] = []
    for (const def of registry.list()) {
      let approval: RitualStatusRow['approval'] = 'none'
      const schedule = readSchedule(def.id)
      if (schedule !== null) {
        try {
          const checker = createRitualApprovalCheck({
            manager: approvals,
            project_slug,
            cadence: cadenceFor(schedule),
          })
          const liveBytes = readFileSync(registry.promptPathFor(def.id), 'utf8')
          if (checker.isApproved(def, liveBytes)) approval = 'approved'
        } catch {
          approval = 'none'
        }
      }
      if (approval === 'none') {
        const pending = approvals
          .listPending(project_slug)
          .some(
            (r) =>
              r.tool_name === ritualApprovalToolName(def.id) ||
              r.tool_name === ritualEgressApprovalToolName(def.id),
          )
        if (pending) approval = 'pending'
      }
      if (approval === 'none') {
        // Argus r1 minor — surface a DENIED grant instead of mis-reporting 'none'
        // ('denied' is part of the advertised RitualStatusRow contract).
        // `findByToolName` returns newest-decision-first; a leading 'denied' row on
        // EITHER grant (with no approved/pending above) means the owner denied it.
        try {
          const latestContent = approvals.findByToolName(project_slug, ritualApprovalToolName(def.id))[0]
          const latestEgress =
            def.egress === 'web'
              ? approvals.findByToolName(project_slug, ritualEgressApprovalToolName(def.id))[0]
              : undefined
          if (latestContent?.status === 'denied' || latestEgress?.status === 'denied') {
            approval = 'denied'
          }
        } catch {
          /* best-effort — a query failure leaves approval='none' */
        }
      }
      let scheduled = false
      try {
        scheduled = store.hasScheduledRitualRow(def.id)
      } catch {
        scheduled = false
      }
      rows.push({
        ritual_id: def.id,
        description: def.description,
        scope: def.scope,
        tool_surface: [...def.tool_surface],
        egress: def.egress,
        approval,
        scheduled,
      })
    }
    return rows
  }

  return { propose, enable, handleOwnerButtonAnswer, status }
}

// ── Schedule validation ──────────────────────────────────────────────────────

function validateSchedule(schedule: RitualProposalSchedule): void {
  if (schedule === null || typeof schedule !== 'object') {
    throw new RitualProposalError('invalid_schedule', 'schedule is required')
  }
  if (typeof schedule.fire_at !== 'number' || !Number.isFinite(schedule.fire_at)) {
    throw new RitualProposalError(
      'invalid_schedule',
      `schedule.fire_at must be a finite unix-seconds number (got ${JSON.stringify(schedule.fire_at)})`,
    )
  }
  const hasCoarse = schedule.recurrence !== undefined
  const hasSpec = typeof schedule.recurrence_spec === 'string' && schedule.recurrence_spec.length > 0
  if (schedule.recurrence_spec !== undefined && !hasSpec) {
    throw new RitualProposalError(
      'invalid_schedule',
      'schedule.recurrence_spec must be a non-empty cron string when provided',
    )
  }
  if (hasCoarse && hasSpec) {
    throw new RitualProposalError(
      'invalid_schedule',
      'schedule: pass at most one of recurrence (coarse) or recurrence_spec (cron), not both',
    )
  }
  if (
    hasCoarse &&
    schedule.recurrence !== 'weekly' &&
    schedule.recurrence !== 'monthly' &&
    schedule.recurrence !== 'occasional'
  ) {
    throw new RitualProposalError(
      'invalid_schedule',
      `schedule.recurrence ${JSON.stringify(schedule.recurrence)} is not 'weekly' | 'monthly' | 'occasional'`,
    )
  }
}

function parseRitualId(args_json: string): string | null {
  try {
    const parsed = JSON.parse(args_json) as { ritual_id?: unknown }
    if (typeof parsed.ritual_id === 'string' && parsed.ritual_id.length > 0) {
      return parsed.ritual_id
    }
    return null
  } catch {
    return null
  }
}

// ── Boot re-registration of agent-persisted defs ─────────────────────────────

/**
 * Scan `<rituals_dir>/*.def.json` and re-register each persisted def so an
 * agent-registered ritual survives reboot. NEVER throws (boot safety — mirrors
 * the `seedBundledRituals` contract): a corrupt/invalid/duplicate record is
 * skipped + logged, never fatal. Returns the ids registered vs skipped.
 *
 * Called AFTER `registerBundledRituals` so a def.json colliding with a bundled
 * id is skipped as a duplicate (the bundled def wins) rather than clobbering it.
 */
export function loadPersistedRitualDefs(opts: {
  registry: RitualRegistry
  rituals_dir: string
  log?: (msg: string) => void
}): { registered: string[]; skipped: string[] } {
  const log = opts.log ?? ((): void => undefined)
  const registered: string[] = []
  const skipped: string[] = []
  let entries: string[]
  try {
    // Lazy import of readdirSync-equivalent via node:fs — read the dir listing.
    entries = readDefJsonFiles(opts.rituals_dir)
  } catch (err) {
    log(`loadPersistedRitualDefs: cannot list ${opts.rituals_dir}: ${(err as Error).message}`)
    return { registered, skipped }
  }
  for (const file of entries) {
    const path = join(opts.rituals_dir, file)
    try {
      const raw = readFileSync(path, 'utf8')
      const parsed = JSON.parse(raw) as PersistedRitualRecord
      if (parsed === null || typeof parsed !== 'object' || parsed.def === undefined) {
        skipped.push(file)
        log(`loadPersistedRitualDefs: ${file} has no def — skipped`)
        continue
      }
      opts.registry.register(parsed.def)
      registered.push(parsed.def.id)
    } catch (err) {
      skipped.push(file)
      log(`loadPersistedRitualDefs: ${file} skipped: ${(err as Error).message}`)
    }
  }
  return { registered, skipped }
}

function readDefJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.def.json'))
}
