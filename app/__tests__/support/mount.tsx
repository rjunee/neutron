/**
 * @neutronai/app — the interaction vocabulary for the device-shaped harness.
 *
 * Mount a real screen, then act on it the way the owner does: type into the
 * composer, press a button by its accessibility label, read what the transcript
 * says. Assertions go through the SAME affordances a thumb uses, so a control
 * that renders but cannot be reached fails the test.
 *
 * Requires `installNativeHarness()` to have run first (see `native-harness.ts`).
 */

import { act, createElement, Fragment, type ReactElement } from 'react';

import { rememberRealWebSocket } from './native-harness';
import { ComposerDock, ComposerDockProvider } from '../../lib/composer-dock';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error react-dom ships no bundled types and @types/react-dom is not a
// dependency of this app; the harness only needs createRoot/unmount.
import { createRoot } from 'react-dom/client';

type Root = { render(el: unknown): void; unmount(): void };

export interface MountedScreen {
  /** The DOM subtree the screen rendered into. */
  host: HTMLElement;
  /** All visible text, for coarse assertions. */
  text(): string;
  /** The composer's text input. Throws when absent — an unreachable composer is
   *  a failure, not a skip. */
  composer(): HTMLTextAreaElement;
  /** Type into the composer exactly as a keyboard does (React-visible). */
  type(value: string): Promise<void>;
  /** Press a control by its `accessibilityLabel`. Throws when it is not there. */
  press(accessibilityLabel: string): Promise<void>;
  /** Find a node by `testID`. */
  byTestId(testId: string): HTMLElement | null;
  /** Let queued microtasks + effects settle. */
  settle(): Promise<void>;
  unmount(): void;
}

/**
 * THE SHELL'S COMPOSER DOCK, around whatever a test mounts.
 *
 * The chat composer does not render where the chat surface sits — it is
 * published into the project shell's full-width bottom band
 * (`lib/composer-dock.tsx`), so a surface mounted with no band in scope throws
 * by design. Every harness mount therefore gets the same two pieces the real
 * shell provides: the store, and the band BELOW the screen under test. Tests that
 * only press Send or read `composer-bar` need to know nothing about it; a test
 * that cares about the placement asserts against the `composer-dock` testID.
 */
function withComposerDock(element: ReactElement): ReactElement {
  return createElement(
    ComposerDockProvider,
    null,
    createElement(Fragment, null, element, createElement(ComposerDock)),
  );
}

/**
 * Mount and tear down in the SAME synchronous window, letting nothing settle.
 *
 * The opposite of {@link mountScreen}, and deliberately: a screen whose effect
 * awaits something (a native module load, a schema open) is disposed here BEFORE
 * that promise resolves. That is the real shape of a rail tap outrunning a
 * session construction, and it is not reachable through `mountScreen`, which
 * exists to wait for exactly what this has to interrupt.
 *
 * It lives in the harness rather than in a test file because `react-dom/client`
 * imported at a TEST FILE's top level leaks the registered happy-dom into the
 * next file in the process — measured: a sibling `uploadAttachment` test then
 * sniffs `typeof window !== 'undefined'`, takes the XMLHttpRequest branch, and
 * opens a real socket. This module already owns that import; nothing else should
 * acquire it.
 */
export function mountThenAbandon(element: ReactElement): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host) as Root;
  act(() => {
    root.render(withComposerDock(element));
  });
  act(() => {
    root.unmount();
  });
  host.remove();
}

export async function mountScreen(element: ReactElement): Promise<MountedScreen> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host) as Root;
  await act(async () => {
    root.render(withComposerDock(element));
  });

  const settle = async (): Promise<void> => {
    // Microtasks for promise chains, and a MACROTASK because
    // react-native-web's `measureInWindow` answers on `setTimeout(…, 0)` — a
    // microtask-only flush leaves every measurement callback unfired and any
    // layout assertion silently vacuous.
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
    }
  };
  await settle();

  const composer = (): HTMLTextAreaElement => {
    const el = host.querySelector('textarea');
    if (el === null) throw new Error('composer text input is not in the tree');
    return el as HTMLTextAreaElement;
  };

  return {
    host,
    text: () => host.textContent ?? '',
    composer,
    settle,
    async type(value: string): Promise<void> {
      const input = composer();
      await act(async () => {
        // Go through the prototype setter so React's synthetic `change` fires;
        // assigning `.value` directly is invisible to React.
        const setter = Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(input) as object,
          'value',
        )?.set;
        setter?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await settle();
    },
    async press(accessibilityLabel: string): Promise<void> {
      // HOST FIRST, THEN THE DOCUMENT — and the order is the whole point.
      //
      // A `Modal` renders into its own portal OUTSIDE the mounted subtree, which is
      // exactly the property that stops Android clipping it, so a container-scoped
      // search cannot reach a control inside one. The reachability probe went red for
      // precisely that reason when the header menu became a Modal.
      //
      // But searching the document FIRST is worse than the bug it fixes. Most tests
      // in this suite never call `unmount()`, so every earlier mount's host is still
      // in the document — a document-wide search silently matches a control belonging
      // to a PREVIOUS test. That is not hypothetical: scoping `byTestId` to the
      // document made `chat-jump-to-bottom` fail in CI (and only in CI, where file
      // order differs), because a button that was correctly absent from THIS mount was
      // found in a stale one. A cross-test match is the worst kind of green.
      //
      // So: this mount's subtree is authoritative, and the document is consulted only
      // when the control is genuinely not in it — which is the portal case and nothing
      // else. `byTestId` deliberately does NOT do this: an assertion that a control is
      // ABSENT must never be satisfied by a portal, stale or otherwise.
      const inHost = Array.from(host.querySelectorAll('*')).find(
        (el) => el.getAttribute('aria-label') === accessibilityLabel,
      ) as HTMLElement | undefined;
      const target =
        inHost ??
        (Array.from(host.ownerDocument.body.querySelectorAll('*')).find(
          (el) => el.getAttribute('aria-label') === accessibilityLabel,
        ) as HTMLElement | undefined);
      if (target === undefined) {
        throw new Error(`no control labelled "${accessibilityLabel}" is in the tree`);
      }
      if (target.getAttribute('aria-disabled') === 'true') {
        throw new Error(`control "${accessibilityLabel}" is disabled and cannot be pressed`);
      }
      await act(async () => {
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await settle();
    },
    byTestId(testId: string): HTMLElement | null {
      // CONTAINER-SCOPED, deliberately. Most tests here never unmount, so a
      // document-wide lookup matches earlier mounts — see the long note in `press`.
      // Callers use this to assert ABSENCE as often as presence, and an absence
      // assertion satisfied by another test's DOM is a false green. A test that needs
      // to see inside a Modal's portal should query `host.ownerDocument` explicitly at
      // the call site, where the risk is visible.
      return host.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
    },
    unmount(): void {
      root.unmount();
      host.remove();
    },
  };
}

/**
 * A `WebSocket` stand-in that records every frame the client hands it.
 *
 * `MobileChatSession` constructs `new globalThis.WebSocket(url)` by default, so
 * installing this as the global is what turns "did the send reach the wire?" into
 * an assertion instead of a hope.
 */
export class FakeChatSocket {
  static opened: FakeChatSocket[] = [];

  readonly url: string;
  /** Raw JSON strings handed to `send()`, in order. */
  readonly sent: string[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeChatSocket.opened.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }

  /** Every frame of `type`, decoded. */
  framesOfType(type: string): Array<Record<string, unknown>> {
    return this.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((env) => env['type'] === type);
  }

  /**
   * Install as the global `WebSocket` and reset the recorder.
   *
   * Pair with `resetHarnessGlobals()` in `afterAll` — Bun shares one process
   * across ~100 test files, and a recorder left installed makes the next file's
   * real `Bun.serve` WebSocket test hang until its timeout.
   */
  static install(): void {
    rememberRealWebSocket();
    FakeChatSocket.opened = [];
    (globalThis as { WebSocket?: unknown }).WebSocket = FakeChatSocket;
  }

  /** The socket the surface opened. Throws when nothing connected. */
  static current(): FakeChatSocket {
    const socket = FakeChatSocket.opened[0];
    if (socket === undefined) throw new Error('the surface never opened a socket');
    return socket;
  }
}
