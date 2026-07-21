/**
 * @neutronai/reminders — the ritual REGISTRY + fail-CLOSED fire-time validation.
 *
 * Spec of record: `docs/plans/executor-mode-reminders-2026-07-20.md` — design
 * doc §2a + the deepened header block (plan task 2). A ritual is an
 * executor-mode reminder: at fire time the tick loop (plan task 4) spawns a
 * scoped sub-agent REPL instead of composing a one-shot nudge. This module is the
 * PURE, storage-free half — the registry of known ritual definitions and the
 * fail-CLOSED fire-time verdict.
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
 *    stronger than Vajra's `resolveExecutorPromptFile` runtime containment check.
 *  - `tool_surface` is NEVER empty (the #361 "toolless class" pin: a ritual with
 *    no tools is a silent no-op that looks like it ran).
 *  - {@link validateRitualFire} returns a SKIP verdict for unknown id / missing
 *    prompt / unapproved (including an approval store that THROWS — fail CLOSED).
 *    A failed verdict means log + SKIP the spawn — NEVER degrade to the nudge
 *    composer, and NEVER spawn with `tools: []`.
 *
 * There is DELIBERATELY (deepened header §142-150) no `requires_approval`, no
 * `prompt_path` (derived from `rituals/<id>.md`), and no `model`/`timeout` field
 * on the def — the model TIER and timeout are the module CONSTANTS below.
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Ritual spawn timeout — 45 min, parity with Vajra's
 * `REMINDER_EXECUTOR_TIMEOUT_SEC=2700`. A ritual REPL that has not reached a
 * terminal event by this deadline is reaped `timed_out` (task 5).
 */
export const RITUAL_TIMEOUT_MS = 45 * 60_000

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
 * ⚠️ LOCKSTEP-MAINTENANCE (Argus r2 minor — denylist, not allowlist): this is an
 * ENUMERATED set of built-in write/exec tool names, so a WRITE-CAPABLE tool NOT in
 * this set slips the gate. Two open lanes to keep in lockstep when either surface
 * grows: (a) a new built-in write/exec tool must be ADDED here the same PR it
 * becomes grantable; (b) an MCP bridge tool name (`mcp__server__tool`, admitted by
 * {@link TOOL_TOKEN_RE}) is write-capable yet unlisted, so it would PASS this gate.
 * Not reachable today — the ritual substrate wires NO tool bridge (no
 * `enableToolBridge` on the ritual variant) and the shipped rituals are read-only
 * with an explicit Read/Glob/Grep allow-list, so no `mcp__*` grant can execute a
 * write. Revisit at task 8/9 (ritual registration) or when the OS-sandbox sprint
 * lifts this gate: prefer flipping the gate to an ALLOW-LIST of read-only tools so
 * the default is fail-closed for any unknown/bridge name, not enumerated-deny.
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

/** A frozen, register-time-validated registry of ritual defs. */
export interface RitualRegistry {
  /**
   * Register a def. THROWS (plain Error, precise message) on any invalid def or
   * a duplicate id — a bad registration is a programming error, not a runtime
   * skip. The stored def is a FROZEN copy (with a frozen tool_surface) so a
   * caller cannot mutate it after registration.
   */
  register(def: RitualDef): void
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

  function assertValid(def: RitualDef): void {
    if (typeof def.id !== 'string' || !RITUAL_ID_RE.test(def.id)) {
      // typeof guard first: RegExp.test coerces (id=42 → "42" matches), which
      // would register the def under a non-string Map key. Fail closed instead.
      throw new Error(
        `ritual id ${JSON.stringify(def.id)} fails RITUAL_ID_RE (^[a-z0-9][a-z0-9-]{0,63}$)`,
      )
    }
    if (byId.has(def.id)) {
      throw new Error(`duplicate ritual id ${JSON.stringify(def.id)}`)
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

  return {
    register(def: RitualDef): void {
      assertValid(def)
      byId.set(
        def.id,
        Object.freeze({ ...def, tool_surface: Object.freeze([...def.tool_surface]) }),
      )
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
  log: (msg: string) => void = console.error,
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
