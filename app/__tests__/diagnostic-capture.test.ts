/**
 * @neutronai/app — global capture + ring buffer.
 *
 * Covers the three things the capture layer has to get right:
 *
 *   1. it CHAINS to the previous `ErrorUtils` handler. Replacing RN's handler
 *      would kill the development redbox — a crash reporter that makes local
 *      debugging worse is a net loss;
 *   2. a FATAL error takes the persist path, not the record-only path — that
 *      distinction is the whole reason a failed launch is recoverable;
 *   3. the ring buffer is bounded and evicts oldest-first.
 *
 * The host globals are injected, so this runs under `bun test` with no React
 * Native present — the real installer, fake globals.
 */

import { describe, expect, it } from 'bun:test';

import { DiagnosticRingBuffer, type DiagnosticEvent } from '../lib/diagnostic-buffer';
import { installGlobalCapture, type CaptureHost, type ErrorUtilsLike } from '../lib/diagnostic-capture';

interface Recorded {
  recorded: DiagnosticEvent[];
  fatal: DiagnosticEvent[];
}

function sink(into: Recorded) {
  return {
    now: () => 1000,
    record: (event: DiagnosticEvent): void => {
      into.recorded.push(event);
    },
    captureFatal: (event: DiagnosticEvent): void => {
      into.fatal.push(event);
    },
  };
}

function fakeErrorUtils(): { utils: ErrorUtilsLike; previousCalls: unknown[]; current: () => ((e: unknown, f?: boolean) => void) | undefined } {
  const previousCalls: unknown[] = [];
  let handler: ((error: unknown, isFatal?: boolean) => void) | undefined = (error) => {
    previousCalls.push(error);
  };
  return {
    previousCalls,
    current: () => handler,
    utils: {
      getGlobalHandler: () => handler,
      setGlobalHandler: (next) => {
        handler = next;
      },
    },
  };
}

describe('installGlobalCapture', () => {
  it('records a non-fatal JS error and still calls the previous handler', () => {
    const into: Recorded = { recorded: [], fatal: [] };
    const eu = fakeErrorUtils();
    installGlobalCapture({ ErrorUtils: eu.utils }, sink(into));

    const err = new Error('kaboom');
    eu.current()!(err, false);

    expect(into.fatal).toEqual([]);
    expect(into.recorded).toHaveLength(1);
    expect(into.recorded[0]!.kind).toBe('js_error');
    expect(into.recorded[0]!.message).toBe('Error: kaboom');
    expect(into.recorded[0]!.at).toBe(1000);
    // The redbox still fires.
    expect(eu.previousCalls).toEqual([err]);
  });

  it('takes the PERSIST path for a fatal error', () => {
    const into: Recorded = { recorded: [], fatal: [] };
    const eu = fakeErrorUtils();
    installGlobalCapture({ ErrorUtils: eu.utils }, sink(into));

    eu.current()!(new Error('fatal boom'), true);

    expect(into.recorded).toEqual([]);
    expect(into.fatal).toHaveLength(1);
    expect(into.fatal[0]!.context).toEqual({ fatal: true });
  });

  it('captures an unhandled promise rejection', () => {
    const into: Recorded = { recorded: [], fatal: [] };
    const listeners = new Map<string, (event: unknown) => void>();
    const host: CaptureHost = {
      addEventListener: (type, listener) => {
        listeners.set(type, listener);
      },
    };
    installGlobalCapture(host, sink(into));

    listeners.get('unhandledrejection')!({ reason: new Error('nobody caught me') });

    expect(into.fatal).toHaveLength(1);
    expect(into.fatal[0]!.kind).toBe('unhandled_rejection');
    expect(into.fatal[0]!.message).toBe('Error: nobody caught me');
  });

  it('handles a non-Error thrown value without losing the report', () => {
    // `throw 'a string'` and `Promise.reject(undefined)` are exactly the cases
    // a naive `error.message` reporter drops on the floor.
    const into: Recorded = { recorded: [], fatal: [] };
    const listeners = new Map<string, (event: unknown) => void>();
    installGlobalCapture(
      {
        addEventListener: (type, listener) => {
          listeners.set(type, listener);
        },
      },
      sink(into),
    );

    listeners.get('unhandledrejection')!({ reason: undefined });
    listeners.get('error')!({ message: 'script error' });

    expect(into.fatal.map((e) => e.message)).toEqual(['undefined', 'script error']);
  });

  it('uninstall restores the previous handler', () => {
    const into: Recorded = { recorded: [], fatal: [] };
    const eu = fakeErrorUtils();
    const original = eu.current();
    const handle = installGlobalCapture({ ErrorUtils: eu.utils }, sink(into));
    expect(eu.current()).not.toBe(original);
    handle.remove();
    expect(eu.current()).toBe(original);
  });

  it('is a no-op on a host with neither hook', () => {
    const into: Recorded = { recorded: [], fatal: [] };
    expect(() => installGlobalCapture({}, sink(into)).remove()).not.toThrow();
  });
});

describe('DiagnosticRingBuffer', () => {
  it('is bounded and evicts oldest-first', () => {
    const buffer = new DiagnosticRingBuffer(3);
    for (let i = 0; i < 6; i += 1) {
      buffer.record({ at: i, level: 'info', kind: 'lifecycle', message: `e${i}` });
    }
    expect(buffer.size).toBe(3);
    expect(buffer.snapshot().map((e) => e.message)).toEqual(['e3', 'e4', 'e5']);
  });

  it('snapshot is a copy — mutating it cannot corrupt the buffer', () => {
    const buffer = new DiagnosticRingBuffer(2);
    buffer.record({ at: 1, level: 'info', kind: 'lifecycle', message: 'a' });
    const snap = buffer.snapshot();
    snap.length = 0;
    expect(buffer.size).toBe(1);
  });
});
