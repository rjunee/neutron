/**
 * @neutronai/app — the persisted, undelivered-report queue.
 *
 * WHY A QUEUE AT ALL
 * ------------------
 * The failure this feature exists to see is a FAILED LAUNCH. During one, there
 * is no session yet, or the process is about to die, or both — so "POST the
 * error immediately" is exactly the strategy that does not work. Instead the
 * report is written to durable storage the moment it is created and delivered
 * on the next launch that gets far enough to authenticate. That is the standard
 * crash-reporter pattern and it is the difference between seeing the crash and
 * not seeing it.
 *
 * It is also why the ingest endpoint stays authenticated. An unauthenticated
 * write endpoint would "solve" the pre-auth case by opening an anonymous log-
 * injection sink on the owner's gateway. The queue solves it without that.
 *
 * THE DURABILITY RULE: A REPORT IS ONLY DROPPED DELIBERATELY
 * ----------------------------------------------------------
 * Three ways a naive queue silently loses reports, all closed here (Codex
 * cross-model review, r1):
 *
 *   1. OVER-SENDING. The gateway accepts at most `MAX_REPORTS_PER_BATCH` per
 *      request and answers 200 for the ones it kept. Sending 15 and pruning all
 *      15 destroys 5. So delivery is CHUNKED, and pruning is driven by the
 *      server's ACCEPTED COUNT — not by "the POST returned 200".
 *   2. CONCURRENT APPENDS. Two fatal captures (a global error and a rejection)
 *      can both read the queue and then both write it, and the later write
 *      erases the earlier crash. Every read-modify-write goes through
 *      `withQueueLock`.
 *   3. A WEDGED OVERSIZED REPORT. A report larger than the gateway's raw-body
 *      ceiling is rejected with 413 BEFORE the server can trim it, so keeping
 *      it at the head of the queue makes every later flush fail forever.
 *      `fitReport` shrinks a report to a deliverable size on the way in.
 *
 * BOUNDED, WITH A DELIBERATE EVICTION ORDER. At most `MAX_QUEUED_REPORTS`
 * reports and `MAX_QUEUE_BYTES` serialized. On overflow the OLDEST are dropped:
 * in a crash loop the newest reports describe the state the app is actually in,
 * and an unbounded queue on a device that never launches is a storage leak with
 * no ceiling.
 *
 * TOTAL BY CONSTRUCTION. Every function here swallows storage and parse
 * failures and degrades to "empty queue" / "not delivered". Diagnostics must
 * never become a new way for the app to fail — the entire value proposition is
 * that it is a passive observer.
 *
 * PURE-ish: no React, no Expo, no `fetch` of its own. The storage seam and the
 * sender are injected, so this is exercised directly under `bun test`
 * (`app/__tests__/diagnostic-queue.test.ts`).
 */

import type { ClientReport } from './diagnostic-report';

export const MAX_QUEUED_REPORTS = 20;
/** Total serialized queue budget on the device. */
export const MAX_QUEUE_BYTES = 256 * 1024;

/**
 * Delivery bounds. These MIRROR the gateway's ingest limits
 * (`gateway/diagnostics/client-report-redaction.ts:MAX_REPORTS_PER_BATCH` and
 * `gateway/http/app-diagnostics-surface.ts:MAX_REPORT_BODY_BYTES`, currently 10
 * and 128 KiB) with headroom for the JSON envelope.
 *
 * They are a local mirror rather than a shared import because the Metro bundle
 * cannot reach the gateway package — but the mirror is NOT load-bearing for
 * correctness: pruning is driven by the server's reported `accepted` count, so
 * if the gateway's cap ever drops below ours the excess simply stays queued and
 * goes out on the next chunk instead of being lost.
 */
export const MAX_REPORTS_PER_BATCH = 10;
export const MAX_BATCH_BYTES = 112 * 1024;
/** A single report must fit inside one request, alone, or it can never be
 *  delivered at all. Kept well under `MAX_BATCH_BYTES`. */
export const MAX_REPORT_BYTES = 80 * 1024;

/** The subset of `TokenStorage` this module needs. */
export interface DiagnosticQueueStore {
  getDiagnosticsQueue(): Promise<string | null>;
  setDiagnosticsQueue(raw: string | null): Promise<void>;
}

/**
 * Serialises every read-modify-write of the queue.
 *
 * The queue lives behind an async storage API, so a plain
 * read → modify → write is interleavable, and the callers are precisely the
 * ones that can fire concurrently: a global error handler and an unhandled-
 * rejection handler, both fire-and-forget. A module-level promise chain is the
 * whole mechanism — there is one queue per process, so one lock suffices.
 */
let queueLock: Promise<unknown> = Promise.resolve();

function withQueueLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = queueLock.then(operation, operation);
  // Keep the chain alive even when an operation rejects, so one failure cannot
  // wedge every later append.
  queueLock = run.catch(() => undefined);
  return run;
}

/** UTF-8 byte length. `TextEncoder` exists on Hermes, JSC and the web; the
 *  fallback keeps this total on an exotic host. */
export function byteLength(value: string): number {
  try {
    return new TextEncoder().encode(value).length;
  } catch {
    return value.length;
  }
}

/** Read the queue. Never throws; a corrupt value reads as empty. */
export async function readQueue(store: DiagnosticQueueStore): Promise<ClientReport[]> {
  let raw: string | null;
  try {
    raw = await store.getDiagnosticsQueue();
  } catch {
    return [];
  }
  if (raw === null || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isClientReport);
  } catch {
    return [];
  }
}

/** Write the queue, trimming to the caps first. Never throws. */
export async function writeQueue(
  store: DiagnosticQueueStore,
  reports: readonly ClientReport[],
): Promise<void> {
  try {
    const bounded = applyCaps(reports);
    await store.setDiagnosticsQueue(bounded.length === 0 ? null : JSON.stringify(bounded));
  } catch {
    // Storage is full / unavailable. There is nothing useful to do: the report
    // is lost, but the app keeps running, which is the correct trade.
  }
}

/**
 * Append a report and persist immediately. Called from the crash paths, so it
 * must not depend on anything a crashing app might already have lost — and it
 * takes the lock, because two crash paths can reach it at once.
 */
export async function enqueueReport(
  store: DiagnosticQueueStore,
  report: ClientReport,
): Promise<void> {
  await withQueueLock(async () => {
    const existing = await readQueue(store);
    await writeQueue(store, [...existing, fitReport(report)]);
  });
}

export interface FlushResult {
  /** How many reports the gateway confirmed it persisted. */
  delivered: number;
  /** How many remain queued (delivery failed, or none were pending). */
  remaining: number;
  /** `false` when a send was attempted and failed. `true` when every attempted
   *  chunk succeeded OR there was nothing to send. */
  ok: boolean;
}

/** What a sender reports back. `accepted` is the gateway's own count — the
 *  ONLY thing that authorises pruning. */
export interface SendOutcome {
  ok: boolean;
  accepted: number;
}

export interface FlushOptions {
  store: DiagnosticQueueStore;
  send(reports: ClientReport[]): Promise<SendOutcome>;
  /**
   * The gateway being flushed TO. Only reports captured against this gateway —
   * or against none at all (`origin: ''`, a crash before the app was
   * configured) — are sent.
   *
   * The queue deliberately survives a server change, so without this filter a
   * report captured against one instance would be delivered to whichever
   * instance the owner pointed at next, disclosing one server's diagnostics to
   * another (Codex cross-model review r2 P1). Foreign-origin reports are NOT
   * deleted — they simply never travel, and age out through the ordinary
   * newest-wins cap, so pointing the app back at the original server still
   * delivers them.
   */
  origin: string;
}

/**
 * Deliver everything queued, in chunks the gateway will actually accept, and
 * prune exactly what it confirmed it kept.
 *
 * Pruning removes the first `accepted` reports OF THE CHUNK — the gateway
 * truncates a batch from the tail (`sanitizeBatch` takes `slice(0, cap)`), so
 * the accepted prefix is exactly what landed. Anything beyond it stays queued
 * and goes out on the next chunk.
 *
 * The prune is a read-modify-write under the queue lock and matches BY
 * `report_id`, so a report enqueued while the POST was in flight — an error
 * during the flush itself, not a hypothetical — is never destroyed.
 *
 * On failure nothing is removed, so the reports ride along to the next launch.
 * That is the behaviour `app/__tests__/diagnostic-queue.test.ts` pins; break it
 * and the persisted-queue test goes red.
 */
export async function flushQueue(opts: FlushOptions): Promise<FlushResult> {
  const queued = await readQueue(opts.store);
  const pending = queued.filter((report) => isDeliverableTo(report, opts.origin));
  if (pending.length === 0) return { delivered: 0, remaining: queued.length, ok: true };

  let delivered = 0;
  let ok = true;
  let cursor = 0;

  while (cursor < pending.length) {
    const chunk = nextChunk(pending, cursor);
    if (chunk.length === 0) break;

    let outcome: SendOutcome;
    try {
      outcome = await opts.send(chunk);
    } catch {
      outcome = { ok: false, accepted: 0 };
    }
    // A 2xx with `accepted: 0` would mean the gateway kept nothing; treating it
    // as progress would spin. Stop and retry next launch.
    if (!outcome.ok || outcome.accepted <= 0) {
      ok = false;
      break;
    }

    const accepted = Math.min(outcome.accepted, chunk.length);
    await pruneDelivered(opts.store, chunk.slice(0, accepted));
    delivered += accepted;
    // Advance only over what the gateway confirmed — the remainder of this
    // chunk is retried as the head of the next one.
    cursor += accepted;
    if (accepted < chunk.length) break;
  }

  const remaining = (await readQueue(opts.store)).length;
  return { delivered, remaining, ok };
}

/** Remove the given reports by id, under the lock. */
async function pruneDelivered(
  store: DiagnosticQueueStore,
  delivered: readonly ClientReport[],
): Promise<void> {
  const ids = new Set(delivered.map((report) => report.report_id));
  await withQueueLock(async () => {
    const current = await readQueue(store);
    await writeQueue(
      store,
      current.filter((report) => !ids.has(report.report_id)),
    );
  });
}

/**
 * The next batch: as many reports as fit under BOTH the count cap and the body
 * budget, always at least one (`fitReport` guarantees a single report fits).
 */
function nextChunk(pending: readonly ClientReport[], from: number): ClientReport[] {
  const chunk: ClientReport[] = [];
  for (let i = from; i < pending.length && chunk.length < MAX_REPORTS_PER_BATCH; i += 1) {
    // Re-fit on the way OUT as well as on the way in: a queue written by an
    // older build (or a storage value edited by hand) could still hold an
    // oversized report, and one of those at the head would 413 every flush
    // forever. The wire payload is guaranteed deliverable regardless of what
    // storage happens to contain.
    const next = fitReport(pending[i]!);
    if (chunk.length > 0) {
      const candidate = byteLength(JSON.stringify({ reports: [...chunk, next] }));
      if (candidate > MAX_BATCH_BYTES) break;
    }
    chunk.push(next);
  }
  return chunk;
}

/**
 * Shrink a report until it fits in one request.
 *
 * The gateway enforces its body ceiling BEFORE sanitising, answering 413, so an
 * oversized report cannot be trimmed server-side — it would sit at the head of
 * the queue and 413 every flush forever. Events are dropped OLDEST-FIRST
 * (the newest are the ones nearest the crash); if a single event is still too
 * big, its stack and message are truncated. A shrunk report is marked so a
 * reader knows they are looking at a trimmed window rather than the whole one.
 */
export function fitReport(report: ClientReport): ClientReport {
  if (byteLength(JSON.stringify(report)) <= MAX_REPORT_BYTES) return report;

  let events = report.events.slice();
  while (events.length > 1) {
    events = events.slice(1);
    const candidate = { ...report, events, truncated: true };
    if (byteLength(JSON.stringify(candidate)) <= MAX_REPORT_BYTES) return candidate;
  }

  // One event left and still over budget: the payload IS the event.
  const last = events[0];
  if (last === undefined) return { ...report, events: [], truncated: true };
  const trimmed = {
    ...last,
    message: last.message.slice(0, 2_000),
    ...(last.stack !== undefined ? { stack: last.stack.slice(0, 4_000) } : {}),
    ...(last.context !== undefined ? { context: { note: 'dropped — report over size limit' } } : {}),
  };
  return { ...report, events: [trimmed], truncated: true };
}

/** Newest-wins trimming: cap the count, then shed from the FRONT until the
 *  serialized form fits the byte budget. */
function applyCaps(reports: readonly ClientReport[]): ClientReport[] {
  let out = reports.slice(-MAX_QUEUED_REPORTS);
  while (out.length > 1 && byteLength(JSON.stringify(out)) > MAX_QUEUE_BYTES) {
    out = out.slice(1);
  }
  return out;
}

/** A report travels only to the gateway it was captured against. An unknown
 *  origin (`''`) belongs to the first server the owner configures, by
 *  definition, so it is deliverable anywhere. */
export function isDeliverableTo(report: ClientReport, origin: string): boolean {
  const captured = typeof report.origin === 'string' ? report.origin : '';
  return captured.length === 0 || captured === origin;
}

function isClientReport(value: unknown): value is ClientReport {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate['report_id'] === 'string' && Array.isArray(candidate['events']);
}

/** Test seam — drain the lock chain so a case cannot leak into the next. */
export async function __settleQueueLockForTests(): Promise<void> {
  await queueLock.catch(() => undefined);
}
