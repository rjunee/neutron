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
 *      token is invalidated at once, in a COMMITTED-phase effect (never
 *      during render). Render must stay pure: a render for project B
 *      that resets the gate but is then abandoned / suspended by React
 *      would leave the committed UI on A while A's still-in-flight
 *      request now fails `isLatest` — its guarded `finally` could never
 *      clear the loading flag, stranding the A screen (Codex D7-r2).
 *      An effect only runs on a COMMITTED transition, so the
 *      invalidation tracks what the user actually sees. Ordering is
 *      still preserved: this hook is called at the TOP of each data
 *      hook, so its reset effect registers — and therefore runs —
 *      before that hook's own refetch effect, keeping "gate reset
 *      BEFORE fetchTree". `RequestGate.reset()` only bumps a monotonic
 *      counter, so a StrictMode double-invoke is a no-op for
 *      correctness.
 *
 * Under the hood this is a `RequestGate` (see `lib/docs-client.ts`)
 * memoised for the component's lifetime; the hook just names the
 * pattern and owns the reset-on-switch wiring so each data cluster
 * doesn't reimplement it.
 */

import { useEffect, useMemo, useRef } from 'react';

import { RequestGate } from '../../lib/docs-client';

export interface ProjectScopedGate {
  /** Grab a token before the first await. The latest token wins. */
  acquire(): number;
  /** True while `token` is still the latest acquired token. */
  isLatest(token: number): boolean;
}

export function useProjectScopedAsync(projectId: string): ProjectScopedGate {
  const gate = useMemo(() => new RequestGate(), []);
  const seenProject = useRef(projectId);
  // reset-on-switch: invalidate every in-flight token on a COMMITTED
  // project transition (see property (3) above). The ref compare skips
  // the mount run (nothing in flight yet) so only real A → B switches
  // reset.
  useEffect(() => {
    if (seenProject.current !== projectId) {
      seenProject.current = projectId;
      gate.reset();
    }
  }, [projectId, gate]);
  return gate;
}
