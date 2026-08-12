/**
 * @neutronai/app — the chat surface's exception strip.
 *
 * THE DEFAULT ASSUMPTION IS "CONNECTED", AND THE UI ONLY SPEAKS UP ONCE THAT
 * ASSUMPTION HAS BEEN WRONG FOR A WHILE.
 *
 * This used to render a live transcription of the socket state machine:
 * "Connecting…" on every mount, "Reconnecting…" on every backoff round. Opening
 * a project mounts a fresh chat surface, so the owner read the word
 * "Connecting…" every single time he switched projects — a routine, invisible
 * piece of plumbing dressed up as a fault, several times a minute. His verdict,
 * and the whole reason this file exists: *"Users don't need to see this."*
 *
 * What is NOT thrown away with it. Two very different facts hid behind that one
 * label, and only one of them was noise:
 *   1. "a socket is negotiating"  — plumbing. Gone, with no replacement.
 *   2. "your message is not going anywhere" — real, and it still has to reach
 *      him. It reaches him by THREE routes, none of which is the old label:
 *      - the per-bubble delivery glyph (🕓 queued → ✓ sent → ⚠️ failed-with-retry;
 *        `lib/chat-core/chat-render-model.ts` `deliveryState`), which is the
 *        iMessage-shaped, per-message channel and is unaffected by this file;
 *      - {@link ConnectionNoticeProps.sendError}, INSTANT and unthrottled — a
 *        message that could not even be queued locally produced no bubble at
 *        all, so this strip is its only channel;
 *      - and this strip's offline line, once the outage is no longer plausibly
 *        a blip — see {@link OFFLINE_NOTICE_AFTER_MS}.
 *
 * The one thing this must never do is LATCH. Every suppression here is a
 * function of the live status, so the notice disappears on the same render the
 * socket comes back.
 */

import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { ConnStatus } from '@neutronai/chat-core';

import { TYPOGRAPHY, SPACING, type NeutronTheme } from '../lib/theme';
import { useTheme, useThemedStyles } from '../lib/theme-context';

/**
 * How long the connection has to be down before the owner is told anything.
 *
 * DERIVED FROM THE RECONNECT MACHINE, not picked by feel. `ChatWsClient` retries
 * with exponential backoff from `minBackoffMs` 500 ms to a `maxBackoffMs` ceiling
 * of 15 000 ms (`chat-core/ws-client.ts`), so the delays it burns getting there
 * are 500 + 1000 + 2000 + 4000 + 8000 = 15 500 ms — i.e. by the time this fires,
 * five reconnect attempts have already failed and the client has stopped
 * believing in a fast recovery too. A healthy reconnect (a project switch, a
 * foreground resume, a wifi→cellular handoff) lands on the first or second
 * attempt, inside ~2 s, so a routine switch misses this by roughly an order of
 * magnitude.
 *
 * ERR LONG, DELIBERATELY. A false "Offline" is precisely the anxiety this change
 * removes; a late-by-ten-seconds true one costs nothing, because the per-message
 * 🕓/⚠️ glyphs are already carrying the per-send truth the whole time.
 */
export const OFFLINE_NOTICE_AFTER_MS = 15_000;

/** Statuses under which we simply ASSUME the connection is fine and say nothing:
 *  `open` (it is), and `idle` (nothing has been attempted yet — a surface that
 *  has not started connecting has no outage to report). */
export function isAssumedHealthy(status: ConnStatus): boolean {
  return status === 'open' || status === 'idle';
}

export interface ConnectionNoticeInput {
  status: ConnStatus;
  /** Sends still awaiting delivery (offline-queue depth). */
  pending_count: number;
  /** True once the connection has been down for {@link OFFLINE_NOTICE_AFTER_MS}
   *  CONTINUOUSLY — see {@link useExtendedOutage}. */
  outage_elapsed: boolean;
}

/**
 * The whole decision, pure: what (if anything) the strip says about the
 * connection. `null` — the overwhelmingly common answer — renders nothing at
 * all: no strip, no dimmed label, no spinner.
 */
export function connectionNotice(input: ConnectionNoticeInput): string | null {
  // Healthy is checked FIRST and independently of `outage_elapsed`, so a notice
  // cannot survive the recovery even for one render.
  if (isAssumedHealthy(input.status)) return null;
  if (!input.outage_elapsed) return null;
  if (input.pending_count > 0) {
    const plural = input.pending_count === 1 ? 'message' : 'messages';
    return `Offline — ${input.pending_count} ${plural} waiting to send`;
  }
  return 'Offline';
}

/**
 * True once `status` has been continuously un-healthy for `afterMs`.
 *
 * The effect keys on the BOOLEAN health, never on the raw status. That is the
 * whole trick: a dead connection flaps `connecting` → `reconnecting` →
 * `closed` → `reconnecting` … and an effect keyed on the status string would
 * tear down and re-arm its timer on every one of those transitions, so the
 * deadline would never be reached and a permanent outage would report nothing
 * at all. Health only flips when the connection genuinely comes back, which is
 * also the only moment the notice may clear.
 *
 * `afterMs` is injectable for tests, exactly as `ChatWsClient` injects its
 * timers — nothing in the app passes it.
 */
export function useExtendedOutage(
  status: ConnStatus,
  afterMs: number = OFFLINE_NOTICE_AFTER_MS,
): boolean {
  const healthy = isAssumedHealthy(status);
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (healthy) {
      setElapsed(false);
      return;
    }
    const handle = setTimeout(() => setElapsed(true), afterMs);
    return () => clearTimeout(handle);
  }, [healthy, afterMs]);
  // Belt and braces against a latch: even if a stale `true` survived a render,
  // a healthy socket reports nothing.
  return elapsed && !healthy;
}

export interface ConnectionNoticeProps {
  status: ConnStatus;
  pendingCount: number;
  /**
   * Non-null when the LAST send could not even be QUEUED locally.
   *
   * It OUTRANKS everything else here and is never delayed. A send that failed
   * this way produced no bubble, so this strip is the only place the owner can
   * learn it happened — and an absent (or cheerful) connection line over a
   * silently-dropped message is exactly the lie that let mobile chat ship broken.
   */
  sendError: string | null;
  /**
   * Test seam ONLY, defaulting to {@link OFFLINE_NOTICE_AFTER_MS}; the app never
   * passes it. Same precedent as `ChatWsClient`'s injectable timers: the
   * alternative is a suite that must sit through a real 15-second outage to
   * prove the notice ever appears, which in practice means nobody proves it.
   */
  offlineAfterMs?: number;
}

export function ConnectionNotice({
  status,
  pendingCount,
  sendError,
  offlineAfterMs = OFFLINE_NOTICE_AFTER_MS,
}: ConnectionNoticeProps): React.JSX.Element | null {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const outageElapsed = useExtendedOutage(status, offlineAfterMs);
  if (sendError !== null) {
    return (
      <View style={styles.statusStrip} testID="chat-send-error">
        <Text style={[styles.statusText, { color: theme.danger }]} accessibilityRole="alert">
          {sendError}
        </Text>
      </View>
    );
  }
  const label = connectionNotice({
    status,
    pending_count: pendingCount,
    outage_elapsed: outageElapsed,
  });
  if (label === null) return null;
  return (
    <View style={styles.statusStrip} testID="chat-offline-notice">
      <Text style={[styles.statusText, { color: theme.warning }]}>{label}</Text>
    </View>
  );
}

const makeStyles = (theme: NeutronTheme) =>
  StyleSheet.create({
    // Unchanged from the strip this replaces — a hairline-separated caption band
    // above the transcript. The point of this change is that it is now RARE, not
    // that it looks new; a fresh visual pattern for the exceptional case would be
    // its own kind of alarm.
    statusStrip: {
      paddingVertical: SPACING.xs,
      paddingHorizontal: SPACING.md,
      alignItems: 'center',
      backgroundColor: theme.surface,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.hairline,
    },
    statusText: { ...TYPOGRAPHY.caption },
  });
