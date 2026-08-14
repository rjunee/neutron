/**
 * landing/chat-react — per-phase build model/effort settings client (web).
 *
 *   GET /api/app/trident/phase-models   the phases, defaults, and the owner's overrides
 *   PUT /api/app/trident/phase-models   replace the overrides ({ overrides })
 *
 * THE TWIN of `app/lib/phase-models-client.ts`. Written twice rather than shared,
 * following the convention every client here already follows: the browser bundle
 * stays free of workspace dependencies, so wire shapes are re-declared. What must NOT
 * diverge is the two pure helpers below — they encode product decisions, not
 * transport, and a web copy that quietly disagreed with the phone would give the same
 * owner two different answers about their own settings.
 *
 * THE PHASE LIST COMES FROM THE SERVER. Labels, descriptions, defaults and the legal
 * values all arrive in the payload, so neither client carries its own idea of what the
 * phases are — that is how a phase gets added to the engine and stays invisible in one
 * UI. This file describes a SHAPE and nothing about the pipeline.
 *
 * THE WRITE REPLACES THE WHOLE SET, which is what makes clearing a pin an omission. A
 * rejected write changes nothing server-side and its message names every problem, so
 * the caller shows it verbatim: the owner is the only one who can fix a bad value.
 */

/** One phase, as the server describes it. */
export interface PhaseDescriptor {
  key: string
  label: string
  description: string
  /**
   * Which executor runs this step by DEFAULT (`claude`, `codex`, `kimi`).
   *
   * Used only to SAY what a greyed option would have to be — "it runs on Claude".
   * Whether an option is selectable is `groups`, not this.
   */
  group: string
  /**
   * Every executor this step can dispatch on.
   *
   * A row can only take a tier from one of these groups: a step with only a Claude
   * dispatch cannot run a GPT model (`agent({model})` resolves against Claude Code's
   * endpoint), and the Codex wrapper cannot be pointed at Kimi. Most steps have one
   * group; the build step has two, because its forge dispatch reaches the codex
   * executor as well. The server decides; this file just compares strings.
   */
  groups?: string[]
  dispatch_constraint?: string | null
  /**
   * False for a step whose DEFAULT executor is a CLI, whose reasoning effort is its own.
   *
   * Not the whole answer for a row: a step with two executors keeps this true while the
   * owner has it on a tier that cannot use an effort. Ask {@link effortSettable}.
   *
   * OPTIONAL FOR THE SAME REASON `groups` IS. It arrived with the CLI executors, and a
   * gateway predating it sends the field not at all — read as a bare boolean that is
   * `undefined`, which is falsy, and EVERY effort control on the pane silently
   * disappears. Absent means "the server has no opinion", which is the old behaviour:
   * the control stays. Read it through {@link effortSettable}, never directly.
   */
  effort_supported?: boolean
  default: { model: string; effort: string }
}

/** One selectable tier, resolved by the server as of this request. */
export interface TierOption {
  tier: string
  provider: string
  /** What the tier points at RIGHT NOW — `fast → claude-haiku-4-5-…`. */
  model_id: string
  group: string
  /**
   * False for a subprocess tier, which chooses its own reasoning effort.
   *
   * Optional for the same version-skew reason as the phase-level field: absent is
   * "no opinion", not `false`. Read it through {@link effortSettable}.
   */
  effort_supported?: boolean
  /** False when this install has no credential for it. Still shown, never hidden. */
  available: boolean
  unavailable_reason: string | null
}

/** An owner's override for one phase. Either field may stand alone. */
export interface PhaseOverride {
  model?: string
  effort?: string
}

export interface PhaseModelsPayload {
  phases: PhaseDescriptor[]
  model_tiers: TierOption[]
  efforts: string[]
  defaults: Record<string, { model: string; effort: string }>
  overrides: Record<string, PhaseOverride>
  /**
   * Stored values the server REFUSED — a tier since retired, an effort on a CLI step.
   * The row shows them struck through and names the default it fell back to, because
   * a control that silently reverts a choice is one the owner stops trusting.
   */
  rejected: Record<string, PhaseOverride>
}

export class PhaseModelsClientError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'PhaseModelsClientError'
    this.code = code
    this.status = status
  }
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

export interface PhaseModelsClientOptions {
  base_url: string
  token: string
  fetchImpl?: FetchImpl
}

const PATH = '/api/app/trident/phase-models'

export class WebPhaseModelsClient {
  private readonly base_url: string
  private readonly token: string
  private readonly fetchImpl: FetchImpl

  constructor(opts: PhaseModelsClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '')
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
  }

  async load(): Promise<PhaseModelsPayload> {
    return await this.req<PhaseModelsPayload>('GET')
  }

  /** Replace the complete override set. Throws with the server's message on 400. */
  async save(overrides: Record<string, PhaseOverride>): Promise<PhaseModelsPayload> {
    return await this.req<PhaseModelsPayload>('PUT', { overrides })
  }

  private async req<T>(method: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` }
    let payload: string | undefined
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    let res: Response
    try {
      res = await this.fetchImpl(`${this.base_url}${PATH}`, {
        method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
      })
    } catch (err) {
      throw new PhaseModelsClientError(
        'network',
        err instanceof Error ? err.message : 'request failed',
        0,
      )
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!res.ok) {
      const code = typeof json?.['code'] === 'string' ? (json['code'] as string) : `http_${res.status}`
      const message =
        typeof json?.['message'] === 'string'
          ? (json['message'] as string)
          : `request failed (${res.status})`
      throw new PhaseModelsClientError(code, message, res.status)
    }
    return (json ?? {}) as T
  }
}

/**
 * The value a row should DISPLAY for a phase: the override when set, else the default.
 *
 * Returns whether it IS an override, because a row that cannot distinguish "opus
 * because I chose it" from "opus because that is the default" gives the owner no way
 * to know what clearing would do.
 *
 * MUST MATCH `app/lib/phase-models-client.ts#effectiveRow`. A cross-client test pins
 * the pair, because this is a product decision and two copies of a decision drift.
 */
export function effectiveRow(
  phase: PhaseDescriptor,
  overrides: Record<string, PhaseOverride>,
): { model: string; effort: string; overridden: boolean } {
  const o = overrides[phase.key]
  const model = o?.model !== undefined && o.model.length > 0 ? o.model : phase.default.model
  const effort = o?.effort !== undefined && o.effort.length > 0 ? o.effort : phase.default.effort
  const overridden =
    (o?.model !== undefined && o.model.length > 0) ||
    (o?.effort !== undefined && o.effort.length > 0)
  return { model, effort, overridden }
}

/** `codex` → `Codex`. Executor names are shown to the owner mid-sentence. */
function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/**
 * Every executor the step can dispatch on, falling back to its default one.
 *
 * THE FALLBACK IS FOR AN OLDER SERVER. `groups` arrived with the build's second
 * executor; a gateway predating it sends `group` alone, and this client ships
 * separately from it. Reading through here means that payload renders the way it always
 * did instead of throwing and blanking the whole settings pane.
 *
 * MUST MATCH `app/lib/phase-models-client.ts#phaseGroupsOf`.
 */
export function phaseGroupsOf(phase: PhaseDescriptor): string[] {
  return phase.groups ?? [phase.group]
}

/**
 * Is the EFFORT control live for this row, given the tier it is set to?
 *
 * TWO QUESTIONS, BOTH OF WHICH MUST BE YES: the step has to have an effort control at
 * all (`phase.effort_supported`), and the chosen TIER has to be one that reads it. The
 * second is what the build row needs — it keeps its control on `opus` and loses it on
 * `sol`, because a `codex exec` subprocess picks its own reasoning effort. Asking only
 * the phase left the cell live on a codex build and posted an effort with the model,
 * which the server then had to throw away.
 *
 * An unknown tier (a saved override the server no longer resolves) keeps the phase's
 * own answer: the row is already telling the owner that value is dead.
 *
 * BOTH READS ARE `!== false`, NOT TRUTHINESS. An older gateway omits these fields
 * entirely, and `undefined` under a truthiness test means "no effort control anywhere"
 * — the same version-skew blanking `phaseGroupsOf` above already guards against.
 * Absent is not the same answer as false.
 *
 * MUST MATCH `app/lib/phase-models-client.ts#effortSettable`.
 */
export function effortSettable(
  phase: PhaseDescriptor,
  tier: string,
  tiers: TierOption[],
): boolean {
  if (phase.effort_supported === false) return false
  const chosen = tiers.find((t) => t.tier === tier)
  return chosen === undefined ? true : chosen.effort_supported !== false
}

/**
 * The tiers a row may offer, each with whether it can be CHOSEN and why not.
 *
 * NOTHING IS FILTERED OUT. A tier from another executor, or one this install has no
 * credential for, comes back `selectable: false` WITH a reason so the row can render
 * it greyed and say "needs a Codex connection". Hiding it would leave the owner unable
 * to account for a missing option — which is exactly how a whole capability stayed
 * invisible for weeks (ISSUES #551). The reason is the product decision here, so it
 * lives in the shared helper rather than in either component.
 *
 * MUST MATCH `app/lib/phase-models-client.ts#tierChoices`.
 */
export function tierChoices(
  phase: PhaseDescriptor,
  tiers: TierOption[],
): Array<{ tier: string; model_id: string; selectable: boolean; reason: string | null }> {
  const groups = phaseGroupsOf(phase)
  return tiers.map((t) => {
    if (!groups.includes(t.group)) {
      // #565 — SAY WHY, AND WHAT WOULD CHANGE IT. The old reason read `Codex steps
      // only`, naming a category the reader has never heard of and explaining
      // nothing; the owner's first words on seeing it were "Wtf does that mean?".
      // The accurate statement is about WIRING, not existence: a codex substrate
      // adapter is already built and registered (`runtime/adapters/codex-cli/`,
      // selected in `runtime/adapters/select-substrate.ts`), and trident's own
      // review seat already shells into `codex exec` — what is missing is a route
      // from THAT step to it. Saying "no executor exists" would be a second false
      // claim in place of the first.
      //
      // The test of the sentence is that it stops being shown the moment the route
      // lands: the build step now dispatches to the codex executor, so `groups`
      // carries `codex` for that row and the GPT tiers here are selectable rather
      // than greyed with a reason that has become false.
      // NAMES EVERY EXECUTOR THE STEP REACHES, not just its default one. On the build
      // row — the one row this sentence was written for — "it runs on Claude" stopped
      // being the whole truth the moment the codex route landed, and a Kimi tier greyed
      // with a half-true reason is the same defect in a smaller size.
      const optionExecutor = capitalize(t.group)
      const stepExecutor = groups.map(capitalize).join(' or ')
      return {
        tier: t.tier,
        model_id: t.model_id,
        selectable: false,
        reason: phase.dispatch_constraint ?? `${optionExecutor} is not wired for this step yet — it runs on ${stepExecutor}`,
      }
    }
    if (!t.available) {
      return {
        tier: t.tier,
        model_id: t.model_id,
        selectable: false,
        reason: t.unavailable_reason ?? 'not available on this install',
      }
    }
    return { tier: t.tier, model_id: t.model_id, selectable: true, reason: null }
  })
}

/**
 * What a tier resolves to right now, or null when the payload has never heard of it.
 *
 * Null is the interesting case: it means a saved override names something the server
 * cannot resolve, which the row must SAY rather than quietly replace.
 *
 * MUST MATCH `app/lib/phase-models-client.ts#resolvedModel`.
 */
export function resolvedModel(tier: string, tiers: TierOption[]): string | null {
  return tiers.find((t) => t.tier === tier)?.model_id ?? null
}

/**
 * The stored-but-refused model for a row, or null.
 *
 * Only the MODEL is surfaced: a refused effort belongs to a CLI row, whose effort cell
 * is already disabled with the reason, so striking it through as well would explain
 * the same thing twice.
 *
 * MUST MATCH `app/lib/phase-models-client.ts#rejectedModel`.
 */
export function rejectedModel(
  phase: PhaseDescriptor,
  rejected: Record<string, PhaseOverride>,
): string | null {
  const value = rejected[phase.key]?.model
  return value !== undefined && value.length > 0 ? value : null
}

/**
 * Apply one row's edit, DROPPING an entry that matches the phase's default.
 *
 * Storing `opus` for a phase whose default is already `opus` would pin it to a tier it
 * happens to hold today, so a later change to that default would silently not reach
 * it. Choosing the default therefore means "no override" — which is also what makes
 * the reset affordance fall out for free.
 *
 * IT ALSO DROPS AN EFFORT THE NEW TIER CANNOT USE. Moving the build row from `opus` to
 * a codex tier leaves any previously-chosen effort sitting in the map. The effort is
 * not a second choice the owner is making here; it is a leftover from the executor
 * they just left.
 *
 * SENDING THE PAIR WOULD NOT FAIL THE SAVE — the server drops it too
 * (`trident/phase-models.ts#parsePhaseModelConfig` deletes the effort and records it in
 * `rejected` WITHOUT pushing an error, so the PUT returns ok). Dropping it here is
 * therefore about what the owner SEES, not about avoiding a rejection: leaving the
 * stale effort in the map would render a control the chosen tier does not have, and the
 * owner would set a value, save successfully, and find it gone on the next read with
 * nothing having said so.
 *
 * MUST MATCH `app/lib/phase-models-client.ts#applyRowEdit`.
 */
export function applyRowEdit(
  overrides: Record<string, PhaseOverride>,
  phase: PhaseDescriptor,
  patch: { model?: string; effort?: string },
  tiers: TierOption[],
): Record<string, PhaseOverride> {
  const current = overrides[phase.key] ?? {}
  const next: PhaseOverride = { ...current, ...patch }
  if (next.model === phase.default.model) delete next.model
  if (next.effort === phase.default.effort) delete next.effort
  if (
    next.effort !== undefined &&
    !effortSettable(phase, next.model ?? phase.default.model, tiers)
  ) {
    delete next.effort
  }
  const out = { ...overrides }
  if (next.model === undefined && next.effort === undefined) {
    delete out[phase.key]
  } else {
    out[phase.key] = next
  }
  return out
}
