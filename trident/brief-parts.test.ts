import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { briefIntegrity, bufferIntegrity, writeBriefParts } from './brief-parts.ts'

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
const large = Array.from({ length: 4000 }, (_, i) => `row ${i}: café € 漢字 😀\n`).join('')
const integrityVectors = [
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
    expect(Buffer.byteLength(large)).toBeGreaterThan(30_000)
    for (const vector of integrityVectors) expect(briefIntegrity(vector)).toBe(mjsBriefIntegrity(vector))
  })

  test('matches the byte-domain receipt for every parity vector', () => {
    for (const vector of integrityVectors) {
      expect(bufferIntegrity(Buffer.from(vector, 'utf8'))).toBe(briefIntegrity(vector))
    }
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
    const warnings: string[] = []
    const result = writeBriefParts({
      runId: 'both',
      task: 'task 😀',
      reflectionGuidance: 'guidance €',
      dir: freshDir(),
      warn: (message) => warnings.push(message),
    })!
    expect(readFileSync(result.taskFile, 'utf8')).toBe('task 😀')
    expect(readFileSync(result.reflectionFile!, 'utf8')).toBe('guidance €')
    expect(result.taskIntegrity).toBe(briefIntegrity('task 😀'))
    expect(result.reflectionIntegrity).toBe(briefIntegrity('guidance €'))
    expect(warnings).toEqual([])
  })

  test('write failure warns without owner content and an empty task returns null quietly', () => {
    const warnings: string[] = []
    expect(
      writeBriefParts({
        runId: 'fail',
        task: 'OWNER-SECRET-CONTENT',
        reflectionGuidance: '',
        dir: `/nonexistent-trident-${Date.now()}/nope`,
        warn: (message) => warnings.push(message),
      }),
    ).toBeNull()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('brief-parts: write failed for run fail:')
    expect(warnings[0]).not.toContain('OWNER-SECRET-CONTENT')
    expect(
      writeBriefParts({
        runId: 'empty',
        task: '',
        reflectionGuidance: '',
        dir: freshDir(),
        warn: (message) => warnings.push(message),
      }),
    ).toBeNull()
    expect(warnings).toHaveLength(1)
  })

  test('refuses a persistently truncated task after exactly one rewrite', () => {
    const dir = freshDir()
    const task = `owner-private-${'x'.repeat(900)}`
    const taskFile = join(dir, 'trident-brief-truncated-task.part')
    const writes: string[] = []
    const warnings: string[] = []
    const result = writeBriefParts({
      runId: 'truncated',
      task,
      reflectionGuidance: 'guidance that must never be attempted',
      dir,
      io: {
        write_file: (path, data) => {
          writes.push(path)
          writeFileSync(path, data.subarray(0, Math.max(0, data.length - 569)))
        },
        read_file: readFileSync,
      },
      warn: (message) => warnings.push(message),
    })

    expect(result).toBeNull()
    expect(writes).toEqual([taskFile, taskFile])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(taskFile)
    expect(warnings[0]).toContain(bufferIntegrity(readFileSync(taskFile)))
    expect(warnings[0]).toContain(briefIntegrity(task))
    expect(warnings[0]).not.toContain(task)
  })

  test('recovers from one transient short write with a disk-matching receipt', () => {
    const dir = freshDir()
    let writes = 0
    const result = writeBriefParts({
      runId: 'transient',
      task: `transient-${'x'.repeat(900)}`,
      reflectionGuidance: '',
      dir,
      io: {
        write_file: (path, data) => {
          writes += 1
          writeFileSync(path, writes === 1 ? data.subarray(0, data.length - 569) : data)
        },
        read_file: readFileSync,
      },
    })!

    const persisted = readFileSync(result.taskFile)
    expect(writes).toBe(2)
    expect(bufferIntegrity(persisted)).toBe(result.taskIntegrity)
    expect(persisted.length).toBe(Number(result.taskIntegrity.split(':')[0]))
  })

  test('refuses the whole manifest when only reflection writes stay truncated', () => {
    const dir = freshDir()
    let reflectionWrites = 0
    const result = writeBriefParts({
      runId: 'reflection-truncated',
      task: 'faithful task',
      reflectionGuidance: `guidance-${'y'.repeat(900)}`,
      dir,
      io: {
        write_file: (path, data) => {
          const truncate = path.endsWith('-reflection.part')
          if (truncate) reflectionWrites += 1
          writeFileSync(path, truncate ? data.subarray(0, data.length - 569) : data)
        },
        read_file: readFileSync,
      },
      warn: () => {},
    })

    expect(result).toBeNull()
    expect(reflectionWrites).toBe(2)
  })

  test('sanitizes run ids so files stay strictly inside the requested directory', () => {
    const dir = freshDir()
    const result = writeBriefParts({ runId: '../../evil x', task: 'task', reflectionGuidance: 'guide', dir })!
    expect(result.taskFile.startsWith(`${dir}/`)).toBe(true)
    expect(result.reflectionFile!.startsWith(`${dir}/`)).toBe(true)
    expect(result.taskFile).toBe(join(dir, 'trident-brief-..-..-evil-x-task.part'))
  })
})
