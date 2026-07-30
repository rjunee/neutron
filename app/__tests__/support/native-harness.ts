/**
 * @neutronai/app — THE DEVICE-SHAPED TEST HARNESS.
 *
 * WHY IT EXISTS. Until this file, the app's bun:test suite could not mount a
 * single React Native component — the convention note at the top of
 * `comments-side-pane.test.tsx` says so explicitly: *"the Neutron app's bun:test
 * suite does NOT mount React Native components"*. So the whole of the app's
 * REACT WIRING was untested: only pure helpers and HTTP clients were covered.
 *
 * That gap is not academic. Mobile chat shipped, passed unit tests, typecheck and
 * lint, and had never delivered one message from a phone: `SendQueue`'s default
 * id generator called `crypto.randomUUID()`, which does not exist on the device
 * runtime, so `enqueue()` threw before writing the optimistic row and the
 * rejection was swallowed by a `void`. Nothing in a pure-helper suite can see
 * that. Something that presses the real Send button can.
 *
 * WHAT IT DOES. Runs the real component tree in-process under Bun:
 *   - `react-native` resolves to `react-native-web`, so RN primitives render to
 *     DOM nodes that a test can query and click;
 *   - `Platform.OS` is settable, so iOS-only branches actually execute;
 *   - the expo native modules the chat surface imports are replaced by inert
 *     stubs (they have no JS-only implementation);
 *   - `globalThis.crypto` is REMOVABLE, so a test can reproduce the device's
 *     missing WebCrypto — the single most valuable thing this harness can do,
 *     because it is the difference this bug lived in.
 *
 * WHAT IT IS NOT. Not a device, not a simulator. It cannot see a native layout,
 * a real keyboard, a gesture, Hermes-specific behaviour, or anything in the
 * native binary. `docs/SYSTEM-OVERVIEW.md` § Mobile test harness states the
 * boundary; treat anything visual as UNVERIFIED until it runs on a phone.
 *
 * USAGE — call `installNativeHarness()` at the TOP of the test file, then load
 * the modules under test with `await import(...)`. The aliases only apply to
 * imports evaluated after the call, which is why the imports must be dynamic:
 *
 *   import { installNativeHarness } from './support/native-harness';
 *   installNativeHarness();
 *   const { ChatSyncSurface } = await import('../components/ChatSyncSurface');
 *
 * Bun runs several test FILES per process, and both the DOM registration and the
 * module aliases are process-global and irreversible — which is why this is opt-in
 * per file rather than a `bunfig.toml` preload. The one real hazard there is other
 * tests' `mock.module('react-native', …)` fakes; see the import-rewrite comment in
 * `installNativeHarness` for why the harness does not fight them for the specifier.
 * `native-harness-selfcheck.test.tsx` asserts the harness is not silently degraded.
 */

import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { plugin } from 'bun';

const STUBS = `${import.meta.dir}/stubs`;

/**
 * Module aliases. `named` re-exports the stub's named exports; `both` also
 * forwards a default (Bun rejects `export *` next to `export { default }`, hence
 * the two shapes).
 */
const ALIASES: ReadonlyArray<readonly [RegExp, string, 'named' | 'both']> = [
  // The whole point: RN primitives that render to DOM.
  [/[\\/]react-native[\\/]index\.js$/, `${STUBS}/react-native.ts`, 'both'],
  [pkg('@react-native-async-storage/async-storage'), `${STUBS}/async-storage.ts`, 'both'],
  // Expo modules with no JS-only implementation. Inert stubs, not fakes with
  // behaviour — a test that needs one of these to DO something should inject its
  // own double rather than grow the stub.
  [pkg('expo-router'), `${STUBS}/expo-router.tsx`, 'named'],
  [pkg('expo-notifications'), `${STUBS}/expo-notifications.ts`, 'named'],
  [pkg('expo-document-picker'), `${STUBS}/expo-document-picker.ts`, 'named'],
  [pkg('expo-constants'), `${STUBS}/expo-constants.ts`, 'both'],
  [pkg('expo-file-system'), `${STUBS}/expo-file-system.ts`, 'named'],
  [pkg('expo-web-browser'), `${STUBS}/expo-web-browser.ts`, 'named'],
  [pkg('expo-sharing'), `${STUBS}/expo-sharing.ts`, 'named'],
  // FlashList v2 is native-only; the stub renders every row so assertions can
  // see the transcript. It deliberately does NOT virtualise.
  [pkg('@shopify/flash-list'), `${STUBS}/flash-list.tsx`, 'named'],
];

/** Match every file inside a node_modules package (so a package's internal
 *  requires are aliased too, not just its entry point). */
function pkg(name: string): RegExp {
  return new RegExp(`[\\\\/]node_modules[\\\\/]${name.replace('/', '[\\\\/]')}[\\\\/]`);
}

let installed = false;

/** Idempotent. Safe to call from every harness test file. */
export function installNativeHarness(): void {
  if (installed) return;
  installed = true;

  if ((globalThis as { document?: unknown }).document === undefined) {
    registerDomKeepingBunNetworking();
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Metro defines this; without it expo-modules-core's environment probe throws.
  (globalThis as { __DEV__?: boolean }).__DEV__ = false;
  installExpoGlobal();
  installLayoutMetrics();

  plugin({
    name: 'neutron-native-harness',
    setup(build) {
      for (const [filter, target, shape] of ALIASES) {
        const spec = JSON.stringify(target);
        const contents =
          shape === 'both'
            ? `import d from ${spec};\nexport * from ${spec};\nexport default d;\n`
            : `export * from ${spec};\n`;
        build.onLoad({ filter }, () => ({ contents, loader: 'ts' }));
      }

      // THE APP'S OWN `react-native` IMPORTS ARE REWRITTEN AT THE SOURCE, not
      // resolved through the module registry.
      //
      // Four existing app tests own the `react-native` specifier with
      // `mock.module('react-native', () => ({ View, Text, … }))` — a hand-written
      // three-export fake. Bun module mocks are PROCESS-GLOBAL and permanent, and
      // Bun runs many test FILES per process, so whichever of those loads first
      // replaces `react-native` for everything after it. A real component tree
      // then fails to link on the first export the fake omits (`AppState` was the
      // one that caught this), and which files share a process depends on chunking
      // — i.e. the harness would be order-dependently flaky, the worst possible
      // property for the gate that is supposed to catch device bugs.
      //
      // A module mock outranks an `onLoad` alias, so the alias above cannot win
      // that fight. Rewriting the IMPORT SPECIFIER inside the app's own sources
      // sidesteps the contest entirely: this graph never asks the registry for
      // `react-native`, so it cannot be handed someone else's fake, and those four
      // tests keep the fake they want. Scoped to app source files (never
      // node_modules, never these stubs) and to import/export statements only.
      build.onLoad({ filter: /[\\/]app[\\/](app|components|lib|features)[\\/].*\.tsx?$/ }, async (args) => {
        const source = await Bun.file(args.path).text();
        const rewritten = source.replace(
          /(\bfrom\s*)(['"])react-native\2/g,
          (_m, from: string, quote: string) => `${from}${quote}${STUBS}/react-native.ts${quote}`,
        );
        return { contents: rewritten, loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts' };
      });
    },
  });

}

/**
 * Bun globals that happy-dom replaces and that OTHER packages' tests depend on
 * being Bun's own.
 *
 * `GlobalRegistrator.register()` installs a whole browser environment, including
 * its own `fetch` / `Response` / `Request` / `Headers` / `WebSocket`. Those are
 * process-global and Bun runs ~100 test FILES per process, so registering them
 * reaches straight into every gateway/open test that boots a `Bun.serve` — a
 * handler returning a happy-dom `Response` fails Bun's `Expected a Response
 * object` check, and a happy-dom `fetch` at a loopback server gives ECONNREFUSED.
 * On the first CI run of this harness that collateral was 68 unrelated failures
 * across three shards.
 *
 * The DOM is what this harness needs; the network stack is not. So the natives are
 * captured first and put back immediately after registration. react-dom and
 * react-native-web touch none of them.
 */
const BUN_NATIVE_GLOBALS = [
  'fetch',
  'Response',
  'Request',
  'Headers',
  'FormData',
  'Blob',
  'File',
  'WebSocket',
  'URL',
  'URLSearchParams',
  'AbortController',
  'AbortSignal',
  'ReadableStream',
  'WritableStream',
  'TransformStream',
  'TextEncoder',
  'TextDecoder',
  'crypto',
] as const;

function registerDomKeepingBunNetworking(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const natives = new Map<string, unknown>();
  for (const name of BUN_NATIVE_GLOBALS) {
    if (name in g) natives.set(name, g[name]);
  }

  GlobalRegistrator.register({ url: 'http://localhost/' });

  for (const [name, value] of natives) {
    Object.defineProperty(g, name, { value, configurable: true, writable: true });
  }
}

/**
 * `globalThis.expo` — the JSI bridge expo-modules-core reads at import time.
 * Unknown native modules resolve to an inert proxy whose every method is a
 * no-op, so importing an expo package never explodes; a test that actually
 * depends on native behaviour must stub that package instead.
 */
function installExpoGlobal(): void {
  class HarnessEventEmitter {
    addListener(): { remove: () => void } {
      return { remove: (): void => undefined };
    }
    removeListener(): void {}
    removeAllListeners(): void {}
    emit(): void {}
    listenerCount(): number {
      return 0;
    }
  }
  const inert = (name: string): unknown =>
    new Proxy(new HarnessEventEmitter() as unknown as Record<string | symbol, unknown>, {
      get: (target, key) => {
        if (key in target) return target[key];
        if (key === 'name') return name;
        return () => undefined;
      },
    });

  (globalThis as { expo?: unknown }).expo = {
    EventEmitter: HarnessEventEmitter,
    NativeModule: HarnessEventEmitter,
    SharedObject: HarnessEventEmitter,
    SharedRef: HarnessEventEmitter,
    modules: new Proxy({} as Record<string, unknown>, {
      get: (target, key: string) => {
        if (!(key in target)) target[key] = inert(key);
        return target[key];
      },
      has: () => true,
    }),
    uuidv4: () => 'harness-uuid',
    uuidv5: () => 'harness-uuid',
    getViewConfig: () => ({}),
    reloadAppAsync: async () => undefined,
  };
}

/** A viewport the layout assertions can reason about. iPhone-15-ish logical points. */
export const HARNESS_SCREEN_HEIGHT = 852;
export const HARNESS_SCREEN_WIDTH = 393;

/**
 * happy-dom reports every element as a 0×0 box, which makes
 * `View.measureInWindow` (react-native-web routes it through
 * `getBoundingClientRect`) useless — and measurement is exactly what the
 * keyboard-inset fix depends on. Report the full viewport instead, so a
 * full-height surface measures as reaching the bottom of the screen the way it
 * does on a device.
 *
 * This is a LAYOUT FICTION, and a deliberately crude one: every element gets the
 * same rect. It is enough to assert "the surface is padded away from the keyboard
 * by the overlap it measured", and not nearly enough to assert anything about
 * real visual layout.
 */
let realGetBoundingClientRect: unknown = null;

function installLayoutMetrics(): void {
  const proto = (globalThis as unknown as { Element?: { prototype: Record<string, unknown> } })
    .Element;
  if (proto === undefined) return;
  realGetBoundingClientRect = proto.prototype['getBoundingClientRect'];
  proto.prototype['getBoundingClientRect'] = function getBoundingClientRect(): DOMRect {
    return {
      x: 0,
      y: 0,
      width: HARNESS_SCREEN_WIDTH,
      height: HARNESS_SCREEN_HEIGHT,
      top: 0,
      left: 0,
      right: HARNESS_SCREEN_WIDTH,
      bottom: HARNESS_SCREEN_HEIGHT,
      toJSON: () => ({}),
    } as DOMRect;
  };
}

/**
 * Pretend to be a phone for the duration of a test file. `Platform.OS` is read
 * through this global by `stubs/react-native.ts`, so an `ios`-only branch in the
 * source under test actually runs.
 */
export function setHarnessPlatform(os: 'ios' | 'android' | 'web'): void {
  (globalThis as { __HARNESS_OS__?: string }).__HARNESS_OS__ = os;
}

/**
 * Remove `globalThis.crypto` — the device runtime's actual shape (React Native
 * 0.81 installs no WebCrypto and Expo SDK 54's WinterCG shim stops at
 * `TextDecoder`/`URL`/`structuredClone`). Returns the restore function.
 *
 * This is the single most load-bearing capability in the harness: under Bun,
 * WebCrypto exists, and the bug that broke every mobile send was invisible for
 * exactly that reason.
 */
export function withoutWebCrypto(): () => void {
  const real = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', {
    value: undefined,
    configurable: true,
    writable: true,
  });
  return () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: real,
      configurable: true,
      writable: true,
    });
  };
}

/**
 * Undo the process-global side effects a harness file must not leave behind.
 *
 * CALL THIS IN `afterAll` OF EVERY HARNESS SUITE. Bun runs ~100 test FILES per
 * process and the chunk composition is not stable, so anything left installed
 * here lands in whatever runs next. The first CI run of this harness proved that
 * the expensive way: 68 failures across three shards in unrelated packages,
 * because the faked layout rect and the `FakeChatSocket` global were still in
 * place when gateway/open tests booted real `Bun.serve` instances.
 *
 * The DOM registration itself is deliberately NOT undone: unregistering after
 * react-native-web has already captured browser globals would break the harness
 * files still to run in this process, and a merely-present `document` is a
 * condition the suite already tolerates (`landing`'s tests register happy-dom the
 * same way). The Bun-native network stack is restored at registration time — see
 * {@link registerDomKeepingBunNetworking}.
 */
export function resetHarnessGlobals(): void {
  const proto = (globalThis as unknown as { Element?: { prototype: Record<string, unknown> } })
    .Element;
  if (proto !== undefined && realGetBoundingClientRect !== null) {
    proto.prototype['getBoundingClientRect'] = realGetBoundingClientRect;
  }
  // Hand the real WebSocket back — a live `Bun.serve` WS test in the next file
  // otherwise connects to a recorder that never opens, and simply times out.
  if (realWebSocket !== null) {
    Object.defineProperty(globalThis, 'WebSocket', {
      value: realWebSocket,
      configurable: true,
      writable: true,
    });
  }
  setHarnessPlatform('web');
}

/** Bun's own `WebSocket`, captured before any test swaps in a recorder. */
let realWebSocket: unknown = null;

/** Called by `FakeChatSocket.install()` so the real constructor can be restored. */
export function rememberRealWebSocket(): void {
  if (realWebSocket === null) {
    realWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket ?? null;
  }
}
