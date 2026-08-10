/**
 * @neutronai/app — per-phase build model/effort settings client (mobile).
 *
 *   GET /api/app/trident/phase-models   the phases, defaults, and the owner's overrides
 *   PUT /api/app/trident/phase-models   replace the overrides ({ overrides })
 *
 * THE PHASE LIST COMES FROM THE SERVER, not from a copy in here. Two clients render
 * this screen and neither should carry its own idea of what the phases are — that is
 * how a phase gets added to the engine and stays invisible in the UI on one platform.
 * The payload carries the labels, the descriptions, the defaults and the legal values,
 * so this file describes a SHAPE and nothing about the pipeline.
 *
 * THE WRITE REPLACES THE WHOLE SET. Sending the complete map is what makes clearing a
 * pin an omission — with a merge there would be no way to say "back to default"
 * without a second verb. The server rejects an absent `overrides` key outright rather
 * than reading it as "clear everything".
 *
 * A REJECTED WRITE CHANGES NOTHING SERVER-SIDE, and its message names every problem
 * rather than the first. The caller is expected to show that verbatim: the owner is
 * the only one who can fix a bad value, and a generic "save failed" hides which of
 * their rows was wrong.
 *
 * Wire shapes are re-declared rather than imported across the workspace boundary —
 * the app bundle stays free of gateway dependencies, as every client here does.
 */

/** One phase, as the server describes it. */
export interface PhaseDescriptor {
  key: string;
  label: string;
  description: string;
  default: { model: string; effort: string };
}

/** An owner's override for one phase. Either field may stand alone. */
export interface PhaseOverride {
  model?: string;
  effort?: string;
}

export interface PhaseModelsPayload {
  phases: PhaseDescriptor[];
  model_tiers: string[];
  efforts: string[];
  defaults: Record<string, { model: string; effort: string }>;
  overrides: Record<string, PhaseOverride>;
}

export class PhaseModelsClientError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'PhaseModelsClientError';
    this.code = code;
    this.status = status;
  }
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface PhaseModelsClientOptions {
  base_url: string;
  token: string;
  /** Injected for tests. */
  fetchImpl?: FetchImpl;
}

const PATH = '/api/app/trident/phase-models';

export class PhaseModelsClient {
  private readonly base_url: string;
  private readonly token: string;
  private readonly fetchImpl: FetchImpl;

  constructor(opts: PhaseModelsClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async load(): Promise<PhaseModelsPayload> {
    return await this.req<PhaseModelsPayload>('GET');
  }

  /** Replace the complete override set. Throws with the server's message on 400. */
  async save(overrides: Record<string, PhaseOverride>): Promise<PhaseModelsPayload> {
    return await this.req<PhaseModelsPayload>('PUT', { overrides });
  }

  private async req<T>(method: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    let payload: string | undefined;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base_url}${PATH}`, {
        method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
      });
    } catch (err) {
      throw new PhaseModelsClientError(
        'network',
        err instanceof Error ? err.message : 'request failed',
        0,
      );
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const code =
        typeof json?.['code'] === 'string' ? (json['code'] as string) : `http_${res.status}`;
      const message =
        typeof json?.['message'] === 'string'
          ? (json['message'] as string)
          : `request failed (${res.status})`;
      throw new PhaseModelsClientError(code, message, res.status);
    }
    return (json ?? {}) as T;
  }
}

/**
 * The value a row should DISPLAY for a phase: the override when set, else the default.
 *
 * Pure, so the screen never has to decide this inline and the "shows the default when
 * unset" behaviour is testable without a render. Returns the default flagged as such,
 * because a row that cannot distinguish "opus because I chose it" from "opus because
 * that is the default" gives the owner no way to know what clearing would do.
 */
export function effectiveRow(
  phase: PhaseDescriptor,
  overrides: Record<string, PhaseOverride>,
): { model: string; effort: string; overridden: boolean } {
  const o = overrides[phase.key];
  const model = o?.model !== undefined && o.model.length > 0 ? o.model : phase.default.model;
  const effort = o?.effort !== undefined && o.effort.length > 0 ? o.effort : phase.default.effort;
  const overridden =
    (o?.model !== undefined && o.model.length > 0) || (o?.effort !== undefined && o.effort.length > 0);
  return { model, effort, overridden };
}

/**
 * Apply one row's edit to the override map, DROPPING an entry that matches the default.
 *
 * Storing "opus" for a phase whose default is already "opus" would pin the phase to a
 * tier it happens to hold today — so a later change to the default would silently not
 * reach it. Choosing the default value therefore means "no override", which is also
 * what makes the UI's reset behaviour fall out for free.
 */
export function applyRowEdit(
  overrides: Record<string, PhaseOverride>,
  phase: PhaseDescriptor,
  patch: { model?: string; effort?: string },
): Record<string, PhaseOverride> {
  const current = overrides[phase.key] ?? {};
  const next: PhaseOverride = { ...current, ...patch };
  if (next.model === phase.default.model) delete next.model;
  if (next.effort === phase.default.effort) delete next.effort;
  const out = { ...overrides };
  if (next.model === undefined && next.effort === undefined) {
    delete out[phase.key];
  } else {
    out[phase.key] = next;
  }
  return out;
}
