import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');

function env(owner?: string) {
  const result = { ...process.env };
  delete result.NEUTRON_EXPO_OWNER;
  if (owner !== undefined) result.NEUTRON_EXPO_OWNER = owner;
  return result;
}

describe('private Expo publisher config', () => {
  it('refuses unset and blank input without exposing values', () => {
    for (const owner of [undefined, '', ' \t\n']) {
      const result = Bun.spawnSync(['node', '-e', 'require("./app/app.config.js")()'], { cwd: root, env: env(owner) });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain('NEUTRON_EXPO_OWNER must be set');
    }
  });

  it('resolves either synthetic publisher and preserves the remaining config', () => {
    const base = JSON.parse(readFileSync(join(root, 'app/app.json'), 'utf8')).expo;
    expect(base).not.toHaveProperty('owner');
    for (const owner of ['fixture-publisher-alpha', 'fixture-publisher-beta']) {
      const result = Bun.spawnSync(['node', '-e', 'console.log(JSON.stringify(require("./app/app.config.js")()))'], { cwd: root, env: { ...env(owner), GOOGLE_SERVICES_JSON: '/fixture/firebase.json' } });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toEqual({ expo: {
        ...base, owner,
        plugins: [...base.plugins, './plugins/with-native-crash-reporting'],
        android: { ...base.android, googleServicesFile: '/fixture/firebase.json' },
      } });
    }
  });

  for (const wrapper of ['eas-build.sh', 'eas-update.sh']) {
    it(`${wrapper} refuses before side effects, accepts supplied publishers`, () => {
      const fixture = mkdtempSync(join(tmpdir(), 'expo-owner-wrapper-'));
      try {
        for (const dir of ['scripts', 'app/dist', 'bin']) mkdirSync(join(fixture, dir), { recursive: true });
        copyFileSync(join(root, 'scripts', wrapper), join(fixture, 'scripts', wrapper));
        for (const file of ['app.config.js', 'app.json']) copyFileSync(join(root, 'app', file), join(fixture, 'app', file));
        const log = join(fixture, 'calls');
        writeFileSync(join(fixture, 'bin/bun'), '#!/bin/bash\nif [ "$1" = "-e" ]; then exec "$REAL_BUN" "$@"; fi\necho bun >> "$CALL_LOG"\n', { mode: 0o755 });
        writeFileSync(join(fixture, 'bin/bunx'), '#!/bin/bash\necho "$*" >> "$CALL_LOG"\n', { mode: 0o755 });
        for (const owner of [undefined, '', '  ', 'fixture-publisher-alpha', 'fixture-publisher-beta']) {
          writeFileSync(log, '');
          const marker = join(fixture, 'app/dist/previous');
          mkdirSync(join(fixture, 'app/dist'), { recursive: true });
          writeFileSync(marker, 'previous verified export');
          const args = wrapper === 'eas-update.sh' ? ['--branch', 'preview', '--message', 'fixture'] : ['--profile', 'preview'];
          const result = Bun.spawnSync(['bash', join(fixture, 'scripts', wrapper), ...args], { env: {
            ...env(owner), PATH: `${join(fixture, 'bin')}:${process.env.PATH}`, REAL_BUN: process.execPath, CALL_LOG: log,
          } });
          if (!owner?.trim()) {
            expect(result.exitCode).not.toBe(0);
            expect(result.stderr.toString()).toContain('NEUTRON_EXPO_OWNER must be set');
            expect(readFileSync(log, 'utf8')).toBe('');
            expect(readFileSync(marker, 'utf8')).toBe('previous verified export');
          } else {
            expect(result.exitCode).toBe(0);
            const calls = readFileSync(log, 'utf8');
            if (wrapper === 'eas-update.sh') {
              expect(calls).toContain('expo export');
              expect(calls).toContain('eas update --branch preview --message fixture');
              expect(calls).toContain('--skip-bundler');
            } else expect(calls).toContain('eas-cli@latest build --profile preview');
          }
        }
      } finally { rmSync(fixture, { recursive: true, force: true }); }
    });
  }
});
