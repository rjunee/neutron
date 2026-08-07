/**
 * Expo config — thin wrapper over app.json whose ONLY job is to resolve the
 * Android Firebase config file at build time (ISSUES #385).
 *
 * WHY THIS EXISTS: `expo-notifications` pulls Firebase/FCM native libs into the
 * Android build, and the generated manifest registers
 * `com.google.firebase.provider.FirebaseInitProvider` — a ContentProvider that
 * runs at PROCESS START, before any Activity. With no `google-services.json`
 * applied, `google_app_id` is absent from resources and the process dies
 * instantly: the app "flashes and closes" with no JS ever executing, which is
 * exactly what Ryan saw on two consecutive builds.
 *
 * WHY IT IS NOT COMMITTED: `neutron-open` is a PUBLIC repo. Committing the
 * config would bake the PUBLISHER'S Firebase project into every fork and
 * self-hosted build, so other people's devices would register for push against
 * our project. That is the same class of mistake as baking one operator's server URL
 * into the app (SPEC Decisions Log 2026-07-25) and it is unreversible once in
 * git history. The file is therefore an EAS **file** env var
 * (`GOOGLE_SERVICES_JSON`, secret, set on development/preview/production) that
 * EAS materialises on disk at build time and exposes here as a PATH.
 *
 * A self-hoster building their own Android app supplies THEIR OWN
 * `google-services.json` — either via the same EAS variable or by dropping it
 * at `app/google-services.json` (gitignored). Push then routes through their
 * Firebase project, not ours, which is the correct ownership boundary.
 */
const { expo } = require('./app.json')

module.exports = () => ({
  expo: {
    ...expo,
    android: {
      ...expo.android,
      // EAS supplies an absolute path; a local build falls back to the
      // gitignored file beside this config. One expression, no branching.
      //
      // `||`, NOT `??` — and this is load-bearing rather than style. `??` falls
      // back only on null/undefined, so an EAS variable that EXISTS but is EMPTY
      // (cleared, or created with no value) resolves `googleServicesFile: ''`.
      // That is not a loud failure: it produces a build with no Firebase config,
      // which is precisely the instant `FirebaseInitProvider` crash this file
      // exists to prevent — flash and close, no JS, no error to read. An empty
      // string must take the fallback like any other missing value. Guarded by
      // `__tests__/android-fcm-config.test.ts`; do not "modernise" this to `??`.
      googleServicesFile: process.env.GOOGLE_SERVICES_JSON || './google-services.json',
    },
  },
})
