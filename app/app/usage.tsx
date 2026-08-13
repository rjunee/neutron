/**
 * @neutronai/app — MODEL USAGE: every connected account, on one screen.
 *
 * Reached as: chat header ☰ → Settings → Model usage. A registered route nothing
 * pushes is the ISSUES #385 defect, so the nav row in `settings.tsx` is part of this
 * feature, not decoration.
 *
 * ── It answers two opposite questions ───────────────────────────────────────
 * The hairline meter under the tab bar already says how full each window is. "72%"
 * is not a decision until you know two more things:
 *
 *   - PACE — consumed ÷ elapsed, over the window. Above 1 means outrunning the
 *     refill, and the projection off it says when the wall arrives.
 *   - THE COUNTDOWN — when capacity comes BACK. That is the input to the
 *     throughput decision (how hard to push concurrency), and it is paired with
 *     the utilisation of the window it belongs to, always: a 5-hour window
 *     resetting in 17 minutes buys nothing while the 7-day window is spent.
 *
 * The pool line at the top of each card is the one-glance answer: how many
 * accounts have room right now, or when the first one gets some.
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
 *   - an absent reset instant → "unknown", NEVER "now" and never omitted. That one
 *     is the difference between "wait" and "push", and getting it wrong sends the
 *     owner into a wall.
 *   - `account_label: null` → "active credential", never a guessed account name.
 *
 * The server sends only facts that DO NOT AGE — the instant each reading was taken,
 * each window's length and reset instant, the pace and the projection anchored at
 * the measurement, and a staleness THRESHOLD. Every delta — the age chip, the "≥"
 * floors, each account's standing and every countdown — is computed HERE against
 * this device's clock, on every paint (`projectPool`). A duration is wrong the
 * moment it is stored: a server-computed age would read "just now" for as long as
 * the screen stayed open, with a live countdown ticking beside it.
 *
 * AND THE PAYLOAD ITSELF IS REPOLLED on that same tick (`USAGE_POLL_MS`), which is
 * the other half of the same rule. Ageing a held payload is right across a dead
 * poller and wrong across a live one: the Anthropic pool goes stale at two minutes,
 * so a screen that only advanced its clock would paint a perfectly healthy install
 * as stale two and a half minutes after it opened, and stay that way. The poll is
 * pinned below that deadline so staleness on this screen only ever means staleness.
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
  USAGE_POLL_MS,
  UsageDashboardClient,
  accountCapacityNote,
  accountName,
  capacityLine,
  connectionNote,
  formatAge,
  formatCountdown,
  formatProjection,
  formatPace,
  formatWindowFraction,
  nextAccountNote,
  paceNote,
  poolTitle,
  projectPool,
  windowName,
  type ProjectedAccount,
  type ProjectedWindow,
  type UsageDashboard,
  type UsagePool,
} from '../lib/usage-dashboard-client';

const BAND_COLOUR: Record<string, string> = {
  nominal: THEME.usage_nominal,
  warning: THEME.usage_warning,
  critical: THEME.usage_critical,
};

/** One window: a bar, the percent, when capacity comes back, and the pace. */
function WindowRow({
  windowKey,
  testID,
  win,
  now,
}: {
  windowKey: 'session' | 'weekly';
  testID: string;
  win: ProjectedWindow | null;
  now: number;
}) {
  // From the LENGTH the provider reported, never a hardcoded "5-hour window":
  // lengths differ per provider and one has already changed regime, so a fixed
  // label eventually names the wrong thing with complete confidence.
  const label = windowName(windowKey, win?.window_ms ?? null);
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
        {/* Floored with a "≥" when the reading is stale and its window is still
            running: the last known value marked as a lower bound, rather than a
            blank or a fresh-looking number. */}
        <Text style={styles.rowPct} testID={`${testID}-pct`}>
          {formatWindowFraction(win)}
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
          {/* THE COUNTDOWN, computed HERE from the absolute instant the server
              sent. "unknown" and "available now" are different answers and
              neither may collapse into the other. */}
          <Text style={styles.factLabel}>Resets in</Text>
          <Text style={styles.factValue} testID={`${testID}-resets`}>
            {formatCountdown(win.reset_at === null ? null : win.reset_at - now)}
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
        {formatProjection(win.exhausts_at, now) !== null ? (
          <View style={styles.fact}>
            <Text style={styles.factLabel}>Caps out in</Text>
            <Text style={styles.factValue} testID={`${testID}-exhausts`}>
              {formatProjection(win.exhausts_at, now)}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

/**
 * One provider's card: the capacity line first, then a chip per account.
 *
 * PER PROVIDER, IN ITS OWN UNITS, NEVER SUMMED. Anthropic, Codex and Kimi meter
 * different things, so a combined headline would be a number about nothing. The
 * cards sit adjacently and each answers for itself.
 */
function PoolCard({ pool, now }: { pool: UsagePool; now: number }) {
  // EVERY DELTA ON THIS CARD IS COMPUTED HERE, from the render clock, on every
  // paint — the age, the staleness, the "≥" floors and each account's standing.
  // The payload carries instants and a threshold and nothing else, so a card left
  // open across a dead poller ages in front of the owner rather than insisting on
  // the freshness it had when the response was built.
  const view = projectPool(pool, now);
  const note = connectionNote(view);
  const line = capacityLine(view);
  const nextUp = nextAccountNote(view);
  return (
    <View style={styles.pool} testID={`usage-${view.pool}`}>
      <View style={styles.poolHead}>
        <Text style={styles.poolTitle} testID={`usage-${view.pool}-title`}>
          {poolTitle(view.pool)}
        </Text>
        {/* The age rides on every card, not only the stale ones — an age that
            shows up only when something is wrong is one nobody learns to read. */}
        <Text style={styles.age} testID={`usage-${view.pool}-age`}>
          {formatAge(view.age_ms)}
        </Text>
      </View>
      {/* THE LINE THE OWNER ASKED FOR: how hard can I push this provider right
          now. It names the BINDING window, because a countdown to a 5-hour reset
          says nothing about capacity while the 7-day window is spent. */}
      {line !== null ? (
        <Text style={styles.capacity} testID={`usage-${view.pool}-capacity`}>
          {line}
        </Text>
      ) : null}
      {/* WHICH account the line above is about. The headline says WHEN; on a pool
          with more than one account the owner still has to know WHOSE, because
          that is the account he routes the next build to. */}
      {nextUp !== null ? (
        <Text style={styles.muted} testID={`usage-${view.pool}-nextup`}>
          {nextUp}
        </Text>
      ) : null}
      {note !== null ? (
        // Three different fixes hide behind an empty card — connect an account,
        // wait for a reading, or nothing at all — so it says which.
        <Text style={styles.muted} testID={`usage-${view.pool}-empty`}>
          {note}
        </Text>
      ) : (
        view.accounts.map((account, i) => (
          <AccountCard
            key={account.account_label ?? `unlabelled-${i}`}
            account={account}
            testID={`usage-${view.pool}-acct-${i}`}
            now={now}
          />
        ))
      )}
    </View>
  );
}

/** One account inside a card: its name, its standing, its age, and both windows. */
function AccountCard({
  account,
  testID,
  now,
}: {
  account: ProjectedAccount;
  testID: string;
  now: number;
}) {
  return (
    <View style={styles.account} testID={testID}>
      <View style={styles.accountHead}>
        {/* NEVER a guessed account name. */}
        <Text style={styles.accountName} testID={`${testID}-name`}>
          {accountName(account.account_label)}
        </Text>
        <Text style={styles.chip} testID={`${testID}-capacity`}>
          {accountCapacityNote(account)}
        </Text>
        <Text style={styles.age} testID={`${testID}-age`}>
          {formatAge(account.age_ms)}
        </Text>
      </View>
      <WindowRow windowKey="session" testID={`${testID}-session`} win={account.session} now={now} />
      <WindowRow windowKey="weekly" testID={`${testID}-weekly`} win={account.weekly} now={now} />
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

  // THE RENDER CLOCK for every countdown on this screen. The payload carries reset
  // INSTANTS and the delta is computed at paint, so this has to advance on its own
  // — a screen left open would otherwise keep insisting capacity returns in the
  // same 17 minutes it did an hour ago. It is advanced by the poll effect below, on
  // a tick finer than the whole minutes the countdowns render in, so nothing is
  // ever visibly wrong.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const load = useCallback(
    async (visible: boolean) => {
      if (client === null) return;
      // The button only says "Refreshing…" for a refresh the OWNER asked for. A
      // background poll that flipped it would make the screen look busy every
      // thirty seconds forever, and would disable the control he came to press.
      if (visible) setRefreshing(true);
      const next = await client.load();
      setUsage(next);
      if (visible) setRefreshing(false);
    },
    [client],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  // ONE TICK ADVANCES THE CLOCK **AND** REFETCHES, and the pairing is the fix.
  //
  // Advancing the clock alone is what ages a card honestly across a DEAD poller —
  // but run against a LIVE one it is a slow lie in the other direction. The
  // Anthropic pool goes stale at two minutes, so a screen left open would floor its
  // gauges to "≥" and drop capacity to "unknown" about two and a half minutes in
  // while a healthy poller wrote a fresh row every 60 seconds behind it. A screen
  // that paints a working install as broken is the same defect as one that paints a
  // broken install as working; both are the card disagreeing with the truth.
  //
  // So the payload is refetched on the SAME interval. One timer, so the data and
  // the clock it is measured against can never drift apart, and `USAGE_POLL_MS`
  // stays below the tightest staleness deadline the store ships (pinned by a test).
  useEffect(() => {
    const handle = setInterval(() => {
      setNowMs(Date.now());
      void load(false);
    }, USAGE_POLL_MS);
    return () => clearInterval(handle);
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
          Every connected account, in its own units — never added together. Each card says
          how much of each window is used, whether it is on track to run out, and when
          capacity comes back. Readings are kept for 30 days and always shown with their age.
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
            <PoolCard key={pool.pool} pool={pool} now={nowMs} />
          ))
        )}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh usage"
          testID="usage-refresh"
          disabled={refreshing}
          onPress={() => void load(true)}
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
  poolHead: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  poolTitle: {
    color: THEME.text_secondary,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  age: { color: THEME.text_muted, fontSize: 11, marginLeft: 'auto' },
  capacity: { color: THEME.text_primary, fontSize: 14, fontWeight: '600' },
  account: { gap: 10 },
  accountHead: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  accountName: { color: THEME.text_primary, fontSize: 13, fontWeight: '600' },
  chip: { color: THEME.text_muted, fontSize: 11 },
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
