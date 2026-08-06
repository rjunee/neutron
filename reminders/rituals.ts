/**
 * @neutronai/reminders — the ritual REGISTRY + fail-CLOSED fire-time validation.
 *
 * Spec of record: `docs/plans/executor-mode-reminders-2026-07-20.md` — design
 * doc §2a + the deepened header block (plan task 2), AS AMENDED BY ISSUES #504 /
 * SPEC Decisions Log 2026-08-05, which deleted the separate ritual execution lane.
 * A ritual is a REMINDER: at fire time the ONE `ReminderDispatcher` composes its
 * approved prompt on the owner's normal warm session (`reminders/ritual-fire.ts`).
 * Nothing spawns a scoped sub-agent REPL any more. This module is the PURE,
 * storage-free half — the registry of known ritual definitions and the fail-CLOSED
 * fire-time verdict, both of which survive unchanged and now carry the whole
 * security model together with the approval gate.
 *
 * Ryan overturns folded in (SPEC Decisions Log 2026-07-20, neutron-managed):
 *  - Overturn 1 — Bash is a PORTABLE surface: security rides the APPROVAL gate
 *    (task 3), NOT tool exclusion, so `tool_surface` may legitimately contain
 *    `Bash`. The gate, not this registry, decides whether a Bash ritual fires.
 *  - Overturn 3 — registration will be AGENT-callable with in-chat approval
 *    (task 8); the approval RENDERING carries the security, which is why the def
 *    has NO `requires_approval` bit (anything that can write the def must not be
 *    able to clear its own approval) — approval lives in a SEPARATE record keyed
 *    (ritual_id, content_hash, approved_by, approved_at), reached only through the
 *    injected {@link RitualApprovalCheck} seam.
 *
 * Security model — charset-by-construction + fail-closed:
 *  - A ritual `id` is guarded by {@link RITUAL_ID_RE}: lowercase alnum + hyphen,
 *    1-64 chars, must start alnum. Path traversal is IMPOSSIBLE by construction —
 *    no conforming id contains `.`, `/`, `\`, or a leading dash, which is
 *    stronger than the legacy harness's `resolveExecutorPromptFile` runtime containment check.
 *  - `tool_surface` is NEVER empty (the #361 "toolless class" pin: a ritual with
 *    no tools is a silent no-op that looks like it ran).
 *  - {@link validateRitualFire} returns a SKIP verdict for unknown id / missing
 *    prompt / unapproved (including an approval store that THROWS — fail CLOSED).
 *    A failed verdict means log + compose NOTHING: the dispatcher posts nothing and
 *    records a durable 'skipped' row. It NEVER degrades to composing the row as an
 *    ordinary nudge, so an unapproved ritual prompt is never sent to a model.
 *
 * There is DELIBERATELY (deepened header §142-150) no `requires_approval`, no
 * `prompt_path` (derived from `rituals/<id>.md`), and no `model`/`timeout` field
 * on the def — the model TIER and timeout are the module CONSTANTS below.
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '@neutronai/logger'

/**
 * Wall-clock budget for one ritual turn — 10 min.
 *
 * WAS 45 min, for parity with the legacy harness's
 * `REMINDER_EXECUTOR_TIMEOUT_SEC=2700`, when a ritual was a DETACHED background
 * REPL that the tick launched and forgot. ISSUES #504 deleted that lane: a ritual
 * is now ONE turn on the owner's warm session, AWAITED inside the tick body
 * exactly like a nudge, and the tick is SINGLE-FLIGHT. So this number is no longer
 * just a ceiling on the ritual — it is the longest one ritual can stall every
 * other due reminder. 45 minutes of that was defensible for a detached run and is
 * not defensible in-band. Ten minutes is a wide margin over what reading a handful
 * of STATUS.md files and a calendar takes, and keeps the worst case bounded.
 *
 * ⚠️ THERE IS EXACTLY ONE OF THESE, AND THAT IS LOAD-BEARING. This constant is
 * hashed into the approval grant by BOTH the request side and the fire-time check
 * side ({@link computeRitualContentHash}, `reminders/ritual-approval.ts`). Two
 * timeout constants — one for the hash, one for the actual budget — would make
 * every approved ritual compute a different hash at fire time than at approval
 * time, so every fire would refuse as `unapproved` and every ritual would go
 * silent with a durable row nobody reads. If you need a different budget, change
 * THIS value; do not add a second one.
 *
 * ⚠️ CHANGING IT INVALIDATES EVERY EXISTING APPROVAL, by design — the grant is
 * bound to the run's description, and the description changed. That is the gate
 * working, not a bug to route around; `reminders/bundled-ritual-enable.ts`
 * re-requests approval when a live content hash is no longer approved, so the owner
 * gets a fresh prompt rather than silence.
 */
export const RITUAL_TIMEOUT_MS = 10 * 60_000

/**
 * Model TIER (not a raw model id) — the executor default is the smart tier
 * (design §2c); plain nudges stay on FAST_MODEL. Resolved to a concrete id at
 * spawn time (task 4) so the ritual model tracks the chat agent's rather than
 * pinning a stale id.
 */
export const RITUAL_MODEL_TIER = 'best' as const

/**
 * Hard cap on a ritual prompt file. A prompt larger than this is treated as a
 * missing/corrupt prompt (fire-time SKIP), never read into a spawn.
 */
export const MAX_RITUAL_PROMPT_BYTES = 256 * 1024

/**
 * Ritual id charset guard: lowercase alphanumeric + hyphen, 1-64 chars, must
 * start with an alphanumeric. Path-safe by construction — no conforming id
 * contains `.`, `/`, or `\`, and none begins with `-`.
 */
export const RITUAL_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** A tool token in a ritual `tool_surface` — a bare built-in / mcp bridge name. */
const TOOL_TOKEN_RE = /^[A-Za-z][A-Za-z0-9_]*$/

/** Web-egress built-in tools — used to enforce egress/surface consistency. */
const WEB_TOOLS = new Set(['WebSearch', 'WebFetch'])

/**
 * Write/exec-class tools that STAY GATED at fire time until the OS-sandbox
 * prerequisite sprint lands a sandboxed writing-ritual factory.
 *
 * The T5 write-containment spike (docs/plans/executor-mode-reminders-2026-07-20.md
 * → "T5 write-containment spike verdict") returned **UNPROVABLE**: a per-session
 * `settings.json` `permissions.deny` does NOT fail-closed cleanly on the shipping
 * CC version, so a ritual granted Bash/Write/Edit could escape its scope. Overturn 1
 * makes these tools PORTABLE (approval-gated, not tool-excluded) IN PRINCIPLE — but
 * until containment is PROVEN they are refused at FIRE TIME (fail-closed), so
 * "STAY GATED" is enforced by CODE, not by the mere absence of a registration
 * surface (Argus r1 major forward-guard). Read-only rituals (Read/Glob/Grep + web)
 * ship unaffected under Layer 1 (`--tools` default-deny + `skip_permissions:true`).
 *
 * When the OS-sandbox sprint lands the sandboxed writing-ritual factory, this gate
 * is lifted (the factory becomes the containment) — see the plan-doc verdict.
 *
 * ⚠️ WHAT THIS GATE ACTUALLY DOES SINCE ISSUES #504 — READ BEFORE TRUSTING IT.
 * It bounds what a ritual may DECLARE and be approved for. It is NOT containment,
 * and it never was after the ritual lane was deleted. A ritual composes on the
 * owner's WARM chat session, which is spawned with `Bash`, `Write` and `Edit` in its
 * `--tools` surface; a ritual's own `tool_surface` cannot be applied per fire,
 * because the persistent-REPL reuse guard would evict and respawn that session
 * (`runtime/adapters/claude-code/persistent/spawn.ts:824,837`). So a ritual whose
 * declared surface is `['Read','Glob','Grep']` still executes somewhere Bash exists.
 *
 * It is KEPT anyway, deliberately: it stops a ritual being registered and approved
 * with an explicit write/exec grant, which keeps the approval prompt's rendered
 * capability lines conservative, and removing a fail-closed check was not part of
 * the #504 decision. But do not reason about ritual safety FROM this set — the
 * boundary is the APPROVAL GATE plus the ritual's own prompt text.
 *
 * The stated reason it could not be bypassed via an `mcp__*` bridge name — "the
 * ritual substrate wires NO tool bridge" — is NO LONGER TRUE: the session a ritual
 * runs in is the one substrate that DOES wire the native-MCP bridge. That is the
 * intended behaviour now (it is how the morning brief reaches a Core at all), which
 * is precisely why this set must not be read as a containment boundary.
 *
 * LOCKSTEP-MAINTENANCE (Argus r2 minor — denylist, not allowlist): this is an
 * ENUMERATED set, so a write-capable name NOT listed slips it. If it is ever made
 * load-bearing again, flip it to an ALLOW-LIST of read-only tools so an unknown or
 * bridge name fails closed instead of passing.
 */
export const GATED_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'Bash',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
])

/**
 * cwd + write-containment root CLASS at spawn (task 4): 'project' runs rooted at
 * the project folder, 'instance' at the instance root.
 */
export type RitualScope = 'project' | 'instance'

/**
 * Declared network-egress capability CLASS. 'none' = no web tools; 'web' = the
 * WebSearch/WebFetch egress capability, a separately-approved class (task 3).
 * {@link RitualRegistry.register} enforces consistency with `tool_surface`.
 */
export type RitualEgress = 'none' | 'web'

/**
 * A ritual definition — the ENGINE-side contract for an executor-mode reminder.
 * See the module header for the security rationale behind each field.
 */
export interface RitualDef {
  /** Charset-guarded id ({@link RITUAL_ID_RE}); also the prompt file basename. */
  id: string
  /**
   * Human capability line rendered in the approval prompt (task 8). Non-empty,
   * <= 200 chars.
   */
  description: string
  /** cwd + write-containment root class at spawn (task 4). */
  scope: RitualScope
  /**
   * Built-in / bridge tool names granted at spawn. NEVER empty (the #361
   * toolless-class pin). Each entry matches {@link TOOL_TOKEN_RE} (covers
   * 'Read', 'Bash', 'mcp__neutron'). Bash is a legitimate entry (overturn 1) —
   * the approval gate, not this list, carries the security.
   */
  tool_surface: readonly string[]
  /**
   * Declared egress class; {@link RitualRegistry.register} enforces it is
   * consistent with `tool_surface` (web tools ⇔ egress 'web').
   */
  egress: RitualEgress
  /** No completion post when true (task 5 consumes this). */
  silent: boolean
}

/**
 * Register-time structural validation of a ritual def, EXTRACTED from the
 * registry's internal `assertValid` (plan task 8) so the agent-callable
 * registration path (`reminders/ritual-registration.ts`) can validate a
 * proposed def BEFORE writing anything to disk — same rules, one source of
 * truth. THROWS a plain Error with a precise message on any invalid field.
 *
 * This covers EVERYTHING `assertValid` did EXCEPT the duplicate-id check — a
 * duplicate is a registry-STATE concern (is this id already registered?), not a
 * property of the def in isolation, so it stays in {@link RitualRegistry.register}
 * (and the registration service does its own never-clobber check against the
 * registry + disk before calling this). The imported-JSON fail-closed contract
 * (a def can arrive from user-data where the compiler never saw it) is preserved:
 * every enum/type guard leads with a `typeof` check so `RegExp.test` coercion can
 * never smuggle a non-string past the charset gates.
 */
export function validateRitualDef(def: RitualDef): void {
  if (typeof def.id !== 'string' || !RITUAL_ID_RE.test(def.id)) {
    // typeof guard first: RegExp.test coerces (id=42 → "42" matches), which
    // would register the def under a non-string Map key. Fail closed instead.
    throw new Error(
      `ritual id ${JSON.stringify(def.id)} fails RITUAL_ID_RE (^[a-z0-9][a-z0-9-]{0,63}$)`,
    )
  }
  const desc = def.description
  if (typeof desc !== 'string' || desc.trim().length === 0) {
    throw new Error(`ritual ${JSON.stringify(def.id)}: description must be non-empty`)
  }
  if (desc.length > 200) {
    throw new Error(
      `ritual ${JSON.stringify(def.id)}: description exceeds 200 chars (${desc.length})`,
    )
  }
  // Runtime enum/type guards — the TS types constrain in-tree callers, but a
  // ritual def can arrive from imported user-data (JSON) where the compiler
  // never saw it. These fields drive containment (scope), egress
  // classification, and delivery, so a bogus value must FAIL CLOSED at
  // register time rather than silently pass the consistency checks below.
  if (def.scope !== 'project' && def.scope !== 'instance') {
    throw new Error(
      `ritual ${JSON.stringify(def.id)}: scope ${JSON.stringify(def.scope)} is not 'project' | 'instance'`,
    )
  }
  if (def.egress !== 'none' && def.egress !== 'web') {
    throw new Error(
      `ritual ${JSON.stringify(def.id)}: egress ${JSON.stringify(def.egress)} is not 'none' | 'web'`,
    )
  }
  if (typeof def.silent !== 'boolean') {
    throw new Error(
      `ritual ${JSON.stringify(def.id)}: silent must be a boolean (got ${JSON.stringify(def.silent)})`,
    )
  }
  if (!Array.isArray(def.tool_surface)) {
    throw new Error(
      `ritual ${JSON.stringify(def.id)}: tool_surface must be an array`,
    )
  }
  if (def.tool_surface.length === 0) {
    // #361 toolless-class pin: a ritual with no tools is a silent no-op.
    throw new Error(
      `ritual ${JSON.stringify(def.id)}: tool_surface is empty (#361 toolless class — grant at least one tool)`,
    )
  }
  let hasWebTool = false
  for (const t of def.tool_surface) {
    if (typeof t !== 'string' || !TOOL_TOKEN_RE.test(t)) {
      // typeof guard first: RegExp.test coerces (null → "null" matches
      // TOOL_TOKEN_RE), which would freeze a non-string tool grant into the
      // registry and flow through approval hashing + spawn. Fail closed —
      // matches the imported-JSON fail-closed contract documented above.
      throw new Error(
        `ritual ${JSON.stringify(def.id)}: tool_surface entry ${JSON.stringify(t)} is not a valid tool token (${TOOL_TOKEN_RE})`,
      )
    }
    if (WEB_TOOLS.has(t)) hasWebTool = true
  }
  if (hasWebTool && def.egress === 'none') {
    throw new Error(
      `ritual ${JSON.stringify(def.id)}: tool_surface grants a web tool but egress is 'none' — set egress:'web'`,
    )
  }
  if (!hasWebTool && def.egress === 'web') {
    throw new Error(
      `ritual ${JSON.stringify(def.id)}: egress is 'web' but tool_surface grants no web tool (WebSearch/WebFetch)`,
    )
  }
}

/** A frozen, register-time-validated registry of ritual defs. */
export interface RitualRegistry {
  /**
   * Register a def. THROWS (plain Error, precise message) on any invalid def or
   * a duplicate id — a bad registration is a programming error, not a runtime
   * skip. The stored def is a FROZEN copy (with a frozen tool_surface) so a
   * caller cannot mutate it after registration.
   */
  register(def: RitualDef): void
  /**
   * Remove `id` from the registry. Returns `true` if a def was removed, `false`
   * if the id was not registered. Used by the registration service to ROLL BACK
   * a registration whose approval-prompt emission failed (Argus r1 MAJOR) so a
   * re-propose is not blocked by a stranded, promptless registration.
   */
  unregister(id: string): boolean
  /** The def for `id`, or undefined if unknown. */
  get(id: string): RitualDef | undefined
  /** Every registered def. */
  list(): RitualDef[]
  /**
   * The prompt file path `<rituals_dir>/<id>.md` — only after `id` passes
   * {@link RITUAL_ID_RE} (THROWS otherwise; defense-in-depth even though the
   * registry already guards every stored id).
   */
  promptPathFor(id: string): string
}

/**
 * Build a ritual registry rooted at `opts.rituals_dir` (where `<id>.md` prompt
 * files live). Empty on creation; callers `register()` each def.
 */
export function createRitualRegistry(opts: { rituals_dir: string }): RitualRegistry {
  const { rituals_dir } = opts
  const byId = new Map<string, RitualDef>()

  return {
    register(def: RitualDef): void {
      // Structural validity (charset, enums, tool-surface/egress consistency)
      // lives in the extracted, exported `validateRitualDef` so the
      // registration service (task 8) shares one rule set. The duplicate-id
      // check is registry STATE, not a def property, so it stays here.
      validateRitualDef(def)
      if (byId.has(def.id)) {
        throw new Error(`duplicate ritual id ${JSON.stringify(def.id)}`)
      }
      byId.set(
        def.id,
        Object.freeze({ ...def, tool_surface: Object.freeze([...def.tool_surface]) }),
      )
    },
    unregister(id: string): boolean {
      return byId.delete(id)
    },
    get(id: string): RitualDef | undefined {
      return byId.get(id)
    },
    list(): RitualDef[] {
      return [...byId.values()]
    },
    promptPathFor(id: string): string {
      if (!RITUAL_ID_RE.test(id)) {
        throw new Error(`promptPathFor: id ${JSON.stringify(id)} fails RITUAL_ID_RE`)
      }
      return join(rituals_dir, `${id}.md`)
    },
  }
}

/**
 * The fail-CLOSED fire-time skip reasons.
 * - `unsupported_scope`: the ritual's scope has no wired cwd/write-containment
 *   root yet (v1 wires only 'instance'; per-project rooting is task 6). The
 *   executor lands this as a durable skip rather than over-granting the
 *   owner-wide dir (Argus r1 MAJOR).
 * - `gated_tool_surface`: the ritual grants a write/exec-class tool
 *   ({@link GATED_WRITE_TOOLS} — Bash/Write/Edit/…) which STAYS GATED until the
 *   OS-sandbox sprint proves fail-closed containment (T5 verdict UNPROVABLE).
 *   Fail-CLOSED refusal enforced by CODE, not the absence of a registration
 *   surface (Argus r1 major).
 */
export type RitualFireSkipReason =
  | 'unknown_ritual'
  | 'missing_prompt'
  | 'unapproved'
  | 'unsupported_scope'
  | 'gated_tool_surface'

/**
 * The approval seam. Task 3 supplies the real content-hash-bound checker (hash of
 * prompt bytes ‖ tool surface ‖ scope ‖ cadence ‖ tier ‖ timeout, re-verified at
 * EVERY fire because ported prompts are mutable files). Task 2 defines ONLY the
 * seam — there is no permissive default anywhere in the module, so composition
 * can never accidentally fail OPEN.
 */
export interface RitualApprovalCheck {
  isApproved(def: RitualDef, promptBytes: string): boolean | Promise<boolean>
}

/**
 * The fire-time verdict. `ok: true` carries the resolved def + the prompt bytes;
 * `ok: false` carries a single SKIP reason + a human detail. A failed verdict
 * means the tick branch (task 4) logs it and SKIPS the spawn — it NEVER degrades
 * to the nudge composer and NEVER spawns with an empty tool set, and the ok
 * branch's `def.tool_surface` is non-empty by the register() invariant.
 */
export type RitualFireValidation =
  | { ok: true; def: RitualDef; prompt: string }
  | { ok: false; reason: RitualFireSkipReason; detail: string }

/**
 * Fail-CLOSED fire-time validation. Order:
 *   1. `ritual_id` malformed or not registered ⇒ { ok:false, 'unknown_ritual' }.
 *   1b. `tool_surface` grants a gated write/exec tool ({@link GATED_WRITE_TOOLS})
 *      ⇒ { ok:false, 'gated_tool_surface' } — STAY GATED until the OS-sandbox
 *      sprint (T5 verdict UNPROVABLE); checked before any disk touch.
 *   2. read `promptPathFor(id)` — a missing / unreadable / empty-or-whitespace /
 *      over-{@link MAX_RITUAL_PROMPT_BYTES} file ⇒ { ok:false, 'missing_prompt' }
 *      (the detail says which).
 *   3. `await approvals.isApproved(def, prompt)` — false OR THROWS ⇒
 *      { ok:false, 'unapproved' } (fail CLOSED — a broken approval store must
 *      never fire a ritual).
 *   4. all pass ⇒ { ok:true, def, prompt }.
 *
 * Every skip calls `log()` exactly once with the ritual id + reason + detail.
 * The `approvals` parameter is REQUIRED. There is NO fallback value and NO
 * degrade-to-nudge shape.
 */
export async function validateRitualFire(
  registry: RitualRegistry,
  approvals: RitualApprovalCheck,
  ritual_id: string,
  log: (msg: string) => void = createLogger('rituals').error,
): Promise<RitualFireValidation> {
  const skip = (reason: RitualFireSkipReason, detail: string): RitualFireValidation => {
    log(`ritual fire SKIP id=${ritual_id} reason=${reason} detail=${detail}`)
    return { ok: false, reason, detail }
  }

  const def = registry.get(ritual_id)
  if (def === undefined) {
    return skip('unknown_ritual', `no registered ritual with id ${JSON.stringify(ritual_id)}`)
  }

  // STAY GATED (Argus r1 major): a ritual granting any write/exec-class tool is
  // refused fail-CLOSED until the OS-sandbox sprint proves containment (T5 verdict
  // UNPROVABLE). Enforced here in code so an approved def can't ship a Bash/Write
  // ritual through the mere absence of a registration surface. Checked BEFORE the
  // prompt read / approval so a gated ritual never touches disk.
  const gated = def.tool_surface.filter((t) => GATED_WRITE_TOOLS.has(t))
  if (gated.length > 0) {
    return skip(
      'gated_tool_surface',
      `tool_surface grants gated write/exec tool(s) [${gated.join(', ')}] — STAY GATED until the OS-sandbox sprint lands (T5 containment verdict: UNPROVABLE)`,
    )
  }

  let prompt: string
  try {
    const path = registry.promptPathFor(def.id)
    // Enforce the byte cap from the on-disk size BEFORE reading the file into
    // memory, so an oversized prompt is rejected without allocating it.
    const size = statSync(path).size
    if (size > MAX_RITUAL_PROMPT_BYTES) {
      return skip(
        'missing_prompt',
        `prompt ${path} is ${size} bytes (> MAX_RITUAL_PROMPT_BYTES ${MAX_RITUAL_PROMPT_BYTES})`,
      )
    }
    prompt = readFileSync(path, 'utf8')
  } catch (err) {
    return skip('missing_prompt', `prompt file unreadable: ${(err as Error).message}`)
  }
  if (prompt.trim().length === 0) {
    return skip('missing_prompt', 'prompt file is empty or whitespace-only')
  }

  let approved: boolean
  try {
    approved = await approvals.isApproved(def, prompt)
  } catch (err) {
    return skip('unapproved', `approval check threw (fail-closed): ${(err as Error).message}`)
  }
  if (!approved) {
    return skip('unapproved', 'approval store returned false')
  }

  return { ok: true, def, prompt }
}
