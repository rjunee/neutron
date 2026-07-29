/**
 * @neutronai/app — `HookRuntime`: the injectable React hook dispatcher seam.
 *
 * WHY THIS EXISTS (test-isolation, not a product feature)
 * ------------------------------------------------------
 * Several app units are hooks/components with no mount harness in this repo
 * (no `@testing-library/react-native`; `react-test-renderer` is deprecated in
 * React 19). Their tests therefore drive the REAL unit against a stubbed hook
 * dispatcher — ordered `useState` slots plus a committed-effect runner — which
 * is a legitimate and valuable way to test them.
 *
 * What is NOT legitimate is the way that stub used to be installed:
 * `mock.module('react', ...)`. Bun's `mock.module` is GLOBAL TO THE TEST
 * PROCESS and is NOT undone by `mock.restore()`, so once any such file ran,
 * every later test in the same `bun test` process rendered against the stub.
 * The observed blast radius was ~92 failures across the repo, all of the shape
 * `TypeError: undefined is not an object (evaluating 'ReactSharedInternals.S')`
 * thrown inside `react-dom` — react-dom asking the real React for shared
 * internals the stub does not have. Test correctness became a function of file
 * execution ORDER.
 *
 * The fix is ordinary dependency injection: a unit that needs its dispatcher
 * substituted takes it as an explicit argument defaulting to the real one.
 * Production callers pass nothing and get real React; a test passes its stub
 * and the substitution is scoped to that single call. Nothing global is
 * mutated, so no execution order can matter.
 *
 * Only the dispatcher hooks belong here. Non-dispatcher React exports
 * (`createElement`, types, …) are imported normally by the units — they were
 * never the thing a test needed to control.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';

export interface HookRuntime {
  useState: typeof useState;
  useRef: typeof useRef;
  useMemo: typeof useMemo;
  useCallback: typeof useCallback;
  useEffect: typeof useEffect;
  useReducer: typeof useReducer;
}

/** The real React dispatcher — the default for every injection point. */
export const reactHooks: HookRuntime = {
  useState,
  useRef,
  useMemo,
  useCallback,
  useEffect,
  useReducer,
};
