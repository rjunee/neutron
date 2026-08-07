/**
 * @neutronai/app — `app.config.js` Android Firebase resolution (ISSUES #385, #487).
 *
 * WHAT THIS PROTECTS. `app.config.js` exists for one reason: `expo-notifications`
 * pulls Firebase native libs into the Android build, and the generated manifest
 * registers `FirebaseInitProvider` — a ContentProvider that runs at PROCESS
 * START. With no `google-services.json` applied, `google_app_id` is missing from
 * resources and the process dies before any JS executes: the app flashes and
 * closes. That happened on two consecutive builds. The file also supplies the
 * client half of push delivery.
 *
 * It had NO test. So the single expression standing between the app and an
 * instant-crash build was unguarded, in a file whose whole job is one line.
 *
 * WHY THE ASSERTIONS TARGET THIS FILE AND NOT `app.json`. `app.json` deliberately
 * does NOT carry `googleServicesFile` — committing a real Firebase config to a
 * PUBLIC repo would bake the publisher's project into every fork. The value is
 * supplied at build time from the `GOOGLE_SERVICES_JSON` EAS file variable, with
 * a gitignored local fallback. A test that read `app.json` would therefore assert
 * the key is ABSENT and "pass" while proving nothing — I wrote exactly that test
 * first, having checked `app.json` and concluded the config was missing without
 * checking what actually resolves it.
 *
 * WHAT NO TEST HERE CAN COVER: the SERVER half. Android delivery also needs an
 * FCM V1 service-account credential registered on the Expo project, which lives
 * in EAS and not in this repo. Its absence is what produces
 * `InvalidCredentials — "Unable to retrieve the FCM server key"` on every send,
 * with a perfectly valid client config. **A green run of this file does not mean
 * push works.**
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const loadConfig = require(join(import.meta.dir, '..', 'app.config.js')) as () => {
  expo: { android: { googleServicesFile?: string; package?: string } };
};

const ORIGINAL = process.env['GOOGLE_SERVICES_JSON'];

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env['GOOGLE_SERVICES_JSON'];
  else process.env['GOOGLE_SERVICES_JSON'] = ORIGINAL;
});

describe('app.config.js — android googleServicesFile', () => {
  it('uses the EAS-supplied absolute path when the build variable is set', () => {
    // This is the branch every cloud build takes. EAS materialises the secret
    // file and exposes its PATH; hardcoding a relative path would ignore it and
    // produce an FCM-less build.
    process.env['GOOGLE_SERVICES_JSON'] = '/var/secrets/google-services.json';
    expect(loadConfig().expo.android.googleServicesFile).toBe(
      '/var/secrets/google-services.json',
    );
  });

  it('falls back to the gitignored local file when the variable is unset', () => {
    // The local-build branch. Without a fallback, a developer build resolves
    // undefined and crashes at process start rather than failing loudly.
    delete process.env['GOOGLE_SERVICES_JSON'];
    expect(loadConfig().expo.android.googleServicesFile).toBe('./google-services.json');
  });

  it('never resolves empty or undefined', () => {
    // The failure mode that matters: an EMPTY string is falsy-but-present and
    // would sail past a `!== undefined` check while still yielding a build with
    // no Firebase config — indistinguishable from the crash case at runtime.
    for (const value of ['', undefined]) {
      if (value === undefined) delete process.env['GOOGLE_SERVICES_JSON'];
      else process.env['GOOGLE_SERVICES_JSON'] = value;
      const resolved = loadConfig().expo.android.googleServicesFile;
      expect(typeof resolved).toBe('string');
      expect((resolved ?? '').length).toBeGreaterThan(0);
    }
  });

  it('preserves the rest of the android config it spreads over', () => {
    // The wrapper REPLACES `android`; a spread that dropped `package` would
    // change the application id and silently break the FCM client mapping,
    // which is keyed on package name.
    expect(loadConfig().expo.android.package).toBe('computer.neutron.app');
  });
});
