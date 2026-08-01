/**
 * THE REACHABILITY GATE, MOBILE HALF — WHAT THE OWNER MUST BE ABLE TO DO ON HIS
 * PHONE.
 *
 * THE CLASS OF BUG THIS EXISTS FOR — and it is not "does the part work".
 * ---------------------------------------------------------------------------
 * Voice messages shipped as five green modules and zero reachable feature. The
 * recorder worked. The overlay worked. The upload worked. The gesture arithmetic
 * had its own test file. And `ChatSyncSurface` rendered `<InputComposer>`
 * WITHOUT its four `onVoice*` props, so the mic rendered perfectly, pressed
 * perfectly, and answered "Voice messages are not available yet."
 *
 * That is the shape: **a control that renders correctly and does nothing,
 * because its host forgot to hand it a handler.** Presence is not reachability.
 * A probe that only asks "is the mic in the tree?" passes on the broken build —
 * the mic WAS in the tree, it was beautiful, and it was dead.
 *
 * So every entry here PRESSES the control the way a thumb does and then demands
 * that something REAL happened at the far end: a microphone that actually
 * opened, a frame that actually left the socket, a file picker that actually
 * ran, a route that actually changed. An absent handler cannot fake any of
 * those.
 *
 * THE WEB HALF is `landing/chat-react/__tests__/reachability-inventory.ts`; the
 * server half is `open/__tests__/reachability-inventory.ts`. Same idea, three
 * seams. All three are described together in `docs/SYSTEM-OVERVIEW.md`
 * § Reachability gate.
 *
 * WRITING A `broken:` SENTENCE. It is read by the owner, not by whoever wrote
 * the code. Say what they can no longer DO. "You cannot send a voice message —
 * the mic button no longer reaches the recorder" — not "record_calls was 0".
 */

/**
 * The platforms the product actually ships (`app/app.json` → `expo.platforms`).
 * EVERY affordance is probed on BOTH, because a platform no test ever renders is
 * a platform where anything can be missing and nothing notices.
 *
 * WHY PLATFORM AND NOT WIDTH — the honest answer, verified rather than assumed.
 * The web gate's second axis is layout width, because `ProjectShell` genuinely
 * ships two of them. The mobile app does not. Every width branch in the app is
 * `Platform.OS === 'web' && width > BREAKPOINTS.narrow_max`
 * (`app/projects/[id]/_layout.tsx:417`, `components/ProjectTabBar.tsx:80`,
 * `ProjectSettingsDrawer.tsx:263`, `CommentsSidePane.tsx:143`,
 * `FocusList.tsx:97`, `ReminderList.tsx:81`, `TaskList.tsx:65`) — and `web` is
 * not a shipped platform, so on a phone or a tablet the app renders ONE layout
 * at every size. A width matrix here would be two identical runs wearing a
 * matrix's clothes, which is worse than no matrix: it reads as coverage.
 *
 * What the app DOES branch on is the platform (`use-keyboard-inset.ts:127`,
 * `ActivityInspectorDrawer.tsx:371`, `ProjectSettingsDrawer.tsx:329`), so that
 * is the axis, and parity across it is enforced exactly the way the web gate
 * enforces parity across widths.
 *
 * This is not a judgement anyone has to remember: `reachability-inventory-
 * complete.test.ts` re-derives it from the source on every run and reds the
 * moment a width branch appears that ISN'T web-gated — i.e. the day the app
 * grows a real tablet layout, the gate demands the width axis back.
 */
export const PLATFORMS = {
  ios: { name: 'ios' },
  android: { name: 'android' },
} as const;

export type PlatformName = keyof typeof PLATFORMS;

/**
 * What a probe is allowed to touch. Deliberately narrow: the affordances act
 * through the SAME surfaces a thumb does (press a control by its accessibility
 * label, type into the composer) and read effects only from places the owner's
 * action really lands — the wire, the microphone, the OS picker, the router.
 *
 * Nothing here can block indefinitely. `press`/`hold`/`type` throw when the
 * control is absent rather than waiting for it, every wait is a fixed number of
 * fixed-length ticks, and there is no polling loop anywhere in the gate. A gate
 * whose failure mode is a hang is worse than no gate.
 */
export interface Probe {
  /** Press a control by its `accessibilityLabel`. Throws when it is not there. */
  press: (accessibilityLabel: string) => Promise<void>;
  /**
   * Hold a control for real wall-clock, optionally sliding away from it before
   * release. `press` fires down/up/click inside one `act()`, so the gesture is
   * over before the recogniser has classified it and `onLongPress` never runs —
   * a hold has to be separate events with real time between them.
   */
  hold: (
    accessibilityLabel: string,
    opts?: {
      ms?: number;
      drift_px?: number;
      /** Run while the finger is still down, after any slide. The only way to
       *  observe a state that exists only mid-gesture. */
      whileHeld?: () => void;
    },
  ) => Promise<void>;
  /** Type into the composer the way a keyboard does. */
  type: (value: string) => Promise<void>;
  /** Is a control with this label in the tree at all? */
  has: (accessibilityLabel: string) => boolean;
  /** All visible text. */
  text: () => string;
  byTestId: (testId: string) => unknown;
  /** Frames of this type that the client actually put on the socket. */
  frames: (type: string) => ReadonlyArray<Record<string, unknown>>;
  /** What the microphone saw. */
  audio: () => { record_calls: number; stop_calls: number; recording: boolean };
  /** How many times the OS document picker was opened. */
  pickerCalls: () => number;
  /** Where the router is now. */
  path: () => string;
  /** Scratch space for an `exercise` to record something only observable
   *  MID-gesture, for its `landed` to assert on afterwards. */
  marks: Record<string, unknown>;
}

export interface OwnerAffordance {
  readonly id: string;
  /** What the owner does with it. */
  readonly can: string;
  /** The sentence printed when it stops being true. */
  readonly broken: string;
  /**
   * The composer callbacks this probe puts through their paces, by prop name.
   *
   * Read by `reachability-inventory-complete.test.ts`: every OPTIONAL callback
   * `InputComposer` accepts must appear here or in {@link COMPOSER_HANDLER_EXCLUSIONS},
   * because an optional callback a host forgets is precisely the voice defect.
   */
  readonly handlers?: readonly string[];
  /** Do the thing, the way a thumb does it. */
  readonly exercise: (p: Probe) => Promise<void>;
  /** Did that press reach something real? */
  readonly landed: (p: Probe) => boolean;
  /**
   * Platforms where this is deliberately absent, WITH the reason. The default
   * expectation is that the owner can do the same things on both phones, and an
   * exception has to be argued for in writing — the parity check reads this
   * field, and an affordance that vanishes from a platform without an entry here
   * fails the gate.
   */
  readonly absentOn?: ReadonlyArray<{ readonly platform: PlatformName; readonly why: string }>;
}

/** The wording the composer shows when the mic has no handlers — the exact
 *  sentence the broken build printed at every press. Duplicated as a literal on
 *  purpose: importing it from the component would let a rename hide the
 *  regression by making both sides agree. */
const VOICE_UNAVAILABLE = 'Voice messages are not available yet.';

/** A second project in the owner's rail, so "switch projects" has somewhere to
 *  go. Matches the fixture the test file serves. */
export const OTHER_PROJECT = 'orchard';
/** The tab the tab probe navigates to — present, and not the one it starts on. */
export const OTHER_TAB = { label: 'Documents', leaf: 'docs' } as const;

export const OWNER_AFFORDANCES: readonly OwnerAffordance[] = [
  {
    id: 'compose',
    can: 'Type a message',
    broken: 'You cannot type a message — the composer does not take input on this phone.',
    exercise: async (p) => {
      await p.type('reachability');
    },
    // The send control only exists once there is a draft, so its arrival proves
    // the field took the keystrokes AND the composer re-rendered on them. A
    // field that renders and swallows input fails here; a presence check on the
    // textarea would not.
    landed: (p) => p.has('Send'),
  },
  {
    id: 'send',
    can: 'Send a message',
    broken: 'You cannot send a message — pressing Send puts nothing on the wire.',
    exercise: async (p) => {
      await p.type('reachability');
      await p.press('Send');
    },
    // THE WIRE, not the button's disabled state. "Send looks pressable" has
    // passed on builds that delivered nothing.
    landed: (p) => p.frames('user_message').some((f) => f['body'] === 'reachability'),
  },
  {
    id: 'voice-tap',
    can: 'Start a voice message by tapping the mic',
    // THE ONE THAT SHIPPED BROKEN. The mic rendered, took the press, and told
    // the owner the feature did not exist — because `ChatSyncSurface` mounted
    // `<InputComposer>` without its `onVoice*` props. Both halves of this probe
    // matter: the microphone must actually open, AND the composer's unwired
    // notice must NOT appear, which is the exact text the broken build showed.
    broken:
      'You cannot record a voice message — the mic button no longer reaches the recorder, so pressing it does nothing (or says voice messages are not available).',
    handlers: ['onVoicePressIn', 'onVoiceTap'],
    exercise: async (p) => {
      await p.press('Record voice message');
    },
    landed: (p) => p.audio().record_calls > 0 && !p.text().includes(VOICE_UNAVAILABLE),
  },
  {
    id: 'voice-hold',
    can: 'Hold the mic to record, and slide away to throw the recording out',
    broken:
      'You cannot use hold-to-talk — holding the mic no longer reaches the recorder, and sliding away no longer cancels (a hold can leave the microphone running).',
    handlers: ['onVoiceHoldStart', 'onVoiceHoldMove', 'onVoiceHoldEnd'],
    exercise: async (p) => {
      await p.hold('Record voice message', {
        ms: 600,
        drift_px: 400,
        // Only observable WHILE the finger is down. The overlay's hint is how
        // the RECORDER says it understood the slide, and it is driven by
        // `onVoiceHoldMove` → `voice.updateDrag`. The mic button recolours
        // itself from its own local state either way, so the button is not
        // evidence and the hint is.
        whileHeld: () => {
          p.marks['cancel_hint'] = p.text().includes('Release to cancel');
        },
      });
    },
    landed: (p) =>
      p.marks['cancel_hint'] === true &&
      // The release reached `onVoiceHoldEnd('cancel')` → `voice.cancel()`. A
      // host that dropped this handler leaves the microphone hot after the
      // finger has gone, which is the worst outcome in this whole file.
      p.audio().stop_calls > 0 &&
      !p.audio().recording,
  },
  {
    id: 'attach',
    can: 'Attach a file to a message',
    broken: 'You cannot attach a file — the + button no longer opens the picker.',
    handlers: ['pickAttachments'],
    exercise: async (p) => {
      await p.press('Add attachment');
    },
    // The OS picker RAN. A + that renders and opens nothing is the voice defect
    // wearing a different control.
    landed: (p) => p.pickerCalls() > 0,
  },
  {
    id: 'projects',
    can: 'Switch to another project',
    broken: 'You cannot switch projects — tapping a project in the rail goes nowhere.',
    exercise: async (p) => {
      await p.press(`Open ${OTHER_PROJECT}`);
    },
    landed: (p) => p.path().includes(`/projects/${OTHER_PROJECT}`),
  },
  {
    id: 'create-project',
    can: 'Make a new project',
    broken:
      'You cannot create a project — the rail’s + button no longer opens the new-project sheet, and it is the only way to make one on a phone.',
    exercise: async (p) => {
      await p.press('New project');
    },
    landed: (p) => p.byTestId('create-project-sheet') !== null,
  },
  {
    id: 'tabs',
    can: 'Move between the tabs of a project',
    broken: 'You cannot move between tabs — tapping a tab does not change what is on screen.',
    exercise: async (p) => {
      await p.press(`${OTHER_TAB.label} tab`);
    },
    landed: (p) => p.path().endsWith(`/${OTHER_TAB.leaf}`),
  },
  {
    id: 'project-settings',
    can: 'Open a project’s settings',
    broken: 'You cannot open project settings — the header’s settings control opens nothing.',
    exercise: async (p) => {
      await p.press('Open project settings');
    },
    landed: (p) => p.byTestId('project-drawer-panel') !== null,
  },
  {
    id: 'app-settings',
    can: 'Reach app settings, Admin and sign-out',
    broken:
      'You cannot reach app settings — the header’s app entry navigates nowhere, and it is the only door to the server editor, Admin and sign out (#385).',
    exercise: async (p) => {
      await p.press('Open app settings');
    },
    landed: (p) => p.path() === '/settings',
  },
  {
    id: 'usage',
    can: 'See how much of the usage window is left',
    // The meter's ROOT renders unconditionally — it is the seam the tab band
    // always drew — and its "unknown" default is the plain hairline, i.e. it
    // looks deliberate. So the probe demands a MEASURED fill, which is the thing
    // that disappears when a host stops passing `usage`. Exactly the web
    // failure, on the other client.
    broken:
      'You cannot see how much of your usage window is left — the meter is drawing a blank hairline even though the server reported a reading.',
    exercise: async () => {
      /* a reading, not an action — the gateway already answered */
    },
    landed: (p) => p.byTestId('usage-meter-session-fill') !== null,
  },
];

/**
 * Optional `InputComposer` callbacks that NO probe exercises, and why.
 *
 * An exclusion is a decision with a cost, and it has to be written down like
 * one. `reachability-inventory-complete.test.ts` reads the composer's real props
 * and fails when a callback is neither in an affordance's `handlers` nor here —
 * so the next optional callback cannot ship the way `onVoiceTap` did.
 */
export const COMPOSER_HANDLER_EXCLUSIONS: ReadonlyArray<{
  readonly handler: string;
  readonly why: string;
}> = [
  {
    handler: 'onFilesPicked',
    why: 'Web-only on this client: the composer only ever fires it from the `isWeb` branches — the hidden file input, the document paste listener and the drop target (`InputComposer.tsx:595`, `:665`, `:838`) — and `ChatSyncSurface` only wires it under `isWeb` (`ChatSyncSurface.tsx:334`). The shipped mobile artifact is ios/android (`app/app.json`), so no thumb can reach this path and a probe for it would assert against a surface the owner does not have. The native attach path IS probed, through `pickAttachments`.',
  },
];

/**
 * Width branches that are NOT gated on `Platform.OS === 'web'` — i.e. code that
 * really does render differently on a big phone or a tablet — with the reason
 * each one is outside this gate.
 *
 * The completeness gate re-derives this list from the source. An unaccounted one
 * appearing means the app grew a genuine native layout and the reachability
 * matrix needs a width axis; that is a decision, and this is where it gets made.
 */
export const NATIVE_WIDTH_BRANCHES: ReadonlyArray<{
  readonly file: string;
  readonly why: string;
}> = [
  {
    file: 'app/projects/[id]/backups.tsx',
    why: 'A two-pane split on the backups-and-restore sub-route, reached from inside the project settings drawer rather than from the owner’s daily path, and it changes the ARRANGEMENT of panes rather than whether any affordance exists — nothing can be lost at one width and present at another. It is the only native width branch in the app; the affordances probed here all live in the shell, which has none.',
  },
];
