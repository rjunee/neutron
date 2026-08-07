/**
 * The owner-facing half of the GitHub connection: run the device flow, show the
 * owner what they need to type, wait for them, store what comes back.
 *
 * `device-flow.ts` owns the protocol and `credential.ts` owns the storage. This
 * file owns the ORDER, which is where the interesting mistakes live:
 *
 *  * The code must reach the owner BEFORE polling starts. Polling first and
 *    presenting afterwards still "works" in a test that stubs the clock, because
 *    the stub approves instantly. Against a real person it is broken: they are
 *    being waited on for a code they have not been shown, and the flow times out
 *    having displayed nothing. The presenter is therefore awaited first, and
 *    there is a test that fails if the two are swapped.
 *
 *  * Nothing is stored on a failed flow. A declined or expired attempt must
 *    leave the instance exactly as unconnected as it was, so that
 *    `readGitHubToken` keeps returning `null` and the owner is told to connect
 *    rather than being handed a credential that does not work.
 *
 *  * The owner is shown `user_code`, never `device_code`. They are different
 *    strings and only the short one is meant for a human. `device_code` is the
 *    bearer half of the exchange: anyone holding it can complete the flow and
 *    receive the token. Chat messages get forwarded, quoted, and screenshotted,
 *    so the presenter is handed a type that structurally cannot carry it rather
 *    than the whole grant plus a comment asking callers to be careful.
 */

import {
  GitHubDeviceFlowError,
  requestDeviceCode,
  pollForAccessToken,
  type DeviceFlowFailure,
  type PollDeps,
} from './device-flow.ts'
import { storeGitHubToken } from './credential.ts'
import type { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import type { OwnerHandle } from '@neutronai/persistence/index.ts'

/**
 * What is safe to put in front of the owner. Deliberately a NARROWER type than
 * `DeviceCodeGrant` — `device_code` is absent by construction, so a presenter
 * cannot render it into a chat message even by accident.
 */
export interface PresentableGrant {
  /** The short code the owner types into GitHub, e.g. `ABCD-1234`. */
  user_code: string
  /** Where they type it. */
  verification_uri: string
  /** How long they have, so the message can say so. */
  expires_in_seconds: number
}

export type ConnectGitHubResult =
  | { connected: true }
  /** Never carries token material — `reason` is one of a closed set of labels. */
  | { connected: false; reason: DeviceFlowFailure }

/**
 * Connect this instance to GitHub.
 *
 * Resolves `{connected:true}` once the token is stored, or `{connected:false}`
 * with the protocol-level reason. A failure to SHOW the owner the code (the
 * presenter throwing — chat delivery down) aborts before polling: waiting out a
 * full device-code expiry for a code nobody ever saw is pure latency, and the
 * honest outcome is an immediate failure the caller can retry.
 */
export async function connectGitHub(input: {
  client_id: string
  store: Pick<SecretsStore, 'put'>
  owner_handle: OwnerHandle
  present: (grant: PresentableGrant) => Promise<void>
  deps: PollDeps
  scopes?: string
  deadline_ms?: number
}): Promise<ConnectGitHubResult> {
  try {
    const grant = await requestDeviceCode({
      client_id: input.client_id,
      fetchImpl: input.deps.fetchImpl,
      ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
    })
    // BEFORE the first poll. See the header note.
    await input.present({
      user_code: grant.user_code,
      verification_uri: grant.verification_uri,
      expires_in_seconds: grant.expires_in_seconds,
    })
    const token = await pollForAccessToken({
      client_id: input.client_id,
      grant,
      deps: input.deps,
      ...(input.deadline_ms !== undefined ? { deadline_ms: input.deadline_ms } : {}),
    })
    await storeGitHubToken(input.store, input.owner_handle, token)
    return { connected: true }
  } catch (err) {
    if (err instanceof GitHubDeviceFlowError) {
      return { connected: false, reason: err.reason }
    }
    // A presenter failure, a storage failure, or a bug. These are NOT device-flow
    // outcomes and must not be flattened into one, or a broken secrets store
    // would read to the owner as "you declined".
    throw err
  }
}
