/**
 * @neutronai/runtime — dev-channel BOOTSTRAP entry (spawned as its own Bun
 * process by spawn.ts; DEFAULT_DEV_CHANNEL_PATH points here).
 *
 * F3 static-import coverage: static `import`s evaluate before any body
 * statement, so an in-body install cannot cover a failure in THIS entry's own
 * static graph (e.g. an unresolvable `@modelcontextprotocol/sdk`). This thin
 * loader's only static import is the stable logger leaf; it arms the net FIRST,
 * then DYNAMICALLY imports the real body (`./dev-channel-impl.ts`) — whose
 * entire static graph evaluates AFTER the net is armed. The channel's behavior
 * lives in `dev-channel-impl.ts`.
 */
import { installProcessSafetyNet } from '@neutronai/logger/fire-and-forget.ts'

installProcessSafetyNet()

await import('./dev-channel-impl.ts')
