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
  key: string;
  label: string;
  description: string;
  /**
   * Which executors this step can dispatch on (`claude`, `codex`, `kimi`).
   *
   * A LIST, because a step can genuinely reach more than one: the build row runs on
   * Claude or on the Codex CLI. It used to be a single `group`, which is what locked
   * every row to one executor forever.
   */
  executors: string[];
  /** True only for the cross-model review slots, which may be emptied. */
  allows_none: boolean;
  /**
   * WHICH TIERS THIS ROW MAY OFFER, AND WHY NOT — decided by the SERVER.
   *
   * The clients used to derive this by comparing group strings themselves, so the rule
   * lived in three places (the validator, this file, and the web copy) and could
   * disagree. The disagreement is invisible until an owner picks a value one client
   * offered and the server refuses the save, at which point the pane looks broken. The
   * server owns the rule; these files render it.
   */
  tier_options: Array<{ tier: string; selectable: boolean; reason: string | null }>;
  /** False for a CLI step, whose reasoning effort is the CLI's own. */
  effort_supported: boolean;
  default: { model: string; effort: string };
}

/** One selectable tier, resolved by the server as of this request. */
export interface TierOption {
  tier: string;
  provider: string;
  /** What the tier points at RIGHT NOW — `fast → claude-haiku-4-5-…`. */
  model_id: string;
  group: string;
  /** False when this install has no credential for it. Still shown, never hidden. */
  available: boolean;
  unavailable_reason: string | null;
}

/** An owner's override for one phase. Either field may stand alone. */
export interface PhaseOverride {
  model?: string;
  effort?: string;
}

export interface PhaseModelsPayload {
  phases: PhaseDescriptor[];
  model_tiers: TierOption[];
  efforts: string[];
  /** The sentinel a cross-model slot stores when the owner turns it off (`none`). */
  none_value: string;
  defaults: Record<string, { model: string; effort: string }>;
  overrides: Record<string, PhaseOverride>;
  /**
   * Stored values the server REFUSED — a tier since retired, an effort on a CLI step.
   * The row shows them struck through and names the default it fell back to, because
   * a control that silently reverts a choice is one the owner stops trusting.
   */
  rejected: Record<string, PhaseOverride>;
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

export class WebPhaseModelsClient {
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
 * The tiers a row may offer, each with whether it can be CHOSEN and why not.
 *
 * NOTHING IS FILTERED OUT. A tier this row's dispatch cannot reach, or one this
 * install has no credential for, comes back `selectable: false` WITH a reason so the
 * row can render it greyed and say why. Hiding it would leave the owner unable to
 * account for a missing option — which is exactly how a whole capability stayed
 * invisible for weeks (ISSUES #551).
 *
 * TWO INDEPENDENT REASONS TO GREY, AND THEY ARE ORDERED. Capability first (`this step
 * cannot dispatch that executor`), credential second (`this install has no key`). A
 * tier that fails both is a tier the owner cannot use even after connecting an
 * account, so leading with the credential would send them to set up a connection that
 * changes nothing.
 *
 * THE CAPABILITY ANSWER IS THE SERVER'S. `phase.tier_options` is computed next to the
 * validator that enforces it, so the option this row greys out and the value the
 * server would refuse are the same fact, phrased once. This file no longer compares
 * group strings — that was the copy that could drift.
 *
 * MUST MATCH `app/lib/phase-models-client.ts#tierChoices`.
 */
export function tierChoices(
  phase: PhaseDescriptor,
  tiers: TierOption[],
): Array<{ tier: string; model_id: string; selectable: boolean; reason: string | null }> {
  const byTier = new Map(phase.tier_options.map((o) => [o.tier, o]));
  return tiers.map((t) => {
    const option = byTier.get(t.tier);
    if (option === undefined || !option.selectable) {
      return {
        tier: t.tier,
        model_id: t.model_id,
        selectable: false,
        reason: option?.reason ?? 'not available for this step',
      };
    }
    if (!t.available) {
      return {
        tier: t.tier,
        model_id: t.model_id,
        selectable: false,
        reason: t.unavailable_reason ?? 'not available on this install',
      };
    }
    return { tier: t.tier, model_id: t.model_id, selectable: true, reason: null };
  });
}

/**
 * Is this row's cross-model seat turned OFF?
 *
 * A pure predicate rather than an inline `=== 'none'`, because the string is a wire
 * value the server sends and both panes must read it the same way. A seat the owner
 * emptied and a seat that merely has no verdict are different states everywhere else
 * in this feature; they must not become the same one in the UI either.
 *
 * MUST MATCH `app/lib/phase-models-client.ts#slotIsOff`.
 */
export function slotIsOff(
  phase: PhaseDescriptor,
  overrides: Record<string, PhaseOverride>,
  noneValue: string,
): boolean {
  return phase.allows_none && overrides[phase.key]?.model === noneValue;
}

/**
 * Is the review panel deliberately single-family?
 *
 * True when every cross-model slot is off. It is a legitimate configuration and must
 * not be presented as an error — but a panel of Claude reviewers only is a panel with
 * one set of blind spots, and a pane that stays silent about it lets the owner keep
 * believing a second family is checking the work.
 *
 * MUST MATCH `app/lib/phase-models-client.ts#panelIsSingleFamily`.
 */
export function panelIsSingleFamily(
  phases: PhaseDescriptor[],
  overrides: Record<string, PhaseOverride>,
  noneValue: string,
): boolean {
  const slots = phases.filter((p) => p.allows_none);
  return slots.length > 0 && slots.every((p) => slotIsOff(p, overrides, noneValue));
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
  return tiers.find((t) => t.tier === tier)?.model_id ?? null;
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
  const value = rejected[phase.key]?.model;
  return value !== undefined && value.length > 0 ? value : null;
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
