import { describe, expect, test } from 'bun:test'
import { NativeModelPicker, parseModelPicker } from './native-model-picker.ts'
import type { PtyChild } from './claude-code/persistent/pty-host.ts'

function nativeFixture(harness: 'claude-code' | 'codex', partial = false) {
  const models = harness === 'codex' ? ['gpt-6-astra', 'gpt-5.6-luna', 'gpt-5.6-sol'] : ['Fable', 'Sonnet', 'Haiku']
  let current = 0, focus = 0
  let view: 'idle' | 'picker' | 'effort' = 'idle'
  let refuse = false
  const commands: string[] = []
  const transcript = ['owner: remember the orange lighthouse', 'assistant: remembered']
  const child: PtyChild = {
    pid: 42, write() { throw new Error('unacknowledged write') }, kill() { throw new Error('must preserve process') },
    hasExited: () => false, exited: new Promise(() => {}),
    async readScreen() {
      if (view === 'idle') return `${transcript.join('\n')}\n❯ \n? for shortcuts`
      if (view === 'effort') return `Select Reasoning Level for ${models[focus]}\n› 2. Medium (default)`
      const rows = models.map((id, i) => `${focus === i ? '❯' : ' '} ${i + 1}. ${id}${current === i ? harness === 'codex' ? ' (current)' : ' ✔' : ''}  ${id} ${harness === 'claude-code' ? '5.1' : ''} model`).filter((_row, i) => !partial || i === focus)
      return `${harness === 'codex' ? 'Select Model and Effort' : 'Select model'}\n${rows.join('\n')}\n${partial ? '… +2 models\n' : ''}${harness === 'codex' ? 'Press enter to confirm or esc to go back' : 'Enter to set as default · s to use this session only · Esc to cancel'}`
    },
    async submitLine(command) {
      commands.push(command)
      if (command !== '/model') throw new Error('model commands must never become a prompt')
      view = 'picker'; focus = current
    },
    async sendKeys(keys) {
      for (const key of keys) {
        commands.push(key)
        if (key === 'escape') { view = 'idle'; continue }
        if (key === 'up') focus = (focus + models.length - 1) % models.length
        if (key === 'down') focus = (focus + 1) % models.length
        if (key === 's' || key === 'enter') {
          if (harness === 'claude-code' && key !== 's') throw new Error('global default must not change')
          if (harness === 'codex' && view === 'picker') { view = 'effort'; continue }
          if (!refuse) current = focus
          view = 'idle'
        }
      }
    },
  }
  return { child, commands, transcript, refuse: () => { refuse = true },
    picker: new NativeModelPicker(harness, 'same-session', child, 20) }
}

describe('native conversation model controls', () => {
  for (const harness of ['claude-code', 'codex'] as const) {
    test(`${harness}: current, complete list, switch down and up retain session and history`, async () => {
      const f = nativeFixture(harness, true)
      const before = await f.picker.run()
      expect(before.status).toBe('ready')
      expect(before.availableModels).toHaveLength(3)
      const cheap = before.availableModels[1]!.id
      const down = await f.picker.run({ sessionId: before.sessionId, model: cheap })
      expect(down.currentModel).toBe(cheap)
      expect(down.sessionId).toBe(before.sessionId)
      const up = await f.picker.run({ sessionId: down.sessionId, model: before.currentModel! })
      expect(up.currentModel).toBe(before.currentModel)
      expect(f.transcript).toEqual(['owner: remember the orange lighthouse', 'assistant: remembered'])
      expect(f.commands.filter(command => command.startsWith('/'))).toEqual(Array(5).fill('/model'))
    })
    test(`${harness}: transport ACK without model change is refused`, async () => {
      const f = nativeFixture(harness)
      const before = await f.picker.run()
      f.refuse()
      await expect(f.picker.run({ sessionId: before.sessionId, model: before.availableModels[1]!.id })).rejects.toMatchObject({ code: 'unknown' })
      expect((await f.picker.run()).currentModel).toBe(before.currentModel)
    })
    test(`${harness}: unoffered, injected, stale and same-model requests do not switch`, async () => {
      const f = nativeFixture(harness)
      const before = await f.picker.run()
      for (const model of ['not-offered', 'sonnet\n/clear']) {
        await expect(f.picker.run({ sessionId: before.sessionId, model })).rejects.toMatchObject({ code: 'invalid-model' })
      }
      const count = f.commands.length
      await expect(f.picker.run({ sessionId: 'other-session', model: before.currentModel! })).rejects.toMatchObject({ code: 'session-changed' })
      expect(f.commands).toHaveLength(count)
      expect((await f.picker.run({ sessionId: before.sessionId, model: before.currentModel! })).currentModel).toBe(before.currentModel)
      expect(f.commands).not.toContain('s')
      expect(f.commands).not.toContain('enter')
    })
  }

  test('busy prompts and unsupported hosts receive no input', async () => {
    const f = nativeFixture('claude-code')
    f.child.readScreen = async () => 'Working (esc to interrupt)\n❯ '
    expect((await f.picker.run()).status).toBe('busy')
    await expect(f.picker.run({ sessionId: 'same-session', model: 'haiku' })).rejects.toMatchObject({ code: 'busy' })
    delete f.child.readScreen
    expect((await f.picker.run()).status).toBe('unsupported')
    expect(f.commands).toEqual([])
  })

  test('unknown current, unknown aliases, missing session-only action and incomplete catalogue fail closed', async () => {
    for (const mutation of [
      (screen: string) => screen.replace('✔', ''),
      (screen: string) => screen.replaceAll('Fable', 'Unknown'),
      (screen: string) => screen.replace('s to use this session only', 'Enter to save'),
      (screen: string) => screen.replace('… +2 models', '… +3 models'),
    ]) {
      const f = nativeFixture('claude-code', true)
      const original = f.child.readScreen!
      f.child.readScreen = async () => mutation(await original())
      expect((await f.picker.run()).status).toBe('unknown')
      expect(f.commands).not.toContain('s')
    }
  })

  test('native Default exposes its concrete target label; focus is distinct from current', () => {
    const parsed = parseModelPicker('claude-code', 'Select model\n  1. Default (recommended) ✔  Opus 5 with 1M context\n❯ 2. Haiku  Haiku 4.5 · Fastest\ns to use this session only')!
    expect(parsed.rows[0]).toMatchObject({ id: 'default', current: true, focused: false, label: 'Default (recommended) Opus 5 with 1M context' })
    expect(parsed.rows[1]).toMatchObject({ id: 'haiku', current: false, focused: true })
  })
})
