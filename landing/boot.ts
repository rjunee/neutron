/**
 * @neutronai/landing — signup-server BOOTSTRAP entry.
 *
 * F3 static-import coverage: this thin loader's ONLY static import is the stable
 * logger leaf; it arms the process-level rejection/exception net FIRST, then
 * DYNAMICALLY imports the real body (`./boot-impl.ts`) + runs
 * `startSignupServerMain()`, so the landing server's whole static-import graph
 * evaluates AFTER the net is armed. The signup server + its exported helpers
 * (`bootSignup`, `resolveSignupPort`, …) live in `boot-impl.ts`.
 */
import { installProcessSafetyNet } from '@neutronai/logger/fire-and-forget.ts'

installProcessSafetyNet()

const { startSignupServerMain } = await import('./boot-impl.ts')
await startSignupServerMain()
