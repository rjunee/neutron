/**
 * @neutronai/app — admin tab, Memory pane.
 *
 * Read-only browse of this instance's memory store. Editing entries lands
 * in a follow-up sprint.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { AdminClient, type MemorySummary } from '../../lib/admin-client';
import { formatError, formatBytes } from './format';
import type { NeutronTheme } from '../../lib/theme';
import { useTheme, useThemedStyles } from '../../lib/theme-context';

export function MemoryPane({ client }: { client: AdminClient }) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [data, setData] = useState<MemorySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchOne = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await client.getMemory();
      setData(next);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void fetchOne();
  }, [fetchOne]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.text_secondary} />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.paneScroll}>
      <View style={styles.intro}>
        <Text style={styles.paneTitle}>Memory</Text>
        <Text style={styles.paneSubtitle}>
          Read-only browse of this instance's memory store. Editing entries lands
          in a follow-up sprint.
        </Text>
      </View>

      {error !== null ? <Text style={styles.bannerError}>{error}</Text> : null}

      {data !== null && data.configured === false ? (
        <Text style={styles.bannerInfo}>
          Memory is not configured for this instance. The MCP transport is
          unwired; entries will appear here once it's mounted.
        </Text>
      ) : null}

      {data !== null && data.stats !== null ? (
        <View style={styles.statsCard}>
          <View style={styles.statsRow}>
            <Text style={styles.statsLabel}>Entries</Text>
            <Text style={styles.statsValue}>{data.stats.count}</Text>
          </View>
          <View style={styles.statsRow}>
            <Text style={styles.statsLabel}>Size</Text>
            <Text style={styles.statsValue}>{formatBytes(data.stats.size_bytes)}</Text>
          </View>
        </View>
      ) : null}

      <Text style={styles.label}>Recent entries</Text>
      {data !== null && data.entries.length === 0 ? (
        <Text style={styles.muted}>No entries.</Text>
      ) : (
        (data?.entries ?? []).map((e) => (
          <View key={e.id} style={styles.entryCard} testID={`admin-memory-entry-${e.id}`}>
            <Text style={styles.entryPreview}>{e.content_preview}</Text>
            <Text style={styles.entryMeta}>
              score {e.score.toFixed(2)} · {e.id}
            </Text>
          </View>
        ))
      )}
    </ScrollView>
  );
}

const makeStyles = (theme: NeutronTheme) =>
  StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  paneScroll: { padding: 16, gap: 12 },
  intro: { gap: 6, marginBottom: 8 },
  paneTitle: { color: theme.text_primary, fontSize: 22, fontWeight: '700' },
  paneSubtitle: { color: theme.text_muted, fontSize: 13, lineHeight: 18 },
  bannerError: {
    backgroundColor: theme.danger_surface,
    color: theme.danger,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.danger_border,
    fontSize: 12,
  },
  bannerInfo: {
    backgroundColor: theme.info_surface,
    color: theme.info,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.info_border,
    fontSize: 12,
  },
  label: {
    color: theme.text_muted,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginTop: 4,
  },
  statsCard: {
    backgroundColor: theme.background,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.hairline,
    padding: 12,
    gap: 6,
  },
  statsRow: { flexDirection: 'row', justifyContent: 'space-between' },
  statsLabel: { color: theme.text_muted, fontSize: 12 },
  statsValue: { color: theme.text_primary, fontSize: 13, fontWeight: '600' },
  entryCard: {
    backgroundColor: theme.background,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.hairline,
    padding: 12,
    gap: 4,
  },
  entryPreview: { color: theme.accent, fontSize: 13, lineHeight: 18 },
  entryMeta: { color: theme.text_muted, fontSize: 11 },
  muted: { color: theme.text_muted, fontSize: 13 },
});
