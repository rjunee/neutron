import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'composer.ts'), 'utf8')

test('Open arms one terminal-deploy observer on the host-deploy service', () => {
  expect(source.split('buildTerminalDeployWakeObserver(')).toHaveLength(2)
  expect(source.split('on_terminal: observeTerminalDeployWake')).toHaveLength(2)
  expect(source).toContain('appWsChatTurn!.composeActingTurn(')
})
