import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { briefIntegrity, writeBriefParts } from './brief-parts.ts'

const SRC = readFileSync(fileURLToPath(new URL('./inner-workflow.mjs', import.meta.url)), 'utf8')

function extract(name: string): string {
  const start = SRC.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`${name} not found in inner-workflow.mjs`)
  const open = SRC.indexOf('{', start)
  let depth = 0
  for (let i = open; i < SRC.length; i += 1) {
    if (SRC[i] === '{') depth += 1
    else if (SRC[i] === '}') {
      depth -= 1
      if (depth === 0) return SRC.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`)
}

const sandbox = new Function(`${extract('briefIntegrity')}\nreturn briefIntegrity`) as () => (
  text: string,
) => string
const mjsBriefIntegrity = sandbox()
const scratch: string[] = []

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'trident-brief-parts-'))
  scratch.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('briefIntegrity', () => {
  test('is byte-exact with the inner-workflow implementation', () => {
    const large = Array.from({ length: 4000 }, (_, i) => `row ${i}: café € 漢字 😀\n`).join('')
    const vectors = [
      '',
      'a',
      'hello\nworld\n',
      'é',
      '€ 漢字',
      '😀',
      '\uD800',
      '\uDC00',
      `ending\uD800`,
      "mixed `backticks` and apostrophe's text",
      large,
    ]
    expect(Buffer.byteLength(large)).toBeGreaterThan(30_000)
    for (const vector of vectors) expect(briefIntegrity(vector)).toBe(mjsBriefIntegrity(vector))
  })
})

describe('writeBriefParts', () => {
  test('writes exact well-formed bytes and counts replacement bytes for a lone surrogate', () => {
    for (const task of ['café € 漢字 😀', `malformed \uD800 input`]) {
      const result = writeBriefParts({ runId: 'run', task, reflectionGuidance: '', dir: freshDir() })!
      const buf = readFileSync(result.taskFile)
      expect(buf.length).toBe(Number(result.taskIntegrity.split(':')[0]))
      if (!task.includes('\uD800')) expect(readFileSync(result.taskFile, 'utf8')).toBe(task)
    }
  })

  test('empty guidance writes no reflection file or manifest entry', () => {
    const dir = freshDir()
    const result = writeBriefParts({ runId: 'empty', task: 'task', reflectionGuidance: '', dir })!
    expect(result.reflectionFile).toBeNull()
    expect(result.reflectionIntegrity).toBeNull()
    expect(existsSync(join(dir, 'trident-brief-empty-reflection.part'))).toBe(false)
  })

  test('non-empty guidance writes both files with workflow-parity receipts', () => {
    const result = writeBriefParts({
      runId: 'both',
      task: 'task 😀',
      reflectionGuidance: 'guidance €',
      dir: freshDir(),
    })!
    expect(readFileSync(result.taskFile, 'utf8')).toBe('task 😀')
    expect(readFileSync(result.reflectionFile!, 'utf8')).toBe('guidance €')
    expect(result.taskIntegrity).toBe(mjsBriefIntegrity('task 😀'))
    expect(result.reflectionIntegrity).toBe(mjsBriefIntegrity('guidance €'))
  })

  test('write failure and an empty task return null without throwing', () => {
    expect(
      writeBriefParts({
        runId: 'fail',
        task: 'task',
        reflectionGuidance: '',
        dir: `/nonexistent-trident-${Date.now()}/nope`,
      }),
    ).toBeNull()
    expect(writeBriefParts({ runId: 'empty', task: '', reflectionGuidance: '', dir: freshDir() })).toBeNull()
  })

  test('sanitizes run ids so files stay strictly inside the requested directory', () => {
    const dir = freshDir()
    const result = writeBriefParts({ runId: '../../evil x', task: 'task', reflectionGuidance: 'guide', dir })!
    expect(result.taskFile.startsWith(`${dir}/`)).toBe(true)
    expect(result.reflectionFile!.startsWith(`${dir}/`)).toBe(true)
    expect(result.taskFile).toBe(join(dir, 'trident-brief-..-..-evil-x-task.part'))
  })
})
