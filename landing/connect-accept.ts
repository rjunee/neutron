/**
 * @neutronai/landing — the public by-link collaborator accept client.
 *
 * Served on the connect node's public edge at `connect.<domain>/connect/accept`
 * — the ONE user-facing HTML surface a connect node serves (an audited carve-out
 * from "connect nodes 404 every user-facing route"; brief § 2.2, § 5 #6, test
 * #10). It is pre-auth, non-consuming-until-handshake, and rate-limited by the
 * existing edge limiter. This is the by-link (token-handshake) collaborator
 * delivery; it lands the SAME role='collaborator' as the by-email OAuth path.
 *
 * Flow (brief § 2.2):
 *   1. read the raw token from the URL FRAGMENT (`#<token>`) — the fragment is
 *      never sent to the server in request logs.
 *   2. GET /connect/v1/connect/invite-preview?token_hash=<sha256(token)>
 *      (read-only; never consumes the single-use invite).
 *   3. render the UNIFIED data-locality disclosure (one disclosure for every
 *      collaborator) with the RESOLVED values (renderDisclosure).
 *   4. collect display_name + guest_handle; the Accept button stays DISABLED
 *      until the disclosure is acknowledged AND both fields are filled.
 *   5. POST /connect/v1/connect/guest-auth { invite_token, display_name,
 *      guest_handle } — the EXISTING single-use handshake (no new redemption
 *      path). On 200, surface the joined state + next steps.
 *
 * The token-hash is computed CLIENT-SIDE so the raw token never reaches the
 * preview endpoint. Everything is injectable so the whole flow is jsdom-testable
 * (brief test #5).
 */

import { renderDisclosure } from './connect-disclosure.ts'

export interface PreviewShape {
  project_name: string
  owner_display: string
  connect_host: string
  privacy_tier: string
  scope: 'write' | 'read'
}

export interface GuestAuthShape {
  token?: string
  local_slug?: string
  origin_instance_slug?: string
  project_id?: string
  error?: string
  reason?: string
}

export interface ConnectAcceptOptions {
  disclosureHost: HTMLElement
  displayNameInput: HTMLInputElement
  guestHandleInput: HTMLInputElement
  acceptButton: HTMLButtonElement
  status: HTMLElement
  title: HTMLElement
  lede: HTMLElement
  /** Override the URL fragment read (tests). Defaults to `window.location.hash`. */
  hash?: string
  /** Override fetch (tests). */
  fetcher?: typeof fetch
  /** Override the SHA-256 hex hasher (tests inject a node-crypto hash that
   *  matches the server's `hashInviteToken`). */
  hashToken?: (raw: string) => Promise<string>
  /** Override the preview URL (tests). */
  previewUrl?: string
  /** Override the guest-auth POST URL (tests). */
  acceptUrl?: string
  /** Fired on a successful accept with the handshake result (tests / next-step). */
  onAccepted?: (result: GuestAuthShape) => void
}

const DEFAULT_PREVIEW_URL = '/connect/v1/connect/invite-preview'
const DEFAULT_ACCEPT_URL = '/connect/v1/connect/guest-auth'

/** Default browser SHA-256 hex hasher (SubtleCrypto). */
async function defaultHashToken(raw: string): Promise<string> {
  const data = new TextEncoder().encode(raw)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Wire the guest accept page. Returns immediately; the preview fetch + render run
 * async. The Accept button is disabled until the disclosure is acknowledged and
 * both fields are filled — there is NO accept path without acknowledgement
 * (brief § 5 #5).
 */
export function initConnectAccept(opts: ConnectAcceptOptions): void {
  const fetcher = opts.fetcher ?? (typeof fetch !== 'undefined' ? fetch : null)
  const hashToken = opts.hashToken ?? defaultHashToken
  const rawHash = opts.hash ?? (typeof window !== 'undefined' ? window.location.hash : '')
  const token = rawHash.replace(/^#/, '').trim()

  // Accept stays disabled until preview loads + disclosure acknowledged.
  opts.acceptButton.disabled = true

  if (token.length === 0) {
    showStatus(opts, 'error', 'Missing invite token. Ask the inviter for a fresh link.')
    return
  }
  if (fetcher === null) {
    showStatus(opts, 'error', 'fetch unavailable')
    return
  }

  let acknowledged: HTMLInputElement | null = null

  const updateGate = (): void => {
    const ok =
      acknowledged !== null &&
      acknowledged.checked &&
      opts.displayNameInput.value.trim().length > 0 &&
      opts.guestHandleInput.value.trim().length > 0
    opts.acceptButton.disabled = !ok
  }

  async function loadPreview(): Promise<void> {
    showStatus(opts, '', 'Loading invite…')
    let tokenHash: string
    try {
      tokenHash = await hashToken(token)
    } catch {
      showStatus(opts, 'error', 'Could not read this invite link.')
      return
    }
    let res: Response
    try {
      const url = `${opts.previewUrl ?? DEFAULT_PREVIEW_URL}?token_hash=${encodeURIComponent(tokenHash)}`
      res = await fetcher!(url, { method: 'GET' })
    } catch {
      showStatus(opts, 'error', 'Could not reach the meeting point. Try again shortly.')
      return
    }
    if (res.status === 410) {
      showStatus(opts, 'error', 'This invite has expired or already been used. Ask the inviter for a fresh link.')
      return
    }
    if (res.status !== 200) {
      showStatus(opts, 'error', 'This invite link is not valid.')
      return
    }
    let preview: PreviewShape
    try {
      preview = (await res.json()) as PreviewShape
    } catch {
      showStatus(opts, 'error', 'Could not read the invite details.')
      return
    }

    opts.title.textContent = `Join ${preview.project_name}`
    opts.lede.textContent = `${preview.owner_display} invited you to collaborate on this project.`

    const rendered = renderDisclosure(opts.disclosureHost, {
      projectName: preview.project_name,
      ownerDisplay: preview.owner_display,
      connectHost: preview.connect_host,
      privacyTier: preview.privacy_tier,
      scope: preview.scope,
    })
    acknowledged = rendered.checkbox
    acknowledged.addEventListener('change', updateGate)
    opts.displayNameInput.addEventListener('input', updateGate)
    opts.guestHandleInput.addEventListener('input', updateGate)
    updateGate()
    showStatus(opts, '', '')
  }

  opts.acceptButton.addEventListener('click', async () => {
    if (opts.acceptButton.disabled) return
    opts.acceptButton.disabled = true
    showStatus(opts, '', 'Joining…')
    try {
      const res = await fetcher!(opts.acceptUrl ?? DEFAULT_ACCEPT_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          invite_token: token,
          display_name: opts.displayNameInput.value.trim(),
          guest_handle: opts.guestHandleInput.value.trim(),
        }),
      })
      const body = (await res.json()) as GuestAuthShape
      if (res.status === 200 && typeof body.token === 'string') {
        showStatus(opts, 'success', "You're in. Open Neutron on your own instance — the shared project is now in your list.")
        opts.onAccepted?.(body)
      } else {
        showStatus(opts, 'error', acceptError(res.status, body))
        updateGate()
      }
    } catch (err) {
      showStatus(opts, 'error', err instanceof Error ? err.message : 'network_error')
      updateGate()
    }
  })

  void loadPreview()
}

function acceptError(status: number, body: GuestAuthShape): string {
  if (status === 409) return 'This invite has already been used.'
  if (status === 410) return 'This invite has expired. Ask the inviter for a fresh link.'
  if (status === 404) return 'This invite is no longer valid.'
  return body.reason ?? body.error ?? 'Could not join. Try again shortly.'
}

function showStatus(opts: ConnectAcceptOptions, kind: '' | 'success' | 'error', text: string): void {
  opts.status.className = kind
  opts.status.textContent = text
}

export function bootConnectAcceptFromHash(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  const disclosureHost = document.getElementById('disclosure')
  const displayNameInput = document.getElementById('display-name') as HTMLInputElement | null
  const guestHandleInput = document.getElementById('guest-handle') as HTMLInputElement | null
  const acceptButton = document.getElementById('btn-accept') as HTMLButtonElement | null
  const status = document.getElementById('status')
  const title = document.getElementById('title')
  const lede = document.getElementById('lede')
  if (
    disclosureHost === null ||
    displayNameInput === null ||
    guestHandleInput === null ||
    acceptButton === null ||
    status === null ||
    title === null ||
    lede === null
  ) {
    return
  }
  initConnectAccept({ disclosureHost, displayNameInput, guestHandleInput, acceptButton, status, title, lede })
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => bootConnectAcceptFromHash())
  } else {
    bootConnectAcceptFromHash()
  }
}
