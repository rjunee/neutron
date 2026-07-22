/**
 * M2 modality threading — REAL-resolver integration (Argus r2 #5).
 *
 * The main attachments test (`build-live-agent-turn-attachments.test.ts`)
 * exercises the turn runner with a STUB `resolveAttachment`, so the actual
 * production seam — the composer supplies
 * `resolveChatAttachmentLocalPath(owner_home, url)` (`open/composer.ts:3244`)
 * and the runner folds its output into the `<user_attachments>` fragment
 * (`build-live-agent-turn.ts:1057`) — is covered by NEITHER that test nor the
 * upload-surface test. This locks the two REAL pieces together end-to-end:
 *   - seed a real blob on disk under `<owner_home>/chat-attachments/…`;
 *   - resolve its upload URL with the SHIPPED `resolveChatAttachmentLocalPath`;
 *   - assert `buildAttachmentsFragment` embeds the resolved ON-DISK path +
 *     canonical MIME (artifact-on-disk assertion, not a bookkeeping stub);
 *   - assert a resolvable-but-MISSING blob is dropped (the resolver's
 *     `existsSync` gate is honored through the fragment builder).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveChatAttachmentLocalPath } from '../../http/app-upload-surface.ts'
import { buildAttachmentsFragment } from '../build-live-agent-turn.ts'

const HASH = 'd'.repeat(64)
let home: string

/** Write a real blob under the same layout the resolver reads. */
function seedBlob(user_id: string, hash: string, ext: string, bytes: Uint8Array): string {
  const dir = join(home, 'chat-attachments', user_id)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${hash}.${ext}`)
  writeFileSync(path, bytes)
  return path
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'neutron-real-resolver-'))
})
afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    /* ignore cleanup */
  }
})

describe('real resolver → attachments fragment (production seam)', () => {
  test('embeds the on-disk path + canonical MIME for a PDF that exists', () => {
    const path = seedBlob('u-1', HASH, 'pdf', new TextEncoder().encode('%PDF-1.4\n%%EOF\n'))
    expect(existsSync(path)).toBe(true)

    const url = `/api/app/upload/u-1/${HASH}.pdf`
    // The SHIPPED resolver, exactly as the composer wires it.
    const resolve = (u: string) => resolveChatAttachmentLocalPath(home, u)
    // Sanity: the resolver itself points at the seeded blob.
    expect(resolve(url)).toEqual({ path, content_type: 'application/pdf' })

    const fragment = buildAttachmentsFragment([url], resolve)
    expect(fragment).not.toBeNull()
    expect(fragment).toContain('<user_attachments>')
    expect(fragment).toContain(`- ${path} (application/pdf)`)
  })

  test('embeds an image path too (same seam fixes images)', () => {
    const path = seedBlob('u-1', HASH, 'png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    const url = `/api/app/upload/u-1/${HASH}.png`
    const resolve = (u: string) => resolveChatAttachmentLocalPath(home, u)
    const fragment = buildAttachmentsFragment([url], resolve)
    expect(fragment).toContain(`- ${path} (image/png)`)
  })

  test('drops a resolvable-but-missing blob (existsSync gate honored end-to-end)', () => {
    // No seedBlob — the path resolves by shape but the file is absent.
    const url = `/api/app/upload/u-1/${HASH}.pdf`
    const resolve = (u: string) => resolveChatAttachmentLocalPath(home, u)
    expect(resolve(url)).toBeNull()
    expect(buildAttachmentsFragment([url], resolve)).toBeNull()
  })
})
