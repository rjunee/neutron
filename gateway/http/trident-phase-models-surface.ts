/**
 * @neutronai/gateway/http — the per-phase model/effort settings surface.
 *
 * Backs the code-gen Settings section on both clients: which model and reasoning
 * effort run each phase of a build, and the writes that change them.
 *
 *   - `GET /api/app/trident/phase-models` → the phases, their defaults, the
 *     owner's overrides, and the vocabulary a UI needs to render controls
 *   - `PUT /api/app/trident/phase-models` → replace the overrides ({ overrides })
 *
 * ── THE WRITE FAILS WHOLE ────────────────────────────────────────────────────
 * A payload with any invalid entry is rejected with 400 and stores NOTHING, and
 * the response names every problem. That is the opposite of what the read path
 * and the workflow do with a bad entry, and the asymmetry is the entire design:
 * here the owner is present and can be told, so a silent partial write is the
 * worst outcome available — they would set `xhigh`, observe no change, and
 * reasonably conclude the feature is broken. Deeper in the stack nobody is
 * listening, so dropping the entry and continuing is the only safe move there.
 *
 * ── REPLACE, NOT MERGE ───────────────────────────────────────────────────────
 * `PUT` takes the complete set. A merge would leave no way to CLEAR a phase back
 * to its default: sending `{}` for it would mean "change nothing" rather than
 * "unset", and the owner would need a second verb to undo a pin. Sending the full
 * set makes clearing an omission, which is what a settings pane naturally does
 * when a control returns to its default.
 *
 * ── THE GET CARRIES THE VOCABULARY ───────────────────────────────────────────
 * Phases, labels, descriptions, defaults, the tier names and the effort scale all
 * ship in the payload, derived from `TRIDENT_PHASES` rather than restated. Two
 * clients render this (React DOM and React Native) and neither should carry its
 * own copy of the phase list — that is how a phase gets added to the engine and
 * silently stays invisible in the UI on one platform.
 *
 * ── THE PAYLOAD RESOLVES EACH TIER, AND ADMITS WHAT IT CANNOT RUN ────────────
 * The controls offer TIERS (they follow a model upgrade; a literal id does not),
 * and every tier ships with the id it resolves to RIGHT NOW plus the EXECUTOR
 * GROUP that reaches it (`claude`, `codex`, `kimi`) — which is how a row knows
 * that a GPT tier cannot run a Claude step. A tier whose group has no credential on this install is
 * still sent, marked unavailable WITH THE REASON — never omitted. An option the
 * owner cannot see is an option they cannot ask about, which is how a whole
 * capability stayed invisible for weeks (ISSUES #551).
 *
 * INSTALL-WIDE, no project segment: which model runs a build is a property of
 * the owner's subscriptions and quota, not of the thing being built. The pane
 * labels itself that way because the storage is keyed by instance slug alone
 * (`instance_metadata.trident_phase_models`) — there is no project dimension, and
 * a section sitting in project settings that silently applies everywhere is a
 * worse lie than an honest label. Same bearer auth as its siblings; the scope key
 * is ALWAYS the server-derived `resolved.project_slug`, never client-supplied.
 */

import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import type { CodexAvailability } from '@neutronai/trident/codex-credential.ts'
import { modelTierRegistry } from '@neutronai/trident/model-tiers.ts'
import {
  EFFORTS,
  TRIDENT_PHASES,
  phaseGroup,
  phaseGroups,
  phaseModelDefaults,
  phaseSupportsEffort,
} from '@neutronai/trident/phase-models.ts'

import { jsonError, jsonOk, readJsonBody, resolveBearer } from './surface-kit.ts'

const PATH = '/api/app/trident/phase-models'

/** Which cross-model executors this install can actually run. */
export interface CrossModelConnections {
  /**
   * Whether the codex executor can run here — and WHEN IT CANNOT, WHY, in the words
   * the owner is shown. Answered by `codexExecutorAvailability`, which is the same
   * decision the build's own preconditions make; see its header for why the reason
   * travels WITH the answer instead of beside it.
   */
  codex: CodexAvailability
  /**
   * A Kimi key — without it the K3 tier cannot run. Still a boolean because the Kimi
   * REVIEW lane has exactly one precondition, so "needs a Kimi key" cannot become the
   * wrong sentence the way the codex one did.
   */
  kimi: boolean
}

export interface TridentPhaseModelsSurfaceOptions {
  auth: AppWsAuthResolver
  /**
   * Read the stored overrides for a scope, WITH the entries validation dropped.
   *
   * Both halves, because a pane that only saw the surviving config could not tell an
   * override the owner never set from one that was silently discarded — and a control
   * that quietly reverts a choice is one the owner stops believing.
   */
  read: (scope: string) => {
    config: Readonly<Record<string, { model?: string; effort?: string }>>
    rejected: Readonly<Record<string, { model?: string; effort?: string }>>
  }
  /** Persist a complete override set. Returns the validation errors, if any. */
  write: (
    scope: string,
    input: unknown,
  ) => Promise<{ ok: boolean; errors: ReadonlyArray<string> }>
  /**
   * Are the cross-model transports reachable on THIS install? Called per request, so
   * a credential connected a minute ago un-greys its tiers without a restart.
   *
   * REQUIRED, not optional with a cheerful default: a tier reported available that
   * cannot run produces a review that defers and blocks a merge for a reason the
   * owner cannot see. The composer must answer this from the same resolvers the
   * build uses.
   */
  connections: () => CrossModelConnections
}

export interface TridentPhaseModelsSurface {
  handler: (req: Request) => Promise<Response | null>
}

/**
 * The static half of the payload: what a UI needs to draw the controls.
 *
 * Derived from `TRIDENT_PHASES`, never restated, so a phase added to the engine
 * appears in both clients without either being edited.
 */
function vocabulary(connections: CrossModelConnections): object {
  return {
    // A FOLLOWER PHASE IS NOT A ROW. `build_mechanical` is the build step under the
    // planner's internal complexity tag and takes `build`'s setting when it has none
    // of its own (`TridentPhase.follows`, implemented by the workflow's
    // `phaseOverrideFor`). Rendering it would show its own `sonnet` default beside a
    // run that dispatched the owner's codex tier — the pane/run disagreement
    // `trident/phase-models.ts` exists to prevent. Filtered HERE, once, rather than in
    // each of the two clients, so they cannot disagree about it either.
    phases: TRIDENT_PHASES.filter((p) => p.follows === undefined).map((p) => ({
      key: p.key,
      label: p.label,
      description: p.description,
      // WHICH EXECUTOR runs this step by DEFAULT — what the row names when it explains
      // that an option is greyed ("…it runs on Claude").
      group: phaseGroup(p),
      // EVERY executor this step can dispatch on, which is what decides whether a tier
      // is selectable. Most steps have one; `build` has two (Claude and codex), and a
      // row that compared against `group` alone would grey the codex tiers on a step
      // that now genuinely reaches them.
      groups: phaseGroups(p),
      // Could this step EVER have an effort control — i.e. does its default executor
      // read one. Whether the cell is live right now also depends on the tier the
      // owner has chosen (see `effort_supported` on each tier below), because the
      // build's second executor is a CLI that picks its own reasoning effort.
      effort_supported: phaseSupportsEffort(p),
      default: { model: p.default.tier, effort: p.default.effort },
    })),
    // THE TIERS, RESOLVED AS OF NOW. Each carries what it points at today
    // (`fast → claude-haiku-4-5-…`), so the pane can be explicit about the actual
    // model WITHOUT the pane needing an edit when a tier's target moves — which is
    // the whole reason the owner picks a tier and not an id.
    //
    // An UNAVAILABLE tier is still listed, with the reason. Dropping it would leave
    // the owner unable to account for a missing option, which is exactly how a
    // capability stays invisible for weeks (ISSUES #551).
    model_tiers: modelTierRegistry().map((t) => {
      // THE REASON IS COMPUTED FIRST AND `available` IS DERIVED FROM IT, so a tier
      // cannot be marked unavailable without saying why. The other order — a boolean
      // plus a reason looked up beside it — is how "needs a Codex connection" outlived
      // the single condition it described.
      const reason =
        t.requires === null
          ? null
          : t.requires === 'codex'
            ? connections.codex.usable
              ? null
              : connections.codex.reason
            : connections.kimi
              ? null
              : 'needs a Kimi key'
      const available = reason === null
      return {
        tier: t.tier,
        provider: t.provider,
        model_id: t.model_id,
        group: t.group,
        // WHETHER PICKING THIS TIER LEAVES THE EFFORT CELL LIVE. Shipped per tier and
        // derived here, so the rule ("a subprocess chooses its own reasoning effort")
        // is stated once on the server rather than re-derived from `group` by each of
        // the two clients. A row whose phase can reach two executors needs this: the
        // build's effort control is real on `opus` and inert on `sol`, and a pane that
        // asked only the PHASE kept the cell live and posted an effort the chosen tier
        // cannot use.
        effort_supported: t.transport === 'agent',
        available,
        unavailable_reason: reason,
      }
    }),
    efforts: [...EFFORTS],
  }
}

export function createTridentPhaseModelsSurface(
  opts: TridentPhaseModelsSurfaceOptions,
): TridentPhaseModelsSurface {
  return {
    handler: async (req: Request): Promise<Response | null> => {
      const url = new URL(req.url)
      if (url.pathname !== PATH) return null

      const resolved = await resolveBearer(req, opts.auth)
      if ('code' in resolved) return jsonError(401, resolved.code, resolved.message)
      const scope = resolved.project_slug

      const payload = (): object => {
        const stored = opts.read(scope)
        return {
          ...vocabulary(opts.connections()),
          defaults: phaseModelDefaults(),
          overrides: stored.config,
          // What was stored and could not be used. The pane shows these struck
          // through with the default it fell back to.
          rejected: stored.rejected,
        }
      }

      switch (req.method) {
        case 'GET':
          return jsonOk(payload())
        case 'PUT': {
          const body = (await readJsonBody(req)) as Record<string, unknown> | null
          if (body === null) {
            return jsonError(400, 'malformed_json', 'expected a JSON body')
          }
          // `overrides` is required and must be present even when empty — an
          // absent key would be ambiguous between "clear everything" and "the
          // client forgot the field", and clearing every pin by accident is not a
          // mistake this surface should make possible.
          if (!('overrides' in body)) {
            return jsonError(
              400,
              'missing_overrides',
              "expected { overrides: { <phase>: { model?, effort? } } } — send {} to clear",
            )
          }
          const result = await opts.write(scope, body['overrides'])
          if (!result.ok) {
            // Every problem, not just the first. An owner fixing a config one
            // rejected field per round trip is a worse experience than the silent
            // drop this rejection exists to prevent.
            return jsonError(400, 'invalid_phase_models', result.errors.join('; '))
          }
          return jsonOk(payload())
        }
        default:
          return jsonError(
            405,
            'method_not_allowed',
            `method '${req.method}' not allowed on ${PATH}`,
          )
      }
    },
  }
}
