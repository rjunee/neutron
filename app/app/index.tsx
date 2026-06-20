/**
 * @neutronai/app — root entry (P5.2).
 *
 * P5.1 mounted the chat surface directly at `/`. P5.2 introduces the
 * project view shell — chat is now scoped to a project at
 * `/projects/<id>/chat`. The top-level entry redirects:
 *
 *   - no session → /login
 *   - session   → /projects
 *
 * The redirect runs after mount so the AuthSessionProvider has a chance
 * to hydrate; otherwise a still-mounting session would bounce to login
 * even when a user is signed in (web reload edge case).
 */

import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { useAuthSession } from '../lib/session';

export default function RootRedirect() {
  const router = useRouter();
  const { user } = useAuthSession();

  useEffect(() => {
    if (user === null) {
      router.replace('/login');
    } else {
      router.replace('/projects');
    }
  }, [router, user]);

  return (
    <View style={styles.container}>
      <ActivityIndicator color="#cfcfcf" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
