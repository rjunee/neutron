/**
 * @neutronai/app — the typed-URL server form (ISSUES #385), now the
 * SELF-HOST path of the login-first flow.
 *
 * ONE form, two mount points:
 *
 *   - `app/app/login.tsx` — the self-host / advanced section. A
 *     self-hoster runs no central identity service, so there is nothing
 *     to discover an address from and manual entry can never be removed.
 *     It is also the escape hatch when a persisted host has gone stale
 *     and there is no session to reach `/settings` with.
 *   - `app/app/settings.tsx` — change the server later, while signed in.
 *
 * Both go through the single normalise → validate (`/healthz`) → persist
 * path in `lib/server-url.ts:commitServerConfig` — and so does LOGIN-FIRST
 * discovery (`lib/identity-client.ts:adoptDiscoveredInstance`), so a
 * discovered address is health-checked by exactly the same rules as a
 * typed one. One implementation, no dual code paths.
 *
 * The full-screen `ServerSetupGate` that #385 mounted as the FIRST-RUN
 * surface is deleted: the app now opens on login and learns its own
 * address (SPEC § Decisions Log 2026-07-25). Keeping a second, unreachable
 * "Connect to your Neutron" screen around would be exactly the dual
 * old/new surface the repo bans.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { loadAppConfig, setRuntimeServerConfig } from '../lib/config';
import {
  commitServerConfig,
  describeInsecureOrigin,
  normalizeServerUrl,
} from '../lib/server-url';
import { THEME } from '../lib/theme';
import { tokenStorage } from '../lib/token-storage';

export interface ServerSavedResult {
  gateway_base_url: string;
  session_cleared: boolean;
  /** `true` when the committed host differs from the previous one. */
  host_changed: boolean;
}

export interface ServerConnectFormProps {
  /**
   * Prefill for the URL field. The self-host section of `/login` passes
   * `LOCAL_DEV_SUGGESTION` as a VISIBLE, EDITABLE suggestion — it is
   * never applied unless the owner submits it, so it is a hint, not a
   * resolver default (that distinction is what ISSUES #385 was about).
   */
  initialUrl?: string;
  /** Prefill for the optional identity-service field. */
  initialAuthUrl?: string;
  submitLabel?: string;
  /** Fired after a successful validate + persist. */
  onSaved(result: ServerSavedResult): void;
  /** Rendered as a secondary "Cancel" action when provided. */
  onCancel?: () => void;
}

export function ServerConnectForm({
  initialUrl,
  initialAuthUrl,
  submitLabel,
  onSaved,
  onCancel,
}: ServerConnectFormProps) {
  const [url, setUrl] = useState(initialUrl ?? '');
  const [authUrl, setAuthUrl] = useState(initialAuthUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live cleartext warning: Android permits cleartext to ANY host, so a
  // bearer token to `http://public-host` would leave in the clear with no
  // signal. Non-blocking — see `describeInsecureOrigin` (Argus r2 MINOR).
  const insecureWarning = useMemo(() => {
    const normalized = normalizeServerUrl(url);
    return normalized === null ? null : describeInsecureOrigin(normalized);
  }, [url]);

  const handleSubmit = useCallback(async (): Promise<void> => {
    setError(null);
    if (url.trim().length === 0) {
      setError('Enter the address of your Neutron instance.');
      return;
    }
    setBusy(true);
    try {
      const result = await commitServerConfig({
        gateway_raw: url,
        auth_raw: authUrl,
        previous_gateway_base_url: loadAppConfig().gateway_base_url,
        store: tokenStorage(),
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setRuntimeServerConfig(result.config);
      onSaved({
        gateway_base_url: result.config.gateway_base_url ?? '',
        session_cleared: result.session_cleared,
        host_changed: result.host_changed,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [authUrl, onSaved, url]);

  return (
    <View style={styles.form} testID="server-connect-form">
      <TextInput
        accessibilityLabel="Neutron server address"
        testID="server-connect-url"
        placeholder="https://neutron.example.com"
        placeholderTextColor={THEME.text_muted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        value={url}
        editable={!busy}
        onChangeText={setUrl}
        style={styles.input}
      />
      {/* Copy names the REAL CLI verb — `bin/neutron:136` usage line is
          `neutron {start|stop|restart|status|logs|backup|doctor|url}`. */}
      <Text style={styles.hint}>
        Your own instance: a machine where you ran neutron start, or your own
        subdomain. We check /healthz on it before saving.
      </Text>

      <TextInput
        accessibilityLabel="Identity service address (optional)"
        testID="server-connect-auth-url"
        placeholder="Identity service (optional)"
        placeholderTextColor={THEME.text_muted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        value={authUrl}
        editable={!busy}
        onChangeText={setAuthUrl}
        style={styles.input}
      />

      {insecureWarning !== null ? (
        <Text style={styles.warning} testID="server-connect-insecure-warning">
          {insecureWarning}
        </Text>
      ) : null}

      {error !== null ? (
        <Text style={styles.error} testID="server-connect-error">
          {error}
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={submitLabel ?? 'Connect'}
        testID="server-connect-submit"
        disabled={busy}
        onPress={() => {
          void handleSubmit();
        }}
        style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      >
        {busy ? (
          <ActivityIndicator color={THEME.background} />
        ) : (
          <Text style={styles.buttonText}>{submitLabel ?? 'Connect'}</Text>
        )}
      </Pressable>

      {onCancel !== undefined ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          testID="server-connect-cancel"
          disabled={busy}
          onPress={onCancel}
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
        >
          <Text style={styles.secondaryButtonText}>Cancel</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 10 },
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
  },
  hint: { color: THEME.text_muted, fontSize: 12, lineHeight: 16 },
  warning: { color: THEME.warning, fontSize: 12, lineHeight: 17 },
  error: { color: THEME.danger, fontSize: 13, lineHeight: 18 },
  button: {
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: THEME.text_primary,
  },
  buttonText: { color: THEME.background, fontSize: 16, fontWeight: '600' },
  secondaryButton: {
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  secondaryButtonText: { color: THEME.text_secondary, fontSize: 15, fontWeight: '600' },
  pressed: { opacity: 0.7 },
  footnote: { color: THEME.text_muted, fontSize: 12, textAlign: 'center' },
});
