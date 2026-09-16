import { bunTerminalHost } from './bun-terminal-host.ts'
import { herdrHost } from './herdr-host.ts'
import type { PtyHost } from './pty-host.ts'

/** Process-start choice, controlled by the service operator. See
 * docs/spec-items/herdr-host-implements-ptyhost-over-the-socket-api.md.
 * Herdr: no exit codes, polled exit and rendered screens, acknowledged submit.
 * Bun: kernel exit codes, direct exit and byte stream, fire-and-forget write;
 * submitLine separately checks acceptance of every text and Enter byte.
 */
export function selectPtyHost(value: string | undefined): PtyHost {
  switch (value) {
    case undefined:
    case 'herdr':
      return herdrHost
    case 'bun':
      return bunTerminalHost
    default:
      throw new Error('NEUTRON_REPL_HOST must be herdr or bun; restart after correcting the service environment')
  }
}

// Read once at module initialization, shared by spawn AND adoption. Changing the
// environment in a running process cannot redirect a session or its supervision.
//
// A TEST RUNNER MUST NOT INHERIT THE HERDR DEFAULT. `selectPtyHost(undefined)` is
// herdr, which is correct for the service: the operator sets nothing and gets the
// session-backed host. Under `bun test` the same silence handed every suite that
// reaches the real spawn path a pane in the OWNER'S LIVE herdr session, where the
// spawned `claude` wedges on the API-key prompt and stays there. They accumulated
// as a wall of blocked tabs the owner had to look at, none of them anyone's work,
// and reaping them by hand does not stop the next run producing more.
//
// The refusal belongs HERE and not in `selectPtyHost`, whose contract is "the
// operator asked for exactly this host" — an explicit NEUTRON_REPL_HOST=herdr is
// still honoured under a test, because `persistent-repl-substrate.test.ts` spawns
// a child process with exactly that to cover the herdr transport on purpose. Only
// the SILENT default changes, and only when NODE_ENV says a test runner set it.
// `bunTerminalHost` is a plain in-process pty: isolated, no session, nothing to
// adopt and nothing to leak.
export const configuredPtyHost = selectPtyHost(
  process.env['NEUTRON_REPL_HOST'] ?? (process.env['NODE_ENV'] === 'test' ? 'bun' : undefined),
)
