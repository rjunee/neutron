/**
 * reachability, mobile — CAN THE OWNER STILL DO IT, ON THE PHONE, ON BOTH
 * PLATFORMS WE SHIP?
 *
 * Mounts the REAL project shell — `app/projects/[id]/_layout.tsx`, over the
 * routing harness, with the real header, the real rail, the real tab bar, the
 * real usage client and the real chat surface inside `<Slot/>` — and, for each
 * shipped platform, asks every entry in `OWNER_AFFORDANCES` one question: press
 * it like a thumb, and did anything REAL happen.
 *
 * WHY THIS IS NOT ANOTHER COMPONENT TEST, and why it presses rather than
 * queries. The component tests next door mount a PART with hand-written props
 * and assert the part behaves. Voice messages had five such files, all green,
 * while the feature did not exist on the device: `ChatSyncSurface` rendered
 * `<InputComposer>` without its `onVoice*` props, so the mic rendered, took the
 * press, and said "Voice messages are not available yet." A presence probe —
 * "is the mic in the tree?" — PASSES on that build. The mic was in the tree.
 *
 * So every probe here ends at an effect a missing handler cannot fake: a
 * microphone that opened, a frame on the socket, an OS picker that ran, a route
 * that changed, a measured meter. That is the whole design. The affordance list
 * and the owner-facing sentences live in `reachability-inventory.ts`; this file
 * is only the machinery that presses them.
 *
 * THE PARITY GATE. Beyond the per-platform run there is a harder assertion: an
 * affordance the owner has on one platform and not the other fails, unless the
 * inventory carries a written `absentOn` reason. That is what turns "we
 * remembered to check Android" into "a capability cannot silently vanish from a
 * platform". (Platform, not width — the shipped app has exactly one layout at
 * every size; `reachability-inventory.ts` § PLATFORMS shows the work, and
 * `reachability-inventory-complete.test.ts` re-derives it from the source so
 * the claim cannot go stale.)
 *
 * WHAT A FAILURE SAYS. The `broken:` sentence from the inventory, naming what
 * the owner can no longer do. Not the selector, not the assertion.
 *
 * NO NETWORK, NO MODEL, NO CLOCK TO WAIT ON. The socket is a recorder, the
 * gateway is a function returning literals, the microphone and the file picker
 * are counting stubs. There is nothing here that can be slow, rate-limited or
 * offline — the property that lets a red be believed.
 *
 * AND NOTHING HERE CAN HANG. Every mount happens INSIDE an `it()` (so bun's
 * timeout is real — a boot in `beforeAll` is not covered by it, which is how a
 * timeout argument becomes decoration), a missing control THROWS rather than
 * being waited for, and every wait in the file is a fixed number of fixed-length
 * ticks. There is no polling loop and no `while` in the gate.
 *
 * VERIFICATION DEPTH (honest): react-native-web under happy-dom, not a device.
 * It runs the real component tree and the real handlers; it does not run Hermes,
 * a native gesture recogniser, a real microphone or a real layout. The bounds
 * are `support/native-harness.ts`, and the gaps are written down in
 * `docs/SYSTEM-OVERVIEW.md` § Reachability gate rather than papered over.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { act, createElement } from 'react';

import {
  installNativeHarness,
  resetHarnessGlobals,
  setHarnessPlatform,
  withoutWebCrypto,
} from './support/native-harness';
import {
  OTHER_PROJECT,
  OWNER_AFFORDANCES,
  PLATFORMS,
  type OwnerAffordance,
  type PlatformName,
  type Probe,
} from './reachability-inventory';

installNativeHarness();
setHarnessPlatform('ios');

const { FakeChatSocket, mountScreen } = await import('./support/mount');
// The stubs BY PATH, not by their package specifiers: the harness aliases those
// at runtime, but `tsc` resolves them to the real packages, whose types carry
// none of the harness controls.
const { installRouting, resetRouting, currentRouterPath } = await import(
  './support/stubs/expo-router'
);
const { harnessAudioState, resetHarnessAudio } = await import('./support/stubs/expo-audio');
const { harnessDocumentPickerCalls, resetHarnessDocumentPicker } = await import(
  './support/stubs/expo-document-picker'
);
const { setRuntimeServerConfig, __resetServerConfigForTests } = await import('../lib/config');
const { AuthSessionProvider } = await import('../lib/session');
const { clearSessionCache } = await import('../lib/chat-core/session-cache');
const { __resetSharedMobileStoreForTests } = await import('../lib/chat-core/op-sqlite-store');
const { __resetLastTabStorageForTests } = await import('../lib/last-tab-storage');

const ProjectLayout = (await import('../app/projects/[id]/_layout')).default;
const ProjectIndexRedirect = (await import('../app/projects/[id]/index')).default;
const ProjectChatTab = (await import('../app/projects/[id]/chat')).default;

const OWNER = {
  id: 'harness-owner',
  email: 'owner@example.test',
  displayName: 'Harness Owner',
  provider: 'dev' as const,
  token: 'harness-token',
};
const BASE_URL = 'https://harness.example.test';
/** The project the shell opens on. `OTHER_PROJECT` is the one the rail probe
 *  switches to, so both have to be in the list. */
const HOME_PROJECT = 'willow';
const PROJECTS = [HOME_PROJECT, OTHER_PROJECT] as const;

/** A MEASURED usage reading. The meter's job is to show a number when the server
 *  has one; handing it a real one is what makes "the host stopped passing usage"
 *  detectable at all. */
const USAGE_READING = { available: true, session: 0.42, weekly: 0.11, measured_at: 1 };

/** The tab set the resolver answers with. Two builtins, so the tab probe has a
 *  tab to travel TO that is not the one it starts on. */
const TABS = [
  { key: 'chat', label: 'Chat', scope: 'project', source: 'builtin', order: 0, mount: { kind: 'builtin', target: 'chat' } },
  { key: 'documents', label: 'Documents', scope: 'project', source: 'builtin', order: 10, mount: { kind: 'builtin', target: 'docs' } },
];

let restoreCrypto: (() => void) | null = null;
let realFetch: typeof fetch;

function settingsDoc(id: string) {
  return {
    id,
    name: id,
    description: '',
    persona: '',
    emoji: '📁',
    privacy_mode: 'private',
    billing_mode: 'personal',
    agent_engagement_mode: 'all_messages',
    members: [],
  };
}

function listRow(id: string) {
  return {
    ...settingsDoc(id),
    kind: 'solo',
    origin_instance: 'local',
    owning_instance_slug: 'local',
    last_activity_at: new Date().toISOString(),
    unread_count: 0,
  };
}

/**
 * A gateway that answers everything the shell asks for, from literals, at once.
 * Anything unlisted 404s — exactly as an older gateway would, and never a hang.
 */
function installGateway(): void {
  (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(BASE_URL, '').split('?')[0] ?? '';
    if (path === '/api/app/projects') {
      return Response.json({ ok: true, projects: PROJECTS.map(listRow), project_slug: 'local' });
    }
    if (path === '/api/app/usage') return Response.json(USAGE_READING);
    const settings = /^\/api\/app\/projects\/([^/]+)\/settings$/.exec(path);
    if (settings !== null) {
      const id = decodeURIComponent(settings[1] ?? '');
      return Response.json({ ok: true, project: settingsDoc(id), project_id: id });
    }
    const tabs = /^\/api\/app\/projects\/([^/]+)\/tabs$/.exec(path);
    if (tabs !== null) {
      const id = decodeURIComponent(tabs[1] ?? '');
      return Response.json({ ok: true, scope: 'project', project_id: id, tabs: TABS });
    }
    return Response.json({ ok: false, code: 'not_found', message: path }, { status: 404 });
  }) as typeof fetch;
}

beforeAll(installNativeHarness);

beforeEach(() => {
  // THE DEVICE RUNTIME: React Native installs no `crypto` global, and a gate
  // that runs on one that HAS WebCrypto is testing a machine the owner does not
  // own — that difference is what hid a `crypto.randomUUID()` in `SendQueue`
  // while every mobile send failed.
  restoreCrypto = withoutWebCrypto();
  realFetch = globalThis.fetch;
  installGateway();
  FakeChatSocket.install();
  clearSessionCache();
  __resetSharedMobileStoreForTests();
  __resetLastTabStorageForTests();
  __resetServerConfigForTests();
  setRuntimeServerConfig({ gateway_base_url: BASE_URL, auth_base_url: null });
  resetHarnessAudio();
  resetHarnessDocumentPicker();
});

afterEach(() => {
  restoreCrypto?.();
  restoreCrypto = null;
  (globalThis as { fetch: typeof fetch }).fetch = realFetch;
  resetRouting();
  clearSessionCache();
  __resetSharedMobileStoreForTests();
  __resetLastTabStorageForTests();
});

afterAll(() => {
  resetRouting();
  __resetServerConfigForTests();
  resetHarnessGlobals();
});

type Screen = Awaited<ReturnType<typeof mountScreen>>;

function control(host: HTMLElement, label: string): HTMLElement {
  const el = Array.from(host.querySelectorAll('*')).find(
    (node) => node.getAttribute('aria-label') === label,
  ) as HTMLElement | undefined;
  if (el === undefined) throw new Error(`no control labelled "${label}" is in the tree`);
  return el;
}

/** Mount the real shell on `platform`, opened on the home project's Chat tab. */
async function mountShell(platform: PlatformName): Promise<Screen> {
  setHarnessPlatform(platform);
  installRouting({
    path: `/projects/${HOME_PROJECT}/chat`,
    routes: { index: ProjectIndexRedirect as never, chat: ProjectChatTab as never },
  });
  const screen = await mountScreen(
    createElement(
      AuthSessionProvider,
      { initialUser: OWNER },
      createElement(ProjectLayout, null),
    ),
  );
  // Let the shell's round trips (rail list, settings doc, tab set, usage) land,
  // opening every socket the tree connects as it appears.
  //
  // EVERY socket, not `FakeChatSocket.current()`. The whole shell opens several
  // — the rail's live feed, the activity feed, the transcript warmer — and which
  // one is `opened[0]` is an accident of effect ordering. Opening only the first
  // leaves the CHAT socket closed, and a send then sits in the queue forever,
  // which reads as "the owner cannot send" when the truth is "the test never
  // connected him".
  //
  // A FIXED number of fixed waits, not a poll: nothing here can outlast them,
  // because every request in flight is answered from a literal.
  const opened = new Set<unknown>();
  const openNewSockets = async (): Promise<void> => {
    for (const socket of FakeChatSocket.opened) {
      if (opened.has(socket)) continue;
      opened.add(socket);
      await act(async () => {
        socket.onopen?.();
      });
    }
  };
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
    });
    await screen.settle();
    await openNewSockets();
    await screen.settle();
  }
  return screen;
}

/** The interaction vocabulary the inventory's probes are written against. */
function probeFor(screen: Screen): Probe {
  return {
    press: (label) => screen.press(label),
    type: (value) => screen.type(value),
    has: (label) =>
      Array.from(screen.host.querySelectorAll('*')).some(
        (node) => node.getAttribute('aria-label') === label,
      ),
    text: () => screen.text(),
    // The mounted subtree FIRST, then the rest of the document — because
    // react-native-web renders `<Modal>` through a PORTAL outside the host, and
    // the new-project sheet is a Modal. Scoping to the host alone would report
    // an affordance the owner really has as missing. Safe against a stale hit:
    // every probe unmounts its shell, which takes its portals with it.
    byTestId: (testId) =>
      screen.byTestId(testId) ?? document.body.querySelector(`[data-testid="${testId}"]`),
    frames: (type) => {
      const all: Array<Record<string, unknown>> = [];
      for (const socket of FakeChatSocket.opened) all.push(...socket.framesOfType(type));
      return all;
    },
    audio: () => {
      const a = harnessAudioState();
      return { record_calls: a.record_calls, stop_calls: a.stop_calls, recording: a.recording };
    },
    pickerCalls: () => harnessDocumentPickerCalls(),
    path: () => currentRouterPath(),
    marks: {},
    async hold(label, opts = {}): Promise<void> {
      // `press()` fires down, up and click inside ONE act(), so the gesture is
      // over before the recogniser has classified it and `onLongPress` never
      // runs. A hold has to be separate events with real time between them.
      const target = control(screen.host, label);
      await act(async () => {
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 0, clientY: 0 }));
      });
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, opts.ms ?? 600));
      });
      const drift = opts.drift_px ?? 0;
      if (drift !== 0) {
        // Two moves: the composer takes the FIRST as the origin travel is
        // measured from, exactly as a finger produces them. `pageX` goes on the
        // DOM event because React hands that object through as `nativeEvent`,
        // which is where the composer reads the coordinate.
        for (const x of [0, drift]) {
          await act(async () => {
            const ev = new Event('touchmove', { bubbles: true });
            Object.defineProperty(ev, 'pageX', { value: x });
            target.dispatchEvent(ev);
          });
        }
        await screen.settle();
      }
      opts.whileHeld?.();
      await act(async () => {
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await screen.settle();
    },
  };
}

/**
 * One affordance, on a FRESH shell.
 *
 * Fresh on purpose. Most of these probes change the world they run in — a
 * recording replaces the composer with an overlay, a tab tap changes the route,
 * a drawer covers the screen — so sharing one mount would make every result
 * depend on the order of the list above it. That is the standing invitation to
 * intermittency, and an intermittent gate gets muted, and a muted gate protects
 * nothing. A shell mount is cheap; a flake is not.
 *
 * A THROWN probe is a FAILED probe, not an error: "no control labelled X is in
 * the tree" is precisely the affordance being unreachable, and the owner is owed
 * the sentence rather than the stack. THE MOUNT IS INSIDE THAT NET TOO — a shell
 * that cannot render is the largest possible reachability failure, and it should
 * print eleven owner sentences ("the app does not come up"), not one stack trace
 * from a helper.
 */
async function probe(platform: PlatformName, affordance: OwnerAffordance): Promise<boolean> {
  let screen: Screen | null = null;
  try {
    screen = await mountShell(platform);
    const p = probeFor(screen);
    await affordance.exercise(p);
    await screen.settle();
    return affordance.landed(p);
  } catch {
    return false;
  } finally {
    try {
      screen?.unmount();
    } catch {
      /* a tree that failed to render can fail to tear down; the next probe
         mounts its own host either way */
    }
  }
}

/** Is this affordance expected to be absent here, on purpose? */
function deliberatelyAbsent(a: OwnerAffordance, platform: PlatformName): boolean {
  return (a.absentOn ?? []).some((x) => x.platform === platform);
}

// One run per platform, reused by the parity gate below.
const results: Partial<Record<PlatformName, Record<string, boolean>>> = {};

describe('reachability — the owner’s phone, on every platform we ship', () => {
  for (const platform of Object.keys(PLATFORMS) as PlatformName[]) {
    it(
      `the owner can still do everything on ${platform}`,
      async () => {
        const reached: Record<string, boolean> = {};
        for (const affordance of OWNER_AFFORDANCES) {
          reached[affordance.id] = await probe(platform, affordance);
        }
        results[platform] = reached;

        const lost = OWNER_AFFORDANCES.filter(
          (a) => !deliberatelyAbsent(a, platform) && reached[a.id] !== true,
        );
        // The failure text is the OWNER's sentence, not the assertion's. It is
        // the asserted VALUE rather than a message argument so it lands in the
        // diff of any runner — and so a green run prints nothing at all.
        const report =
          lost.length === 0
            ? ''
            : [
                `On ${platform}, the owner can no longer do this:`,
                ...lost.map((a) => `  • ${a.broken}`),
              ].join('\n');
        expect(report).toBe('');
      },
      120_000,
    );
  }

  it('no capability quietly disappears between platforms', () => {
    const platforms = Object.keys(PLATFORMS) as PlatformName[];
    for (const pl of platforms) {
      if (results[pl] === undefined) throw new Error(`platform ${pl} never probed`);
    }
    // An affordance the owner has on one phone and not the other, with no
    // written reason, is the usage-meter failure recurring under another name.
    const drifted = OWNER_AFFORDANCES.filter((a) => {
      const on = platforms.filter((pl) => results[pl]![a.id] === true);
      const off = platforms.filter(
        (pl) => results[pl]![a.id] !== true && !deliberatelyAbsent(a, pl),
      );
      return on.length > 0 && off.length > 0;
    });
    const report =
      drifted.length === 0
        ? ''
        : [
            'These work on some phones and not others, with no reason recorded in the inventory:',
            ...drifted.map(
              (a) =>
                `  • ${a.broken}\n    reachable on: ${platforms
                  .filter((pl) => results[pl]![a.id] === true)
                  .join(', ')} — missing on: ${platforms
                  .filter((pl) => results[pl]![a.id] !== true && !deliberatelyAbsent(a, pl))
                  .join(', ')}`,
            ),
          ].join('\n');
    expect(report).toBe('');
  });
});
