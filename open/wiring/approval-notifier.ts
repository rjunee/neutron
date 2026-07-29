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
 */
export function buildAppWsApprovalNotifier(deps: {
  registry: ApprovalNotifierRegistry
}): ApprovalNotifier {
  const { registry } = deps
  return {
    notify: async (row: ApprovalRow): Promise<void> => {
      try {
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

        for (const topic of registry.topics()) {
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
