/**
 * @neutronai/app — the diagnostics runtime (the one stateful piece).
 *
 * Wires the pure parts into a working reporter:
 *
 *   ring buffer  →  redaction  →  report  →  persisted queue  →  owner's gateway
 *
 * WHAT THIS FEATURE IS FOR
 * ------------------------
 * The Android app failed on the owner's device three times and nobody could see
 * why, because the only diagnosis channel was "plug in a USB cable and run
 * logcat". Each round cost hours of guessing, and most of the guesses were
 * wrong. Reports now go to the owner's OWN gateway — no Sentry, no third party,
 * no account — which is the only shape compatible with a self-hosted product.
 *
 * WHAT IT DOES NOT COVER — READ THIS BEFORE TRUSTING IT
 * ----------------------------------------------------
 * JavaScript errors ONLY. A NATIVE crash produces nothing here, because no JS
 * ever runs to catch it. Concretely: the crash that actually blocked the owner
 * this week — an Android provider dying during process start, before the JS
 * bundle loaded — would NOT have been captured by this code, and still needs
 * logcat or an emulator. This feature closes the JS blind spot. It does not
 * close the native one, and pretending otherwise would just move the wasted
 * hours somewhere else.
 *
 * NO FLAG. There is no env gate, no "diagnostics enabled" setting, and no
 * second code path. It ships on, as the product.
 *
 * Everything expensive or platform-bound is resolved lazily inside a function
 * so this module stays importable under `bun test` without React Native.
 */

import { DiagnosticRingBuffer, type DiagnosticEvent, type DiagnosticLevel } from './diagnostic-buffer';
import {
  installGlobalCapture,
  type CaptureHandle,
  type CaptureHost,
} from './diagnostic-capture';
import {
  enqueueReport,
  flushQueue,
  readQueue,
  type DiagnosticQueueStore,
  type FlushResult,
} from './diagnostic-queue';
import { buildClientReport, redactEvent, type ClientReport, type ReportAppContext, type ReportReason } from './diagnostic-report';
import { DiagnosticsClient } from './diagnostics-client';
import { tokenStorage } from './token-storage';

const buffer = new DiagnosticRingBuffer();
let captureHandle: CaptureHandle | null = null;
/**
 * Exact credential values the redactor removes from every string. Set whenever
 * the session changes (`components/DiagnosticsSync.tsx`) so a token captured in
 * a stack trace is scrubbed even before a flush knows the bearer.
 */
let knownSecrets: string[] = [];
let queueStoreOverride: DiagnosticQueueStore | null = null;
/**
 * The gateway the app is currently pointed at, stamped onto every report so a
 * queued one can never be delivered to a DIFFERENT instance after a server
 * change (Codex cross-model review r2 P1). `''` until the server config has
 * been hydrated — a crash before then belongs to whichever server is configured
 * first, which is the correct answer.
 */
let currentOrigin = '';

function store(): DiagnosticQueueStore {
  return queueStoreOverride ?? tokenStorage();
}

/** Test seam — point the queue at an in-memory store. Real builds never call
 *  this; `__resetDiagnosticsForTests` puts it back. */
export function __setDiagnosticsQueueStoreForTests(next: DiagnosticQueueStore | null): void {
  queueStoreOverride = next;
}

/** Test seam — wipe module state between cases. */
export function __resetDiagnosticsForTests(): void {
  buffer.clear();
  knownSecrets = [];
  currentOrigin = '';
  queueStoreOverride = null;
  if (captureHandle !== null) {
    captureHandle.remove();
    captureHandle = null;
  }
}

/**
 * Register the gateway the app is pointed at, so every report captured from now
 * on is bound to it and can never be delivered to a different instance. Called
 * once the server config has been hydrated (`app/app/_layout.tsx`) and again on
 * every server change (`app/components/DiagnosticsSync.tsx`).
 */
export function setDiagnosticsOrigin(origin: string): void {
  currentOrigin = typeof origin === 'string' ? origin : '';
}

/**
 * Register the credentials the redactor must never let through. Called with the
 * live bearer on every session change.
 */
export function setDiagnosticsSecrets(secrets: readonly string[]): void {
  knownSecrets = secrets.filter((secret) => typeof secret === 'string' && secret.length >= 8);
}

export interface RecordInput {
  level?: DiagnosticLevel;
  kind: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
  /** Epoch ms; defaults to now. Injected by tests. */
  at?: number;
}

/**
 * Record an observation. Redacted BEFORE it enters the buffer, so a credential
 * never sits in the device's memory either — not just never on the wire.
 */
export function recordDiagnosticEvent(input: RecordInput): void {
  const event: DiagnosticEvent = {
    at: input.at ?? Date.now(),
    level: input.level ?? 'info',
    kind: input.kind,
    message: input.message,
  };
  if (input.stack !== undefined) event.stack = input.stack;
  if (input.context !== undefined) event.context = input.context;
  buffer.record(redactEvent(event, knownSecrets));
}

/** The current window, for a report or for a UI preview. */
export function diagnosticEvents(): DiagnosticEvent[] {
  return buffer.snapshot();
}

/**
 * Build a report from the current window and PERSIST it immediately.
 *
 * "Immediately" is the whole contract: this is called from crash paths where
 * the next thing that happens may be the process dying. The write is one
 * AsyncStorage `setItem`, which normally lands; a hard native abort in that
 * window can still lose it, and that is an honest residual rather than
 * something the code pretends to solve.
 */
export async function captureReport(reason: ReportReason): Promise<ClientReport | null> {
  const events = buffer.snapshot();
  if (events.length === 0 && reason !== 'manual') return null;
  const report = buildClientReport({
    report_id: newReportId(),
    created_at: Date.now(),
    origin: currentOrigin,
    reason,
    app: resolveAppContext(),
    signed_in: knownSecrets.length > 0,
    events,
    secrets: knownSecrets,
  });
  await enqueueReport(store(), report);
  return report;
}

/** How many reports are waiting to be delivered. Surfaced in Settings. */
export async function pendingReportCount(): Promise<number> {
  return (await readQueue(store())).length;
}

export interface FlushInput {
  base_url: string;
  token: string;
  fetchFn?: typeof globalThis.fetch;
}

/**
 * Deliver everything queued to the owner's gateway. Called on the first
 * authenticated render of each launch — the point at which a report from a
 * PREVIOUS, failed launch finally has a bearer to travel with.
 */
export async function flushDiagnostics(input: FlushInput): Promise<FlushResult> {
  setDiagnosticsSecrets([...knownSecrets, input.token]);
  setDiagnosticsOrigin(input.base_url);
  const clientOpts = {
    base_url: input.base_url,
    token: input.token,
    ...(input.fetchFn !== undefined ? { fetchFn: input.fetchFn } : {}),
  };
  const client = new DiagnosticsClient(clientOpts);
  return await flushQueue({
    store: store(),
    // Deliver ONLY what was captured against this gateway.
    origin: input.base_url,
    // Hand the gateway's OWN accepted count back to the queue: pruning is
    // driven by what the server confirmed it kept, never by "the POST returned
    // 200" (Codex r1 P1 — a 15-report flush against a 10-report server cap used
    // to destroy the 5 the gateway dropped).
    send: async (reports) => {
      const result = await client.sendReports(reports);
      return { ok: result.ok, accepted: result.accepted };
    },
  });
}

/**
 * The manual "Send diagnostics" action in Settings: snapshot now, queue it,
 * deliver everything. Returns the flush result so the UI can say what happened
 * instead of pretending it worked.
 */
export async function sendDiagnosticsNow(input: FlushInput): Promise<FlushResult> {
  recordDiagnosticEvent({ kind: 'lifecycle', level: 'info', message: 'manual diagnostics snapshot' });
  await captureReport('manual');
  return await flushDiagnostics(input);
}

/**
 * Install the global handlers. Idempotent — a second call is a no-op, so an
 * accidental double-mount cannot chain the handler to itself.
 *
 * `host` defaults to `globalThis`, which is where both `ErrorUtils` (React
 * Native) and `addEventListener` (web) live.
 */
export function installDiagnostics(host?: CaptureHost): void {
  if (captureHandle !== null) return;
  const resolved = host ?? (globalThis as unknown as CaptureHost);
  captureHandle = installGlobalCapture(resolved, {
    now: () => Date.now(),
    record: (event) => buffer.record(redactEvent(event, knownSecrets)),
    captureFatal: (event) => {
      buffer.record(redactEvent(event, knownSecrets));
      const reason: ReportReason =
        event.kind === 'unhandled_rejection' ? 'unhandled_rejection' : 'js_error';
      // Fire-and-forget: a global error handler cannot await, and a rejection
      // here would itself become an unhandled rejection.
      void captureReport(reason).catch(() => undefined);
    },
  });
  recordDiagnosticEvent({ kind: 'lifecycle', level: 'info', message: 'app launch' });
}

/** Detach the global handlers (tests + hot reload). */
export function uninstallDiagnostics(): void {
  if (captureHandle === null) return;
  captureHandle.remove();
  captureHandle = null;
}

/** Report ids only need to be unique within one device's queue, so a
 *  timestamp + a short random suffix is sufficient and dependency-free. */
function newReportId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${random}`;
}

/**
 * Build metadata for the report. Resolved lazily through `require` so this
 * module imports cleanly under `bun test` with no Expo / React Native present —
 * the same lazy-platform pattern `lib/token-storage.ts` uses.
 */
function resolveAppContext(): ReportAppContext {
  const context: ReportAppContext = {
    version: 'unknown',
    build: null,
    platform: 'unknown',
    os_version: null,
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Platform } = require('react-native') as {
      Platform: { OS: string; Version?: string | number };
    };
    context.platform = Platform.OS;
    if (Platform.Version !== undefined) context.os_version = String(Platform.Version);
  } catch {
    // Not running on a React Native host (bun test, SSR export).
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Constants = (require('expo-constants') as { default?: unknown }).default as
      | {
          expoConfig?: { version?: string | null } | null;
          nativeBuildVersion?: string | null;
        }
      | undefined;
    const version = Constants?.expoConfig?.version;
    if (typeof version === 'string') context.version = version;
    const build = Constants?.nativeBuildVersion;
    if (typeof build === 'string') context.build = build;
  } catch {
    // Same — absent outside an Expo runtime.
  }
  return context;
}
