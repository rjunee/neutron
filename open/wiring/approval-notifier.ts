/**
 * @neutronai/open — the real app-ws ApprovalNotifier (plan task 3).
 *
 * `ApprovalManager` (composed at `gateway/composition/build-core-modules.ts:275-278`
 * from the composer's `approval_notifier`) fires its notifier on every
 * `prompt-user` request. Until now the composer handed it a no-op
 * (`open/composer.ts` — `approval_notifier: { notify: async () => undefined }`),
 * so a persisted approval request surfaced nowhere. This is the first REAL
 * approval surface; the ritual approval path (`reminders/ritual-approval.ts`)
 * is its first production caller.
 *
 * The delivery follows the `watchdogNotifier` app-ws precedent
 * (`open/composer.ts` ~3338-3364): broadcast a plain-text `agent_message` to
 * every live app-ws topic, fully fail-soft — the whole body is wrapped so a
 * throw never escapes into `ApprovalManager.requestApproval` (which surfaces
 * notifier failure through `fireAndForget`, not a crash), and each per-topic
 * `send` is guarded so one dead socket never stops the rest.
 *
 * SECURITY: the body is PLAIN TEXT and carries ONLY the approval id, the
 * tool_name, and (if present) the request's `description`. It NEVER includes the
 * ritual prompt bytes, the tool surface, or any other args, and it is never
 * Markdown-rendered — the header's "never Markdown-render the prompt body" and
 * "describe capability, not internals" constraints. The rich, itemized approval
 * rendering with the affirmative-act binding is task 8's ButtonStore surface;
 * this notifier is only the "an approval is waiting" push.
 *
 * ANNOUNCE NOTHING BY DEFAULT (2026-09-11, owner-reported twice). Task 8 landed,
 * and every production caller of `requestApproval` now emits its OWN code-rendered
 * Approve/Deny prompt immediately after the row is persisted — `open/host-deploy.ts`
 * and `reminders/ritual-registration.ts`. So this push stopped being the approval
 * surface and became a second, UNACTIONABLE copy of it stacking up beneath the real
 * one, in EVERY open project at once. It was never a safety net either: a message
 * with no button cannot be acted on, so removing it removes no protection.
 *
 * `announce_tools` is therefore REQUIRED and OPT-IN — no default, so the caller has
 * to decide rather than inherit. It is EMPTY in production and that is the correct
 * value, not dead config: add a tool name here only if you introduce a `prompt-user`
 * approval that renders NO button prompt of its own, and prefer giving it buttons.
 */

import type { ApprovalNotifier, ApprovalRow } from '@neutronai/tools/approval.ts'
import type { AppWsOutboundAgentMessage } from '@neutronai/channels/adapters/app-ws/envelope.ts'

/**
 * The structural slice of the app-ws session registry this notifier needs.
 * Declared structurally (not as the concrete `InMemoryAppWsSessionRegistry`)
 * so the unit test can pass a recording stub with no real sockets.
 * `InMemoryAppWsSessionRegistry` satisfies this by construction.
 */
export interface ApprovalNotifierRegistry {
  topics(): string[]
  send(topic: string, env: AppWsOutboundAgentMessage): unknown
}

/**
 * Build the app-ws ApprovalNotifier. On `notify(row)` it broadcasts a
 * plain-text `agent_message` (`Approval requested [<id>]: <tool_name>[ — <description>]`)
 * to every live topic, fail-soft throughout.
 *
 * `ttl_ms` (optional) is the TTL GUARD: a row ALREADY older than it broadcasts
 * nothing at all. This banner is a one-shot frame held in client memory with no
 * retraction path, so a banner born pointing at a grant that is already dead can
 * only be cleared by reloading the page — it must never be born that way.
 * Omitted ⇒ the legacy always-broadcast behaviour, byte-identical.
 */
export function buildAppWsApprovalNotifier(deps: {
  registry: ApprovalNotifierRegistry
  /**
   * The tool names that still need the plain-text "an approval is waiting" push.
   * REQUIRED, with no default: a tool absent from this set is not announced at
   * all. Empty is the correct production value — see the header.
   */
  announce_tools: ReadonlySet<string>
  /** Grant lifetime in ms. A row past it is never announced. */
  ttl_ms?: number
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number
}): ApprovalNotifier {
  const { registry } = deps
  return {
    notify: async (row: ApprovalRow): Promise<void> => {
      try {
        // THE OPT-IN GATE, checked before anything else: a tool that renders its
        // own Approve/Deny prompt must not also get a buttonless copy.
        if (!deps.announce_tools.has(row.tool_name)) return

        // `requested_at` is SECONDS since epoch (the `tool_approvals` grammar).
        if (
          deps.ttl_ms !== undefined &&
          (deps.now ?? Date.now)() - row.requested_at * 1000 > deps.ttl_ms
        ) {
          return
        }

        let description: string | undefined
        try {
          const parsed = JSON.parse(row.args_json) as { description?: unknown }
          if (parsed && typeof parsed.description === 'string') {
            description = parsed.description
          }
        } catch {
          // Malformed args_json → fall back to the tool_name-only body.
        }

        const body =
          description !== undefined
            ? `Approval requested [${row.id}]: ${row.tool_name} — ${description}`
            : `Approval requested [${row.id}]: ${row.tool_name}`

        const env: AppWsOutboundAgentMessage = {
          v: 1,
          type: 'agent_message',
          body,
          message_id: `approval:${row.id}`,
          ts: Date.now(),
        }

        // SCOPED TO THE APPROVAL'S OWN TOPIC when it has one. Fanning out to
        // every live topic put a neutron-open deploy prompt in every other
        // project's chat — half of why these read as noise. A row with a null
        // topic_id has no home to go to, so it still broadcasts.
        const targets =
          row.topic_id !== null && registry.topics().includes(row.topic_id)
            ? [row.topic_id]
            : registry.topics()
        for (const topic of targets) {
          try {
            registry.send(topic, env)
          } catch {
            // One dead socket must not stop the rest.
          }
        }
      } catch {
        // app-ws delivery is best-effort — never throw into the caller.
      }
    },
  }
}
