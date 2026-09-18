## 2026-09-18 — The projects client storage fixture survives an earlier entry-route test

The shared test process could select its device reader before the projects-client
suite installed its browser storage fixture. `installationDeviceId`
(`app/lib/installation-device.ts:25`) caches that backing. The AsyncStorage web
implementation selected by earlier entry-route tests reads `window.localStorage`,
while the fixture supplied only `globalThis.localStorage`. Consequently the real
client correctly treated storage as unavailable and omitted the device header
(`app/lib/projects-client.ts:249`), defeating the test's available-storage premise.

The fixture now exposes one backing through both browser access paths and
restores both original global property descriptors afterward
(`app/__tests__/projects-client.test.ts:3`). The production reader, fallback, and
header assertion remain unchanged. This is a test-environment correction, not a
change to what an unavailable device store means.

On base `9adb9ac`, the explicit ordered command
`bun test ./app/__tests__/mobile-entry-route.test.ts ./app/__tests__/projects-client.test.ts`
failed the device-header assertion, while the isolated projects-client file
passed all 11 tests. The corrected ordered pair passes all 27 tests. Adding
`./app/__tests__/installation-device.test.ts` first passes all 29 tests, including
the storage-failure refusal and recovery control. Removing the production
`x-device-id` writer still makes the unchanged header assertion fail; the mutation
was restored.

The exact 100-file first general chunk from the bounded full-suite runner was
replayed with explicit `./` paths, concurrency 16 and timeout 15000. It changed
from 1,233 passes and two failures to 1,234 passes and one failure: the device
header failure is gone. Both runs also encountered an independent native-module
link error importing `TurboModuleRegistry` through `expo-constants`. This record
does not claim that the complete chunk or full suite passed. Root, trident and
app TypeScript checks passed.
