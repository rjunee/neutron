import { expect, test } from 'bun:test'
import { bootstrapCodexOwner } from './project-control-bootstrap.ts'

test('explicit placement refuses the unhosted bootstrap before filesystem or process work', async () => {
  await expect(bootstrapCodexOwner({ binary: 'must-not-run', cwd: 'invalid', codexHome: 'invalid',
    socketPath: 'invalid', env: {},
    projectPlacement: { instanceId: 'instance', projectId: null, projectLabel: 'General', role: 'chat' },
  })).rejects.toThrow('Explicit Codex project placement requires a terminal host')
  // Positive control: with a host the independent canonical-path guard is reached.
  await expect(bootstrapCodexOwner({ binary: 'must-not-run', cwd: 'invalid', codexHome: 'invalid',
    socketPath: 'invalid', env: {},
    terminalHost: { async spawn() { throw new Error('must not spawn before path validation') } },
    projectPlacement: { instanceId: 'instance', projectId: null, projectLabel: 'General', role: 'chat' },
  })).rejects.toThrow('Canonical bootstrap paths required')
})
