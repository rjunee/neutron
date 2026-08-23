/**
 * The `host_deploy_request` / `host_deploy_status` agent tool surface.
 *
 * The one property this file exists to pin: THE CAPABILITY IS VISIBLE EVEN WHEN
 * IT IS DISABLED. A box with no control-plane endpoint configured must still
 * advertise both tools and answer with the REASON — an option that silently
 * disappears is how a missing capability stays invisible for weeks.
 *
 * MUTATION-TESTED: making registration conditional on `status().enabled` turns
 * "registered even with no control plane configured" RED; dropping the
 * `agent_hidden` assertion's subject (setting `agent_hidden: true`) turns the
 * manifest-visibility assertion RED.
 */

import { describe, expect, test } from 'bun:test'

import { ToolRegistry } from '@neutronai/tools/registry.ts'

import {
  registerHostDeployToolSurface,
  HOST_DEPLOY_REQUEST_TOOL,
  HOST_DEPLOY_STATUS_TOOL,
  HOST_DEPLOY_WINDOW_REQUEST_TOOL,
  HOST_DEPLOY_WINDOW_REVOKE_TOOL,
  HOST_DEPLOY_WINDOW_STATUS_TOOL,
  type HostDeployToolService,
} from '../host-deploy-tool.ts'

const CTX = {
  project_slug: 'owner',
  project_id: null,
  topic_id: 'app:owner',
  call_id: 'call-1',
  speaker_user_id: 'owner',
}

const DISABLED_REASON =
  'No host-deploy endpoint is configured. Add its named values in Settings → Integrations.'

function stub(
  overrides: Partial<HostDeployToolService> = {},
): {
  service: HostDeployToolService
  requests: Array<{ ref?: string; topic_id?: string | null }>
} {
  const requests: Array<{ ref?: string; topic_id?: string | null }> = []
  const service: HostDeployToolService = {
    status: () => ({ enabled: true, reason: null, default_ref: 'origin/main' }),
    request: async (input) => {
      requests.push(input)
      return {
        status: 'pending_approval',
        request_id: 'r1',
        ref: input.ref ?? 'origin/main',
        target_sha: 'ff00112233445566778899aabbccddeeff001122',
        current_sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        commit_count: 3,
        approval_topic_id: input.topic_id ?? 'app:owner',
      }
    },
    requestWindow: async (input) => ({
      status: 'pending_approval',
      request_id: 'w1',
      ref: input.ref ?? 'origin/main',
      hours: input.hours,
      expires_at_ms: 1_800_000_000_000,
      approval_topic_id: input.topic_id ?? 'app:owner',
    }),
    windowStatus: (ref) => ({
      open: false,
      ref: ref ?? 'origin/main',
      expires_at_ms: null,
      remaining: null,
    }),
    revokeWindow: async () => 0,
    ...overrides,
  }
  return { service, requests }
}

describe('registration', () => {
  test('both tools register, are agent-visible, and gate on the right capability', () => {
    const reg = new ToolRegistry()
    const { service } = stub()
    const names = registerHostDeployToolSurface(reg, () => service)
    // The two single-deploy tools FIRST and in this order — the window trio was
    // added after them and must not reshuffle the pair anything else asserts on.
    expect(names.slice(0, 2)).toEqual([HOST_DEPLOY_REQUEST_TOOL, HOST_DEPLOY_STATUS_TOOL])
    expect(names).toEqual([
      HOST_DEPLOY_REQUEST_TOOL,
      HOST_DEPLOY_STATUS_TOOL,
      HOST_DEPLOY_WINDOW_REQUEST_TOOL,
      HOST_DEPLOY_WINDOW_STATUS_TOOL,
      HOST_DEPLOY_WINDOW_REVOKE_TOOL,
    ])

    const request = reg.get(HOST_DEPLOY_REQUEST_TOOL)
    expect(request).not.toBeUndefined()
    expect(request?.capability_required).toBe('write:project_data')
    // 'auto' is the tool-call gate, NOT the deploy gate: the deploy gate is the
    // `prompt-user` tool_approvals row the service mints, which carries the
    // commit list. A second prompt here would be a prompt with nothing in it.
    expect(request?.approval_policy).toBe('auto')
    expect(request?.agent_hidden ?? false).toBe(false)
    // The description tells the agent it cannot approve its own request.
    expect(request?.description).toContain('does NOT deploy anything')
    expect(request?.description).toContain('cannot approve this yourself')

    const status = reg.get(HOST_DEPLOY_STATUS_TOOL)
    expect(status?.capability_required).toBe('read:project_data')
    expect(status?.agent_hidden ?? false).toBe(false)
  })

  test('registered even with NO control plane configured — visible and disabled', async () => {
    const reg = new ToolRegistry()
    const { service } = stub({
      status: () => ({ enabled: false, reason: DISABLED_REASON, default_ref: 'origin/main' }),
      request: async () => ({ status: 'unavailable', reason: DISABLED_REASON }),
    })
    registerHostDeployToolSurface(reg, () => service)

    // PRESENT.
    expect(reg.get(HOST_DEPLOY_REQUEST_TOOL)).not.toBeUndefined()
    expect(reg.get(HOST_DEPLOY_STATUS_TOOL)).not.toBeUndefined()

    // DISABLED, WITH THE REASON — assert the reason string, not just the flag.
    const out = (await reg.get(HOST_DEPLOY_STATUS_TOOL)!.handler({}, CTX)) as {
      enabled: boolean
      reason: string
    }
    expect(out.enabled).toBe(false)
    expect(out.reason).toBe(DISABLED_REASON)

    const asked = (await reg.get(HOST_DEPLOY_REQUEST_TOOL)!.handler({}, CTX)) as {
      status: string
      reason: string
    }
    expect(asked.status).toBe('unavailable')
    expect(asked.reason).toBe(DISABLED_REASON)
  })
})

describe('handler behaviour', () => {
  test('a ref argument is trimmed through; an empty one falls back to the default', async () => {
    const reg = new ToolRegistry()
    const { service, requests } = stub()
    registerHostDeployToolSurface(reg, () => service)
    const tool = reg.get(HOST_DEPLOY_REQUEST_TOOL)!

    await tool.handler({ ref: '  release/2026-08  ' }, CTX)
    await tool.handler({ ref: '   ' }, CTX)
    await tool.handler({}, CTX)
    await tool.handler({ ref: 42 }, CTX)
    expect(requests).toEqual([
      { ref: 'release/2026-08', topic_id: 'app:owner' },
      { topic_id: 'app:owner' },
      { topic_id: 'app:owner' },
      { topic_id: 'app:owner' },
    ])
  })

  // THE CARD, 2026-08-15: the owner asked for a deploy from his project topic
  // and was told to tap a button that had been posted to General. The tool used
  // to ignore its ctx entirely; the topic the call came from is the topic the
  // Approve/Deny prompt has to land on, so it must reach the service.
  test('the CALLING topic is threaded into the service request', async () => {
    const reg = new ToolRegistry()
    const { service, requests } = stub()
    registerHostDeployToolSurface(reg, () => service)

    await reg.get(HOST_DEPLOY_REQUEST_TOOL)!.handler(
      { ref: 'origin/main' },
      { ...CTX, topic_id: 'app:owner:proj-x' },
    )
    expect(requests).toEqual([{ ref: 'origin/main', topic_id: 'app:owner:proj-x' }])
  })

  test('a null calling topic is passed through — the SERVICE picks the fallback', async () => {
    const reg = new ToolRegistry()
    const { service, requests } = stub()
    registerHostDeployToolSurface(reg, () => service)

    // Cron/system callers have no conversation. The tool does not invent one:
    // choosing the fallback destination is the service's single decision.
    await reg.get(HOST_DEPLOY_REQUEST_TOOL)!.handler({}, { ...CTX, topic_id: null })
    expect(requests).toEqual([{ topic_id: null }])
  })

  test('the description tells the agent to name the topic carrying the prompt', () => {
    const reg = new ToolRegistry()
    registerHostDeployToolSurface(reg, () => stub().service)
    const description = reg.get(HOST_DEPLOY_REQUEST_TOOL)?.description ?? ''
    expect(description).toContain('approval_topic_id')
    expect(description).toContain('Never say a button is waiting without saying where it is.')
  })

  test('the late-bound getter returning null reads as unavailable, not a crash', async () => {
    const reg = new ToolRegistry()
    registerHostDeployToolSurface(reg, () => null)

    const asked = (await reg.get(HOST_DEPLOY_REQUEST_TOOL)!.handler({}, CTX)) as {
      status: string
      reason: string
    }
    expect(asked.status).toBe('unavailable')
    expect(asked.reason).toContain('not wired on this instance')

    const status = (await reg.get(HOST_DEPLOY_STATUS_TOOL)!.handler({}, CTX)) as {
      enabled: boolean
      reason: string
    }
    expect(status.enabled).toBe(false)
    expect(status.reason).toContain('not wired on this instance')
  })

  test('the getter is dereferenced at CALL time, not at registration time', async () => {
    const reg = new ToolRegistry()
    let installed: HostDeployToolService | null = null
    registerHostDeployToolSurface(reg, () => installed)

    // Registered before the service exists (the tools module initializes before
    // the graph's ApprovalManager) — and it still answers.
    expect((await reg.get(HOST_DEPLOY_STATUS_TOOL)!.handler({}, CTX)) as { enabled: boolean }).toMatchObject(
      { enabled: false },
    )

    installed = stub().service
    expect((await reg.get(HOST_DEPLOY_STATUS_TOOL)!.handler({}, CTX)) as { enabled: boolean }).toMatchObject(
      { enabled: true, default_ref: 'origin/main' },
    )
  })
})
