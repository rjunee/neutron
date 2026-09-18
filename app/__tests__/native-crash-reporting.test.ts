import { afterEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import { buildNativeCrashReport, readNativeCrashReport } from '../lib/native-crash-import';
import { readQueue, type DiagnosticQueueStore } from '../lib/diagnostic-queue';
import { installNativeHarness } from './support/native-harness';

// `importNativeCrashReport` deliberately resolves Expo/React Native app context.
// Install the device-shaped aliases before loading that runtime. Mentioning this
// harness also places the file in run-tests.sh's isolated device lane, away from
// process-global module mocks owned by ordinary app fixtures.
installNativeHarness();

const {
  __resetDiagnosticsForTests,
  __setDiagnosticsQueueStoreForTests,
  importNativeCrashReport,
} = await import('../lib/diagnostics');

const plugin = require(join(import.meta.dir, '..', 'plugins', 'with-native-crash-reporting.js')) as {
  addCrashInitProvider(manifest: Record<string, unknown>): Record<string, unknown>;
  nativeCrashReporterSource(packageName: string): string;
};

const APP = { version: '1.2.3', build: '44', platform: 'android', os_version: '15' };

afterEach(() => __resetDiagnosticsForTests());

describe('native process-start crash reporting', () => {
  it('registers a highest-priority initializer before other process-start providers', () => {
    const manifest = {
      manifest: {
        application: [
          {
            $: { 'android:name': '.MainApplication' },
            provider: [] as { $: Record<string, string> }[],
          },
        ],
      },
    };
    const transformed = plugin.addCrashInitProvider(manifest) as typeof manifest;
    expect(transformed.manifest.application[0]?.provider).toContainEqual({
      $: {
        'android:name': '.NativeCrashInitProvider',
        'android:authorities': '${applicationId}.native-crash-init',
        'android:exported': 'false',
        'android:initOrder': '2147483647',
      },
    });
    plugin.addCrashInitProvider(transformed);
    expect(transformed.manifest.application[0]?.provider).toHaveLength(1);
  });

  it('generates a bounded synchronous handler that delegates the original crash', () => {
    const source = plugin.nativeCrashReporterSource('computer.neutron.app');
    expect(source).toContain('Thread.setDefaultUncaughtExceptionHandler');
    expect(source).toContain('class NativeCrashInitProvider');
    expect(source).toContain('NativeCrashReporter.install(it)');
    expect(source).toContain('persist(context, thread, throwable)');
    expect(source).toContain('previous.uncaughtException(thread, throwable)');
    expect(source).toContain('.take(MAX_STACK_CHARS)');
    expect(source).toContain('temporary.renameTo(target)');
  });

  it('turns the native envelope into the existing report vocabulary and redacts it', () => {
    const report = buildNativeCrashReport({
      raw: JSON.stringify({
        created_at: 123,
        message: 'provider failed bearer abcdefghijklmnop',
        stack: 'at Provider.start token=abcdefghijklmnop',
        thread: 'main',
        os_version: '16',
      }),
      origin: 'https://gateway.example.test',
      app: APP,
    });
    expect(report?.reason).toBe('native_crash');
    expect(report?.origin).toBe('https://gateway.example.test');
    expect(report?.events[0]).toMatchObject({ kind: 'native_crash', context: { thread: 'main' } });
    expect(JSON.stringify(report)).not.toContain('abcdefghijklmnop');
  });

  it('deletes only after a valid crash is read, so a failed handoff remains retryable', async () => {
    const deleted: string[] = [];
    const staged = await readNativeCrashReport({
      fileSystem: {
        documentDirectory: 'file:///data/user/0/computer.neutron.app/files/',
        readAsStringAsync: async () => JSON.stringify({ created_at: 456, message: 'startup failed' }),
        deleteAsync: async (uri) => {
          deleted.push(uri);
        },
      },
      origin: 'https://gateway.example.test',
      app: APP,
    });
    expect(staged?.report.events[0]?.message).toBe('startup failed');
    expect(deleted).toEqual([]);
    await staged?.remove();
    expect(deleted).toEqual([
      'file:///data/user/0/computer.neutron.app/files/native-crash.json',
    ]);

    let deleteCalled = false;
    const invalid = await readNativeCrashReport({
      fileSystem: {
        documentDirectory: 'file:///files/',
        readAsStringAsync: async () => 'not json',
        deleteAsync: async () => {
          deleteCalled = true;
        },
      },
      origin: '',
      app: APP,
    });
    expect(invalid).toBeNull();
    expect(deleteCalled).toBe(false);
  });

  it('removes the native file only after the existing durable queue contains it', async () => {
    let rawQueue: string | null = null;
    const store: DiagnosticQueueStore = {
      getDiagnosticsQueue: async () => rawQueue,
      setDiagnosticsQueue: async (raw) => {
        rawQueue = raw;
      },
    };
    const deleted: string[] = [];
    __setDiagnosticsQueueStoreForTests(store);
    const report = await importNativeCrashReport('https://gateway.example.test', {
      documentDirectory: 'file:///files/',
      readAsStringAsync: async () => JSON.stringify({ created_at: 789, message: 'provider crash' }),
      deleteAsync: async (uri) => {
        expect((await readQueue(store)).some((queued) => queued.report_id === 'native-789')).toBe(true);
        deleted.push(uri);
      },
    });
    expect(report?.reason).toBe('native_crash');
    expect(deleted).toEqual(['file:///files/native-crash.json']);
  });

  it('keeps the native file when the durable queue refuses the handoff', async () => {
    let deleted = false;
    __setDiagnosticsQueueStoreForTests({
      getDiagnosticsQueue: async () => null,
      setDiagnosticsQueue: async () => {
        throw new Error('storage unavailable');
      },
    });
    const report = await importNativeCrashReport('', {
      documentDirectory: 'file:///files/',
      readAsStringAsync: async () => JSON.stringify({ created_at: 790, message: 'provider crash' }),
      deleteAsync: async () => {
        deleted = true;
      },
    });
    expect(report).toBeNull();
    expect(deleted).toBe(false);
  });
});
