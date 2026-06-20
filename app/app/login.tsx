import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { signInWithDevToken } from '../lib/auth';
import { loadAppConfig } from '../lib/config';
import { enablePushForUser } from '../lib/push';
import { useAuthSession } from '../lib/session';
import { THEME } from '../lib/theme';

import type { AuthUser } from '../lib/auth';

async function tryEnablePush(user: AuthUser): Promise<void> {
  // P5.6 — best-effort push registration. The connect flow must NOT
  // be blocked by a permission-denied / unsupported-platform /
  // gateway-unreachable error. `enablePushForUser` never throws;
  // it surfaces every failure mode as a structured result that
  // we log to the console for dev-loop debugging.
  try {
    const cfg = loadAppConfig();
    const result = await enablePushForUser({ base_url: cfg.base_url, token: user.token });
    if (!result.ok) {
      console.warn(`[push] skipped: ${result.reason}`, result.detail ?? '');
    }
  } catch (err) {
    // Defensive — enablePushForUser already swallows; this is a
    // belt-and-suspenders guard against unexpected throws so the
    // connect path stays health-checked-clean.
    console.warn('[push] unexpected error during enable', err);
  }
}

export default function LoginScreen() {
  const router = useRouter();
  const { setUser } = useAuthSession();
  const [busy, setBusy] = useState<'token' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState('');

  async function handleConnect() {
    setError(null);
    if (token.trim().length === 0) {
      setError('Paste the access token your gateway printed on first run.');
      return;
    }
    setBusy('token');
    try {
      // Connects to the configured local gateway (NEUTRON_APP_WS_BYPASS=1
      // or NEUTRON_APP_WS_DEV_SECRET=...) using the access token the
      // harness prints on `neutron up`.
      const user = await signInWithDevToken({ token });
      setUser(user);
      await tryEnablePush(user);
      router.replace('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.brand}>
        <Text style={styles.title}>Neutron</Text>
        <Text style={styles.subtitle}>Your self-hosted agent harness</Text>
      </View>

      <View style={styles.actions}>
        <View style={styles.connectSection}>
          <Text style={styles.heading}>Connect to your Neutron</Text>
          <Text style={styles.sub}>
            Start the harness on your machine with `neutron up`, then paste the
            access token it printed. The app connects straight to your own
            gateway — nothing routes through a hosted service.
          </Text>
          <TextInput
            accessibilityLabel="Access token"
            placeholder="Paste your access token"
            placeholderTextColor={THEME.text_muted}
            autoCapitalize="none"
            autoCorrect={false}
            value={token}
            editable={busy === null}
            onChangeText={setToken}
            style={styles.input}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Connect to your Neutron"
            disabled={busy !== null}
            onPress={handleConnect}
            style={({ pressed }) => [
              styles.button,
              styles.buttonPrimary,
              pressed && styles.buttonPressed,
            ]}
          >
            {busy === 'token' ? (
              <ActivityIndicator color={THEME.background} />
            ) : (
              <Text style={styles.buttonPrimaryText}>Connect</Text>
            )}
          </Pressable>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>

      <Text style={styles.footnote}>
        The token lives only on your machine and this device. Local-first by
        default.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: THEME.background,
    paddingHorizontal: 32,
    paddingTop: 64,
    paddingBottom: 32,
    justifyContent: 'space-between',
  },
  brand: { alignItems: 'flex-start' },
  title: {
    color: THEME.text_primary,
    fontSize: 44,
    fontWeight: '700',
    letterSpacing: -1,
  },
  subtitle: {
    color: THEME.text_muted,
    fontSize: 17,
    marginTop: 8,
  },
  actions: { gap: 12 },
  button: {
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  buttonPrimary: { backgroundColor: THEME.text_primary },
  buttonPrimaryText: { color: THEME.background, fontSize: 16, fontWeight: '600' },
  buttonPressed: { opacity: 0.7 },
  connectSection: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: THEME.hairline,
    gap: 10,
  },
  heading: { color: THEME.text_primary, fontSize: 16, fontWeight: '600' },
  sub: { color: THEME.text_muted, fontSize: 13, lineHeight: 18 },
  input: {
    color: THEME.text_primary,
    fontSize: 14,
    borderWidth: 1,
    borderColor: THEME.hairline,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: THEME.background,
    fontFamily: 'Menlo',
    marginTop: 2,
  },
  error: { color: THEME.danger, fontSize: 14, marginTop: 8 },
  footnote: { color: THEME.text_muted, fontSize: 12, textAlign: 'center' },
});
