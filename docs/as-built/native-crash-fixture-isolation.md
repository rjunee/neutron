## 2026-09-18 — Native-crash fixture uses the device harness

### What changed

The native-crash reporting fixture now installs the existing device-shaped test
harness before dynamically loading the diagnostics runtime. The bounded runner's
content-derived classifier consequently moves the file out of the ordinary app
chunk and into the isolated device lane.

The fixture adds no `mock.module` registration. It still exercises the real
`importNativeCrashReport` path, including runtime app-context resolution, durable
queue confirmation, deletion-after-persistence, refusal preservation, native
envelope conversion, and redaction.

### Why

The fixture statically loaded the diagnostics runtime while later calling its
lazy `expo-constants` lookup. In the runner's 100-file app chunk, that lookup
shared a process with an unrelated fixture's process-global Expo mock and could
link the real React Native package under Bun. The resulting missing
`TurboModuleRegistry` export failed between tests even though the native-crash
file and the full app directory each passed independently.

This is a fixture-boundary defect: the tested path consumes native modules, so it
belongs in the repository's existing native-harness isolation lane. Production
diagnostics code and behavior are unchanged.

### Verification

- Baseline runner chunk order: 1,234 pass, 1 fail, 1 unhandled linker error
  across 100 files; the error reached `native-crash-reporting.test.ts:138` from
  the lazy Expo lookup.
- Regenerated general chunk 1: 1,264 pass, 0 fail across 100 files. This is the
  no-global-pollution direction: the native fixture is absent from the ordinary
  module-mock process.
- Regenerated device lane: 366 pass, 0 fail across 40 files. This is the native
  behavior direction: the fixture runs its six assertions with the real
  diagnostics runtime behind the device-shaped module aliases.
- `bunx tsc -p tsconfig.json --noEmit` — pass.
- `bunx tsc -p trident/tsconfig.json --noEmit` — pass.

### Scope

This change does not alter `app/lib/diagnostics.ts`, the native crash plugin, the
runner, or the global module registry. It only makes the fixture declare the
native runtime it already exercises.
