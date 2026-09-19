import { ReplModelError, type ReplModelState, type ReplModelSwitch } from '../repl-model.ts'
import type { PtyChild } from './claude-code/persistent/pty-host.ts'
import { stripAnsi } from './claude-code/persistent/pty-text.ts'

interface Row { index: number; id: string; label: string; current: boolean; focused: boolean }
interface Picker { rows: Row[]; hidden: number; focused: number }

function pickerVisible(harness: ReplModelState['harness'], raw: string): boolean {
  const text = stripAnsi(raw)
  return harness === 'codex'
    ? text.includes('Select Model and Effort') && text.includes('Press enter to confirm or esc to go back')
    : text.includes('Select model') && text.includes('Esc to cancel')
}

/** The aliases are native selector spellings, never a catalogue of available models. */
function claudeId(label: string): string | undefined {
  const name = label.match(/^(Default|Opus|Fable|Sonnet|Haiku)\b/i)?.[1]?.toLowerCase()
  if (!name) return undefined
  return name + (name !== 'default' && label.includes('(1M context)') ? '[1m]' : '')
}

export function parseModelPicker(harness: ReplModelState['harness'], raw: string): Picker | undefined {
  const text = stripAnsi(raw).replace(/\r/g, '')
  const title = harness === 'codex' ? 'Select Model and Effort' : 'Select model'
  const start = text.lastIndexOf(title)
  if (start < 0) return undefined
  const body = text.slice(start)
  if (harness === 'claude-code' && !body.includes('s to use this session only')) return undefined
  if (harness === 'codex' && !body.includes('Press enter to confirm or esc to go back')) return undefined
  const rows: Row[] = []
  for (const line of body.split('\n')) {
    const match = line.match(/^\s*([❯›↑↓]?)\s*(\d+)\.\s+(.+)$/)
    if (!match) continue
    const value = match[3]!
    const id = harness === 'codex' ? value.match(/^([a-z0-9][a-z0-9._-]*)\b/)?.[1] : claudeId(value)
    if (!id) return undefined
    // Keep the provider's generation and description, including Default's actual target.
    const label = value.replace(/\s*✔\s*/g, ' ').replace(/\s*\(current\)\s*/g, ' ').replace(/\s+/g, ' ').trim()
    if (id === 'default' && !/\b(?:Opus|Fable|Sonnet|Haiku)\s+\d/i.test(label)) return undefined
    rows.push({ index: Number(match[2]), id, label,
      current: harness === 'codex' ? value.includes('(current)') : value.includes('✔'),
      focused: match[1] === '❯' || match[1] === '›' })
  }
  const focused = rows.find(row => row.focused)?.index
  if (!rows.length || focused === undefined) return undefined
  const hidden = Number(body.match(/…\s*\+(\d+)\s+models/)?.[1] ?? 0)
  return { rows, hidden, focused }
}

function idle(raw: string): boolean {
  const text = stripAnsi(raw).replace(/\r/g, '')
  if (/esc to interrupt|Esc to interrupt|Select model|Select Model and Effort/.test(text.slice(-2500))) return false
  return text.trimEnd().split('\n').slice(-6).some(line => /^\s*[❯›]\s*(?:Ask Codex to do anything)?\s*$/.test(line))
}

/** Operates only on the existing child. Never starts a model turn, clears, or resumes. */
export class NativeModelPicker {
  constructor(private readonly harness: ReplModelState['harness'], private readonly sessionId: string,
    private readonly child: PtyChild, private readonly budgetMs = 5000) {}

  private state(status: ReplModelState['status'], detail?: string): ReplModelState {
    return { harness: this.harness, sessionId: this.sessionId, currentModel: null,
      availableModels: [], status, ...(detail ? { detail } : {}) }
  }

  async run(request?: ReplModelSwitch): Promise<ReplModelState> {
    if (request && request.sessionId !== this.sessionId) throw new ReplModelError('session-changed', 'Conversation session changed; refresh before switching.')
    if (!this.child.readScreen || !this.child.submitLine || !this.child.sendKeys) {
      if (request) throw new ReplModelError('unsupported', 'Terminal host cannot observe and acknowledge native model controls.')
      return this.state('unsupported', 'Terminal host cannot observe and acknowledge native model controls.')
    }
    if (this.child.hasExited()) throw new ReplModelError('unavailable', 'Conversation session is not running.')
    if (!idle(await this.child.readScreen())) {
      if (request) throw new ReplModelError('busy', 'Conversation is busy or its prompt is not empty.')
      return this.state('busy', 'Conversation is busy or its prompt is not empty.')
    }
    let opened = false
    const read = async (): Promise<string> => {
      if (this.child.hasExited()) throw new ReplModelError('unavailable', 'Conversation ended during model selection.')
      return this.child.readScreen!()
    }
    const wait = async <T>(parse: (screen: string) => T | undefined): Promise<T> => {
      const deadline = Date.now() + this.budgetMs
      do {
        const parsed = parse(await read())
        if (parsed !== undefined) return parsed
        await new Promise(resolve => setTimeout(resolve, 50))
      } while (Date.now() < deadline)
      throw new ReplModelError('unknown', 'Native model control did not acknowledge its state.')
    }
    const close = async (): Promise<void> => {
      await this.child.sendKeys!(['escape'])
      await wait(screen => idle(screen) ? true : undefined)
      opened = false
    }
    try {
      await this.child.submitLine('/model')
      opened = true
      let picker = await wait(screen => parseModelPicker(this.harness, screen))
      const byIndex = new Map<number, Row>()
      const total = picker.rows.length + picker.hidden
      if (total > 40) throw new ReplModelError('unknown', 'Native model list exceeds the supported inspection bound.')
      // A viewport is not a catalogue. Walk to every row and require contiguous coverage.
      for (let step = 0; step < total * 2; step++) {
        for (const row of picker.rows) byIndex.set(row.index, row)
        if (byIndex.size === total && [...byIndex.keys()].every(index => index >= 1 && index <= total)) break
        const before = picker.focused
        await this.child.sendKeys!(['down'])
        picker = await wait(screen => {
          const next = parseModelPicker(this.harness, screen)
          return next && next.focused !== before ? next : undefined
        })
      }
      const rows = [...byIndex.values()].sort((a, b) => a.index - b.index)
      const current = rows.filter(row => row.current)
      if (rows.length !== total || current.length !== 1) throw new ReplModelError('unknown', 'Native model list or current selection is incomplete.')
      const state: ReplModelState = { ...this.state('ready'), currentModel: current[0]!.id,
        availableModels: rows.map(({ id, label }) => ({ id, label })) }
      if (!request) { await close(); return state }
      const target = rows.find(row => row.id === request.model)
      if (!target) throw new ReplModelError('invalid-model', 'Requested model is not offered by this conversation harness.')
      if (target.id === state.currentModel) { await close(); return state }
      let navigation = 0
      while (picker.focused !== target.index) {
        if (++navigation > total) throw new ReplModelError('unknown', 'Native model selection moved unexpectedly.')
        const before = picker.focused
        await this.child.sendKeys!([before < target.index ? 'down' : 'up'])
        picker = await wait(screen => {
          const next = parseModelPicker(this.harness, screen)
          return next && next.focused !== before ? next : undefined
        })
      }
      if (this.harness === 'claude-code') {
        await this.child.sendKeys!(['s'])
      } else {
        await this.child.sendKeys!(['enter'])
        await wait(screen => stripAnsi(screen).includes(`Select Reasoning Level for ${target.id}`) ? true : undefined)
        await this.child.sendKeys!(['enter'])
      }
      await wait(screen => idle(screen) ? true : undefined)
      opened = false
      // A delivered key is not success. Re-open native state and prove the selected row changed.
      const verified = await this.run()
      if (verified.status !== 'ready' || verified.currentModel !== target.id) {
        throw new ReplModelError('unknown', 'Harness did not acknowledge the requested model; refresh its native state.')
      }
      return verified
    } catch (error) {
      if (opened) {
        // Only dismiss a still-recognised picker, never an arbitrary later owner prompt.
        const screen = await read().catch(() => '')
        if (pickerVisible(this.harness, screen)) await close().catch(() => {})
      }
      if (!request && error instanceof ReplModelError && error.code === 'unknown') return this.state('unknown', error.message)
      throw error
    }
  }
}
