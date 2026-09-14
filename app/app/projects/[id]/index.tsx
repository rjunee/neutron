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
 *      no redirect and no fallback. A missing scope now falls through to
 *      General rather than to a spinner.
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

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { GENERAL_CHAT_ROUTE } from '../../../lib/entry-route';
import { projectTabRoute } from '../../../lib/project-tab-route';
import { THEME } from '../../../lib/composer-constants';

// Re-exported so the timeout keeps ONE home while the tests that assert the
// handoff's deadline keep importing it from the screen that spends it.
export { DEFAULT_TAB, LAST_TAB_READ_TIMEOUT_MS } from '../../../lib/project-tab-route';

export default function ProjectIndexRedirect() {
  const router = useRouter();
  const { id: paramId } = useLocalSearchParams<{ id: string }>();
  const read = typeof paramId === 'string' ? paramId : '';
  // This waypoint owns the scope it was entered for until its asynchronous
  // last-tab lookup hands off. A later render must not retarget that in-flight
  // operation.
  const latched = useRef<string | null>(null);
  if (latched.current === null && read.length > 0) latched.current = read;
  const id = latched.current ?? '';

  useEffect(() => {
    let cancelled = false;
    if (id.length === 0) {
      // No scope in the route. General always exists and needs no fetch,
      // so it is the honest floor — a spinner here would be a dead end.
      router.replace(GENERAL_CHAT_ROUTE as Parameters<typeof router.replace>[0]);
      return;
    }
    void (async () => {
      const route = await projectTabRoute(id);
      if (cancelled) return;
      router.replace(route as Parameters<typeof router.replace>[0]);
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
