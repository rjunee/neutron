/**
 * SLIDE AWAY FROM THE MIC AND THE RECORDING IS DISCARDED (owner-reported, #521).
 *
 * WHAT HE SAW: *"'slide to cancel' on the voice note recorder doesn't work."*
 *
 * WHY, and the arithmetic was never the problem. `Pressable` releases a press
 * once the touch leaves the button plus its retention offset. RN's default
 * retention is a couple of dozen points and the mic button is 44pt, while the
 * gesture requires travelling `VOICE_CANCEL_SLIDE_PT` = 64pt — comfortably
 * outside it. So the press TERMINATED mid-slide: `onPressOut` fired while
 * `holding.cancelling` was still false, the release resolved as **'send'**, and
 * the View stopped receiving `onTouchMove` before the threshold could be crossed.
 * Sliding away didn't cancel the recording, it SENT it — the worst possible
 * reading of "cancel", because the thing the user was trying to destroy is the
 * thing that got delivered.
 *
 * The fix is `pressRetentionOffset`, sized larger than the gesture it has to
 * outlive.
 *
 * HONEST BOUNDARY, stated plainly because my first draft of this note overclaimed
 * and I am not going to let it ship that way. **THIS FILE IS MOSTLY SOURCE
 * ASSERTIONS, NOT A DRIVEN GESTURE.**
 *
 * Two things make the real gesture undrivable here. RN-web's Pressable does not
 * model the native responder's retention region at all — so the very termination
 * that CAUSED the bug cannot occur in this harness, and a driven test would pass
 * with the retention offset removed. And `holding` is only entered through
 * `onLongPress` after `VOICE_LONG_PRESS_MS`, which the harness has no clean way to
 * elapse into a real press.
 *
 * So what is actually asserted is:
 *
 *   1. the mic control is MOUNTED and reachable (driven, real);
 *   2. it CARRIES a retention offset derived from — and larger than — the slide
 *      threshold (source-scoped; this is the half the device bug lived in);
 *   3. the cancel threshold counts travel in either direction (source-scoped).
 *
 * The claim that a real thumb sliding 64pt cancels on a real device is settled on
 * HARDWARE. It is not settled here, and no assertion below should be read as
 * settling it.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installNativeHarness, resetHarnessGlobals, setHarnessPlatform } from './support/native-harness';

installNativeHarness();
setHarnessPlatform('android');

const { FakeChatSocket, mountScreen } = await import('./support/mount');
const { setRuntimeServerConfig, __resetServerConfigForTests } = await import('../lib/config');
const { AuthSessionProvider } = await import('../lib/session');
const { ChatSyncSurface } = await import('../components/ChatSyncSurface');
const { __resetSharedMobileStoreForTests } = await import('../lib/chat-core/op-sqlite-store');
const { clearSessionCache } = await import('../lib/chat-core/session-cache');

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPOSER_SRC = readFileSync(join(HERE, '..', 'components', 'InputComposer.tsx'), 'utf8');

const OWNER = {
  id: 'harness-owner',
  email: 'owner@example.test',
  displayName: 'Harness Owner',
  provider: 'dev' as const,
  token: 'harness-token',
};

beforeEach(() => {
  FakeChatSocket.install();
  clearSessionCache();
  __resetSharedMobileStoreForTests();
  __resetServerConfigForTests();
  setRuntimeServerConfig({ gateway_base_url: 'https://harness.example.test', auth_base_url: null });
});

afterEach(() => {
  clearSessionCache();
  __resetServerConfigForTests();
});

beforeAll(installNativeHarness);
afterAll(resetHarnessGlobals);

async function mountChat() {
  const screen = await mountScreen(
    createElement(
      AuthSessionProvider,
      { initialUser: OWNER },
      createElement(ChatSyncSurface, { projectId: 'harness-project' }),
    ),
  );
  FakeChatSocket.current().onopen?.();
  await screen.settle();
  return screen;
}

describe('the mic control keeps the press alive across the slide', () => {
  it('carries a retention offset LARGER than the slide it has to survive', () => {
    // STRUCTURAL, and weaker than it looks — see the file note. RN-web does not
    // model the native retention region, so this cannot be driven; without it
    // there is NO cover at all for the half the device bug lived in.
    expect(COMPOSER_SRC.includes('pressRetentionOffset={VOICE_PRESS_RETENTION_PT}')).toBe(true);
    // And it must be derived from the threshold rather than a loose literal: a
    // retention smaller than the gesture reintroduces the bug exactly.
    expect(COMPOSER_SRC.includes('left: VOICE_CANCEL_SLIDE_PT * 4')).toBe(true);
    expect(COMPOSER_SRC.includes('top: VOICE_CANCEL_SLIDE_PT * 2')).toBe(true);
  });

  it('is mounted and reachable in the first place', async () => {
    // The control this whole gesture hangs off. If the composer stops rendering
    // it, every assertion above is vacuously true.
    const screen = await mountChat();
    expect(screen.byTestId('composer-voice')).not.toBeNull();
    screen.unmount();
  });
});

describe('the release verdict follows the slide, not the button (source-scoped)', () => {
  it('a drifted press still routes to the CANCEL verdict', () => {
    // SOURCE-SCOPED, and named that way after the first draft of this file called
    // it behavioural when it is not. `pressDrifted` is what makes a wandering
    // finger discard rather than latch a recording; inverting it would send the
    // clip the user was trying to throw away — the exact shape of the report.
    expect(COMPOSER_SRC.includes("onVoiceHoldEnd?.('cancel')")).toBe(true);
    expect(COMPOSER_SRC.includes('if (pressDrifted.current)')).toBe(true);
  });

  it('the cancel threshold counts travel in EITHER direction', () => {
    // A one-handed thumb arcs. A gesture that only cancels leftward strands
    // whoever arcs the other way, and the abs() is the thing that prevents it.
    expect(COMPOSER_SRC.includes('Math.abs(holdOriginX.current - x) > VOICE_CANCEL_SLIDE_PT')).toBe(
      true,
    );
  });
});
