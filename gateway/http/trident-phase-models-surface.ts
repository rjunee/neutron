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
 * MACHINE-SCOPED, no project segment: which model runs a build is a property of
 * the owner's subscriptions and quota, not of the thing being built. Same bearer
 * auth as its siblings; the scope key is ALWAYS the server-derived
 * `resolved.project_slug`, never client-supplied.
 */

import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import {
  EFFORTS,
  MODEL_TIERS,
  TRIDENT_PHASES,
  phaseModelDefaults,
} from '@neutronai/trident/phase-models.ts'

import { jsonError, jsonOk, readJsonBody, resolveBearer } from './surface-kit.ts'

const PATH = '/api/app/trident/phase-models'

export interface TridentPhaseModelsSurfaceOptions {
  auth: AppWsAuthResolver
  /** Read the stored overrides for a scope (already re-validated). */
  read: (scope: string) => Readonly<Record<string, { model?: string; effort?: string }>>
  /** Persist a complete override set. Returns the validation errors, if any. */
  write: (
    scope: string,
    input: unknown,
  ) => Promise<{ ok: boolean; errors: ReadonlyArray<string> }>
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
function vocabulary(): object {
  return {
    phases: TRIDENT_PHASES.map((p) => ({
      key: p.key,
      label: p.label,
      description: p.description,
      default: { model: p.default.tier, effort: p.default.effort },
    })),
    model_tiers: [...MODEL_TIERS],
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

      switch (req.method) {
        case 'GET':
          return jsonOk({
            ...vocabulary(),
            defaults: phaseModelDefaults(),
            overrides: opts.read(scope),
          })
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
          return jsonOk({
            ...vocabulary(),
            defaults: phaseModelDefaults(),
            overrides: opts.read(scope),
          })
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
