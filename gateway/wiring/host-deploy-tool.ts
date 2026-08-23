/**
 * @neutronai/gateway/wiring — `host_deploy_request` / `host_deploy_status`
 * agent tool surface.
 *
 * The agent's half of "the owner can ask his instance to deploy the host, and
 * approve it in chat". Registered into the SAME `neutron` tools registry the
 * #87 tools-bridge advertises (mirrors `create-project-tool.ts`), so the chat
 * REPL reaches them as `mcp__neutron__host_deploy_request` /
 * `mcp__neutron__host_deploy_status`.
 *
 * WHAT THE TOOL IS AND IS NOT. It does NOT deploy. It resolves what would be
 * deployed, raises an owner approval carrying the actual commit list, and
 * returns `pending_approval`. The deploy — one authenticated call to the
 * configured control-plane endpoint — happens only after the owner's explicit
 * tap, on a path the agent cannot reach at all (`handleOwnerButtonAnswer` is
 * wired to the live-turn capture seam, not to any tool). A request crosses the
 * privilege boundary; the capability never does.
 *
 * `approval_policy:'auto'` is deliberate and is NOT a missing gate: the tool's
 * gate is the `prompt-user` `tool_approvals` row it mints. Marking the tool
 * itself `prompt-user` would prompt the owner twice, once for a message with no
 * commit list in it.
 *
 * VISIBLE EVEN WHEN DISABLED. Both tools are registered whenever the composer
 * wires the service, regardless of whether a control-plane endpoint is
 * configured. On a self-hosted box with no endpoint, `host_deploy_status`
 * answers `enabled:false` WITH the reason and `host_deploy_request` refuses the
 * same way — it never disappears. An option that silently disappears is how a
 * missing capability stays invisible for weeks.
 */

import type { JsonSchemaDocument } from '@neutronai/cores-sdk/manifest'
import type { ToolRegistry } from '@neutronai/tools/registry.ts'

export const HOST_DEPLOY_REQUEST_TOOL = 'host_deploy_request'
export const HOST_DEPLOY_STATUS_TOOL = 'host_deploy_status'
export const HOST_DEPLOY_WINDOW_REQUEST_TOOL = 'host_deploy_window_request'
export const HOST_DEPLOY_WINDOW_STATUS_TOOL = 'host_deploy_window_status'
export const HOST_DEPLOY_WINDOW_REVOKE_TOOL = 'host_deploy_window_revoke'

/**
 * The structural slice of `open/host-deploy.ts`'s service this surface needs.
 * Declared structurally so the gateway never imports the Open product module
 * (the L3 DAG cut) and a test can pass a recording stub.
 */
export interface HostDeployToolService {
  status(): {
    enabled: boolean
    reason: string | null
    default_ref: string
  }
  request(input: { ref?: string; topic_id?: string | null }): Promise<
    | {
        status: 'pending_approval'
        request_id: string
        ref: string
        target_sha: string
        current_sha: string
        commit_count: number
        approval_topic_id: string
        note?: string
      }
    | {
        /** A standing window was open, so this DEPLOYED instead of asking. */
        status: 'auto_approved'
        ref: string
        target_sha: string
        current_sha: string
        commit_count: number
        accepted: boolean
        detail: string
        window_expires_at_ms: number
      }
    | { status: 'unavailable'; reason: string }
    | { status: 'up_to_date'; ref: string; target_sha: string }
    | { status: 'refused'; reason: string }
  >
  requestWindow(input: { hours: number; ref?: string; topic_id?: string | null }): Promise<
    | {
        status: 'pending_approval'
        request_id: string
        ref: string
        hours: number
        expires_at_ms: number
        approval_topic_id: string
        note?: string
      }
    | { status: 'unavailable'; reason: string }
    | { status: 'refused'; reason: string }
  >
  windowStatus(ref?: string): {
    open: boolean
    ref: string
    expires_at_ms: number | null
    remaining: string | null
  }
  revokeWindow(ref?: string): Promise<number>
}

const requestInputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {
    ref: {
      type: 'string',
      description:
        'The git ref to deploy the host to (e.g. "origin/main", a branch, a tag or a sha). ' +
        'Defaults to the instance default when omitted. Must already be known to the host checkout.',
    },
  },
  required: [],
  additionalProperties: false,
}

const requestOutputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      description:
        "'pending_approval' (the owner has been asked), 'unavailable' (no control plane configured), " +
        "'up_to_date' (the host already runs that sha) or 'refused' (nothing was requested).",
    },
    request_id: { type: 'string' },
    ref: { type: 'string' },
    target_sha: { type: 'string' },
    current_sha: { type: 'string' },
    commit_count: { type: 'integer' },
    approval_topic_id: {
      type: 'string',
      description: 'The chat topic the Approve/Deny prompt was posted to.',
    },
    note: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['status'],
}

const statusInputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
}

const statusOutputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    reason: {
      type: ['string', 'null'],
      description: 'Why host deploys are disabled on this instance, and what would enable them.',
    },
    default_ref: { type: 'string' },
  },
  required: ['enabled', 'reason', 'default_ref'],
}

const windowRequestInputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {
    hours: {
      type: 'integer',
      description:
        'How long the window stays open, in whole hours (1-72). Outside that range is REFUSED, ' +
        'never clamped.',
    },
    ref: {
      type: 'string',
      description:
        'The git ref the window authorises. Defaults to the instance default. A window for one ref ' +
        'authorises nothing about any other.',
    },
  },
  required: ['hours'],
  additionalProperties: false,
}

const windowRequestOutputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      description:
        "'pending_approval' (the owner has been asked to open it), 'unavailable' (no control plane " +
        "configured) or 'refused' (nothing was requested — the reason says why).",
    },
    request_id: { type: 'string' },
    ref: { type: 'string' },
    hours: { type: 'integer' },
    expires_at_ms: { type: 'integer' },
    approval_topic_id: {
      type: 'string',
      description: 'The chat topic the Approve/Deny prompt was posted to.',
    },
    note: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['status'],
}

const windowStatusInputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: { ref: { type: 'string' } },
  required: [],
  additionalProperties: false,
}

const windowStatusOutputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {
    open: { type: 'boolean' },
    ref: { type: 'string' },
    expires_at_ms: { type: ['integer', 'null'] },
    remaining: {
      type: ['string', 'null'],
      description: 'How long the window has left, in words. Null when nothing is open.',
    },
  },
  required: ['open', 'ref'],
}

const windowRevokeOutputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {
    closed: {
      type: 'integer',
      description: 'How many live windows THIS call closed. 0 means none was open.',
    },
    ref: { type: 'string' },
  },
  required: ['closed', 'ref'],
}

interface RequestArgs {
  ref?: unknown
}

interface WindowRequestArgs {
  hours?: unknown
  ref?: unknown
}

/**
 * Register `host_deploy_request` + `host_deploy_status` against `registry`,
 * backed by the composer-built service. `service` is a LATE-BOUND getter: the
 * tools module initializes before the graph's `ApprovalManager` exists, so the
 * handler derefs at CALL time. A null deref means the box never installed the
 * service — the tool says so rather than throwing an internal error. Returns
 * the registered tool names.
 */
export function registerHostDeployToolSurface(
  registry: ToolRegistry,
  service: () => HostDeployToolService | null,
): string[] {
  registry.register({
    name: HOST_DEPLOY_REQUEST_TOOL,
    description:
      'ASK the owner to deploy the host this instance runs on to a named git ref. IMPORTANT: this ' +
      'does NOT deploy anything. It works out what would be deployed (the sha the host runs now, the ' +
      'target sha, and every commit between them), posts that list to the owner as an Approve/Deny ' +
      'message, and returns status "pending_approval". The deploy only happens if the owner taps ' +
      'Approve, and the approval is bound to the exact target sha — if the ref moves before he ' +
      'answers, it is refused as stale and you must ask again. You cannot approve this yourself. ' +
      'Returns status "unavailable" with a reason when no control-plane endpoint is configured (a ' +
      'self-hosted box), "up_to_date" when the host already runs that sha, or "refused" with a reason. ' +
      'When you relay "pending_approval" you MUST tell the owner WHICH topic carries the Approve/Deny ' +
      'prompt: it is in "approval_topic_id" and is normally this very conversation, and the "note" field ' +
      'says so when it is somewhere else. Never say a button is waiting without saying where it is.',
    input_schema: requestInputSchema,
    output_schema: requestOutputSchema,
    capability_required: 'write:project_data',
    approval_policy: 'auto',
    handler: async (args, ctx) => {
      const svc = service()
      if (svc === null) {
        return {
          status: 'unavailable',
          reason: 'host deploys are not wired on this instance',
        }
      }
      const a = (args ?? {}) as RequestArgs
      const ref = typeof a.ref === 'string' ? a.ref.trim() : ''
      // THE CALLING TOPIC IS THE DESTINATION. `ToolCallContext.topic_id` is null
      // for cron/system calls; pass it through as-is and let the service pick
      // the install fallback — the tool does not decide where the button goes.
      return await svc.request({
        ...(ref.length > 0 ? { ref } : {}),
        topic_id: ctx.topic_id,
      })
    },
  })

  registry.register({
    name: HOST_DEPLOY_STATUS_TOOL,
    description:
      'Report whether this instance can ASK for a deploy of the host it runs on, and if not, exactly ' +
      'what would enable it. Read-only — it neither deploys nor asks. Use it before host_deploy_request ' +
      'so you can tell the owner plainly when the capability exists but is switched off on this box.',
    input_schema: statusInputSchema,
    output_schema: statusOutputSchema,
    capability_required: 'read:project_data',
    approval_policy: 'auto',
    handler: async () => {
      const svc = service()
      if (svc === null) {
        return {
          enabled: false,
          reason: 'host deploys are not wired on this instance',
          default_ref: '',
        }
      }
      return svc.status()
    },
  })

  registry.register({
    name: HOST_DEPLOY_WINDOW_REQUEST_TOOL,
    description:
      'ASK the owner to open a STANDING DEPLOY WINDOW: for the next N hours (1-72), deploys of the ' +
      'named ref go out WITHOUT a per-sha Approve tap. IMPORTANT: this opens nothing by itself — it ' +
      'posts an Approve/Deny prompt and returns "pending_approval"; only the owner\'s tap opens the ' +
      'window. Use it when the owner is away or when a run of merges would otherwise need a tap each. ' +
      'While a window is open, host_deploy_request returns "auto_approved" and the deploy has ALREADY ' +
      'happened — every one of them posts a notice to chat saying what went out. An open window is ' +
      'never extended by asking again: close it first. Tell the owner WHICH topic carries the prompt ' +
      '(the "approval_topic_id" field).',
    input_schema: windowRequestInputSchema,
    output_schema: windowRequestOutputSchema,
    capability_required: 'write:project_data',
    approval_policy: 'auto',
    handler: async (args, ctx) => {
      const svc = service()
      if (svc === null) {
        return { status: 'unavailable', reason: 'host deploys are not wired on this instance' }
      }
      const a = (args ?? {}) as WindowRequestArgs
      const ref = typeof a.ref === 'string' ? a.ref.trim() : ''
      // Passed through UNVALIDATED on purpose: the range check lives in the
      // service (`validateWindowHours`), so the tool surface and the chat surface
      // cannot disagree about what a legal window is.
      return await svc.requestWindow({
        hours: a.hours as number,
        ...(ref.length > 0 ? { ref } : {}),
        topic_id: ctx.topic_id,
      })
    },
  })

  registry.register({
    name: HOST_DEPLOY_WINDOW_STATUS_TOOL,
    description:
      'Report whether a standing deploy window is open right now, and how long it has left. ' +
      'Read-only. Check this before telling the owner whether a deploy needs his tap.',
    input_schema: windowStatusInputSchema,
    output_schema: windowStatusOutputSchema,
    capability_required: 'read:project_data',
    approval_policy: 'auto',
    handler: async (args) => {
      const svc = service()
      if (svc === null) {
        return { open: false, ref: '', expires_at_ms: null, remaining: null }
      }
      const a = (args ?? {}) as RequestArgs
      const ref = typeof a.ref === 'string' ? a.ref.trim() : ''
      return svc.windowStatus(ref.length > 0 ? ref : undefined)
    },
  })

  registry.register({
    name: HOST_DEPLOY_WINDOW_REVOKE_TOOL,
    description:
      'CLOSE the standing deploy window immediately, so deploys go back to asking the owner per sha. ' +
      'Safe to call when nothing is open — it returns closed:0. Call it the moment the owner says to ' +
      'stop deploying without asking; do NOT wait for the window to lapse.',
    input_schema: windowStatusInputSchema,
    output_schema: windowRevokeOutputSchema,
    capability_required: 'write:project_data',
    approval_policy: 'auto',
    handler: async (args) => {
      const svc = service()
      if (svc === null) return { closed: 0, ref: '' }
      const a = (args ?? {}) as RequestArgs
      const ref = typeof a.ref === 'string' ? a.ref.trim() : ''
      const target = ref.length > 0 ? ref : undefined
      const closed = await svc.revokeWindow(target)
      return { closed, ref: svc.windowStatus(target).ref }
    },
  })

  return [
    HOST_DEPLOY_REQUEST_TOOL,
    HOST_DEPLOY_STATUS_TOOL,
    HOST_DEPLOY_WINDOW_REQUEST_TOOL,
    HOST_DEPLOY_WINDOW_STATUS_TOOL,
    HOST_DEPLOY_WINDOW_REVOKE_TOOL,
  ]
}
