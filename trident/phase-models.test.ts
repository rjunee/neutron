import { expect, test } from 'bun:test'
import { parsePhaseModelConfig } from './phase-models.ts'

test('structured synthesis accepts explicit Claude and Codex, not arbitrary transports or NONE', () => {
  for (const model of ['opus', 'sol']) expect(parsePhaseModelConfig({ synthesis: { model } }).errors).toEqual([])
  for (const model of ['none', 'k3']) expect(parsePhaseModelConfig({ synthesis: { model } }).errors.length).toBeGreaterThan(0)
  expect(parsePhaseModelConfig({ decomposition: { model: 'sol' } }).errors.length).toBeGreaterThan(0)
})
