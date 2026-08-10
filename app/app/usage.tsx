/**
 * @neutronai/app — MODEL USAGE: how much quota is left, and whether it will hold.
 *
 * Reached as: chat header ☰ → Settings → Model usage. A registered route nothing
 * pushes is the ISSUES #385 defect, so the nav row in `settings.tsx` is part of this
 * feature, not decoration.
 *
 * ── It reports PACE, not fullness ───────────────────────────────────────────
 * The hairline meter under the tab bar already says how full each window is. "72%" is
 * not a decision until you know whether it is climbing, which is what pace answers:
 * consumed ÷ elapsed, over the window. Above 1 means outrunning the refill.
 *
 * ── What it refuses to say is the design ────────────────────────────────────
 * Every branch below that renders NOTHING is deliberate, and each is a place where
 * the plausible-looking alternative states something false:
 *
 *   - unreachable server → NO bar. A 0% bar invents a measurement.
 *   - `pace: null` → an em dash. A 0 would read as "burning nothing", the opposite
 *     of "the server declined to answer".
 *   - `exhausts_at: null` → the row is OMITTED, because null is the common GOOD case
 *     and a permanent "—" trains the eye to hunt for an absent warning.
 *   - `account_label: null` → "active credential", never a guessed account name.
 *
 * The server does every calculation; this screen formats and nothing else.
 */

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type DimensionValue,
} from 'react-native';

import { loadAppConfig } from '../lib/config';
import { useAuthSession } from '../lib/session';
import { THEME } from '../lib/theme';
import { clampFraction, usageBand } from '@neutronai/contracts/credential-usage.ts';

import {
  UsageDashboardClient,
  accountName,
  formatDuration,
  formatPace,
  formatPercent,
  paceNote,
  type UsageDashboard,
  type UsageWindow,
} from '../lib/usage-dashboard-client';

const BAND_COLOUR: Record<string, string> = {
  nominal: THEME.usage_nominal,
  warning: THEME.usage_warning,
  critical: THEME.usage_critical,
};

/** One window: a bar, the percent, when it resets, and the pace. */
function WindowRow({
  label,
  testID,
  win,
}: {
  label: string;
  testID: string;
  win: UsageWindow | null;
}) {
  if (win === null) {
    // No track at all. An empty coloured track is the specific claim "0% used",
    // which nothing measured.
    return (
      <View style={styles.row} testID={testID}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.muted} testID={`${testID}-none`}>
          not reported
        </Text>
      </View>
    );
  }
  const band = usageBand(win.fraction);
  const pct = Math.round(clampFraction(win.fraction) * 100);
  const note = paceNote(win.pace);
  return (
    <View style={styles.row} testID={testID}>
      <View style={styles.rowHead}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowPct} testID={`${testID}-pct`}>
          {formatPercent(win.fraction)}
        </Text>
      </View>
      <View
        style={styles.track}
        accessibilityRole="progressbar"
        accessibilityLabel={`${label} used`}
        accessibilityValue={{ min: 0, max: 100, now: pct, text: `${pct}% used` }}
      >
        <View
          testID={`${testID}-fill`}
          // The band is carried as a real prop, not only as a colour: a test that can
          // only read a style cannot tell amber from red on a 6px bar.
          accessibilityLabel={`band ${band}`}
          style={[
            styles.fill,
            {
              width: `${(clampFraction(win.fraction) * 100).toFixed(2)}%` as DimensionValue,
              backgroundColor: BAND_COLOUR[band],
            },
          ]}
        />
      </View>
      <View style={styles.facts}>
        <View style={styles.fact}>
          <Text style={styles.factLabel}>Resets in</Text>
          <Text style={styles.factValue} testID={`${testID}-resets`}>
            {formatDuration(win.resets_in_ms)}
          </Text>
        </View>
        <View style={styles.fact}>
          <Text style={styles.factLabel}>Pace</Text>
          <Text style={styles.factValue} testID={`${testID}-pace`}>
            {formatPace(win.pace)}
          </Text>
          {note !== null ? <Text style={styles.factNote}>{note}</Text> : null}
        </View>
        {/* ONLY when there is a projection. Null is the common, good case. */}
        {win.exhausts_at !== null ? (
          <View style={styles.fact}>
            <Text style={styles.factLabel}>Caps out in</Text>
            <Text style={styles.factValue} testID={`${testID}-exhausts`}>
              {formatDuration(win.exhausts_at - Date.now())}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

export default function ModelUsageScreen() {
  const router = useRouter();
  const { user } = useAuthSession();
  const config = useMemo(() => loadAppConfig(), []);

  const client = useMemo(() => {
    if (user === null) return null;
    return new UsageDashboardClient({ base_url: config.base_url, token: user.token });
  }, [user, config.base_url]);

  // `null` is "not asked yet". The client never rejects, so there is no error state:
  // an unreachable server is one of its two ANSWERS, and a third representation would
  // put the same branch in two places.
  const [usage, setUsage] = useState<UsageDashboard | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (client === null) return;
    setRefreshing(true);
    const next = await client.load();
    setUsage(next);
    setRefreshing(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (user === null) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator color={THEME.text_secondary} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          testID="usage-back"
          onPress={() => router.back()}
          style={({ pressed }) => [styles.headerBack, pressed && styles.pressed]}
        >
          <Text style={styles.headerIcon}>←</Text>
        </Pressable>
        <View>
          <Text style={styles.headerOverline}>Settings</Text>
          <Text style={styles.headerTitle}>Model usage</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.muted}>
          How much of each window this instance has consumed, and whether it is on track to
          run out before the window resets. Measured once a minute and kept for 30 days.
        </Text>

        {usage === null ? (
          <ActivityIndicator color={THEME.text_secondary} testID="usage-loading" />
        ) : !usage.reachable ? (
          <Text style={styles.muted} testID="usage-unreachable">
            Usage history isn&apos;t available from this server.
          </Text>
        ) : usage.pools.length === 0 ? (
          <Text style={styles.muted} testID="usage-empty">
            No readings yet.
          </Text>
        ) : (
          usage.pools.map((pool) => (
            <View key={pool.pool} style={styles.pool} testID={`usage-${pool.pool}`}>
              <Text style={styles.poolTitle} testID={`usage-${pool.pool}-account`}>
                {accountName(pool.account_label)}
              </Text>
              {pool.measured_at === null ? (
                <Text style={styles.muted}>No readings yet.</Text>
              ) : (
                <>
                  <WindowRow
                    label="5-hour window"
                    testID={`usage-${pool.pool}-session`}
                    win={pool.session}
                  />
                  <WindowRow
                    label="7-day window"
                    testID={`usage-${pool.pool}-weekly`}
                    win={pool.weekly}
                  />
                </>
              )}
            </View>
          ))
        )}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh usage"
          testID="usage-refresh"
          disabled={refreshing}
          onPress={() => void load()}
          style={({ pressed }) => [
            styles.secondaryBtn,
            refreshing && styles.btnDisabled,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.secondaryBtnText}>{refreshing ? 'Refreshing…' : 'Refresh'}</Text>
        </Pressable>

        <Text style={styles.footnote}>
          Pace is how much you have used divided by how much of the window has passed.
          Above 1× means you are using it faster than it refills.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: THEME.background, paddingTop: 48 },
  centered: { alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: THEME.hairline,
  },
  headerBack: { padding: 4 },
  headerIcon: { color: THEME.text_primary, fontSize: 20 },
  headerOverline: { color: THEME.text_muted, fontSize: 11, textTransform: 'uppercase' },
  headerTitle: { color: THEME.text_primary, fontSize: 18, fontWeight: '700' },
  scroll: { padding: 16, gap: 16, paddingBottom: 48 },
  muted: { color: THEME.text_muted, fontSize: 13, lineHeight: 18 },
  footnote: { color: THEME.text_muted, fontSize: 11, lineHeight: 15 },
  pool: {
    gap: 14,
    padding: 12,
    borderRadius: 10,
    backgroundColor: THEME.surface_raised,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  poolTitle: {
    color: THEME.text_secondary,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  row: { gap: 6 },
  rowHead: { flexDirection: 'row', alignItems: 'center' },
  rowLabel: { color: THEME.text_primary, fontSize: 14, fontWeight: '600' },
  rowPct: { color: THEME.text_primary, fontSize: 14, fontWeight: '700', marginLeft: 'auto' },
  track: {
    height: 6,
    borderRadius: 999,
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.hairline,
    overflow: 'hidden',
  },
  // A measured-but-tiny fraction still shows: without a floor, 0.4% renders as
  // nothing and is indistinguishable from unmeasured.
  fill: { height: '100%', minWidth: 2, borderRadius: 999 },
  facts: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  fact: { gap: 1 },
  factLabel: {
    color: THEME.text_muted,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  factValue: { color: THEME.text_primary, fontSize: 13 },
  factNote: { color: THEME.text_muted, fontSize: 11 },
  secondaryBtn: {
    alignItems: 'center',
    paddingVertical: 11,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  secondaryBtnText: { color: THEME.text_secondary, fontSize: 13, fontWeight: '600' },
  btnDisabled: { opacity: 0.5 },
});
