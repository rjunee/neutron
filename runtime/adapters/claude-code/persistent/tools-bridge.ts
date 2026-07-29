/**
 * @neutronai/runtime — tools-bridge BOOTSTRAP entry (spawned as its own Bun
 * process by spawn.ts; DEFAULT_TOOLS_BRIDGE_PATH points here).
 *
 * F3 static-import coverage: a module's `import` statements RESOLVE + EVALUATE
 * before any body statement runs, so an in-body `installProcessSafetyNet()`
 * could not cover a failure in THIS entry's own static graph (e.g. an
 * unresolvable `@modelcontextprotocol/sdk`). This thin loader's ONLY static
 * import is the tiny, stable logger leaf; it arms the net FIRST, then
 * DYNAMICALLY imports the real body (`./tools-bridge-impl.ts`) — whose entire
 * static-import graph therefore evaluates AFTER the net is armed, so a missing
 * dependency / throwing module-init there is logged-then-crashed with structure.
 * The bridge's behavior + security model live in `tools-bridge-impl.ts`.
 */
import { installProcessSafetyNet } from '@neutronai/logger/fire-and-forget.ts'

installProcessSafetyNet()

await import('./tools-bridge-impl.ts')
