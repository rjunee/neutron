/**
 * landing/chat-react — browser entry point for the React/assistant-ui web chat.
 *
 * Bundled to `/chat-react.js` by the landing server's lazy `Bun.build` (mirrors
 * how `chat.ts` → `/chat.js` works today) and loaded only by `chat-react.html`,
 * which the server serves at `/chat` ONLY when the web-chat flag resolves to
 * `react`. The vanilla client is otherwise untouched.
 *
 * Wiring: derive the bootstrap config from the page (start token → user id →
 * app-ws topic + URL), open a durable local store (OPFS, with in-memory
 * fallback), build a `WebChatSession` (chat-core), wrap it in the controller,
 * and mount the assistant-ui composition.
 */

import { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { WebChatSession, createWebStore } from '@neutronai/chat-core'

import { ProjectShell } from './ProjectShell.tsx'
import {
  resolveBootstrapConfig,
  topicForProject,
  wsUrlForScope,
  type BootstrapConfig,
  type WindowLike,
} from './config.ts'
import { NeutronChatController } from './controller.ts'
import { useNeutronChatVm } from './useNeutronChat.ts'
import { useAttachmentDraft } from './useAttachmentDraft.ts'

function Root({
  controller,
  config,
}: {
  controller: NeutronChatController
  config: BootstrapConfig
}): React.JSX.Element {
  const draft = useAttachmentDraft({ token: config.token })
  // Mirror the controller vm + drive its lifecycle here (stable across the
  // whole session). The assistant-ui runtime is NO LONGER provided at the root:
  // it's built per-conversation inside `ChatApp` (`ConversationRuntimeHost`,
  // keyed by convId) so a project switch mounts a fresh runtime and can't index
  // a stale message list (SEV1 switch-race fix). The chat session still survives
  // tab switches because `ProjectShell` keeps `ChatApp` mounted.
  const vm = useNeutronChatVm(controller)
  return <ProjectShell vm={vm} controller={controller} config={config} draft={draft} />
}

function renderError(rootEl: HTMLElement, message: string): void {
  rootEl.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.className = 'car-fatal'
  wrap.textContent = message
  rootEl.appendChild(wrap)
}

// ── Root-level auto-recovery (#380) ─────────────────────────────────────────
// A setState-after-unmount (a doc/history pane fetch that 503s and settles after
// the pane is gone — DocumentsTab.tsx guards its own, but the class can arise
// anywhere) surfaces in a real browser commit as React's teardown-phase
// invariant "Tried to unmount a fiber that is already unmounted". That is thrown
// from React's OWN commit/teardown phase, so it BYPASSES every error boundary
// (the per-pane `PaneErrorBoundary` and the `ChatErrorBoundary` only catch
// errors thrown during a child RENDER) and React unmounts the WHOLE root → the
// blank screen Ryan keeps hitting. Per-continuation guards are whack-a-mole; the
// CLASS fix is a root-level net: React 19.1 calls `onUncaughtError` for any error
// no boundary caught, and from there we AUTO-REMOUNT the app. The controller +
// OPFS store live OUTSIDE React, so a remount restores the transcript and session
// with no data loss. A bounded policy caps recoveries so a genuinely fatal render
// loop can't spin forever — beyond the cap we paint a visible error card with a
// Reload button. A silent blank screen is impossible either way.

const FATAL_MESSAGE =
  'Neutron hit a problem it could not recover from. Reload to continue — your conversation is saved.'

export interface RecoveryPolicy {
  /** Record a crash NOW; 'remount' while under the cap in the rolling window,
   *  'fatal' once the window is saturated. */
  record(): 'remount' | 'fatal'
}

/**
 * Bounded crash policy: allow up to `maxRecoveries` auto-remounts inside a
 * rolling `windowMs` window, then give up (→ 'fatal'). Timestamps outside the
 * window are pruned, so once the storm passes the budget refills. Pure + an
 * injectable clock so it is fully unit-testable.
 */
export function createRecoveryPolicy(opts?: {
  maxRecoveries?: number
  windowMs?: number
  now?: () => number
}): RecoveryPolicy {
  const maxRecoveries = opts?.maxRecoveries ?? 3
  const windowMs = opts?.windowMs ?? 60_000
  const now = opts?.now ?? ((): number => Date.now())
  const stamps: number[] = []
  return {
    record(): 'remount' | 'fatal' {
      const t = now()
      while (stamps.length > 0 && t - (stamps[0] ?? 0) > windowMs) stamps.shift()
      stamps.push(t)
      return stamps.length <= maxRecoveries ? 'remount' : 'fatal'
    },
  }
}

/** The visible fatal card — a message + a Reload button. NEVER a silent blank. */
function renderFatal(rootEl: HTMLElement, message: string): void {
  rootEl.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.className = 'car-fatal'
  const msg = document.createElement('div')
  msg.className = 'car-fatal-msg'
  msg.textContent = message
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'car-fatal-reload'
  btn.textContent = 'Reload'
  btn.addEventListener('click', () => window.location.reload())
  wrap.appendChild(msg)
  wrap.appendChild(btn)
  rootEl.appendChild(wrap)
}

/**
 * Execute a recovery decision. Tears down the dead root (idempotent — React may
 * already have unmounted it after the uncaught error), clears the container, then
 * either remounts the app fresh ('remount') or paints the fatal card ('fatal').
 * Always paints SOMETHING, so a blank screen can't survive this call. Exported so
 * the recovery mechanics are unit-testable without provoking React's (jsdom-
 * unobservable) teardown invariant.
 */
export function performRecovery(
  decision: 'remount' | 'fatal',
  ctx: { root: Root; rootEl: HTMLElement; remount: () => void; fatalMessage?: string },
): void {
  try {
    ctx.root.unmount()
  } catch {
    /* the root may already be torn down by React's uncaught-error handling */
  }
  ctx.rootEl.innerHTML = ''
  if (decision === 'fatal') {
    renderFatal(ctx.rootEl, ctx.fatalMessage ?? FATAL_MESSAGE)
    return
  }
  ctx.remount()
}

export interface MountConfig {
  controller: NeutronChatController
  config: BootstrapConfig
}

export interface UncaughtErrorHandlerCtx {
  /** Late-bound: the root is created AFTER the handler (the handler is passed to
   *  `createRoot`), and only ever read at recovery time, well after assignment. */
  getRoot: () => Root
  rootEl: HTMLElement
  remount: () => void
  fatalMessage?: string
}

/**
 * Build the `onUncaughtError` handler for ONE mounted root. The returned handler
 * is GUARDED: the first uncaught error records a crash, decides remount-vs-fatal,
 * and schedules the recovery; every SUBSEQUENT error for the same root is ignored
 * (the recovery for this root is already in flight — it will remount a brand-new
 * root with its own fresh handler).
 *
 * Why the guard is load-bearing (the #380 round-2 race, all three reviewers):
 * two pane fetches can 503 and settle within the SAME macrotask tick, before the
 * scheduled recovery fires. Without the guard, each error closes over the same
 * `root` and schedules its own recovery. Recovery #1 unmounts the dead root and
 * remounts a fresh one (root A). Recovery #2 then unmounts the already-dead
 * captured root (a caught no-op), wipes root A's freshly-rendered DOM with
 * `rootEl.innerHTML = ''`, and remounts AGAIN (root B) — leaving root A a
 * live-but-orphaned React root over an emptied container (leaked root + duplicate
 * controller subscription). One error → one recovery closes that race.
 *
 * Extracted (rather than inlined in `mount`) so the decision→schedule→
 * performRecovery seam is directly unit-testable without provoking React's
 * jsdom-unobservable teardown invariant.
 */
export function buildUncaughtErrorHandler(
  policy: RecoveryPolicy,
  schedule: (fn: () => void) => void,
  ctx: UncaughtErrorHandlerCtx,
): (error: unknown, errorInfo: { componentStack?: string }) => void {
  let recovering = false
  return (error: unknown, errorInfo: { componentStack?: string }): void => {
    console.error('[chat-react] uncaught root error — auto-recovering', error, errorInfo?.componentStack)
    // One recovery per root. Suppress the concurrent-error race described above.
    if (recovering) return
    recovering = true
    const decision = policy.record()
    schedule(() => {
      performRecovery(decision, {
        root: ctx.getRoot(),
        rootEl: ctx.rootEl,
        remount: ctx.remount,
        ...(ctx.fatalMessage !== undefined ? { fatalMessage: ctx.fatalMessage } : {}),
      })
    })
  }
}

/**
 * Mount the app onto `rootEl` with root-level auto-recovery wired through
 * `createRoot`'s `onUncaughtError`. On an uncaught (boundary-bypassing) error the
 * guarded handler consults the policy and SCHEDULES the recovery on a macrotask —
 * NEVER synchronously from React's error path — so React finishes tearing down
 * before we remount with the SAME controller + store.
 *
 * Note on subscriber leakage: the controller/OPFS store live outside React, so a
 * remount reuses them; if React's teardown-invariant path skipped a component's
 * effect cleanup, up to `maxRecoveries` stale VM subscribers can linger in the
 * controller's Set. That is bounded (≤3) and harmless — React 19 no-ops setState
 * on an unmounted component, so a dead closure can't loop or crash.
 *
 * `opts.renderTree` and `opts.scheduleRemount` are test seams (a throwing stub
 * tree; a synchronous scheduler); production uses the real `<Root/>` and
 * `setTimeout`.
 */
export function mount(
  rootEl: HTMLElement,
  mountConfig: MountConfig,
  policy: RecoveryPolicy,
  opts?: {
    renderTree?: () => React.ReactNode
    scheduleRemount?: (fn: () => void) => void
  },
): Root {
  const schedule = opts?.scheduleRemount ?? ((fn: () => void): void => void setTimeout(fn, 50))
  const tree = opts?.renderTree ?? ((): React.ReactNode => (
    <Root controller={mountConfig.controller} config={mountConfig.config} />
  ))
  // `root` is created below but referenced (lazily, at recovery time) by the
  // handler — a definite-assignment forward reference, safe because the handler
  // only ever fires after `createRoot` has returned.
  let root!: Root
  const handler = buildUncaughtErrorHandler(policy, schedule, {
    getRoot: () => root,
    rootEl,
    remount: () => mount(rootEl, mountConfig, policy, opts),
    fatalMessage: FATAL_MESSAGE,
  })
  root = createRoot(rootEl, { onUncaughtError: handler })
  root.render(<StrictMode>{tree()}</StrictMode>)
  return root
}

async function boot(): Promise<void> {
  const rootEl = document.getElementById('root')
  if (rootEl === null) return
  let config: BootstrapConfig
  try {
    config = resolveBootstrapConfig(window as unknown as WindowLike)
  } catch (err) {
    renderError(rootEl, err instanceof Error ? err.message : 'chat-react: failed to initialize')
    return
  }
  // OPFS store with graceful in-memory fallback (createWebStore handles the
  // feature-detect); the transcript is durable so cold-open is instant. ONE
  // store is shared across per-project sessions — it's keyed internally by
  // topic_id, so each project's transcript stays isolated under its own topic.
  const store = await createWebStore()
  // Per-project chat: derive the socket URL for a given scope. `project_id` on
  // the URL tells the server to bind the PER-PROJECT topic (`app:<user>:<id>`);
  // General omits it. An explicit `__neutron_app_ws_url` override (dev/test)
  // wins verbatim — a single fixed socket, no per-project query.
  // ISSUES #40 — delegate to the shared, unit-tested URL factory so EVERY connect
  // (initial + project switch + reconnect) carries the boot-detected IANA `tz`,
  // not just the initial `config.wsUrl`.
  const wsUrlFor = (projectId: string | null): string => wsUrlForScope(config, projectId)
  const controller = new NeutronChatController({
    projectId: config.projectId,
    // FIX 1 — seed the rail from the bootstrap, then keep it reactive so
    // projects created mid-onboarding appear live (a `projects_changed` frame).
    projects: config.projects,
    // Managed post-onboarding claim redirect — undefined on Open self-host, so
    // the controller's redirect no-ops (see BootstrapConfig.postOnboardingClaimUrl).
    ...(config.postOnboardingClaimUrl !== undefined
      ? { postOnboardingClaimUrl: config.postOnboardingClaimUrl }
      : {}),
    topicForProject: (projectId) => topicForProject(config.userId, projectId),
    createSession: (sinks, scope) =>
      new WebChatSession({
        url: wsUrlFor(scope.projectId),
        topic_id: scope.topicId,
        store,
        device_id: config.deviceId,
        onChange: sinks.onChange,
        onStatus: sinks.onStatus,
        onFrame: sinks.onFrame,
      }),
  })
  // Mount with root-level auto-recovery (#380). The controller + store were just
  // built above and live OUTSIDE React, so an auto-remount after an uncaught
  // teardown error restores the transcript + session with no data loss.
  mount(rootEl, { controller, config }, createRecoveryPolicy())
}

void boot()
