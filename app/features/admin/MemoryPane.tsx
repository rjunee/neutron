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

export function MemoryPane({ client }: { client: AdminClient }) {
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
        <ActivityIndicator color="#cfcfcf" />
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

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
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
  bannerInfo: {
    backgroundColor: '#0f1c2e',
    color: '#bfdbfe',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1e40af',
    fontSize: 12,
  },
  label: {
    color: '#6a6a6a',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginTop: 4,
  },
  statsCard: {
    backgroundColor: '#121212',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#1f1f1f',
    padding: 12,
    gap: 6,
  },
  statsRow: { flexDirection: 'row', justifyContent: 'space-between' },
  statsLabel: { color: '#7a7a7a', fontSize: 12 },
  statsValue: { color: '#fafafa', fontSize: 13, fontWeight: '600' },
  entryCard: {
    backgroundColor: '#121212',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#1f1f1f',
    padding: 12,
    gap: 4,
  },
  entryPreview: { color: '#e0e0e0', fontSize: 13, lineHeight: 18 },
  entryMeta: { color: '#6a6a6a', fontSize: 11 },
  muted: { color: '#7a7a7a', fontSize: 13 },
});
