import { describe, expect, test } from 'bun:test'

import {
  MAX_REPLY_FILES,
  chunkTelegramText,
  classifyReplyFile,
  extractReplyFiles,
  planReplyUploads,
} from '../reply-files.ts'

describe('extractReplyFiles', () => {
  test('lifts file lines out and keeps the words', () => {
    const r = extractReplyFiles('Here are the sheets.\n\n[[file: /data/day/sheet-1.pdf]]\n[[file:/data/day/clip.mp4]]\n\nEnjoy!')
    expect(r.files).toEqual(['/data/day/sheet-1.pdf', '/data/day/clip.mp4'])
    expect(r.text).toBe('Here are the sheets.\n\nEnjoy!')
    expect(r.rejected).toEqual([])
  })

  test('a directive inside a sentence is not a file', () => {
    const r = extractReplyFiles('Use [[file: /x.pdf]] to attach.')
    expect(r.files).toEqual([])
    expect(r.text).toBe('Use [[file: /x.pdf]] to attach.')
  })

  test('relative paths and files past the cap are rejected; duplicates collapse', () => {
    const lines = ['[[file: rel/a.pdf]]', '[[file: /a.pdf]]', '[[file: /a.pdf]]']
    for (let i = 0; i < MAX_REPLY_FILES + 1; i++) lines.push(`[[file: /f${i}.png]]`)
    const r = extractReplyFiles(lines.join('\n'))
    expect(r.files.length).toBe(MAX_REPLY_FILES)
    expect(r.files[0]).toBe('/a.pdf')
    expect(r.rejected).toContain('rel/a.pdf')
    expect(r.rejected.length).toBe(3)
  })
})

describe('classifyReplyFile', () => {
  test('photos, videos and documents', () => {
    expect(classifyReplyFile('/a/b.JPG')).toEqual({ kind: 'photo', content_type: 'image/jpeg', filename: 'b.JPG' })
    expect(classifyReplyFile('/a/b.png').kind).toBe('photo')
    expect(classifyReplyFile('/a/b.mp4')).toEqual({ kind: 'video', content_type: 'video/mp4', filename: 'b.mp4' })
    expect(classifyReplyFile('/a/b.pdf')).toEqual({ kind: 'document', content_type: 'application/pdf', filename: 'b.pdf' })
    expect(classifyReplyFile('/a/noext').content_type).toBe('application/octet-stream')
    // Over the 10 MB photo limit, an image goes as a document.
    expect(classifyReplyFile('/a/big.jpg', 11 * 1024 * 1024)).toEqual({ kind: 'document', content_type: 'image/jpeg', filename: 'big.jpg' })
    expect(classifyReplyFile('/a/ok.jpg', 9 * 1024 * 1024).kind).toBe('photo')
    expect(classifyReplyFile('/a/clip.mov')).toEqual({ kind: 'document', content_type: 'video/quicktime', filename: 'clip.mov' })
  })
})

describe('planReplyUploads', () => {
  test('consecutive media become one album; documents and lone media go alone', () => {
    const f = (kind: 'photo' | 'video' | 'document', n: string) => ({ kind, n })
    const plan = planReplyUploads([f('photo', 'a'), f('video', 'b'), f('document', 'c'), f('photo', 'd'), f('document', 'e')])
    expect(plan).toEqual([
      { album: [f('photo', 'a'), f('video', 'b')] },
      { single: f('document', 'c') },
      { single: f('photo', 'd') },
      { single: f('document', 'e') },
    ])
  })
})

describe('chunkTelegramText', () => {
  test('short text is one message', () => {
    expect(chunkTelegramText('hello')).toEqual(['hello'])
  })

  test('long text splits on paragraph boundaries under the cap', () => {
    const para = 'x'.repeat(3000)
    const parts = chunkTelegramText(`${para}\n\n${para}\n\n${para}`)
    expect(parts.length).toBe(3)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096)
    expect(parts.join('')).toBe(para.repeat(3))
  })

  test('never splits a surrogate pair', () => {
    const text = `${'a'.repeat(9)}😀${'b'.repeat(20)}`
    for (const p of chunkTelegramText(text, 10)) {
      expect(p.length).toBeLessThanOrEqual(10)
      expect(p).not.toMatch(/[\uD800-\uDBFF]$/)
    }
  })
})
