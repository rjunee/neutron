import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { TranscriptUsageIngestor, parseTranscriptUsageLine } from './transcript-usage.ts'

let dir: string
let db: ProjectDb
let transcript: string
const attribution = { project: 'alpha', topic: 'fix usage', agent: 'codex', phase: 'build', run_id: 'run-1' }

function line(input: number, output: number, cached: number, reasoning: number): string {
  return JSON.stringify({ timestamp: '2026-09-15T01:00:00.000Z', type: 'event_msg', payload: {
    type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output,
      cached_input_tokens: cached, reasoning_output_tokens: reasoning } },
  } })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'transcript-usage-'))
  const dbPath = join(dir, 'project.db')
  seedMigratedDb(dbPath)
  db = ProjectDb.open(dbPath)
  transcript = join(dir, 'rollout.jsonl')
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

test('watermark makes a bounded transcript append one usage row per complete token line', async () => {
  writeFileSync(transcript, `${line(100, 20, 60, 5)}\n${line(140, 30, 80, 7)}`)
  const ingestor = new TranscriptUsageIngestor(db)
  expect(await ingestor.ingest(transcript, attribution)).toMatchObject({ rows: 1, caught_up: false })
  appendFileSync(transcript, '\n')
  expect(await ingestor.ingest(transcript, attribution)).toMatchObject({ rows: 1, caught_up: true })
  expect((await ingestor.ingest(transcript, attribution)).rows).toBe(0)
  expect(db.all(`SELECT project, topic, agent, phase, input_tokens, output_tokens,
    cache_read_tokens, reasoning_tokens FROM transcript_usage_events ORDER BY line_offset`)).toEqual([
    { project: 'alpha', topic: 'fix usage', agent: 'codex', phase: 'build', input_tokens: 100, output_tokens: 20, cache_read_tokens: 60, reasoning_tokens: 5 },
    { project: 'alpha', topic: 'fix usage', agent: 'codex', phase: 'build', input_tokens: 40, output_tokens: 10, cache_read_tokens: 20, reasoning_tokens: 2 },
  ])
})

test('reasoning is an output subset and never an additive token class', async () => {
  expect(parseTranscriptUsageLine(line(10, 5, 3, 6))).toBeNull()
  writeFileSync(transcript, `${line(10, 5, 3, 4)}\n`)
  await new TranscriptUsageIngestor(db).ingest(transcript, attribution)
  const row = db.get<{ billed: number }>('SELECT input_tokens + output_tokens AS billed FROM transcript_usage_events')
  expect(row).toEqual({ billed: 15 })
})

test('a transcript cannot shrink behind the watermark and silently spend twice', async () => {
  writeFileSync(transcript, `${line(10, 5, 3, 4)}\n`)
  const ingestor = new TranscriptUsageIngestor(db)
  await ingestor.ingest(transcript, attribution)
  truncateSync(transcript, 0)
  await expect(ingestor.ingest(transcript, attribution)).rejects.toThrow('shrank')
  expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM transcript_usage_events')).toEqual({ n: 1 })
})

test('explicit attribution refuses a concurrent rollout from another working directory', async () => {
  writeFileSync(transcript, `${JSON.stringify({ type: 'session_meta', payload: { cwd: '/repos/beta' } })}\n${line(10, 5, 3, 4)}\n`)
  await expect(new TranscriptUsageIngestor(db).ingest(transcript, {
    ...attribution, expected_cwds: ['/repos/alpha'],
  })).rejects.toThrow('does not match')
  expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM transcript_usage_events')).toEqual({ n: 0 })
})
