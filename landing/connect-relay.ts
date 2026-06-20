/**
 * @neutronai/landing — connect ("Connect" relay) client (M2.5).
 *
 * Open self-hosters connect their instance to a Connect relay so the shared
 * projects they're invited to appear in their project list across devices.
 * The backend surface (gateway/http/app-connect-auth.ts) is already
 * built + tested; this module only drives it from the browser:
 *
 *   POST /api/app/connect/auth/start  → { auth_url } → redirect there
 *   GET  /api/app/connect/auth/status → { connected, user_instance_slug? }
 *   POST /api/app/connect/auth/disconnect → { ok: true }
 *
 * After OAuth the browser lands back at the app root with
 * `?connect=connected` or `?connect=error`.
 *
 * Two consumers:
 *   - chat.ts mounts the header affordance + inline panel (TASK 1).
 *   - invite.ts gates the Open-invitee accept flow on connection (TASK 2).
 */

const BASE = '/api/app/connect/auth'

/**
 * The Connect-relay display label. The relay host is env-configured
 * (`NEUTRON_CONNECT_PUBLIC_BASE_URL`) with NO baked-in default — Open is
 * local-first, so there is no hosted relay unless an operator sets one. When
 * the env URL is present we surface its hostname as the affordance label
 * (e.g. `connect.example.test`); when unset we render a neutral
 * `'the Connect relay'` so the affordance is still meaningful without naming
 * a host that doesn't exist.
 *
 * `process.env.NEUTRON_CONNECT_PUBLIC_BASE_URL` is inlined by Bun.build at
 * bundle time, so the browser bundle carries whatever the operator's build
 * environment configured (or the empty string when unset).
 */
function relayBaseUrl(): string {
  try {
    if (typeof process !== 'undefined' && process.env) {
      return process.env['NEUTRON_CONNECT_PUBLIC_BASE_URL'] ?? ''
    }
  } catch {
    // no process binding in this runtime — treat as unset
  }
  return ''
}

/** Hostname of the configured relay, or `null` when unset / unparseable. */
function relayHost(): string | null {
  const raw = relayBaseUrl()
  if (raw.length === 0) return null
  try {
    return new URL(raw).hostname
  } catch {
    return null
  }
}

/** Short label for the relay: the configured hostname, else a neutral fallback. */
function relayLabel(): string {
  return relayHost() ?? 'the Connect relay'
}

export interface ConnectStatus {
  connected: boolean
  user_instance_slug?: string
  access_expires_at_ms?: number
  refresh_expires_at_ms?: number
}

/** Outcome of reading the status endpoint. `unavailable` means the route
 *  404'd — i.e. a Managed instance that does not expose this surface — and
 *  callers must fall through to their non-connect behavior. */
export type StatusResult =
  | { kind: 'status'; status: ConnectStatus }
  | { kind: 'unavailable' }

type Fetcher = typeof fetch

function pickFetcher(override?: Fetcher): Fetcher | null {
  if (override) return override
  return typeof fetch !== 'undefined' ? fetch : null
}

/**
 * Read connection status. Returns `{ kind: 'unavailable' }` on a 404 (the
 * surface is absent — Managed instance) so callers can detect "this instance
 * has no connect concept" distinctly from "connected: false".
 */
export async function fetchConnectStatus(fetcher?: Fetcher): Promise<StatusResult> {
  const f = pickFetcher(fetcher)
  if (f === null) return { kind: 'unavailable' }
  const res = await f(`${BASE}/status`, { method: 'GET' })
  if (res.status === 404) return { kind: 'unavailable' }
  if (res.status < 200 || res.status >= 300) return { kind: 'unavailable' }
  const status = (await res.json()) as ConnectStatus
  return { kind: 'status', status }
}

/**
 * Kick off the connect flow: POST /start, read `{ auth_url }`, navigate the
 * browser there. `provider` defaults to google. `navigate` is injectable for
 * tests. Resolves only if the redirect could not be performed (otherwise the
 * page is already gone).
 */
export async function startConnect(opts?: {
  provider?: 'google' | 'apple'
  fetcher?: Fetcher
  navigate?: (url: string) => void
  /** Same-origin relative path to land back on after OAuth (e.g. the invite
   *  page). Defaults to the current location so the user returns where they
   *  started; the server validates it's a safe relative path. */
  returnPath?: string
}): Promise<void> {
  const f = pickFetcher(opts?.fetcher)
  if (f === null) throw new Error('fetch unavailable')
  const params = new URLSearchParams()
  if (opts?.provider) params.set('provider', opts.provider)
  const returnPath =
    opts?.returnPath ??
    (typeof window !== 'undefined'
      ? window.location.pathname + window.location.search
      : undefined)
  if (returnPath !== undefined && returnPath.length > 0) {
    params.set('return_path', returnPath)
  }
  const qs = params.toString().length > 0 ? `?${params.toString()}` : ''
  const res = await f(`${BASE}/start${qs}`, { method: 'POST' })
  const body = (await res.json()) as { auth_url?: string }
  if (typeof body.auth_url !== 'string' || body.auth_url.length === 0) {
    throw new Error('connect_start_missing_auth_url')
  }
  const go =
    opts?.navigate ??
    ((url: string) => {
      if (typeof window !== 'undefined') window.location.href = url
    })
  go(body.auth_url)
}

/** Drop the stored federated credential. */
export async function disconnectConnect(fetcher?: Fetcher): Promise<void> {
  const f = pickFetcher(fetcher)
  if (f === null) throw new Error('fetch unavailable')
  await f(`${BASE}/disconnect`, { method: 'POST' })
}

/* ------------------------------------------------------------------ *
 * TASK 1 — header affordance + inline panel (chat surface).
 * ------------------------------------------------------------------ */

export interface ConnectPanelOptions {
  /** The header element to append the trigger button into. */
  header: HTMLElement
  /** Container the inline panel mounts into (defaults to document.body). */
  mountTarget?: HTMLElement
  /** Read the `?connect=…` return param (defaults to window.location.search). */
  search?: string
  fetcher?: Fetcher
  navigate?: (url: string) => void
}

/**
 * Mount the "Connect" relay control in the chat header and an
 * inline disclosure panel just below it. Idempotent enough for a single
 * boot; not designed to be called twice on the same header.
 */
export function mountConnectPanel(opts: ConnectPanelOptions): void {
  if (typeof document === 'undefined') return

  const label = relayLabel()

  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.id = 'connect-trigger'
  trigger.className = 'ct-trigger'
  trigger.setAttribute('aria-haspopup', 'dialog')
  trigger.setAttribute('aria-expanded', 'false')
  // The status dot reads connection state at a glance; the label carries
  // the meaning. Both update after the status fetch resolves.
  trigger.innerHTML =
    `<span class="ct-dot" aria-hidden="true"></span><span class="ct-trigger-label">${escapeHtml(
      label,
    )}</span>`
  // Slot the trigger before the live connection `.status` text so the
  // header reads logo → connect → ws-status, left to right.
  const statusEl = opts.header.querySelector('.status')
  if (statusEl !== null) opts.header.insertBefore(trigger, statusEl)
  else opts.header.appendChild(trigger)

  const panel = document.createElement('section')
  panel.id = 'connect-panel'
  panel.className = 'ct-panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', `Connect to ${label}`)
  panel.hidden = true
  const mount = opts.mountTarget ?? document.body
  mount.appendChild(panel)

  const toast = document.createElement('div')
  toast.className = 'ct-toast'
  toast.setAttribute('role', 'status')
  toast.setAttribute('aria-live', 'polite')
  toast.hidden = true
  mount.appendChild(toast)

  let lastStatus: ConnectStatus = { connected: false }
  let busy = false

  function showToast(message: string, kind: 'ok' | 'error'): void {
    toast.textContent = message
    toast.dataset['kind'] = kind
    toast.hidden = false
    // Auto-dismiss; opacity transition handled in CSS via the `[hidden]`
    // toggle plus a `.ct-toast--in` class for the entrance.
    toast.classList.add('ct-toast--in')
    window.setTimeout(() => {
      toast.classList.remove('ct-toast--in')
    }, 4_200)
    window.setTimeout(() => {
      toast.hidden = true
    }, 4_600)
  }

  function setOpen(open: boolean): void {
    panel.hidden = !open
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false')
  }

  function renderPanel(): void {
    const connected = lastStatus.connected
    trigger.classList.toggle('ct-trigger--connected', connected)
    const triggerLabel = trigger.querySelector('.ct-trigger-label')
    if (triggerLabel !== null) {
      triggerLabel.textContent = connected ? 'Connected' : label
    }

    if (connected) {
      const slug = lastStatus.user_instance_slug
      panel.innerHTML = `
        <h2 class="ct-title">Connected to ${escapeHtml(label)}</h2>
        <p class="ct-body">Shared projects ${
          slug ? `for <strong>${escapeHtml(slug)}</strong> ` : ''
        }appear in your project list across devices.</p>
        <div class="ct-actions">
          <button type="button" class="ct-btn ct-btn--ghost" data-act="disconnect">Disconnect</button>
        </div>`
    } else {
      panel.innerHTML = `
        <h2 class="ct-title">Connect to ${escapeHtml(label)}</h2>
        <p class="ct-body">Join shared projects across devices. Sign in once and the projects you're invited to show up in your list automatically.</p>
        <div class="ct-actions">
          <button type="button" class="ct-btn ct-btn--primary" data-act="connect">Connect</button>
        </div>`
    }

    const connectBtn = panel.querySelector<HTMLButtonElement>('[data-act="connect"]')
    if (connectBtn !== null) {
      connectBtn.addEventListener('click', () => {
        if (busy) return
        busy = true
        connectBtn.disabled = true
        connectBtn.textContent = 'Redirecting…'
        startConnect({
          ...(opts.fetcher ? { fetcher: opts.fetcher } : {}),
          ...(opts.navigate ? { navigate: opts.navigate } : {}),
        }).catch(() => {
          busy = false
          connectBtn.disabled = false
          connectBtn.textContent = 'Connect'
          showToast('Could not start the connection. Try again.', 'error')
        })
      })
    }

    const disconnectBtn = panel.querySelector<HTMLButtonElement>('[data-act="disconnect"]')
    if (disconnectBtn !== null) {
      disconnectBtn.addEventListener('click', () => {
        if (busy) return
        busy = true
        disconnectBtn.disabled = true
        disconnectBtn.textContent = 'Disconnecting…'
        disconnectConnect(opts.fetcher)
          .then(() => {
            lastStatus = { connected: false }
            busy = false
            renderPanel()
            showToast(`Disconnected from ${label}.`, 'ok')
          })
          .catch(() => {
            busy = false
            disconnectBtn.disabled = false
            disconnectBtn.textContent = 'Disconnect'
            showToast('Could not disconnect. Try again.', 'error')
          })
      })
    }
  }

  trigger.addEventListener('click', () => {
    setOpen(panel.hidden)
  })

  // Click-away + Escape close the disclosure.
  document.addEventListener('click', (ev) => {
    if (panel.hidden) return
    const target = ev.target as Node | null
    if (target !== null && (panel.contains(target) || trigger.contains(target))) return
    setOpen(false)
  })
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !panel.hidden) setOpen(false)
  })

  // Return-from-OAuth confirmation.
  const search = opts.search ?? (typeof window !== 'undefined' ? window.location.search : '')
  const params = new URLSearchParams(search)
  const ret = params.get('connect')
  if (ret === 'connected') {
    showToast("Connected. Your shared projects will appear in your list.", 'ok')
  } else if (ret === 'error') {
    showToast('Could not connect. Try again.', 'error')
  }

  renderPanel()

  // Hydrate from the live status endpoint; non-fatal on failure.
  void fetchConnectStatus(opts.fetcher)
    .then((result) => {
      if (result.kind === 'unavailable') {
        // Managed instance — no connect surface. Hide the affordance
        // entirely rather than show a control that 404s on click.
        trigger.hidden = true
        panel.hidden = true
        return
      }
      lastStatus = result.status
      renderPanel()
    })
    .catch(() => {
      /* leave the disconnected default in place */
    })
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
