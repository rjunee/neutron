/**
 * @neutronai/app — pure router for launcher long-press menu dispatch
 * (ISSUE #17).
 *
 * The launcher route (`app/app/projects/[id]/launcher.tsx`) hands one
 * tapped menu row to `resolveLongPressDispatch(...)`. The helper
 * returns the Expo Router target the route should `router.push`,
 * resolving `<project_id>` substitution + URL-encoding the prefill /
 * autosend payload.
 *
 * Kept as a pure function (no React, no expo-router import) so it's
 * unit-testable without a renderer + so the launcher route file stays
 * concise.
 */

import type {
  LauncherEntry,
  LauncherEntryLongPressEntry,
} from './launcher-client';

export interface LongPressDispatch {
  /**
   * Expo Router path to push. Includes the project-id substitution
   * and (when applicable) URL search params for the chat composer
   * prefill / one-shot autosend.
   */
  path: string;
}

/**
 * Resolve the navigation target for one tapped long-press menu row.
 *
 * Dispatch semantics by `action`:
 *
 *   - 'open_app_tab' → resolve `parent.app_tab_path` (substituting
 *     `<project_id>` → `projectId`). Falls back to a slug-derived
 *     route (`<projectId>/<slug-minus-_core>`) when the parent has no
 *     `app_tab_path`.
 *   - 'chat_send_prefix' → `/projects/<projectId>/chat?prefill=<URI(prefix)>`.
 *     The chat route reads `prefill` on mount and seeds the composer
 *     draft. An empty `prefix` still navigates (lands on chat with
 *     no prefill).
 *   - 'chat_send' → `/projects/<projectId>/chat?autosend=<URI(text)>`.
 *     The chat route reads `autosend` on mount, waits for WS connect,
 *     and fires a one-shot `send({ body })`. The ref-guard makes this
 *     idempotent across re-renders.
 *
 * Returns `null` for an unrecognised action (forward-compat — a
 * server that adds a new verb won't crash old clients).
 */
export function resolveLongPressDispatch(
  parent: LauncherEntry,
  item: LauncherEntryLongPressEntry,
  projectId: string,
): LongPressDispatch | null {
  if (item.action === 'open_app_tab') {
    const declared = parent.app_tab_path;
    if (typeof declared === 'string' && declared.length > 0) {
      return { path: declared.replace('<project_id>', projectId) };
    }
    // Fallback to the slug-derived inference the legacy tap path uses.
    const route = parent.slug.replace(/_core$/, '');
    return { path: `/projects/${projectId}/${route}` };
  }
  if (item.action === 'chat_send_prefix') {
    const prefix = item.prefix ?? '';
    return {
      path: `/projects/${projectId}/chat?prefill=${encodeURIComponent(prefix)}`,
    };
  }
  if (item.action === 'chat_send') {
    const text = item.text ?? '';
    return {
      path: `/projects/${projectId}/chat?autosend=${encodeURIComponent(text)}`,
    };
  }
  return null;
}
