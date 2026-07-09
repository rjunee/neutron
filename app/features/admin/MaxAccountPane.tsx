/**
 * @neutronai/app — admin tab, Max account pane.
 *
 * Lets an already-onboarded owner swap their attached Claude Max
 * credential to a different Anthropic account without operator SQL.
 *
 * Flow:
 *   1. User taps "Switch account".
 *   2. We POST `/api/app/admin/max-oauth/mint-reauth-token` and the
 *      gateway mints a fresh start_token JWT bound to this instance +
 *      authenticated user, returning a full paste URL pointing at
 *      `<identity>/oauth/max/start` (with instance + return + start_token + force params).
 *   3. We hand the URL to `Linking.openURL` which opens the user's
 *      browser. The identity-side paste-token form is already in
 *      production (see `identity/oauth/max-handoff.ts:handleStart`)
 *      and accepts any valid start_token regardless of how it was
 *      minted. The user runs `claude setup-token`, pastes the new
 *      value, and the existing `persistPasteToken` flow replaces the
 *      stored Max credential atomically (`auth/max-oauth.ts ~line 340`).
 *
 * Deployments without the identity-DB wiring (Open self-host without
 * NEUTRON_AUTH_DB_PATH) get a 503 `reauth_not_configured` envelope;
 * we render the "not supported here" branch instead of the button so
 * the user isn't stuck pressing a broken control.
 *
 * Disconnect / cancel subscription is out of scope for this sprint —
 * the button is a "Coming soon" disabled affordance so the visual
 * shape is correct when the follow-up lands.
 */

import { Linking } from 'react-native';
import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { AdminClient, AdminClientError } from '../../lib/admin-client';
import { formatError } from './format';

interface MaxAccountState {
  switching: boolean;
  error: string | null;
  notSupported: { message: string } | null;
}

function freshMaxAccountState(): MaxAccountState {
  return { switching: false, error: null, notSupported: null };
}

export function MaxAccountPane({ client }: { client: AdminClient }): React.ReactElement {
  const [state, setState] = useState<MaxAccountState>(() => freshMaxAccountState());

  const handleSwitch = useCallback(async () => {
    setState({ switching: true, error: null, notSupported: null });
    try {
      const result = await client.mintMaxReauthToken();
      // Open the paste URL externally. On web `Linking.openURL` opens
      // a new tab; on native it hands off to the system browser.
      await Linking.openURL(result.paste_url);
      setState(freshMaxAccountState());
    } catch (err) {
      if (
        err instanceof AdminClientError &&
        err.code === 'reauth_not_configured'
      ) {
        setState({
          switching: false,
          error: null,
          notSupported: { message: err.message },
        });
        return;
      }
      setState({
        switching: false,
        error: formatError(err),
        notSupported: null,
      });
    }
  }, [client]);

  return (
    <ScrollView contentContainerStyle={styles.paneScroll}>
      <View style={styles.intro}>
        <Text style={styles.paneTitle}>Claude Max account</Text>
        <Text style={styles.paneSubtitle}>
          This instance uses your personal Claude Max subscription to power
          chat. Switching accounts swaps the stored credential atomically —
          in-flight sessions keep their current token until the next chat
          turn picks up the new one.
        </Text>
      </View>

      {state.error !== null ? (
        <Text style={styles.bannerError} testID="admin-max-error">
          {state.error}
        </Text>
      ) : null}

      {state.notSupported !== null ? (
        <View style={styles.managedCard} testID="admin-max-not-supported">
          <View style={styles.managedBadgeRow}>
            <Text style={styles.managedBadge}>Not supported here</Text>
          </View>
          <Text style={styles.managedBody}>
            This deployment can't mint a fresh paste link from the app —
            the identity service isn't co-located with the gateway. Ask
            your operator to re-run the Max paste flow from the Anthropic
            sign-in page.
          </Text>
          <Text style={styles.managedHint}>{state.notSupported.message}</Text>
        </View>
      ) : (
        <View style={styles.coreActionsRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Switch Claude Max account"
            testID="admin-max-switch"
            disabled={state.switching}
            onPress={() => void handleSwitch()}
            style={({ pressed }) => [
              styles.primaryBtn,
              state.switching && styles.primaryBtnDisabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.primaryBtnText}>
              {state.switching ? 'Opening paste form…' : 'Switch account'}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Disconnect Claude Max account (coming soon)"
            testID="admin-max-disconnect"
            disabled
            style={({ pressed }) => [
              styles.secondaryBtn,
              styles.primaryBtnDisabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.secondaryBtnText}>Disconnect (coming soon)</Text>
          </Pressable>
        </View>
      )}

      <View style={styles.intro}>
        <Text style={styles.paneSubtitle}>
          Tapping <Text style={styles.code}>Switch account</Text> opens the
          Anthropic Max paste form in your browser. Run{' '}
          <Text style={styles.code}>claude setup-token</Text> in your
          terminal, copy the value, paste it, and submit. You'll be
          returned to chat once the new credential is stored.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  paneScroll: { padding: 16, gap: 12 },
  intro: { gap: 6, marginBottom: 8 },
  paneTitle: { color: '#fafafa', fontSize: 22, fontWeight: '700' },
  paneSubtitle: { color: '#9a9a9a', fontSize: 13, lineHeight: 18 },
  code: { color: '#cfcfcf', fontFamily: 'Menlo', fontSize: 12 },
  bannerError: {
    backgroundColor: '#3b1212',
    color: '#fecaca',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#7f1d1d',
    fontSize: 12,
  },
  managedCard: {
    backgroundColor: '#0f1c2e',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#1e40af',
    padding: 14,
    gap: 10,
  },
  managedBadgeRow: { flexDirection: 'row' },
  managedBadge: {
    color: '#bfdbfe',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    backgroundColor: '#1e40af',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: 'hidden',
  },
  managedBody: { color: '#dbeafe', fontSize: 13, lineHeight: 18 },
  managedHint: { color: '#8aa8d6', fontSize: 11, fontStyle: 'italic' },
  coreActionsRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  primaryBtn: {
    marginTop: 12,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#ffffff',
    alignSelf: 'flex-start',
  },
  primaryBtnDisabled: { opacity: 0.5 },
  primaryBtnText: { color: '#0a0a0a', fontSize: 14, fontWeight: '600' },
  secondaryBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  secondaryBtnText: { color: '#e0e0e0', fontSize: 13, fontWeight: '500' },
  pressed: { opacity: 0.7 },
});
