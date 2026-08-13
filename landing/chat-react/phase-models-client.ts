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
  default: { model: string; effort: string }
}

/** An owner's override for one phase. Either field may stand alone. */
export interface PhaseOverride {
  model?: string
  effort?: string
}

export interface PhaseModelsPayload {
  phases: PhaseDescriptor[]
  model_tiers: string[]
  efforts: string[]
  defaults: Record<string, { model: string; effort: string }>
  overrides: Record<string, PhaseOverride>
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

/**
 * Apply one row's edit, DROPPING an entry that matches the phase's default.
 *
 * Storing `opus` for a phase whose default is already `opus` would pin it to a tier it
 * happens to hold today, so a later change to that default would silently not reach
 * it. Choosing the default therefore means "no override" — which is also what makes
 * the reset affordance fall out for free.
 *
 * MUST MATCH `app/lib/phase-models-client.ts#applyRowEdit`.
 */
export function applyRowEdit(
  overrides: Record<string, PhaseOverride>,
  phase: PhaseDescriptor,
  patch: { model?: string; effort?: string },
): Record<string, PhaseOverride> {
  const current = overrides[phase.key] ?? {}
  const next: PhaseOverride = { ...current, ...patch }
  if (next.model === phase.default.model) delete next.model
  if (next.effort === phase.default.effort) delete next.effort
  const out = { ...overrides }
  if (next.model === undefined && next.effort === undefined) {
    delete out[phase.key]
  } else {
    out[phase.key] = next
  }
  return out
}
