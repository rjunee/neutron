/**
 * @neutronai/app — admin tab, Diagnostics pane (O5).
 *
 * Read-only view of `GET /api/app/admin/diagnostics`: composes existing
 * per-instance state so the owner can answer "why is memory / chat / import
 * broken?" without journalctl. Sections that read in-process-only state
 * (credentials) may report `available: false` on some deployments; each
 * renders its own note.
 */

import React, { useCallback, useEffect, useReducer } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { AdminClient } from '../../lib/admin-client';
import {
  arr,
  diagnosticsReducer,
  initialDiagnosticsState,
  str,
} from '../../lib/diagnostics-pane-helpers';
import { formatError } from './format';

function fmtTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

function Section({
  title,
  available,
  note,
  children,
}: {
  title: string;
  available: boolean;
  note?: string;
  children?: React.ReactNode;
}) {
  return (
    <View style={styles.card} testID={`admin-diagnostics-${title.toLowerCase().replace(/\W+/g, '-')}`}>
      <View style={styles.cardHead}>
        <Text style={styles.cardTitle}>{title}</Text>
        <View style={[styles.dot, available ? styles.dotOk : styles.dotOff]} />
      </View>
      {available ? null : (
        <Text style={styles.muted}>{str(note, 'not available on this deployment')}</Text>
      )}
      {children}
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{str(value)}</Text>
    </View>
  );
}

export function DiagnosticsPane({ client }: { client: AdminClient }) {
  const [{ data, loading, error }, dispatch] = useReducer(
    diagnosticsReducer,
    initialDiagnosticsState,
  );

  const fetchOne = useCallback(async () => {
    dispatch({ type: 'fetch-start' });
    try {
      dispatch({ type: 'fetch-success', report: await client.getDiagnostics() });
    } catch (err) {
      dispatch({ type: 'fetch-error', error: formatError(err) });
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
        <Text style={styles.paneTitle}>Diagnostics</Text>
        <Text style={styles.paneSubtitle}>
          Read-only snapshot of this instance's health — memory, chat sessions,
          imports, cron, and recent events. Answers "why is X broken?" without
          the server logs.
        </Text>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Refresh diagnostics"
        testID="admin-diagnostics-refresh"
        onPress={() => void fetchOne()}
        style={({ pressed }) => [styles.refreshBtn, pressed && styles.pressed]}
      >
        <Text style={styles.refreshLabel}>Refresh</Text>
      </Pressable>

      {error !== null ? <Text style={styles.bannerError}>{error}</Text> : null}

      {data !== null ? (
        <>
          <Text style={styles.generated}>
            {data.project_slug} · {fmtTime(data.generated_at)}
          </Text>

          <Section title="Memory (gbrain)" available={data.gbrain.available} note={data.gbrain.note}>
            {data.gbrain.available && data.gbrain.status !== undefined ? (
              <>
                <Row label="Status" value={data.gbrain.status} />
                {data.gbrain.status === 'unavailable' ? (
                  <>
                    <Row label="Latched" value={fmtTime(Date.parse(data.gbrain.latched_at ?? '') || null)} />
                    <Row label="Reason" value={data.gbrain.latch_reason ?? '?'} />
                  </>
                ) : null}
                <Row
                  label="Last success"
                  value={data.gbrain.last_success_at ?? '—'}
                />
                <Row label="Deferred writes" value={String(data.gbrain.deferred_count ?? 0)} />
              </>
            ) : data.gbrain.available ? (
              <Text style={styles.muted}>{str(data.gbrain.note, 'no sync state recorded yet')}</Text>
            ) : null}
          </Section>

          <Section
            title="Credentials"
            available={data.credentials.available}
            note={data.credentials.note}
          >
            {data.credentials.available ? (
              <>
                <Row label="Usable now" value={data.credentials.has_usable ? 'yes' : 'no'} />
                {data.credentials.has_usable ? null : (
                  <Row
                    label="Soonest cooldown"
                    value={fmtTime(data.credentials.soonest_cooldown_until ?? null)}
                  />
                )}
              </>
            ) : null}
          </Section>

          <Section
            title="Chat (REPL sessions)"
            available={data.repl_sessions.available}
            note={data.repl_sessions.note}
          >
            {data.repl_sessions.available ? (
              arr(data.repl_sessions.sessions).length === 0 ? (
                <Text style={styles.muted}>No active REPL sessions.</Text>
              ) : (
                arr(data.repl_sessions.sessions).map((s) => (
                  <View key={s.key} style={styles.subCard}>
                    <Text style={styles.subTitle}>{str(s.key)}</Text>
                    <Row label="Model" value={s.model ?? '?'} />
                    <Row label="Respawns" value={String(s.respawn_count ?? 0)} />
                    {s.capped_at ? <Row label="Capped" value={fmtTime(s.capped_at)} /> : null}
                    <Row
                      label="Age"
                      value={
                        s.age_ms === null || s.age_ms === undefined
                          ? '—'
                          : `${Math.round(s.age_ms / 1000)}s`
                      }
                    />
                  </View>
                ))
              )
            ) : null}
          </Section>

          <Section title="Cron jobs" available={data.cron_jobs.available} note={data.cron_jobs.note}>
            {data.cron_jobs.available ? (
              arr(data.cron_jobs.jobs).length === 0 ? (
                <Text style={styles.muted}>No cron runs recorded.</Text>
              ) : (
                arr(data.cron_jobs.jobs).map((j) => (
                  <View key={j.job_name} style={styles.subCard}>
                    <Text style={styles.subTitle}>{str(j.job_name)}</Text>
                    <Row label="Last run" value={fmtTime(j.last_run_at ?? null)} />
                    <Row label="Status" value={j.last_run_status ?? '—'} />
                    {j.last_run_error ? <Row label="Error" value={j.last_run_error} /> : null}
                  </View>
                ))
              )
            ) : null}
          </Section>

          <Section
            title="Import jobs"
            available={data.import_jobs.available}
            note={data.import_jobs.note}
          >
            {data.import_jobs.available ? (
              arr(data.import_jobs.jobs).length === 0 ? (
                <Text style={styles.muted}>No import jobs.</Text>
              ) : (
                arr(data.import_jobs.jobs).map((j) => (
                  <View key={j.job_id} style={styles.subCard}>
                    <Text style={styles.subTitle}>{str(j.status, '?')}</Text>
                    <Row label="Source" value={j.source ?? '?'} />
                    <Row label="Job" value={j.job_id} />
                    {j.error_code ? (
                      <Row label="Error" value={`[${j.error_code}] ${j.error_message ?? ''}`} />
                    ) : null}
                  </View>
                ))
              )
            ) : null}
          </Section>

          <Section
            title="Recent events"
            available={data.recent_events.available}
            note={data.recent_events.note}
          >
            {data.recent_events.available ? (
              arr(data.recent_events.events).length === 0 ? (
                <Text style={styles.muted}>No recent events.</Text>
              ) : (
                arr(data.recent_events.events).slice(0, 20).map((e, i) => (
                  <Text key={i} style={styles.eventLine}>
                    {fmtTime(e.ts ?? null)} · [{str(e.level, '?')}] {str(e.module, '?')}/{str(e.event, '?')}
                  </Text>
                ))
              )
            ) : null}
          </Section>
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  paneScroll: { padding: 16, gap: 12 },
  intro: { gap: 6, marginBottom: 4 },
  paneTitle: { color: '#fafafa', fontSize: 22, fontWeight: '700' },
  paneSubtitle: { color: '#9a9a9a', fontSize: 13, lineHeight: 18 },
  generated: { color: '#6a6a6a', fontSize: 11 },
  refreshBtn: {
    alignSelf: 'flex-start',
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#2a2a2a',
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  refreshLabel: { color: '#d0d0d0', fontSize: 12, fontWeight: '600' },
  pressed: { opacity: 0.7 },
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
  card: {
    backgroundColor: '#121212',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#1f1f1f',
    padding: 12,
    gap: 6,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: { color: '#fafafa', fontSize: 14, fontWeight: '700' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotOk: { backgroundColor: '#22c55e' },
  dotOff: { backgroundColor: '#525252' },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  rowLabel: { color: '#7a7a7a', fontSize: 12 },
  rowValue: { color: '#e0e0e0', fontSize: 12, fontWeight: '500', flexShrink: 1, textAlign: 'right' },
  subCard: {
    backgroundColor: '#0e0e0e',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1c1c1c',
    padding: 8,
    gap: 3,
  },
  subTitle: { color: '#cfcfcf', fontSize: 12, fontWeight: '600', marginBottom: 2 },
  eventLine: { color: '#9a9a9a', fontSize: 11, lineHeight: 16 },
  muted: { color: '#7a7a7a', fontSize: 13 },
});
