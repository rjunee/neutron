/**
 * @neutronai/app — `useProjectScopedAsync`, the structural race-guard
 * primitive every docs data hook (`useDocTree`, `useDocFile`,
 * `useDocHistory`, `useDocMutations`) is built on (D7 refactor).
 *
 * The contract (three properties the P7.1 round-4→7 review history
 * fixed the docs tab against, one bug at a time):
 *
 *   1. acquire-before-first-await — every async op grabs a token
 *      (`gate.acquire()`) BEFORE its first `await`, so a project /
 *      file switch that happens mid-flight is observable when the
 *      response lands.
 *   2. isLatest-before-setState — the resolver calls
 *      `gate.isLatest(token)` and bails BEFORE committing any state,
 *      so a slower response from a superseded op can never stomp a
 *      newer one's state (or re-install a stale `file` closure whose
 *      next Save would write the wrong project's path).
 *   3. reset-on-switch — when `projectId` changes, every in-flight
 *      token is invalidated at once. Implemented here as a render-
 *      phase compare (the standard React "adjust on prop change"
 *      pattern) so the invalidation is guaranteed to precede the
 *      effect-phase refetch the switch triggers — this is what keeps
 *      the "gates reset BEFORE fetchTree" ordering the docs tab's
 *      project-change path depends on. `RequestGate.reset()` only
 *      bumps a monotonic counter, so a discarded render (or a
 *      StrictMode double-invoke) at worst invalidates tokens twice,
 *      which is a no-op for correctness.
 *
 * Under the hood this is a `RequestGate` (see `lib/docs-client.ts`)
 * memoised for the component's lifetime; the hook just names the
 * pattern and owns the reset-on-switch wiring so each data cluster
 * doesn't reimplement it.
 */

import { useMemo, useRef } from 'react';

import { RequestGate } from '../../lib/docs-client';

export interface ProjectScopedGate {
  /** Grab a token before the first await. The latest token wins. */
  acquire(): number;
  /** True while `token` is still the latest acquired token. */
  isLatest(token: number): boolean;
}

export function useProjectScopedAsync(projectId: string): ProjectScopedGate {
  const gate = useMemo(() => new RequestGate(), []);
  // reset-on-switch: invalidate every in-flight token the instant the
  // project changes, in the render pass — before the effects that
  // refetch this project's tree/file run. See property (3) above.
  const seenProject = useRef(projectId);
  if (seenProject.current !== projectId) {
    seenProject.current = projectId;
    gate.reset();
  }
  return gate;
}
