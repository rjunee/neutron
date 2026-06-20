/**
 * @neutronai/app — focus-state reducer (P5.6).
 *
 * Pure, React-free reducer for the global Focus view provider.
 * Mirrors `task-state-reducer.ts` (P5.4) + `reminder-state-reducer.ts`
 * (P5.5) shape — the load lifecycle stays the same; mutations are
 * intentionally absent because the Focus view is a read-only
 * projection (engineering-plan § B.P5 L634).
 *
 *   1. Load     — `LOAD_START` / `LOAD_OK` / `LOAD_FAIL`.
 *                 Initial-mount fetch clears the prior list (rare —
 *                 only after sign-out + sign-in within the same
 *                 process; normally the provider mounts fresh).
 *   2. Refresh  — `REFRESH_START` / `LOAD_OK` / `LOAD_FAIL`. Keeps the
 *                 existing rows visible while the refresh spinner
 *                 plays. Pull-to-refresh + manual Refresh button + the
 *                 on-tab-focus auto-refresh all dispatch this pair.
 *   3. Banner   — `DISMISS_ERROR` clears `error` without re-fetching.
 *
 * Also exports the `bucketizeSections` helper that the provider runs
 * once per `LOAD_OK` to transform the flat `FocusItem[]` server
 * response into the grouped `BucketSection[]` shape the UI renders
 * (overdue → today → soon; empty buckets suppressed). Doing the
 * bucketing inside the reducer keeps the route file from re-deriving
 * sections on every render.
 */

import type {
  FocusBucket,
  FocusItem,
  FocusOrder,
} from './focus-client';

/** Bucket section the UI renders after the reducer groups the flat list. */
export interface BucketSection {
  /** Canonical bucket id (matches the server's `FocusBucket`). */
  bucket: FocusBucket;
  /** Display label rendered as the section overline (`Overdue` / `Today` / `Soon`). */
  label: string;
  /** Items in this bucket, in server-canonical sort order. */
  items: FocusItem[];
}

/** Server-canonical bucket order. Overdue first, then today, then soon. */
export const BUCKET_ORDER: ReadonlyArray<FocusBucket> = [
  'overdue',
  'today',
  'soon',
];

/** Display labels for each bucket — token-ified out of the MVP's inline strings. */
export const BUCKET_LABELS: Readonly<Record<FocusBucket, string>> = Object.freeze({
  overdue: 'Overdue',
  today: 'Today',
  soon: 'Soon',
});

/**
 * Locked default sort for the Focus view (brief § 4.3). The opt-in
 * `'focus_score'` is plumbed through the client for a future per-user
 * preference but stays off at P5.6 — Focus's value-add is the bucket
 * grouping, not the score (which is the Tasks tab's lens per P5.4 § 4.2).
 */
export const DEFAULT_FOCUS_ORDER: FocusOrder = 'default';

export interface FocusStateError {
  /** Stable identifier (e.g. 'forbidden', 'network', 'invalid_response'). */
  code: string;
  /** Human-readable message safe to surface inline. */
  message: string;
}

export interface FocusState {
  /** True while the initial fetch (or a manual reload after error) is in flight. */
  loading: boolean;
  /**
   * True while a pull-to-refresh / manual Refresh / on-tab-focus refresh
   * is in flight. Distinct from `loading` so the UI can keep the
   * prior list visible during a refresh.
   */
  refreshing: boolean;
  /** Flat server-canonical list (cached on the state so the reducer can re-derive sections). */
  items: FocusItem[];
  /** Grouped sections derived from `items` (one pass per LOAD_OK). */
  sections: BucketSection[];
  /** Last error from a failed GET; cleared on success or DISMISS_ERROR. */
  error: FocusStateError | null;
  /**
   * Server-side `now` reference at the moment of the last successful
   * load. Plumbed for a future "refreshed Xm ago" polish (not rendered
   * at P5.6).
   */
  snapshotAt: string | null;
}

export const EMPTY_FOCUS_STATE: FocusState = Object.freeze({
  loading: false,
  refreshing: false,
  items: [],
  sections: [],
  error: null,
  snapshotAt: null,
});

export type FocusAction =
  | { type: 'LOAD_START' }
  | { type: 'REFRESH_START' }
  | { type: 'LOAD_OK'; items: FocusItem[]; snapshotAt: string | null }
  | { type: 'LOAD_FAIL'; error: FocusStateError }
  | { type: 'DISMISS_ERROR' };

export function focusStateReducer(
  state: FocusState,
  action: FocusAction,
): FocusState {
  switch (action.type) {
    case 'LOAD_START':
      // Initial mount / reload after error → clear the prior list so
      // the UI shows the full-screen ActivityIndicator.
      return {
        ...state,
        loading: true,
        refreshing: false,
        items: [],
        sections: [],
        error: null,
      };
    case 'REFRESH_START':
      // Pull-to-refresh / manual Refresh / on-tab-focus → keep the
      // existing rows on screen while the spinner plays so the user
      // doesn't see a flash of empty.
      return {
        ...state,
        refreshing: true,
        error: null,
      };
    case 'LOAD_OK':
      return {
        ...state,
        loading: false,
        refreshing: false,
        items: action.items,
        sections: bucketizeSections(action.items),
        snapshotAt: action.snapshotAt,
        error: null,
      };
    case 'LOAD_FAIL':
      return {
        ...state,
        loading: false,
        refreshing: false,
        error: action.error,
      };
    case 'DISMISS_ERROR':
      return { ...state, error: null };
    default:
      return state;
  }
}

/**
 * Group the flat server list into bucket sections in server-canonical
 * order. Empty buckets are NOT rendered — `BUCKET_ORDER.filter(...)`
 * matches the MVP's existing suppression at `focus.tsx:142` per brief
 * § 4.1.
 *
 * The server already sorts items inside the response (`bucket → priority
 * DESC → due_at ASC` by default; `focus_score DESC NULLS LAST` when
 * the `?order=focus_score` opt-in is used). The reducer preserves that
 * order verbatim — no client-side re-sort.
 */
export function bucketizeSections(items: FocusItem[]): BucketSection[] {
  if (items.length === 0) return [];
  const grouped: Record<FocusBucket, FocusItem[]> = {
    overdue: [],
    today: [],
    soon: [],
  };
  for (const item of items) {
    grouped[item.bucket].push(item);
  }
  const sections: BucketSection[] = [];
  for (const bucket of BUCKET_ORDER) {
    const rows = grouped[bucket];
    if (rows.length === 0) continue;
    sections.push({
      bucket,
      label: BUCKET_LABELS[bucket],
      items: rows,
    });
  }
  return sections;
}

/**
 * Wraps a thrown value into the typed `FocusStateError`. Recognises
 * `FocusClientError` (carries `.code`) and falls back to `unknown`
 * for plain `Error` / non-Error throws.
 */
export function toFocusStateError(err: unknown): FocusStateError {
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    'message' in err &&
    typeof (err as { message: unknown }).message === 'string'
  ) {
    return {
      code: (err as { code: string }).code,
      message: (err as { message: string }).message,
    };
  }
  if (err instanceof Error) {
    return { code: 'unknown', message: err.message };
  }
  return { code: 'unknown', message: String(err) };
}
