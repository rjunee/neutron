/**
 * Source-sniff routing tests (P2 code-review FIX 2).
 *
 * The web onboarding affordance hardcodes `POST /api/upload/chatgpt`, so a
 * CLAUDE export would otherwise be parsed by the ChatGPT parser and fail. The
 * handler now sniffs the zip's central-directory entry list and OVERRIDES the
 * URL source when the entries confidently disagree:
 *
 *   - Claude:  `users.json` (plural) and/or `projects.json`.
 *   - ChatGPT: `user.json` (singular) and/or `message_feedback.json` /
 *              `model_comparisons.json`.
 *
 * Ambiguous / unreadable zips keep the URL source (back-compat, defensive).
 *
 * Builds REAL zips via the shared test zip-writer so `listEntries` (the
 * production reader the parsers use) actually walks the central directory.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  handleImportUpload,
  resolveEffectiveSource,
  sniffZipSource,
  type ImportUploadDeps,
  type ImportUploadInstanceContext,
} from '../import-upload-handler.ts'
import type { AdvanceResult } from '@neutronai/onboarding/interview/engine.ts'
import {
  writeZip,
  type ZipWriteEntry,
} from '@neutronai/onboarding/history-import/__tests__/zip-writer.ts'

let tmpRoots: string[] = []
afterEach(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
  tmpRoots = []
})

function mkOwnerHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-sniff-test-'))
  tmpRoots.push(dir)
  return dir
}

function file(name: string): ZipWriteEntry {
  return { name, data: Buffer.from('[]', 'utf8') }
}

/**
 * Build a real zip and wrap it in a multipart FormData part. A single
 * trailing non-NUL byte is appended AFTER the EOCD because bun's
 * `Request.formData()` parser drops trailing NUL bytes from binary parts
 * (observed bun 1.3.9) — the EOCD's comment-length field is `0x00 0x00`, so an
 * un-padded zip would lose its tail and fail `findEocd`. The extra byte sits
 * past the EOCD signature, so `listEntries` is unaffected.
 */
function zipMultipart(entries: ZipWriteEntry[], filename: string): FormData {
  const padded = Buffer.concat([writeZip(entries), Buffer.from([0x0a])])
  const ab = new ArrayBuffer(padded.byteLength)
  new Uint8Array(ab).set(padded)
  const form = new FormData()
  form.append('file', new File([ab], filename, { type: 'application/zip' }))
  return form
}

interface Recorder {
  calls: Array<{ source: 'chatgpt' | 'claude' }>
}

function buildDeps(owner_home: string, recorder: Recorder): ImportUploadDeps {
  const ctx: ImportUploadInstanceContext = {
    owner_home,
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    project_slug: 'test-project',
    topic_id: 'chat',
    channel_kind: 'app_socket',
  }
  return {
    resolveInstanceContext: async () => ctx,
    engine: {
      notifyImportUpload: async (input) => {
        recorder.calls.push({ source: input.source })
        return {
          outcome: 'advanced',
          state: {
            project_slug: ctx.project_slug,
            phase: 'import_running',
            phase_state: { import_job_id: 'job-abc' },
            last_advanced_at: 0,
          },
        } as unknown as AdvanceResult
      },
    },
  }
}

async function postZip(
  urlSource: 'chatgpt' | 'claude',
  entries: ZipWriteEntry[],
): Promise<{ recorder: Recorder; owner_home: string }> {
  const owner_home = mkOwnerHome()
  const recorder: Recorder = { calls: [] }
  const req = new Request(`http://test.local/api/upload/${urlSource}`, {
    method: 'POST',
    body: zipMultipart(entries, 'export.zip'),
  })
  const res = await handleImportUpload(req, buildDeps(owner_home, recorder))
  expect(res.status).toBe(200)
  return { recorder, owner_home }
}

describe('sniffZipSource (unit)', () => {
  test('claude shape → claude', () => {
    expect(sniffZipSource(writeZip([file('conversations.json'), file('users.json')]))).toBe(
      'claude',
    )
    expect(sniffZipSource(writeZip([file('conversations.json'), file('projects.json')]))).toBe(
      'claude',
    )
  })

  test('chatgpt shape → chatgpt', () => {
    expect(sniffZipSource(writeZip([file('conversations.json'), file('user.json')]))).toBe(
      'chatgpt',
    )
    expect(
      sniffZipSource(writeZip([file('conversations.json'), file('message_feedback.json')])),
    ).toBe('chatgpt')
  })

  test('ambiguous (both signals) → null', () => {
    expect(
      sniffZipSource(
        writeZip([file('conversations.json'), file('user.json'), file('users.json')]),
      ),
    ).toBeNull()
  })

  test('no discriminating sidecars → null', () => {
    expect(sniffZipSource(writeZip([file('conversations.json')]))).toBeNull()
  })

  test('garbage / non-zip buffer → null (never throws)', () => {
    expect(sniffZipSource(Buffer.from([0x01, 0x02, 0x03, 0x04]))).toBeNull()
  })

  test('nested entry paths are matched by basename', () => {
    expect(
      sniffZipSource(writeZip([file('export/conversations.json'), file('export/users.json')])),
    ).toBe('claude')
  })
})

describe('resolveEffectiveSource (unit)', () => {
  test('overrides URL source when sniff confidently disagrees', () => {
    const logs: string[] = []
    const buf = writeZip([file('conversations.json'), file('users.json')])
    expect(resolveEffectiveSource('chatgpt', buf, (m) => logs.push(m))).toBe('claude')
    expect(logs.some((l) => l.includes('source override'))).toBe(true)
  })

  test('keeps URL source when sniff agrees or is ambiguous', () => {
    const chatgptBuf = writeZip([file('conversations.json'), file('user.json')])
    expect(resolveEffectiveSource('chatgpt', chatgptBuf, () => {})).toBe('chatgpt')
    const ambiguous = writeZip([file('conversations.json')])
    expect(resolveEffectiveSource('chatgpt', ambiguous, () => {})).toBe('chatgpt')
  })
})

describe('handleImportUpload source routing', () => {
  test('Claude-shaped zip POSTed to /chatgpt → notifyImportUpload(source=claude)', async () => {
    const { recorder, owner_home } = await postZip('chatgpt', [
      file('conversations.json'),
      file('users.json'),
      file('projects.json'),
    ])
    expect(recorder.calls).toEqual([{ source: 'claude' }])
    // The bytes land at the OVERRIDDEN path so the import-runner reads claude.zip.
    expect(statSync(join(owner_home, 'imports', 'claude.zip')).isFile()).toBe(true)
  })

  test('ChatGPT-shaped zip POSTed to /chatgpt → stays chatgpt', async () => {
    const { recorder, owner_home } = await postZip('chatgpt', [
      file('conversations.json'),
      file('user.json'),
      file('message_feedback.json'),
    ])
    expect(recorder.calls).toEqual([{ source: 'chatgpt' }])
    expect(statSync(join(owner_home, 'imports', 'chatgpt.zip')).isFile()).toBe(true)
  })

  test('ambiguous zip POSTed to /chatgpt → keeps URL source (chatgpt)', async () => {
    const { recorder } = await postZip('chatgpt', [file('conversations.json')])
    expect(recorder.calls).toEqual([{ source: 'chatgpt' }])
  })
})
