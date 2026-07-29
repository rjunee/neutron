/**
 * @neutronai/app — global JS error capture (pure, host-injected).
 *
 * Installs the process-wide handlers that turn an uncaught error into a
 * recorded event. Three sources, because the JS runtime has three:
 *
 *   1. `ErrorUtils.setGlobalHandler` — React Native's uncaught-exception hook,
 *      the one that fires for a fatal JS error on device. The PREVIOUS handler
 *      is always called afterwards: it is RN's own, and replacing it would kill
 *      the redbox in development, which would be a strictly worse debugging
 *      experience than the one this feature exists to improve.
 *   2. `unhandledrejection` — a rejected promise with no `.catch`. On web this
 *      is a real DOM event; on native Hermes it fires when the host exposes it.
 *      Silent rejected promises are the single most common way a React Native
 *      app "does nothing" instead of failing visibly.
 *   3. `error` — the DOM-level uncaught error event, so the web build of the
 *      app is covered by the same pipeline as native.
 *
 * Every hook is OPTIONAL and probed, never assumed. The set of globals differs
 * between Hermes, JSC, the web bundle and the bun test runner, and a crash
 * reporter that itself throws on an unexpected runtime would be worse than
 * useless.
 *
 * PURE — the host globals are an injected argument, so the real installer is
 * unit-tested with fakes under `bun test`, with no React Native present.
 */

import type { DiagnosticEvent } from './diagnostic-buffer';
import { describeThrown } from './diagnostic-report';

/** RN's global error hook, as much of it as we use. */
export interface ErrorUtilsLike {
  getGlobalHandler?: () => ((error: unknown, isFatal?: boolean) => void) | undefined;
  setGlobalHandler: (handler: (error: unknown, isFatal?: boolean) => void) => void;
}

/** The host globals this installer probes. Every field is optional. */
export interface CaptureHost {
  ErrorUtils?: ErrorUtilsLike | undefined;
  addEventListener?: ((type: string, listener: (event: unknown) => void) => void) | undefined;
  removeEventListener?: ((type: string, listener: (event: unknown) => void) => void) | undefined;
}

export interface CaptureSink {
  /** Record a non-fatal observation into the ring buffer. */
  record(event: DiagnosticEvent): void;
  /**
   * A crash: record it AND persist a report right now, because the process may
   * not survive to the next tick. Fire-and-forget — the handler cannot await.
   */
  captureFatal(event: DiagnosticEvent): void;
  /** Epoch-ms clock, injected so tests get deterministic stamps. */
  now(): number;
}

/** Undo handle. Restores the previous `ErrorUtils` handler and detaches the
 *  DOM listeners, so a test can install and uninstall repeatedly. */
export interface CaptureHandle {
  remove(): void;
}

/**
 * Install the handlers. Idempotency is the CALLER's concern (see
 * `lib/diagnostics.ts`), so this stays a plain, testable function.
 */
export function installGlobalCapture(host: CaptureHost, sink: CaptureSink): CaptureHandle {
  const undos: Array<() => void> = [];

  const errorUtils = host.ErrorUtils;
  if (errorUtils !== undefined && typeof errorUtils.setGlobalHandler === 'function') {
    const previous =
      typeof errorUtils.getGlobalHandler === 'function' ? errorUtils.getGlobalHandler() : undefined;
    const handler = (error: unknown, isFatal?: boolean): void => {
      const described = describeThrown(error);
      const event: DiagnosticEvent = {
        at: sink.now(),
        level: 'error',
        kind: 'js_error',
        message: described.message,
        context: { fatal: isFatal === true },
      };
      if (described.stack !== undefined) event.stack = described.stack;
      if (isFatal === true) sink.captureFatal(event);
      else sink.record(event);
      // ALWAYS chain: this is RN's redbox / LogBox handler in development.
      if (typeof previous === 'function') previous(error, isFatal);
    };
    errorUtils.setGlobalHandler(handler);
    undos.push(() => {
      if (typeof previous === 'function') errorUtils.setGlobalHandler(previous);
    });
  }

  const add = host.addEventListener;
  const remove = host.removeEventListener;
  if (typeof add === 'function') {
    const onRejection = (event: unknown): void => {
      const reason = readReason(event);
      const described = describeThrown(reason);
      const diagnostic: DiagnosticEvent = {
        at: sink.now(),
        level: 'error',
        kind: 'unhandled_rejection',
        message: described.message,
      };
      if (described.stack !== undefined) diagnostic.stack = described.stack;
      // A rejected promise does not kill the process, but it IS the shape of
      // "the app silently did nothing" — persist it so it survives a launch
      // that later dies for an unrelated reason.
      sink.captureFatal(diagnostic);
    };
    const onError = (event: unknown): void => {
      const described = describeThrown(readError(event));
      const diagnostic: DiagnosticEvent = {
        at: sink.now(),
        level: 'error',
        kind: 'js_error',
        message: described.message,
      };
      if (described.stack !== undefined) diagnostic.stack = described.stack;
      sink.captureFatal(diagnostic);
    };
    add('unhandledrejection', onRejection);
    add('error', onError);
    if (typeof remove === 'function') {
      undos.push(() => {
        remove('unhandledrejection', onRejection);
        remove('error', onError);
      });
    }
  }

  return {
    remove(): void {
      for (const undo of undos.reverse()) {
        try {
          undo();
        } catch {
          // Uninstall is best-effort; a host that refuses to restore a handler
          // is not worth crashing over.
        }
      }
    },
  };
}

/** `PromiseRejectionEvent.reason`, tolerating hosts that pass the reason raw. */
function readReason(event: unknown): unknown {
  if (event !== null && typeof event === 'object' && 'reason' in event) {
    return (event as { reason: unknown }).reason;
  }
  return event;
}

/** `ErrorEvent.error` (falling back to `.message`), tolerating raw values. */
function readError(event: unknown): unknown {
  if (event !== null && typeof event === 'object') {
    const record = event as { error?: unknown; message?: unknown };
    if (record.error !== undefined && record.error !== null) return record.error;
    if (typeof record.message === 'string') return record.message;
  }
  return event;
}
