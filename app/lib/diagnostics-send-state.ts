/**
 * @neutronai/app — copy for the manual "Send diagnostics" action (pure).
 *
 * Split out of `app/settings.tsx` for the same reason the rest of this app's
 * pure helpers are: the app suite does not mount React Native components, so
 * anything with real branching lives in a plain function that `bun test` can
 * exercise. The branching here is small but load-bearing — reporting "sent"
 * after a failed POST would be a lie about the one feature whose whole job is
 * telling the truth about failures.
 */

import type { FlushResult } from './diagnostic-queue';

export type DiagnosticsSendState = 'idle' | 'sending' | 'done' | 'failed';

export interface SendDescription {
  state: DiagnosticsSendState;
  message: string;
}

/** Turn a flush result into the state + user-facing line. */
export function describeSendResult(result: FlushResult): SendDescription {
  if (!result.ok) {
    return {
      state: 'failed',
      message:
        result.remaining === 1
          ? 'Could not reach your server. 1 report is saved and will be sent later.'
          : `Could not reach your server. ${result.remaining} reports are saved and will be sent later.`,
    };
  }
  if (result.delivered === 0) {
    return { state: 'done', message: 'Nothing to send — no errors recorded.' };
  }
  return {
    state: 'done',
    message:
      result.delivered === 1
        ? 'Sent 1 report to your server.'
        : `Sent ${result.delivered} reports to your server.`,
  };
}

/** The line shown when the send throws outright (no result to describe). */
export function describeSendError(err: unknown): SendDescription {
  return {
    state: 'failed',
    message: `Could not send: ${err instanceof Error ? err.message : String(err)}`,
  };
}
