# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v54.0.0/ before writing any code.

# Android builds — fingerprint runtime parity (do not break these)

`runtimeVersion.policy` is `fingerprint`: the runtime version is a hash of the
native project inputs, computed BOTH on the submitting machine (by eas-cli) and
on the EAS builder. If the two disagree, the build fails in the
"Configure expo-updates" phase with "Runtime version mismatch". Three inputs
must therefore be identical on both sides:

1. **bun version.** `eas.json` pins `bun` (base profile) to the version
   installed locally. bun's isolated linker (1.3+) resolves packages through
   `node_modules/.bun/<pkg>@<ver>+<hash>/…` store paths and the fingerprint
   keys sources by path, so a builder on a different bun (e.g. 1.2.x hoisted
   layout) can never agree with a 1.3.x machine. If you upgrade bun locally,
   bump the pin in the same change.
2. **`google-services.json` contents.** The file is gitignored (public repo —
   it carries the publisher's Firebase project) and reaches the builder via the
   secret EAS file env var `GOOGLE_SERVICES_JSON` (all three environments).
   The fingerprint hashes its CONTENTS on both sides
   (`expoConfigExternalFile:contentsOnly`), so the env var must byte-match the
   local `app/google-services.json`. After replacing the local file, re-sync:
   `eas env:update --variable-name GOOGLE_SERVICES_JSON --variable-environment
   <env> --type file --value ./google-services.json --non-interactive` for
   development, preview, and production.
3. **No generated `android/` dir in the checkout.** A leftover `expo prebuild`
   / `expo run:android` output at `app/android/` (gitignored) flips the local
   fingerprint to bare-workflow hashing while the builder prebuilds fresh —
   guaranteed mismatch. Delete it before running `eas build`.
