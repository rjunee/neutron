/**
 * PRODUCTION WIRING guard for owner-approved host deploy.
 *
 * WHY THIS FILE EXISTS. The two lines that switch this capability on live in
 * `build-core-modules.ts` and nowhere else, and they had NO coverage: Argus r1
 * deleted each in turn and the suite stayed identically green while the feature
 * was dead. `open/__tests__/open-composition-fields-characterization.test.ts`
 * only asserts the composer EMITS the `host_deploy` key; nothing exercised
 * `buildCoreModules` CONSUMING it, and `gateway/wiring/__tests__/host-deploy-tool.test.ts`
 * registers against a stub registry of its own making. So the field could be
 * emitted, the surface could be correct, and the wire between them could be cut
 * with the whole tree passing.
 *
 * The two mutants this file exists to kill, both applied to the shipped source:
 *   1. delete the `registerHostDeployToolSurface(reg, input.host_deploy.service)`
 *      call from `toolsModule.init` → RED on "the tools module registers…".
 *   2. delete the `input.host_deploy?.install({ approvals: manager })` call from
 *      `approvalModule.init` → RED on "the approval module installs…".
 *
 * Both assertions are on the REAL registry and the REAL `ApprovalManager` the
 * graph hands out, not on stand-ins: identity of the manager is the point, since
 * a service holding a DIFFERENT manager would mint rows the owner's tap can
 * never resolve.
 */

import { asOwnerHandle } from '@neutronai/persistence/index.ts'
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'
import { ApprovalManager } from '@neutronai/tools/approval.ts'
import type { ToolCallContext } from '@neutronai/tools/registry.ts'

import { buildCoreModules } from './build-core-modules.ts'
import type { CompositionInput } from '../composition.ts'
import type { ModuleContext } from '../module-graph.ts'
import {
  HOST_DEPLOY_REQUEST_TOOL,
  HOST_DEPLOY_STATUS_TOOL,
  type HostDeployToolService,
} from '../wiring/host-deploy-tool.ts'

const OWNER = asOwnerHandle('host-deploy-composition')

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function makeProjectDb(): ProjectDb {
  const tmp = mkdtempSync(join(tmpdir(), 'host-deploy-comp-'))
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }))
  const db = ProjectDb.open(join(tmp, 'project.db'))
  cleanups.push(() => db.close())
  applyMigrations(db.raw())
  return db
}

/** A service that records nothing but its own identity — enough for the wire. */
function stubService(): HostDeployToolService {
  return {
    status: () => ({
      enabled: false,
      reason: 'no control-plane endpoint is configured on this instance',
      default_ref: 'origin/main',
    }),
    request: async () => ({
      status: 'unavailable',
      reason: 'no control-plane endpoint is configured on this instance',
    }),
  }
}

function baseInput(db: ProjectDb): CompositionInput {
  return {
    db,
    project_slug: OWNER,
    topic_handler: async () => {},
    approval_notifier: { notify: async () => undefined },
    watchdog_notifier: { notify: async () => undefined },
    reminder_dispatcher: { dispatch: async () => {} },
    heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
    platform: STUB_PLATFORM,
  } as unknown as CompositionInput
}

const EMPTY_CTX = { graph: { get: () => undefined, names: () => [] }, config: {} } as unknown as ModuleContext

const CALL_CTX = {
  project_slug: OWNER,
  project_id: null,
  topic_id: 'app:owner',
  call_id: 'call-1',
  speaker_user_id: null,
} as unknown as ToolCallContext

test('the tools module registers host_deploy_request + host_deploy_status from the composer field', async () => {
  const db = makeProjectDb()
  const input = {
    ...baseInput(db),
    host_deploy: { service: () => stubService(), install: (): void => {} },
  } as unknown as CompositionInput

  const mods = buildCoreModules(input)
  const registry = await mods.toolsModule.init(EMPTY_CTX)

  const names = registry.list().map((t) => t.name)
  expect(names).toContain(HOST_DEPLOY_REQUEST_TOOL)
  expect(names).toContain(HOST_DEPLOY_STATUS_TOOL)

  // Not merely present — REACHABLE, and reaching the service the composer wired.
  // A registration that throws on call would satisfy a name check and nothing else.
  const status = await registry.get(HOST_DEPLOY_STATUS_TOOL)!.handler({}, CALL_CTX)
  expect(status).toMatchObject({ enabled: false, default_ref: 'origin/main' })
})

test('an instance that wires no host_deploy field registers neither tool (the field IS the switch)', async () => {
  const db = makeProjectDb()
  const mods = buildCoreModules(baseInput(db))
  const registry = await mods.toolsModule.init(EMPTY_CTX)

  // The NEGATIVE control for the test above: the names are absent when the field
  // is, so "contains" up there is a real answer about the wire rather than a
  // registry that lists everything under the sun.
  const names = registry.list().map((t) => t.name)
  expect(names).not.toContain(HOST_DEPLOY_REQUEST_TOOL)
  expect(names).not.toContain(HOST_DEPLOY_STATUS_TOOL)
})

test('the approval module installs the host-deploy service with the GRAPH ApprovalManager', async () => {
  const db = makeProjectDb()
  // An array rather than a `let`: the assignment happens inside a closure the
  // checker cannot follow, so a nullable binding narrows to `null` at the
  // assertion and the identity check below stops compiling.
  const installed: ApprovalManager[] = []

  const input = {
    ...baseInput(db),
    host_deploy: {
      service: () => stubService(),
      install: (deps: { approvals: ApprovalManager }): void => {
        installed.push(deps.approvals)
      },
    },
  } as unknown as CompositionInput

  const mods = buildCoreModules(input)
  const manager = await mods.approvalModule.init(EMPTY_CTX)

  // The hook ran at all, exactly once…
  expect(installed).toHaveLength(1)
  // …and with the EXACT instance the graph hands everyone else. A service
  // holding a second manager would write `tool_approvals` rows the owner's
  // in-chat tap resolves against a different object.
  expect(installed[0]).toBe(manager)
  expect(manager).toBeInstanceOf(ApprovalManager)
})
