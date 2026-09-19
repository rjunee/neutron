## 2026-09-19 — Resolve Expo publisher identity from private configuration

The public-source PII rule in `AGENTS.md` and the locked pivot plan's
“Keep the gates, replace the loop” requirement apply to deployment configuration
as well as prose. `app/app.json` previously embedded the active publisher account.
`app/app.config.js:29` now requires `NEUTRON_EXPO_OWNER` and preserves its exact
value in the resolved owner field. Missing, empty, or whitespace-only values throw
without echoing the input. The static owner field is removed. A historical
named-system reference in the activity inspector comment is also generalized.

Both EAS wrappers resolve config before doing work: build before dependency
preflight, fingerprinting, or remote lookup; update before deleting its old export.
The existing Firebase fallback, project ID, update URL, native identifiers,
plugins, build profiles, and verified-export publication path remain intact.

Before deployment, the publisher must provision the exact existing account value
as `NEUTRON_EXPO_OWNER` in their private local shell and in each used EAS environment
(development, preview, production). Use **sensitive**, not secret, EAS visibility:
local config resolution needs access. These wrappers run local operations before
EAS retrieves remote variables, so EAS provisioning alone is insufficient. Direct
Expo config/export/start commands also need the local variable. No account transfer,
new project, CI secret edit, build, or update is performed by this source change.
Until provisioned, config-dependent commands fail closed. This removes the literal
from current public source; it does not erase git history or hide resolved app
metadata from Expo. See [Expo's environment documentation](https://docs.expo.dev/eas/environment-variables/).

Validation: 19 consuming tests cover Android Firebase config, owner resolution,
dependency preflight, and both wrappers with stubbed external commands. Two
synthetic publishers succeed independently; unset/blank values fail before side
effects. Private old/new config comparison with the existing publisher value
reported complete equality without recording that value. Mutations accepting
missing input, rejecting valid input, and hardcoding one publisher were all killed
by the owner tests. Root and app TypeScript checks pass after a frozen isolated
dependency install. The real local leak gate passes on all changed files with
the private denylist loaded; this scoped check does not certify unrelated files.
