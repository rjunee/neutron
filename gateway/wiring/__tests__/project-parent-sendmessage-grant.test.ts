import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import { buildReplArgv } from '@neutronai/runtime/adapters/claude-code/persistent/build-repl-argv.ts'
import { seedMigratedDb } from '../../../tests/support/migrated-db.ts'
import { buildLiveAgentTurn, LIVE_AGENT_TOOL_NAMES, PROJECT_REPL_TOOL_DEFS } from '../build-live-agent-turn.ts'
import { openAdmission } from './project-admission-fixture.ts'

let dir: string
let db: ProjectDb
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'project-native-grant-'))
  seedMigratedDb(join(dir, 'project.db'))
  db = ProjectDb.open(join(dir, 'project.db'))
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

async function capture(projectId: string | undefined, toolNames?: string[]) {
  const specs: AgentSpec[] = []
  const substrate: Substrate = {
    start(spec) {
      specs.push(spec)
      return {
        tool_resolution: 'internal',
        events: (async function* () {
          yield { kind: 'token' as const, text: 'ok' }
          yield { kind: 'completion' as const, usage: { input_tokens: 1, output_tokens: 1 }, substrate_instance_id: 'fixture' }
        })(),
        async cancel() {},
        async respondToTool() { throw new Error('unused') },
      }
    },
  }
  const run = buildLiveAgentTurn({ admission: openAdmission(), substrate,
    personaLoader: { async load() { return '' } }, buttonStore: new ButtonStore({ db }),
    project_slug: 'owner', owner_home: dir,
    ...(toolNames === undefined ? {} : { tool_names: toolNames }),
  })
  for (const user_text of ['hello', 'again']) {
    const result = await run({ project_slug: 'owner', user_id: 'owner', topic_id: 'chat',
      user_text, observed_at: Date.now(), send() {},
      ...(projectId === undefined ? {} : { project_id: projectId }),
    })
    expect(result.outcome).toBe('replied')
  }
  expect(specs).toHaveLength(2)
  return specs.map(spec => {
    const argv = buildReplArgv({ sessionId: 'fixture-session', resume: false, channelName: 'fixture-channel',
      mcpConfigPath: '/tmp/fixture-mcp.json', settingsPath: '/tmp/fixture-settings.json',
      appendSystemPromptFile: '/tmp/fixture-prompt.md', model: 'fixture-model', tools: spec.tools.map(t => t.name) })
    return argv[argv.indexOf('--tools') + 1]!.split(',').filter(Boolean)
  })
}

test('project cold and warm turns grant native messaging with the exact prewarm surface', async () => {
  for (const names of await capture('project-one')) {
    expect(names).toContain('Agent')
    expect(names).toContain('SendMessage')
    expect(names).toContain('TaskStop')
    expect(names).toEqual(PROJECT_REPL_TOOL_DEFS.map(t => t.name))
  }
})

test('a project named general still receives the project grant', async () => {
  for (const names of await capture('general')) expect(names).toContain('SendMessage')
})

test('General and the shared reminder surface retain their original grant', async () => {
  expect([...LIVE_AGENT_TOOL_NAMES]).toContain('Agent')
  expect([...LIVE_AGENT_TOOL_NAMES]).not.toContain('SendMessage')
  for (const names of await capture(undefined)) {
    expect(names).toEqual([...LIVE_AGENT_TOOL_NAMES])
    expect(names).not.toContain('SendMessage')
    expect(names).not.toContain('TaskStop')
  }
})

test('explicit project caller restrictions remain exact, including empty', async () => {
  for (const requested of [[], ['Read'], ['Agent']]) {
    for (const names of await capture('project-one', requested)) expect(names).toEqual(requested)
  }
})
