/**
 * @neutronai/app — default-tab redirect (P5.2).
 *
 * `/projects/<id>` lands here, and EVERY rail tap on a project you are not
 * already in lands here first (`_layout.tsx` `onRailSelect`). It is a pure
 * waypoint: pick the tab this device last had open for this project
 * (`neutron.project.<id>.lastTab`) and hand off. Missing or illegal key ⇒ `chat`
 * (the default per § B.P5 of the engineering plan). Per-device, not synced —
 * P5.2 brief § 4.6.
 *
 * TWO WAYS THIS SCREEN USED TO BE ABLE TO STOP FOREVER, both of which present as
 * the same thing the owner reported for three builds running: a spinner in the
 * content area, chrome fine, rail tappable, and NOTHING on the wire for the
 * project they tapped — because the chat route this hands off to is what opens
 * the socket, and it is never reached.
 *
 *   1. NO SCOPE. `useLocalSearchParams()` yielding no `id` returned early with
 *      no redirect and no fallback. The route params are also the source the
 *      SHELL was already fixed not to trust across a project switch (see
 *      `_layout.tsx`, which reads `projectIdFromPathname(usePathname())`
 *      because the param went stale on device) — so this screen and the shell
 *      wrapping it could disagree about which project they were showing. They
 *      now read the SAME source, in the same order, and a scope that resolves
 *      from neither falls through to General rather than to a spinner.
 *
 *   2. A STORAGE READ THAT NEVER ANSWERS. The `try/catch` covers a REJECTION;
 *      it cannot cover a promise that simply never settles, and the native
 *      AsyncStorage read is a bridge call with no timeout. The read is now
 *      RACED against a deadline whose loser is the default tab. The last-tab
 *      preference is a nicety; arriving at the project is not, and the nicety
 *      must never be able to hold the whole handoff.
 *
 * The invariant, stated once: THIS SCREEN ALWAYS NAVIGATES. Nothing it awaits
 * may decide otherwise.
 */

import { useLocalSearchParams, usePathname, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { lastTabStorage, type LastTabValue } from '../../../lib/last-tab-storage';
import { GENERAL_CHAT_ROUTE } from '../../../lib/entry-route';
import { projectIdFromPathname } from '../../../lib/project-rail-view';
import { THEME } from '../../../lib/composer-constants';

const DEFAULT_TAB: LastTabValue = 'chat';

/**
 * How long the last-tab preference may take before the handoff goes ahead
 * without it. Short on purpose: this is the difference between landing on the
 * tab you left and landing on Chat, and no owner would trade a second of
 * staring at a spinner for it.
 */
export const LAST_TAB_READ_TIMEOUT_MS = 1_200;

/** The stored tab, or `null` if it is missing, illegal, slow, or broken. */
async function preferredTab(projectId: string): Promise<LastTabValue | null> {
  const read = (async (): Promise<LastTabValue | null> => {
    try {
      return await lastTabStorage().get(projectId);
    } catch {
      return null;
    }
  })();
  let handle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<null>((resolve) => {
        handle = setTimeout(() => {
          resolve(null);
        }, LAST_TAB_READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

export default function ProjectIndexRedirect() {
  const router = useRouter();
  const pathname = usePathname();
  const { id: paramId } = useLocalSearchParams<{ id: string }>();
  // The PATH first, the param second — the same precedence the shell uses, so
  // the two can never disagree about the scope they are rendering.
  const id =
    projectIdFromPathname(pathname) ?? (typeof paramId === 'string' ? paramId : '');

  useEffect(() => {
    let cancelled = false;
    if (id.length === 0) {
      // No scope from either source. General always exists and needs no fetch,
      // so it is the honest floor — a spinner here would be a dead end.
      router.replace(GENERAL_CHAT_ROUTE as Parameters<typeof router.replace>[0]);
      return;
    }
    void (async () => {
      const stored = await preferredTab(id);
      if (cancelled) return;
      router.replace(`/projects/${encodeURIComponent(id)}/${stored ?? DEFAULT_TAB}`);
    })();
    return () => {
      cancelled = true;
    };
  }, [router, id]);

  return (
    <View style={styles.container} testID="project-index-redirect">
      <ActivityIndicator color={THEME.text_secondary} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: THEME.background,
  },
});
