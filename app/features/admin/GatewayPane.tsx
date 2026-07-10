/**
 * @neutronai/app — admin tab, Gateway pane.
 *
 * Restart this instance's gateway process. This signals SIGTERM so
 * systemd brings the unit back. Confirms before triggering to avoid mis-taps.
 */

import React, { useCallback, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { AdminClient } from '../../lib/admin-client';
import { formatError } from './format';

export function GatewayPane({ client }: { client: AdminClient }) {
  const [confirming, setConfirming] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const handleConfirm = useCallback(async () => {
    setRestarting(true);
    setError(null);
    setResult(null);
    try {
      const r = await client.restartGateway();
      setResult(
        r.triggered
          ? `Restart signalled at ${new Date(r.triggered_at).toLocaleTimeString()} (tier=${r.tier}).`
          : `Restart not triggered (tier=${r.tier}).`,
      );
    } catch (err) {
      setError(formatError(err));
    } finally {
      setRestarting(false);
      setConfirming(false);
    }
  }, [client]);

  return (
    <ScrollView contentContainerStyle={styles.paneScroll}>
      <View style={styles.intro}>
        <Text style={styles.paneTitle}>Gateway</Text>
        <Text style={styles.paneSubtitle}>
          Restart this instance's gateway process. This signals SIGTERM so
          systemd brings the unit back.
        </Text>
      </View>

      {error !== null ? <Text style={styles.bannerError}>{error}</Text> : null}
      {result !== null ? <Text style={styles.bannerOk}>{result}</Text> : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Restart gateway"
        testID="admin-gateway-restart"
        disabled={restarting}
        onPress={() => setConfirming(true)}
        style={({ pressed }) => [
          styles.dangerBtn,
          restarting && styles.primaryBtnDisabled,
          pressed && styles.pressed,
        ]}
      >
        <Text style={styles.dangerBtnText}>
          {restarting ? 'Signalling restart…' : 'Restart gateway'}
        </Text>
      </Pressable>

      <Modal transparent visible={confirming} animationType="fade" onRequestClose={() => setConfirming(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalPanel}>
            <Text style={styles.modalTitle}>Restart gateway?</Text>
            <Text style={styles.modalBody}>
              This drops any open chat sessions for ~3–10 seconds while the
              process restarts.
            </Text>
            <View style={styles.modalActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel restart"
                testID="admin-gateway-cancel"
                onPress={() => setConfirming(false)}
                style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
              >
                <Text style={styles.secondaryBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Confirm restart"
                testID="admin-gateway-confirm"
                onPress={() => void handleConfirm()}
                style={({ pressed }) => [styles.dangerBtn, pressed && styles.pressed]}
              >
                <Text style={styles.dangerBtnText}>Yes, restart</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  paneScroll: { padding: 16, gap: 12 },
  intro: { gap: 6, marginBottom: 8 },
  paneTitle: { color: '#fafafa', fontSize: 22, fontWeight: '700' },
  paneSubtitle: { color: '#9a9a9a', fontSize: 13, lineHeight: 18 },
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
  bannerOk: {
    backgroundColor: '#0f2418',
    color: '#bbf7d0',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#14532d',
    fontSize: 12,
  },
  dangerBtn: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#7f1d1d',
    alignSelf: 'flex-start',
  },
  dangerBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  primaryBtnDisabled: { opacity: 0.5 },
  pressed: { opacity: 0.7 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  modalPanel: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#121212',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1f1f1f',
    padding: 18,
    gap: 12,
  },
  modalTitle: { color: '#fafafa', fontSize: 16, fontWeight: '700' },
  modalBody: { color: '#bdbdbd', fontSize: 13, lineHeight: 18 },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  secondaryBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  secondaryBtnText: { color: '#e0e0e0', fontSize: 13, fontWeight: '500' },
});
