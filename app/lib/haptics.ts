/**
 * @neutronai/app — the app's haptic vocabulary.
 *
 * Owner request: *"a very subtle haptic vibration when tapping to switch projects,
 * and also when doing a voice note when the recording starts and when it stops."*
 *
 * WHY A WRAPPER RATHER THAN CALLING `expo-haptics` AT EACH SITE.
 *
 * 1. **"Subtle" is a decision, not a per-call guess.** Three call sites reaching
 *    for `Haptics` independently is how one of them ends up on `Heavy` and the
 *    app starts feeling like a slot machine. The mapping from EVENT to feedback
 *    lives here, once, named for the event rather than the intensity.
 *
 * 2. **Haptics must never be able to break the thing they annotate.** They are
 *    unavailable on a simulator, on web, on a device with the setting off, and on
 *    hardware with no actuator — and `expo-haptics` rejects rather than no-ops in
 *    some of those. A rejected promise on the recording-start path would surface as
 *    a failed voice note, which is a far worse bug than a missing buzz. So every
 *    call here is fire-and-forget with the rejection swallowed: a haptic is the
 *    LEAST important thing happening in any turn it appears in.
 *
 * The two feedback kinds are chosen, not interchangeable:
 *
 *   - `selectionAsync` for switching projects. It is the platform's
 *     "selection changed" tick — the lightest thing either OS offers, and
 *     semantically exactly what a rail tap is. `impactAsync` here would be too
 *     much for something the owner does dozens of times an hour.
 *   - `impactAsync(Light)` for recording start/stop. A recording boundary is a
 *     STATE CHANGE the owner needs to feel without looking, since the whole point
 *     of a voice note is that his eyes are elsewhere. A selection tick is too
 *     faint to confirm "the mic is live"; Light is the smallest impact that reads
 *     as an event rather than a twitch.
 */

/**
 * RESOLVED LAZILY, and this is not a style preference.
 *
 * `expo-haptics` is a NATIVE module with no web/test implementation, so a top-level
 * import puts it in the module graph of everything that imports this file — the
 * project rail and the voice recorder. That broke every test which transitively
 * loads either of them (four CI shards, in chat-session suites that have nothing to
 * do with haptics), because the import itself throws before any test body runs.
 *
 * Requiring it inside the call keeps the graph clean at import time and folds
 * "module unavailable on this platform" into the same swallow that already handles
 * "device has no actuator". Not cached: a cached null would permanently disable
 * haptics for a process that merely loaded this file early, and the resolution is
 * cheap after the first one.
 */
interface HapticsModule {
  selectionAsync(): Promise<void>;
  impactAsync(style?: unknown): Promise<void>;
  /** Android-only: the platform's OWN named haptic primitives. */
  performAndroidHapticsAsync?(effect: unknown): Promise<void>;
  ImpactFeedbackStyle: { Light: unknown; Rigid?: unknown };
  AndroidHaptics?: { Context_Click?: unknown };
}

/**
 * Test override. Set to a stub to assert the mapping, `null` to simulate a platform
 * with no haptics, `undefined` to restore the real module.
 *
 * WHY A SEAM RATHER THAN `mock.module`. Bun's module mocks are PROCESS-WIDE and
 * persist for the rest of the run, and this file is imported by the rail and the
 * recorder — so mocking the specifier leaked into unrelated chat suites sharing the
 * shard and failed them (CI shard 2, passing in isolation, which is the signature).
 * An explicit override is scoped to the test that sets it and matches the
 * `__…ForTests` convention already used for the server config and mobile store.
 */
let override: HapticsModule | null | undefined;

export function __setHapticsModuleForTests(m: HapticsModule | null | undefined): void {
  override = m;
}

/**
 * Test override for the platform, alongside the module override below.
 *
 * The click mapping is per-platform, so a test that cannot choose a platform can
 * only ever exercise one branch — and on a non-harness test file `react-native` is
 * not resolvable at all, so that branch would be the `web` fallback. Steering it
 * through `Platform.OS` on the resolved module is not available there either. Hence a
 * seam, matching `__setHapticsModuleForTests` exactly.
 */
let platformOverride: string | undefined;

export function __setPlatformForTests(os: string | undefined): void {
  platformOverride = os;
}

/** The platform, resolved the same lazy way as the module itself. */
function platformOS(): string {
  if (platformOverride !== undefined) return platformOverride;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('react-native') as { Platform: { OS: string } }).Platform.OS;
  } catch {
    // Unresolvable means this is not a React Native runtime, which is the same
    // answer as web for every purpose here.
    return 'web';
  }
}

function load(): HapticsModule | null {
  if (override !== undefined) return override;
  try {
    // Haptics do not exist on web, and the mobile test harness IS react-native-web,
    // so the platform check is both honest and the reason the specifier below is
    // never resolved where it cannot work.
    //
    // `require`, NOT a top-level `import { Platform } from 'react-native'`. A static
    // ESM import of that specifier from this file broke the device-harness lane with
    // `TypeError: Requested module is already fetched` — thrown not here but inside
    // `last-tab-storage.ts:226`, which has ALWAYS resolved react-native by `require`.
    // The harness aliases the specifier for the whole process; once an ESM import has
    // fetched it, bun refuses the later synchronous require. So the rule is per-file
    // consistency with the rest of the app's lazy react-native access, and the cost of
    // breaking it lands in a DIFFERENT module, which is why it took three tries.
    if (platformOS() === 'web') return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-haptics') as HapticsModule;
  } catch {
    return null;
  }
}

/**
 * Run a haptic without ever letting it affect the caller.
 *
 * Deliberately not `async` and deliberately returns void: an `await` here would
 * put a hardware call on the critical path of a state transition, and a caller
 * that forgot the `await` would produce an unhandled rejection on exactly the
 * devices where haptics are unavailable.
 */
function fire(run: (h: HapticsModule) => Promise<void>): void {
  const h = load();
  if (h === null) return;
  try {
    void run(h).catch(() => undefined);
  } catch {
    // A synchronous throw (module unavailable on this platform) is as ignorable
    // as a rejection. Nothing about this feature is worth an error path.
  }
}

/**
 * Switching projects in the rail — a CLICK, not a buzz.
 *
 * Owner, on device, after the first version: *"is there a way you can change it to
 * feel more like a click than a buzz? like when I hold an app and swipe up in
 * android to open the app switcher, it does a haptic click… our project switcher is
 * a little more fuzzy."*
 *
 * He is describing a TRANSIENT — one sharp edge — and `selectionAsync` is the wrong
 * primitive for it. On Android `selectionAsync` falls back to a short vibration,
 * which has an attack and a decay: physically a buzz, however short. What the system
 * UI uses for the gesture he named is one of Android's own named haptic constants,
 * and those are rendered by the platform's haptic composition rather than by
 * amplitude over time — which is exactly why they read as a click.
 *
 * So the mapping is per-platform, because the platforms genuinely differ here:
 *
 *   - ANDROID: `performAndroidHapticsAsync(AndroidHaptics.Context_Click)` — the
 *     platform's own crisp click, the same primitive the system UI uses. Not
 *     `Gesture_End` despite the gesture he described: that constant is semantically
 *     "a gesture finished" and on many devices is a softer, longer effect. He asked
 *     for the FEEL, and `Context_Click` is the sharpest short transient Android
 *     exposes by name.
 *   - iOS: `impactAsync(Rigid)`. `Rigid` is the crisp end of the impact scale —
 *     `Light` and `Soft` are deliberately cushioned, which is the fuzziness he
 *     described. iOS has no `Context_Click` equivalent, and `selectionAsync` there
 *     is already a clean tick, but `Rigid` matches the Android choice more closely
 *     so the app feels like one app on both.
 *
 * Every step degrades: an older `expo-haptics` without `performAndroidHapticsAsync`,
 * or a device whose HAL lacks the constant, falls back through `Rigid` to
 * `selectionAsync` rather than doing nothing. A missing buzz is a worse outcome than
 * a slightly different buzz.
 */
export function hapticProjectSwitch(): void {
  fire(async (h) => {
    if (platformOS() === 'android') {
      const effect = h.AndroidHaptics?.Context_Click;
      if (h.performAndroidHapticsAsync !== undefined && effect !== undefined) {
        return h.performAndroidHapticsAsync(effect);
      }
    }
    if (h.ImpactFeedbackStyle.Rigid !== undefined) {
      return h.impactAsync(h.ImpactFeedbackStyle.Rigid);
    }
    return h.selectionAsync();
  });
}

/** A voice recording just went live — the mic is hot. */
export function hapticRecordingStarted(): void {
  fire((h) => h.impactAsync(h.ImpactFeedbackStyle.Light));
}

/** A voice recording just stopped — the clip is held for review. */
export function hapticRecordingStopped(): void {
  fire((h) => h.impactAsync(h.ImpactFeedbackStyle.Light));
}
