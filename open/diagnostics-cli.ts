/**
 * @neutronai/open — diagnostics CLI (`neutron doctor`) BOOTSTRAP entry.
 *
 * F3 static-import coverage: a module's `import`s evaluate before any body
 * statement, so this thin loader keeps its ONLY static import to the stable
 * logger leaf, arms the process-level rejection/exception net FIRST, then
 * DYNAMICALLY imports the real body (`./diagnostics-cli-impl.ts`) — whose whole
 * static graph (ProjectDb + the gateway diagnostics composer) therefore
 * evaluates AFTER the net is armed. The CLI logic + its exported helpers
 * (`collectCliDiagnostics`, `runDiagnosticsCli`, …) live in the impl.
 */
import { installProcessSafetyNet } from '@neutronai/logger/fire-and-forget.ts'

installProcessSafetyNet()

const { runDiagnosticsCli } = await import('./diagnostics-cli-impl.ts')
process.exit(runDiagnosticsCli(process.argv.slice(2)))
