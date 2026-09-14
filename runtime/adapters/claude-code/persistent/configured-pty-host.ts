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
export const configuredPtyHost = selectPtyHost(process.env['NEUTRON_REPL_HOST'])
