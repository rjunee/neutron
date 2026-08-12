/**
 * @neutronai/app — the usage meter.
 *
 * The RN twin of `landing/chat-react/UsageMeter.tsx`, and the same object in the
 * layout: the seam between the tab band and the chat below it. Two hairlines,
 * the 5-hour session window over the 7-day window, each filling from the left
 * with the WHOLE fill changing colour at 85% and again at 95%.
 *
 * Nothing measured means no fill at all — the bar is the plain hairline the band
 * always had. A coloured track with an empty fill would assert "0% used", which
 * is a claim, and the whole point of the unavailable state is that we have none
 * to make.
 *
 * Thresholds come from `@neutronai/contracts` so the phone and the web browser
 * cannot disagree about where the colour turns.
 */

import { StyleSheet, View, type DimensionValue } from 'react-native';

import { clampFraction, usageBand, type UsageBand } from '@neutronai/contracts/credential-usage.ts';

import { type NeutronTheme } from '../lib/theme';
import { useTheme, useThemedStyles } from '../lib/theme-context';
import type { UsagePayload } from '../lib/usage-client';

/** A measured-but-tiny reading still gets a visible sliver, so "barely used" and
 *  "unknown" never render identically. */
const MIN_VISIBLE_FILL = 2;

/** The band ramp, per palette. A function rather than a constant because the
 *  three bar colours differ between light and dark (the dark greens and ambers
 *  wash out on a white page), so a map built once at import would have painted
 *  the wrong ramp in one of the two themes. */
function bandColor(band: UsageBand, theme: NeutronTheme): string {
  if (band === 'critical') return theme.usage_critical;
  if (band === 'warning') return theme.usage_warning;
  return theme.usage_nominal;
}

function UsageLine({
  fraction,
  testID,
}: {
  fraction: number | null;
  testID: string;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  if (fraction === null) {
    return <View style={styles.line} testID={testID} />;
  }
  return (
    <View style={styles.line} testID={testID}>
      <View
        testID={`${testID}-fill`}
        style={[
          styles.fill,
          { backgroundColor: bandColor(usageBand(fraction), theme) },
          // Percentage width so the fill tracks the band's own width without a
          // measured layout; `styles.fill`'s `minWidth` keeps a tiny reading
          // visible. Fixed precision because `0.07 * 100` is not 7.
          { width: `${(clampFraction(fraction) * 100).toFixed(2)}%` as DimensionValue },
        ]}
      />
    </View>
  );
}

export function UsageMeter({ usage }: { usage: UsagePayload }) {
  const styles = useThemedStyles(makeStyles);
  const available = usage.available;
  return (
    <View style={styles.meter} testID="usage-meter">
      <UsageLine fraction={available ? usage.session : null} testID="usage-meter-session" />
      <UsageLine fraction={available ? usage.weekly : null} testID="usage-meter-weekly" />
    </View>
  );
}

const METER_LINE_HEIGHT = 1;

const makeStyles = (theme: NeutronTheme) =>
  StyleSheet.create({
    meter: { flexGrow: 0 },
    line: {
      height: METER_LINE_HEIGHT,
      backgroundColor: theme.hairline,
      overflow: 'hidden',
    },
    fill: {
      height: METER_LINE_HEIGHT,
      minWidth: MIN_VISIBLE_FILL,
    },
  });
