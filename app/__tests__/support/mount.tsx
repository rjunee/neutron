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

import { act, type ReactElement } from 'react';
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

export async function mountScreen(element: ReactElement): Promise<MountedScreen> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host) as Root;
  await act(async () => {
    root.render(element);
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
      const target = Array.from(host.querySelectorAll('*')).find(
        (el) => el.getAttribute('aria-label') === accessibilityLabel,
      ) as HTMLElement | undefined;
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

  /** Install as the global `WebSocket` and reset the recorder. */
  static install(): void {
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
