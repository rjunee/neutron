import type { ClientReport, ReportAppContext } from './diagnostic-report';
import { buildClientReport } from './diagnostic-report';

export const NATIVE_CRASH_FILE = 'native-crash.json';

export interface NativeCrashFileSystem {
  documentDirectory: string | null;
  readAsStringAsync(uri: string): Promise<string>;
  deleteAsync(uri: string, options?: { idempotent?: boolean }): Promise<void>;
}

export interface NativeCrashEnvelope {
  created_at?: unknown;
  message?: unknown;
  stack?: unknown;
  thread?: unknown;
  os_version?: unknown;
}

export function buildNativeCrashReport(input: {
  raw: string;
  origin: string;
  app: ReportAppContext;
}): ClientReport | null {
  let envelope: NativeCrashEnvelope;
  try {
    const parsed: unknown = JSON.parse(input.raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    envelope = parsed as NativeCrashEnvelope;
  } catch {
    return null;
  }
  const createdAt =
    typeof envelope.created_at === 'number' && Number.isFinite(envelope.created_at)
      ? envelope.created_at
      : Date.now();
  const message = typeof envelope.message === 'string' ? envelope.message : 'Native process crash';
  const stack = typeof envelope.stack === 'string' ? envelope.stack : undefined;
  return buildClientReport({
    report_id: `native-${createdAt}`,
    created_at: createdAt,
    origin: input.origin,
    reason: 'native_crash',
    app: {
      ...input.app,
      os_version:
        typeof envelope.os_version === 'string' ? envelope.os_version : input.app.os_version,
    },
    signed_in: false,
    events: [
      {
        at: createdAt,
        level: 'error',
        kind: 'native_crash',
        message,
        ...(stack !== undefined ? { stack } : {}),
        ...(typeof envelope.thread === 'string' ? { context: { thread: envelope.thread } } : {}),
      },
    ],
  });
}

export interface StagedNativeCrashReport {
  report: ClientReport;
  remove(): Promise<void>;
}

export async function readNativeCrashReport(input: {
  fileSystem: NativeCrashFileSystem;
  origin: string;
  app: ReportAppContext;
}): Promise<StagedNativeCrashReport | null> {
  const root = input.fileSystem.documentDirectory;
  if (root === null) return null;
  const uri = `${root}${NATIVE_CRASH_FILE}`;
  let raw: string;
  try {
    raw = await input.fileSystem.readAsStringAsync(uri);
  } catch {
    return null;
  }
  const report = buildNativeCrashReport({
    raw,
    origin: input.origin,
    app: input.app,
  });
  if (report === null) return null;
  return {
    report,
    remove: async () => {
      await input.fileSystem.deleteAsync(uri, { idempotent: true });
    },
  };
}
