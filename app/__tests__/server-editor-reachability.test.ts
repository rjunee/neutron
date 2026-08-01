/**
 * @neutronai/app — the server editor must be REACHABLE (ISSUES #385).
 *
 * Argus r2 BLOCKER: the first version of #385 put the ONLY on-device
 * server editor on `/settings`, a route that was REGISTERED
 * (`app/app/_layout.tsx` `<Stack.Screen name="settings" />`) but never
 * pushed from anywhere in the app. A fresh install could configure a host
 * on the boot gate, then lose it to a DHCP lease change, and from then on
 * `configured === true` skipped the gate while no reachable UI could
 * correct the address — reinstall was the only escape. The blocker got
 * through review because "WIRED + SERVED" rested on code reading alone.
 *
 * This file is the mechanical guard for that class of defect. The app
 * suite has no React Native mount harness (no
 * `@testing-library/react-native`; `react-test-renderer` is deprecated in
 * React 19 — see the note atop `diagnostics-pane-render.test.ts`), so the
 * checks are SOURCE-level, in the established style of
 * `push-deep-link-routing.test.ts` ("source-pin") — with one difference
 * that makes this more than a presence check: the first test ENUMERATES
 * every `router.push`/`replace` target in `app/` and asserts `/settings`
 * is among them, so deleting the button fails here no matter which file
 * it lived in.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const APP_ROOT = join(__dirname, '..');

function sourceFiles(dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
  };
  for (const dir of dirs) walk(join(APP_ROOT, dir));
  return out;
}

/** Every literal target passed to `router.push(...)` / `router.replace(...)`. */
function navTargets(): Set<string> {
  const targets = new Set<string>();
  const re = /router\.(?:push|replace)\(\s*['"`]([^'"`]*)['"`]/g;
  for (const file of sourceFiles(['app', 'components', 'lib'])) {
    const src = readFileSync(file, 'utf8');
    for (const match of src.matchAll(re)) targets.add(match[1]!);
  }
  return targets;
}

function read(...parts: string[]): string {
  return readFileSync(join(APP_ROOT, ...parts), 'utf8');
}

describe('#385 — /settings is navigable (the only signed-in server editor)', () => {
  it('some screen actually pushes /settings', () => {
    const targets = navTargets();
    expect([...targets].sort()).toContain('/settings');
  });

  it('the CHAT header carries the entry (the projects header is deleted)', () => {
    // Until 2026-07-29 this entry lived in the projects-list header
    // (`projects-settings-btn`). That screen is DELETED — the app opens straight
    // into chat with the rail (SPEC § Decisions Log 2026-07-27) — so the ONLY
    // signed-in path to the server editor is now the project shell's header:
    // ☰ → /settings. Deleting the screen without re-homing this would have
    // recreated the exact #385 defect, which is why the assertion moved rather
    // than being dropped.
    const shell = read('app', 'projects', '[id]', '_layout.tsx');
    expect(shell).toContain("router.push('/settings')");
    const header = read('components', 'ProjectHeader.tsx');
    expect(header).toContain('project-header-app-settings');
    expect(header).toContain('onOpenAppSettings');
    expect(shell).toContain('onOpenAppSettings={');
  });

  it('/admin is reachable too — one hop further, from inside /settings', () => {
    // Same story: `/admin` was pushed ONLY from the deleted list header. It now
    // hangs off Settings (☰ → Settings → Admin), and `navTargets()` above proves
    // *some* screen pushes it.
    const settings = read('app', 'settings.tsx');
    expect(settings).toContain('settings-admin');
    expect(settings).toContain("router.push('/admin')");
    expect([...navTargets()]).toContain('/admin');
  });

  it('/settings is still registered on the Stack (a push at a dead route routes nowhere)', () => {
    expect(read('app', '_layout.tsx')).toContain('<Stack.Screen name="settings" />');
  });
});

describe('#385 — the server editor is reachable while UNAUTHENTICATED', () => {
  it('/login mounts the same ServerConnectForm', () => {
    // /settings redirects to /login the moment auth resolves to
    // unauthenticated (`lib/auth-helpers.ts:shouldRedirectToLogin`), and
    // the boot gate only shows when NOTHING is configured — so without an
    // affordation here, a wrong persisted host + no token is a dead end
    // (Argus r2 MAJOR).
    const src = read('app', 'login.tsx');
    expect(src).toContain('ServerConnectForm');
    expect(src).toContain('login-change-server');
    expect(src).toContain('login-server-url');
  });

  it('the login redirect guard is unchanged (this test would be vacuous otherwise)', () => {
    const helpers = read('lib', 'auth-helpers.ts');
    expect(helpers).toContain('shouldRedirectToLogin');
    expect(read('app', 'settings.tsx')).toContain('shouldRedirectToLogin');
  });
});

describe('#385 — boot hydration wiring', () => {
  const layout = read('app', '_layout.tsx');

  it('hydration is awaited BEFORE the app tree renders', () => {
    // Unchanged and still essential: `loadAppConfig()` is synchronous and
    // ~20 call sites read it inside `useMemo`, so the persisted server URL
    // has to be in the module cache before anything mounts.
    expect(layout).toContain('await hydrateServerConfig()');
    expect(layout).toContain("setPhase('ready')");
  });

  it('an UNCONFIGURED install mounts the Stack and lands on /login', () => {
    // SUPERSEDED BY LOGIN-FIRST (SPEC § Decisions Log 2026-07-25). #385
    // rendered `ServerSetupGate` INSTEAD of the Stack while unconfigured,
    // which made "type your instance address" the first thing a new owner
    // saw. Ryan: "why does it have to ask? it should just open with a login
    // screen, and once you login it should know the url." So the gate is
    // deleted and the Stack always mounts.
    //
    // The #385 INVARIANT this test originally protected — never issue a
    // request against an unconfigured install — is now enforced at the entry
    // route instead, which is what the assertions below check. Full coverage
    // of the replacement lives in `login-first-discovery.test.ts`.
    expect(layout).not.toContain("if (phase === 'setup')");
    expect(layout).toContain('<Stack screenOptions');

    const index = read('app', 'index.tsx');
    expect(index).toContain('loadAppConfig()');
    // Both hold conditions go through the SHARED predicate — never a bare
    // `user === null`, which would flash /login on every cold start while the
    // session is still hydrating (Argus BLOCKER on PR #13). The predicate's
    // behaviour is asserted in `auth-helpers.test.ts` § shouldHoldOnLogin.
    expect(index).toContain('shouldHoldOnLogin({ configured, status, user })');
    expect(index).toContain("router.replace('/login')");
  });

  it('the app tree is KEYED on the server-config epoch', () => {
    // Argus r2 MAJOR — ~10 screens freeze `loadAppConfig()` in
    // `useMemo(() => loadAppConfig(), [])`, so mutating the module cache
    // alone leaves mounted screens talking to the OLD host.
    expect(layout).toContain('subscribeServerConfig');
    expect(layout).toContain('getServerConfigEpoch');
    expect(layout).toContain('key={`server-${serverEpoch}`}');
  });
});

describe('#385 — Settings server card', () => {
  const settings = read('app', 'settings.tsx');

  it('renders the current server and the change affordance', () => {
    expect(settings).toContain('settings-server-card');
    expect(settings).toContain('settings-server-url');
    expect(settings).toContain('settings-change-server');
    expect(settings).toContain('ServerConnectForm');
  });

  it('bounces to /login on HOST CHANGE, not merely on session_cleared', () => {
    expect(settings).toContain('result.host_changed');
    expect(settings).not.toContain('result.session_cleared');
    expect(settings).toContain("router.replace('/login')");
  });
});

describe('#385 — one commit path, no duplicated rules', () => {
  it('every server-editing surface goes through commitServerConfig', () => {
    // NO FEATURE FLAGS / no dual code paths. This list is EXHAUSTIVE on
    // purpose: a new writer of the persisted server config has to be added
    // here consciously, which is what stops a second set of
    // normalise/validate/persist rules from growing.
    //
    // Two callers as of 2026-07-25 (login-first): the typed-URL form, and
    // discovery's adopt step. Both DELEGATE to the single implementation in
    // `lib/server-url.ts` — a discovered `publicUrl` is normalised and
    // /healthz-validated by exactly the same code as a typed one, so this is
    // one path with two entry points, not two paths.
    const callers = sourceFiles(['app', 'components', 'lib'])
      .filter((file) => !file.endsWith(join('lib', 'server-url.ts')))
      .filter((file) => /commitServerConfig\(/.test(readFileSync(file, 'utf8')));
    expect(callers.map((f) => f.replace(`${APP_ROOT}/`, '')).sort()).toEqual([
      'components/ServerConnectForm.tsx',
      'lib/identity-client.ts',
    ]);
  });

  it('no module reintroduces a loopback default outside the UI prefill', () => {
    const offenders = sourceFiles(['lib', 'components']).filter((file) => {
      // `server-url.ts` holds LOCAL_DEV_SUGGESTION (a form prefill, never
      // a resolver default — see its own unit test).
      if (file.endsWith(join('lib', 'server-url.ts'))) return false;
      // Comment lines are excluded: `lib/config.ts` documents the deleted
      // `DEFAULT_GATEWAY_BASE` in prose on purpose.
      return readFileSync(file, 'utf8')
        .split('\n')
        .some(
          (line) =>
            !/^\s*(\*|\/\/|\/\*)/.test(line) &&
            /=\s*['"`]https?:\/\/(127\.0\.0\.1|localhost)/.test(line),
        );
    });
    expect(offenders.map((f) => f.replace(`${APP_ROOT}/`, ''))).toEqual([]);
  });
});

describe('#385 — eas.json build profiles', () => {
  const eas = JSON.parse(read('eas.json')) as {
    build: Record<string, Record<string, unknown>>;
  };

  it('every profile selects an EAS environment (the server-side env-var set)', () => {
    // SPEC DEVIATION, documented in app/README.md and flagged for Ryan's
    // ack: the brief asked for an `env` block, but an `eas.json` `env`
    // block takes LITERAL values only, so `"$EXPO_PUBLIC_NEUTRON_BASE_URL"`
    // would be baked in verbatim and every build would resolve a garbage
    // "configured" host. `environment` is the field that loads server-side
    // variables. UNVERIFIED against a live EAS schema — `eas-cli` is not a
    // repo dependency; this only guards the values we chose.
    expect(Object.keys(eas.build).sort()).toEqual(['development', 'preview', 'production']);
    for (const [name, profile] of Object.entries(eas.build)) {
      expect(['development', 'preview', 'production']).toContain(
        profile['environment'] as string,
      );
      expect(profile['environment']).toBe(name);
    }
  });

  it('no literal env values — a hostname in eas.json would ship in this PUBLIC repo', () => {
    const raw = read('eas.json');
    expect(raw).not.toContain('EXPO_PUBLIC_NEUTRON_BASE_URL');
    expect(raw).not.toContain('EXPO_PUBLIC_NEUTRON_AUTH_BASE_URL');
  });
});

describe('#385 — native cleartext permissions + OTA gate', () => {
  const appJson = JSON.parse(read('app.json')) as {
    expo: Record<string, unknown>;
  };

  it('iOS relaxes ATS for the LAN ONLY (NSAllowsArbitraryLoads stays unset)', () => {
    const ios = appJson.expo['ios'] as Record<string, Record<string, Record<string, unknown>>>;
    const ats = ios['infoPlist']!['NSAppTransportSecurity']!;
    expect(ats['NSAllowsLocalNetworking']).toBe(true);
    expect(ats['NSAllowsArbitraryLoads']).toBeUndefined();
  });

  it('Android permits cleartext (the host is user-supplied, so it cannot be domain-scoped)', () => {
    const plugins = appJson.expo['plugins'] as unknown[];
    const buildProps = plugins.find(
      (p): p is [string, Record<string, Record<string, unknown>>] =>
        Array.isArray(p) && p[0] === 'expo-build-properties',
    );
    expect(buildProps).toBeDefined();
    expect(buildProps![1]['android']!['usesCleartextTraffic']).toBe(true);
  });

  it('runtimeVersion is FINGERPRINT, so a native change cannot be OTA\'d to a build that lacks it', () => {
    // Argus r2 MAJOR, restated under the mechanism that now enforces it.
    //
    // The requirement has not changed: the mandatory gate above depends on
    // two NATIVE permissions applied by `expo prebuild` at BUILD time, so an
    // OTA'd install would render a gate whose LAN probe the platform blocks
    // and never get past it. Such a bundle must never reach an older build.
    //
    // What changed is HOW that is guaranteed. This test used to assert
    // `policy: 'appVersion'` plus a hand-bumped `version` — i.e. it pinned a
    // MANUAL workaround, and the guarantee only held for as long as someone
    // remembered to bump. Under `appVersion` a native dependency added
    // WITHOUT a version bump keeps the old runtimeVersion, and expo-updates
    // then judges the bundle compatible with builds that cannot run it. That
    // is not hypothetical: it was found the day `expo-audio` was added for
    // voice messages.
    //
    // `fingerprint` hashes the native project, so ANY native change yields a
    // new runtimeVersion on its own. The gate is now a property of the
    // tooling rather than of anyone's memory, which is strictly stronger than
    // what this test previously pinned.
    expect(appJson.expo['runtimeVersion']).toEqual({ policy: 'fingerprint' });

    // Still pinned: the two version fields must not drift apart. They no
    // longer gate OTA eligibility, but a mismatch misreports the release.
    const version = appJson.expo['version'] as string;
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).toBe(version);
  });
});
