/**
 * @neutronai/app — persisted-queue behaviour.
 *
 * The queue is the reason this feature can see a FAILED LAUNCH at all: the
 * report is written to durable storage the moment it is created, and delivered
 * on the next launch that gets far enough to authenticate. The property that
 * carries that promise is simple to state and easy to lose: A REPORT IS ONLY
 * DROPPED DELIBERATELY.
 *
 * Five ways it can be lost or MIS-SENT, all pinned here — the last four found by
 * the Codex cross-model review (r1, r2) before this shipped:
 *
 *   1. a failed delivery pruning the queue anyway;
 *   2. over-sending a batch and pruning reports the gateway never kept;
 *   3. two concurrent crash captures overwriting each other's append;
 *   4. an oversized report wedging the queue behind a permanent 413;
 *   5. a report captured against one server being delivered to a DIFFERENT one
 *      after a server change — the queue deliberately outlives the session.
 *
 * Backed by the REAL `NativeTokenStorage` over an in-memory AsyncStorage-shaped
 * backing, so the storage seam under test is the production one — not a stub of
 * the queue's own interface.
 *
 * MUTATION-VERIFIED: make `flushQueue` prune on any 2xx (ignore the accepted
 * count) and case (2) goes red; remove the `if (!outcome.ok …) break` guard and
 * case (1) goes red. Evidence is in the PR body.
 */

import { describe, expect, it } from 'bun:test';

import {
  byteLength,
  enqueueReport,
  fitReport,
  flushQueue,
  readQueue,
  MAX_QUEUED_REPORTS,
  MAX_REPORTS_PER_BATCH,
  MAX_REPORT_BYTES,
} from '../lib/diagnostic-queue';
import type { ClientReport } from '../lib/diagnostic-report';
import { NativeTokenStorage } from '../lib/token-storage';

/** AsyncStorage-shaped in-memory backing — the same shim shape the sibling
 *  storage suites use. The storage CLASS under test is the real one. */
function backing(): {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  map: Map<string, string>;
} {
  const map = new Map<string, string>();
  return {
    map,
    async getItem(key) {
      return map.has(key) ? map.get(key)! : null;
    },
    async setItem(key, value) {
      map.set(key, value);
    },
    async removeItem(key) {
      map.delete(key);
    },
  };
}

/** A backing whose reads/writes yield to the microtask queue, so an interleaved
 *  read-modify-write is actually possible — the real AsyncStorage is async, and
 *  a synchronous shim would hide the race this suite exists to catch. */
function slowBacking(): ReturnType<typeof backing> {
  const inner = backing();
  return {
    map: inner.map,
    async getItem(key) {
      await Promise.resolve();
      return inner.getItem(key);
    },
    async setItem(key, value) {
      await Promise.resolve();
      return inner.setItem(key, value);
    },
    async removeItem(key) {
      await Promise.resolve();
      return inner.removeItem(key);
    },
  };
}

const HOME = 'https://neutron.example.com';

function report(id: string, events = 1, origin: string = HOME): ClientReport {
  return {
    schema: 1,
    report_id: id,
    created_at: 1,
    origin,
    reason: 'js_error',
    app: { version: '1.0.0', build: null, platform: 'android', os_version: '14' },
    session: { signed_in: true },
    events: Array.from({ length: events }, (_v, i) => ({
      at: i,
      level: 'error' as const,
      kind: 'js_error',
      message: `boom ${id} ${i}`,
    })),
  };
}

/** A sender that accepts at most `cap` reports per call — i.e. behaves the way
 *  the real gateway does (`sanitizeBatch` keeps `slice(0, cap)`). */
function cappedSender(cap: number) {
  const batches: string[][] = [];
  return {
    batches,
    send: async (reports: ClientReport[]) => {
      batches.push(reports.map((r) => r.report_id));
      return { ok: true, accepted: Math.min(cap, reports.length) };
    },
  };
}

describe('diagnostic queue — durability', () => {
  it('persists a report through the real storage seam, so it survives the process', async () => {
    // A report written by one process instance, read by a fresh one over the
    // same durable backing — which is exactly what "crashed, then relaunched"
    // looks like from the app's point of view.
    const disk = backing();
    await enqueueReport(new NativeTokenStorage(disk), report('a'));

    const nextLaunch = new NativeTokenStorage(disk);
    expect((await readQueue(nextLaunch)).map((r) => r.report_id)).toEqual(['a']);
    expect(disk.map.has('neutron.diagnostics.queue')).toBe(true);
  });

  it('delivers on flush and prunes what the gateway accepted', async () => {
    const store = new NativeTokenStorage(backing());
    await enqueueReport(store, report('a'));
    await enqueueReport(store, report('b'));

    const sender = cappedSender(MAX_REPORTS_PER_BATCH);
    const result = await flushQueue({ store, origin: HOME, send: sender.send });

    expect(sender.batches).toEqual([['a', 'b']]);
    expect(result).toEqual({ delivered: 2, remaining: 0, ok: true });
    expect(await readQueue(store)).toEqual([]);
  });

  it('KEEPS reports when delivery fails, so they ride to the next launch', async () => {
    const store = new NativeTokenStorage(backing());
    await enqueueReport(store, report('a'));

    const failed = await flushQueue({ store, origin: HOME, send: async () => ({ ok: false, accepted: 0 }) });
    expect(failed).toEqual({ delivered: 0, remaining: 1, ok: false });
    expect((await readQueue(store)).map((r) => r.report_id)).toEqual(['a']);

    const ok = await flushQueue({ store, origin: HOME, send: cappedSender(10).send });
    expect(ok.delivered).toBe(1);
    expect(await readQueue(store)).toEqual([]);
  });

  it('treats a thrown sender as a failure and keeps the queue', async () => {
    const store = new NativeTokenStorage(backing());
    await enqueueReport(store, report('a'));
    const result = await flushQueue({
      store,
      origin: HOME,
      send: async () => {
        throw new Error('network down');
      },
    });
    expect(result.ok).toBe(false);
    expect((await readQueue(store)).map((r) => r.report_id)).toEqual(['a']);
  });

  it('treats a 2xx that confirms NOTHING as a failure rather than pruning', async () => {
    // A proxy or captive portal answering 200 without the gateway's `accepted`
    // count. Stalling is recoverable (the queue is capped and evicts oldest);
    // a wrongly pruned crash report is gone for good.
    const store = new NativeTokenStorage(backing());
    await enqueueReport(store, report('a'));
    const result = await flushQueue({ store, origin: HOME, send: async () => ({ ok: true, accepted: 0 }) });
    expect(result.ok).toBe(false);
    expect((await readQueue(store)).map((r) => r.report_id)).toEqual(['a']);
  });

  it('does not destroy a report that was enqueued DURING the flush', async () => {
    const store = new NativeTokenStorage(backing());
    await enqueueReport(store, report('a'));

    const result = await flushQueue({
      store,
      origin: HOME,
      send: async (reports) => {
        await enqueueReport(store, report('late'));
        return { ok: true, accepted: reports.length };
      },
    });

    expect(result.delivered).toBe(1);
    expect((await readQueue(store)).map((r) => r.report_id)).toEqual(['late']);
  });
});

describe('diagnostic queue — batch limits (Codex r1 P1)', () => {
  it('never loses reports the gateway did not keep', async () => {
    // The gateway caps a batch at MAX_REPORTS_PER_BATCH and still answers 200.
    // Sending 15 and pruning 15 would silently destroy 5.
    const store = new NativeTokenStorage(backing());
    for (let i = 0; i < 15; i += 1) await enqueueReport(store, report(`r${i}`));

    const sender = cappedSender(MAX_REPORTS_PER_BATCH);
    const result = await flushQueue({ store, origin: HOME, send: sender.send });

    expect(result.delivered).toBe(15);
    expect(result.remaining).toBe(0);
    expect(await readQueue(store)).toEqual([]);
    // Chunked, never over-sent.
    for (const batch of sender.batches) {
      expect(batch.length).toBeLessThanOrEqual(MAX_REPORTS_PER_BATCH);
    }
    // Every report reached the wire exactly once.
    expect(sender.batches.flat().sort()).toEqual(
      Array.from({ length: 15 }, (_v, i) => `r${i}`).sort(),
    );
  });

  it('keeps the remainder when a server accepts FEWER than we sent', async () => {
    // A server whose cap is smaller than the client's mirror. The excess must
    // stay queued, not vanish.
    const store = new NativeTokenStorage(backing());
    for (let i = 0; i < 4; i += 1) await enqueueReport(store, report(`r${i}`));

    const result = await flushQueue({
      store,
      origin: HOME,
      // Accepts 2, then refuses — so exactly r0,r1 land and r2,r3 must survive.
      send: async (reports) => ({ ok: true, accepted: Math.min(2, reports.length) }),
    });

    expect(result.delivered).toBe(2);
    expect((await readQueue(store)).map((r) => r.report_id)).toEqual(['r2', 'r3']);
  });
});

describe('diagnostic queue — concurrent appends (Codex r1 P1)', () => {
  it('does not lose a crash report when two captures enqueue at once', async () => {
    // A global error handler and an unhandled-rejection handler are both
    // fire-and-forget, so overlapping read-modify-writes are ordinary. Without
    // serialization the later write erases the earlier crash.
    const store = new NativeTokenStorage(slowBacking());
    await Promise.all([
      enqueueReport(store, report('crash-a')),
      enqueueReport(store, report('crash-b')),
      enqueueReport(store, report('crash-c')),
    ]);
    const ids = (await readQueue(store)).map((r) => r.report_id).sort();
    expect(ids).toEqual(['crash-a', 'crash-b', 'crash-c']);
  });

  it('a prune racing an append keeps the new report', async () => {
    const store = new NativeTokenStorage(slowBacking());
    await enqueueReport(store, report('old'));
    await Promise.all([
      flushQueue({
        store,
        origin: HOME,
        send: async (reports) => ({ ok: true, accepted: reports.length }),
      }),
      enqueueReport(store, report('new')),
    ]);
    const ids = (await readQueue(store)).map((r) => r.report_id);
    expect(ids).toContain('new');
  });
});

describe('diagnostic queue — oversized reports (Codex r1 P2)', () => {
  it('shrinks a report that could never be delivered', async () => {
    // The gateway enforces its body ceiling BEFORE sanitising and answers 413,
    // so an oversized report cannot be trimmed server-side — left at the head
    // of the queue it would 413 every flush, forever.
    const huge = report('huge', 1);
    huge.events = Array.from({ length: 200 }, (_v, i) => ({
      at: i,
      level: 'error' as const,
      kind: 'js_error',
      message: 'x'.repeat(2_000),
    }));
    expect(byteLength(JSON.stringify(huge))).toBeGreaterThan(MAX_REPORT_BYTES);

    const fitted = fitReport(huge);
    expect(byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(MAX_REPORT_BYTES);
    expect(fitted.truncated).toBe(true);
    // Newest events are kept — they are the ones nearest the crash.
    expect(fitted.events[fitted.events.length - 1]).toEqual(huge.events[huge.events.length - 1]!);
  });

  it('a single enormous event is truncated rather than dropped', () => {
    const one = report('one', 1);
    one.events = [
      { at: 1, level: 'error', kind: 'js_error', message: 'y'.repeat(400_000) },
    ];
    const fitted = fitReport(one);
    expect(byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(MAX_REPORT_BYTES);
    expect(fitted.events).toHaveLength(1);
    expect(fitted.truncated).toBe(true);
  });

  it('leaves an ordinary report untouched', () => {
    const ordinary = report('small', 3);
    expect(fitReport(ordinary)).toBe(ordinary);
    expect(ordinary.truncated).toBeUndefined();
  });

  it('an oversized report already in storage cannot wedge the queue', async () => {
    // Written by an older build, or edited by hand. The wire payload must still
    // be deliverable.
    const disk = backing();
    const huge = report('legacy', 1);
    huge.events = Array.from({ length: 200 }, (_v, i) => ({
      at: i,
      level: 'error' as const,
      kind: 'js_error',
      message: 'z'.repeat(2_000),
    }));
    disk.map.set('neutron.diagnostics.queue', JSON.stringify([huge]));

    const store = new NativeTokenStorage(disk);
    let sentBytes = 0;
    const result = await flushQueue({
      store,
      origin: HOME,
      send: async (reports) => {
        sentBytes = byteLength(JSON.stringify({ reports }));
        return { ok: true, accepted: reports.length };
      },
    });
    expect(result.delivered).toBe(1);
    expect(sentBytes).toBeLessThanOrEqual(MAX_REPORT_BYTES + 1_024);
  });
});

describe('diagnostic queue — bounds + resilience', () => {
  it('is bounded: an app in a crash loop cannot grow storage without limit', async () => {
    const store = new NativeTokenStorage(backing());
    for (let i = 0; i < MAX_QUEUED_REPORTS + 15; i += 1) {
      await enqueueReport(store, report(`r${i}`));
    }
    const queued = await readQueue(store);
    expect(queued.length).toBe(MAX_QUEUED_REPORTS);
    expect(queued[queued.length - 1]!.report_id).toBe(`r${MAX_QUEUED_REPORTS + 14}`);
  });

  it('reads a corrupt queue as empty rather than throwing', async () => {
    const shared = backing();
    shared.map.set('neutron.diagnostics.queue', '{not json');
    const store = new NativeTokenStorage(shared);
    expect(await readQueue(store)).toEqual([]);
  });

  it('an empty queue flushes without calling the sender', async () => {
    const store = new NativeTokenStorage(backing());
    let called = false;
    const result = await flushQueue({
      store,
      origin: HOME,
      send: async () => {
        called = true;
        return { ok: true, accepted: 0 };
      },
    });
    expect(called).toBe(false);
    expect(result).toEqual({ delivered: 0, remaining: 0, ok: true });
  });
});

describe('diagnostic queue — server isolation (Codex r2 P1)', () => {
  const OTHER = 'https://someone-elses.example.com';

  it('never delivers a report to a gateway it was not captured against', async () => {
    // The queue deliberately survives a server change (a crash report is
    // evidence about the app, not the session). Without an origin filter, a
    // report captured against the old instance would be handed to the new one.
    const store = new NativeTokenStorage(backing());
    await enqueueReport(store, report('from-home', 1, HOME));

    const sender = cappedSender(MAX_REPORTS_PER_BATCH);
    const result = await flushQueue({ store, origin: OTHER, send: sender.send });

    expect(sender.batches).toEqual([]);
    expect(result.delivered).toBe(0);
    // Retained, not deleted — pointing back at the original server delivers it.
    expect((await readQueue(store)).map((r) => r.report_id)).toEqual(['from-home']);
  });

  it('delivers only the matching subset when the queue is mixed', async () => {
    const store = new NativeTokenStorage(backing());
    await enqueueReport(store, report('home-1', 1, HOME));
    await enqueueReport(store, report('foreign', 1, OTHER));
    await enqueueReport(store, report('home-2', 1, HOME));

    const sender = cappedSender(MAX_REPORTS_PER_BATCH);
    await flushQueue({ store, origin: HOME, send: sender.send });

    expect(sender.batches).toEqual([['home-1', 'home-2']]);
    expect((await readQueue(store)).map((r) => r.report_id)).toEqual(['foreign']);
  });

  it('a report captured BEFORE any server was configured is deliverable', async () => {
    // A crash inside the first-run setup gate. It belongs to whichever server
    // the owner configures first, by definition — dropping it would blind us to
    // exactly the failure that is hardest to diagnose.
    const store = new NativeTokenStorage(backing());
    await enqueueReport(store, report('pre-config', 1, ''));

    const sender = cappedSender(MAX_REPORTS_PER_BATCH);
    const result = await flushQueue({ store, origin: HOME, send: sender.send });

    expect(sender.batches).toEqual([['pre-config']]);
    expect(result.delivered).toBe(1);
  });

  it('a foreign report still delivers after switching back', async () => {
    const store = new NativeTokenStorage(backing());
    await enqueueReport(store, report('home-only', 1, HOME));
    await flushQueue({ store, origin: OTHER, send: cappedSender(10).send });

    const sender = cappedSender(MAX_REPORTS_PER_BATCH);
    await flushQueue({ store, origin: HOME, send: sender.send });
    expect(sender.batches).toEqual([['home-only']]);
    expect(await readQueue(store)).toEqual([]);
  });
});
