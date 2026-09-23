import { expect, test } from 'bun:test'
import { createPersistentReplSubstrate } from '../persistent-repl-substrate.ts'
import type { ProjectPanePlacement } from '../project-workspaces.ts'

test.each([null, 'general', 'project'])('Claude spawn preserves exact terminal scope %s', async projectId => {
  const placement: ProjectPanePlacement = { instanceId: 'instance', projectId, projectLabel: 'Shared label', role: 'chat' }
  const observed: ProjectPanePlacement[] = []
  const substrate = createPersistentReplSubstrate({ substrate_instance_id: `placement-${JSON.stringify(projectId)}`,
    cwd: '/tmp', skipTrustSeed: true, projectPlacement: placement,
    ptyHost: { async spawn(_argv, options) {
      if (options.projectPlacement) observed.push(options.projectPlacement)
      throw new Error('placement test stops before launching a model')
    } },
  })
  const events = []
  for await (const event of substrate.start({ prompt: 'hello', tools: [], model_preference: ['claude-opus-4-7'] }).events) events.push(event)
  expect(events).toContainEqual(expect.objectContaining({ kind: 'error', message: expect.stringContaining('placement test stops') }))
  expect(observed).toEqual([placement])
})
