/**
 * @neutronai/app — default-tab redirect (P5.2).
 *
 * `/projects/<id>` lands here. The redirect target is computed from
 * `neutron.project.<id>.lastTab` in AsyncStorage / localStorage — the
 * last tab the user opened for THIS project on THIS device. When the
 * key is missing or no longer maps to a legal tab, falls through to
 * `chat` (the default per § B.P5 of the engineering plan).
 *
 * Per-device, not synced cross-device — see P5.2 brief § 4.6.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { lastTabStorage, type LastTabValue } from '../../../lib/last-tab-storage';
import { THEME } from '../../../lib/composer-constants';

const DEFAULT_TAB: LastTabValue = 'chat';

export default function ProjectIndexRedirect() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  useEffect(() => {
    if (typeof id !== 'string' || id.length === 0) return;
    let cancelled = false;
    void (async () => {
      let target: LastTabValue = DEFAULT_TAB;
      try {
        const stored = await lastTabStorage().get(id);
        if (stored !== null) target = stored;
      } catch {
        // Storage read errors fall through to the default.
      }
      if (cancelled) return;
      router.replace(`/projects/${id}/${target}`);
    })();
    return () => {
      cancelled = true;
    };
  }, [router, id]);

  return (
    <View style={styles.container}>
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
