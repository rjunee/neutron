/**
 * @neutronai/gateway/cores — Tasks Core chat-command router.
 *
 * Wraps an inner `IncomingEventReceiver` so any inbound chat message
 * whose body starts with the Tasks Core's `/task` verb is dispatched
 * through the Core's `parseTaskCommand` + `executeTaskCommand` pipeline
 * INSTEAD OF falling through to the LLM. The response is pushed back
 * to the channel via the supplied `replyToTopic` callback (the
 * `AppWsSessionRegistry` in production).
 *
 * The wrapper ALSO recognises the Tasks Core's button postback
 * scheme `task:done:<id>` and `task:open:<id>`. The Core's response
 * envelopes emit these tokens as `option.value` so the Expo button-
 * primitive's tap path (`chooseOption` posts `value` as the next
 * user_message body — see `app/lib/button-primitives.tsx`) lands on
 * a real action: `task:done:<id>` dispatches the Core's `done`
 * verb; `task:open:<id>` emits a deep-link-only response so the
 * client navigates without state-change side-effects.
 *
 * Failure isolation: a parser/dispatcher throw or a `null` parse
 * result falls through to the inner receiver. The wrapper never
 * silently swallows a chat send.
 *
 * Spec input: docs/plans/tasks-core-tier1-brief.md § 3.2 (chat
 * commands) + § 6 (production-composer reachability test).
 */

import type { IncomingEvent, IncomingEventReceiver } from '../../channels/types.ts'
import {
  executeTaskCommand,
  parseTaskCommand,
  type ExecuteTaskCommandContext,
  type PickNextService,
  type TaskCommand,
  type TaskCommandResponse,
  type TaskStore,
} from '@neutronai/tasks-core'

import type { AppWsOutbound } from '../../channels/adapters/app-ws/envelope.ts'

/**
 * Per-instance Tasks Core dependencies the router resolves via
 * `deps.resolve(project_slug)`. The runtime composer constructs the
 * factories at boot time and stashes them in a map keyed by instance
 * slug; tests inject an in-memory map.
 */
export interface TasksChatRouterDepsResolver {
  resolve(project_slug: string): Promise<TasksChatOwnerDeps | null>
}

export interface TasksChatOwnerDeps {
  store: TaskStore
  pickNext: PickNextService
}

export interface TasksChatRouterOptions {
  /** Inner receiver — non-`/task` bodies forward here verbatim. */
  inner: IncomingEventReceiver
  /** Per-instance Tasks Core deps resolver. */
  deps: TasksChatRouterDepsResolver
  /**
   * Resolve a project_slug from an inbound event. The app-ws adapter
   * doesn't stamp project_slug on the IncomingEvent (the topic carries
   * it after resolution); the composer passes a closure that derives
   * it from the event's user/topic context.
   */
  resolveOwner: (event: IncomingEvent) => string | null
  /**
   * Push an outbound envelope to the channel topic. The production
   * composer wires `AppWsSessionRegistry.send`; tests inject a stub
   * that records envelopes for assertions.
   */
  replyToTopic: (channel_topic_id: string, env: AppWsOutbound) => boolean
  /** Wall-clock override for tests. */
  now?: () => number
  /** Message-id generator override for tests. */
  generateMessageId?: () => string
  /** Structured-log sink for parser/dispatcher errors. */
  log?: (event: TasksChatRouterEvent) => void
}

export interface TasksChatRouterEvent {
  kind:
    | 'tasks_chat.dispatched'
    | 'tasks_chat.unrecognized'
    | 'tasks_chat.error'
    | 'tasks_chat.no_owner'
  project_slug: string | null
  channel_topic_id: string
  body_prefix: string
  message?: string
}

/**
 * Construct the wrapped `IncomingEventReceiver`. The returned receiver:
 *
 *   1. parses the body with `parseTaskCommand`
 *   2. if `null` (body doesn't start with `/task`) → forwards to inner
 *   3. if parser returned a command, resolves per-instance deps; if the
 *      deps factory returns null (unknown instance), falls through to
 *      inner — defensive
 *   4. dispatches `executeTaskCommand`, emits the response envelope,
 *      AND short-circuits the inner receiver
 *
 * Errors during step 3-4 log via `log` and fall through to the inner
 * receiver so a degraded Tasks Core (e.g. LLM client unreachable for
 * `/task focus`) doesn't break unrelated chat.
 */
export function wrapWithTasksChatRouter(
  options: TasksChatRouterOptions,
): IncomingEventReceiver {
  const now = options.now ?? ((): number => Date.now())
  const genId = options.generateMessageId ?? ((): string => crypto.randomUUID())
  const log = options.log ?? noop

  return {
    async receive(event: IncomingEvent): Promise<void> {
      const text = event.body.text ?? ''
      // Postback first — the Tasks Core's button envelopes emit
      // `task:done:<id>` / `task:open:<id>` as option.value. The Expo
      // button row submits the value as the next user_message body
      // (button-primitives.tsx:11), so a tap re-enters this receiver
      // with one of those tokens as text. Decode it BEFORE the
      // parseTaskCommand check — neither token starts with `/task`,
      // so a raw parser pass would fall through to the LLM path and
      // the tap would be dead UI. Argus r1 BLOCKER.
      const postback = parseTaskPostback(text)
      const parsed: TaskCommand | null = postback?.kind === 'done'
        ? { kind: 'done', target: postback.task_id }
        : parseTaskCommand(text)
      if (parsed === null && postback === null) {
        await options.inner.receive(event)
        return
      }
      const project_slug = options.resolveOwner(event)
      if (project_slug === null) {
        log({
          kind: 'tasks_chat.no_owner',
          project_slug: null,
          channel_topic_id: event.channel_topic_id,
          body_prefix: text.slice(0, 32),
        })
        await options.inner.receive(event)
        return
      }
      let deps: TasksChatOwnerDeps | null = null
      try {
        deps = await options.deps.resolve(project_slug)
      } catch (err) {
        log({
          kind: 'tasks_chat.error',
          project_slug,
          channel_topic_id: event.channel_topic_id,
          body_prefix: text.slice(0, 32),
          message: errMessage(err),
        })
        await options.inner.receive(event)
        return
      }
      if (deps === null) {
        // Tasks Core not installed for this instance — quiet fall-through.
        await options.inner.receive(event)
        return
      }
      const project_id = readProjectId(event)
      const user_id = event.user.channel_user_id
      const ctx: ExecuteTaskCommandContext = {
        store: deps.store,
        pickNext: deps.pickNext,
        project_id: project_id ?? undefined,
        user_id,
      }
      let response: TaskCommandResponse
      try {
        // `task:open:<id>` is a pure-navigate postback — no state
        // mutation. The Core's executeTaskCommand doesn't know about
        // it (the parser only emits the four spec'd verbs); the
        // router synthesises a deep-link-only response so the
        // client can navigate to the task page without inventing a
        // fifth verb the help text would have to advertise.
        if (postback?.kind === 'open') {
          response = openPostbackResponse(postback.task_id, project_id ?? undefined)
        } else if (parsed !== null) {
          response = await executeTaskCommand(parsed, ctx)
        } else {
          // Unreachable — guarded above by the `parsed === null && postback === null` early return.
          await options.inner.receive(event)
          return
        }
      } catch (err) {
        log({
          kind: 'tasks_chat.error',
          project_slug,
          channel_topic_id: event.channel_topic_id,
          body_prefix: text.slice(0, 32),
          message: errMessage(err),
        })
        await options.inner.receive(event)
        return
      }
      if (!response.short_circuit_llm) {
        await options.inner.receive(event)
        return
      }
      const envelope = renderResponseEnvelope(response, project_id, now(), genId())
      options.replyToTopic(event.channel_topic_id, envelope)
      log({
        kind: 'tasks_chat.dispatched',
        project_slug,
        channel_topic_id: event.channel_topic_id,
        body_prefix: text.slice(0, 32),
      })
    },
  }
}

function renderResponseEnvelope(
  response: TaskCommandResponse,
  project_id: string | null,
  ts: number,
  message_id: string,
): AppWsOutbound {
  const env: Record<string, unknown> = {
    v: 1,
    type: 'agent_message',
    body: response.text,
    message_id,
    ts,
  }
  if (project_id !== null) env['project_id'] = project_id
  if (response.buttons !== undefined && response.buttons.length > 0) {
    env['options'] = response.buttons.map((b) => ({
      label: b.label,
      body: b.label,
      value: b.value,
    }))
    env['allow_freeform'] = false
  }
  // ISSUE #18 — `deep_link` is promoted to a top-level envelope field so
  // a single client-side `<ChatDeepLinkNavigator>` consumer handles every
  // Core uniformly. `data` and `error` stay nested under `tasks_core` —
  // those are Core-private structured payloads, not envelope-level
  // metadata.
  if (response.deep_link !== undefined) env['deep_link'] = response.deep_link
  const meta: Record<string, unknown> = {}
  if (response.data !== undefined) meta['data'] = response.data
  if (response.error !== undefined) meta['error'] = response.error
  if (Object.keys(meta).length > 0) env['tasks_core'] = meta
  return env as unknown as AppWsOutbound
}

/**
 * Tasks Core button-postback prefix scheme.
 *
 *   `task:done:<task_id>` — mark a task done
 *   `task:open:<task_id>` — navigate to the task without state change
 *
 * Emitted as `option.value` by the Core's response envelopes (capture
 * + focus). When the user taps a button, the Expo button-primitive
 * sends the value as the next user_message body — the router decodes
 * it here so the tap reaches the right action.
 *
 * Returns `null` for any body that doesn't match the scheme; callers
 * fall through to `parseTaskCommand` (the `/task ...` verb path).
 */
type TaskPostback = { kind: 'done' | 'open'; task_id: string }

const TASK_POSTBACK_RE = /^task:(done|open):([^\s:]+)$/

function parseTaskPostback(raw: string): TaskPostback | null {
  const trimmed = raw.trim()
  const m = TASK_POSTBACK_RE.exec(trimmed)
  if (m === null) return null
  const kind = m[1] as 'done' | 'open'
  const task_id = m[2]
  if (task_id === undefined || task_id.length === 0) return null
  return { kind, task_id }
}

function openPostbackResponse(
  task_id: string,
  project_id: string | undefined,
): TaskCommandResponse {
  // Argus r2 BLOCKER B2 (PR #276) — emit the deep_link as a query
  // string on the existing flat-list route (`/projects/[id]/tasks`)
  // INSTEAD of `/projects/[id]/tasks/[task_id]`. The nested per-task
  // detail route does NOT exist in the Expo Router tree
  // (`app/app/projects/[id]/tasks.tsx` is the only mount), so the
  // prior path landed on an unmatched route. The flat-list screen
  // reads `useLocalSearchParams().task_id` and scrolls / highlights
  // the matching row — preserves the single-screen UX without adding
  // a separate detail file.
  const deep_link = project_id !== undefined
    ? `/projects/${project_id}/tasks?task_id=${encodeURIComponent(task_id)}`
    : undefined
  const response: TaskCommandResponse = {
    text: 'Opening task...',
    data: { task_id },
    short_circuit_llm: true,
  }
  if (deep_link !== undefined) response.deep_link = deep_link
  return response
}

function readProjectId(event: IncomingEvent): string | null {
  const meta = event.adapter_metadata
  if (meta === undefined) return null
  const raw = meta['project_id']
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function noop(_event: TasksChatRouterEvent): void {
  // intentional
}
