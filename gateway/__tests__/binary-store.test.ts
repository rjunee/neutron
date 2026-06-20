/**
 * P7.5 — content-addressed binary store unit tests.
 *
 * Covers the brief's § 8.1 (init), § 8.2 (put/get), § 8.3 (refcount),
 * § 8.4 (failure modes — disk-level corruption / orphan blob / missing
 * blob), and the spec-pin from § 6.1 (every BINARY_EXTENSIONS entry is
 * present in the P7.4 DOC_VERSION_GITIGNORE so a stray git-add can't
 * inflate the markdown repo).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BinaryStore, parseMarkdownBinaryLinks } from '../storage/binary-store.ts'
import {
  BINARY_EXTENSIONS,
  BinaryCorruptedError,
  BinaryNotFoundError,
  BinarySizeError,
  BinaryTypeError,
  type BinaryPutResult,
} from '../storage/binary-types.ts'
import { DOC_VERSION_GITIGNORE } from '../git/doc-version-store.ts'

const PROJECT_ID = 'demo-project'

interface Harness {
  store: BinaryStore
  owner_home: string
  project_root: string
  blobs_root: string
  tmp: string
  close(): void
}

function makeHarness(opts: { max_bytes?: number } = {}): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-binary-'))
  const owner_home = join(tmp, 'home')
  mkdirSync(owner_home, { recursive: true })
  const project_root = join(owner_home, 'Projects', PROJECT_ID)
  mkdirSync(project_root, { recursive: true })
  const storeOpts: ConstructorParameters<typeof BinaryStore>[0] = { owner_home }
  if (opts.max_bytes !== undefined) storeOpts.max_bytes = opts.max_bytes
  const store = new BinaryStore(storeOpts)
  return {
    store,
    owner_home,
    project_root,
    blobs_root: join(project_root, '.docs-blobs'),
    tmp,
    close() {
      store.closeAll()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

const PNG_PREFIX = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
])
const JPEG_PREFIX = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
const PDF_PREFIX = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])

function pngBytes(payloadLen = 32): Uint8Array {
  const out = new Uint8Array(PNG_PREFIX.length + payloadLen)
  out.set(PNG_PREFIX, 0)
  for (let i = 0; i < payloadLen; i++) out[PNG_PREFIX.length + i] = (i * 7) & 0xff
  return out
}

function altPngBytes(): Uint8Array {
  const out = pngBytes(32)
  out[PNG_PREFIX.length] = 0xfe
  return out
}

function jpegBytes(payloadLen = 32): Uint8Array {
  const out = new Uint8Array(JPEG_PREFIX.length + payloadLen)
  out.set(JPEG_PREFIX, 0)
  for (let i = 0; i < payloadLen; i++) out[JPEG_PREFIX.length + i] = (i + 11) & 0xff
  return out
}

function pdfBytes(payloadLen = 32): Uint8Array {
  const out = new Uint8Array(PDF_PREFIX.length + payloadLen)
  out.set(PDF_PREFIX, 0)
  for (let i = 0; i < payloadLen; i++) out[PDF_PREFIX.length + i] = (i + 1) & 0xff
  return out
}

describe('BinaryStore — init + schema', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => h.close())

  it('ensureInit creates .docs-blobs/ + index.sqlite', async () => {
    await h.store.ensureInit(PROJECT_ID)
    expect(existsSync(h.blobs_root)).toBe(true)
    expect(existsSync(join(h.blobs_root, 'index.sqlite'))).toBe(true)
  })

  it('ensureInit is idempotent', async () => {
    await h.store.ensureInit(PROJECT_ID)
    await h.store.ensureInit(PROJECT_ID)
    await h.store.ensureInit(PROJECT_ID)
    expect(existsSync(join(h.blobs_root, 'index.sqlite'))).toBe(true)
  })

  it('listPaths is empty for a freshly-initialized project', async () => {
    await h.store.ensureInit(PROJECT_ID)
    const rows = h.store.listPaths(PROJECT_ID)
    expect(rows).toEqual([])
  })

  it('BINARY_EXTENSIONS is a subset of DOC_VERSION_GITIGNORE (no drift vs P7.4)', () => {
    for (const ext of BINARY_EXTENSIONS) {
      // `.gitignore` lines look like `*.png` — match the bare extension.
      expect(DOC_VERSION_GITIGNORE).toContain(`*${ext}`)
    }
  })
})

describe('BinaryStore — put / get round-trip', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => h.close())

  it('uploads a PNG and reads back identical bytes', async () => {
    const bytes = pngBytes()
    const out = await h.store.put(PROJECT_ID, 'notes/shot.png', bytes, 'image/png')
    expect(out.path).toBe('notes/shot.png')
    expect(out.size_bytes).toBe(bytes.length)
    expect(out.content_type).toBe('image/png')
    expect(out.hash).toMatch(/^[0-9a-f]{64}$/)
    const buf = await h.store.readBytes(PROJECT_ID, 'notes/shot.png')
    expect(Array.from(buf)).toEqual(Array.from(bytes))
  })

  it('blob is content-addressed (same content under two paths → ONE blob)', async () => {
    const bytes = pngBytes()
    const a = await h.store.put(PROJECT_ID, 'a.png', bytes, 'image/png')
    const b = await h.store.put(PROJECT_ID, 'b.png', bytes, 'image/png')
    expect(a.hash).toBe(b.hash)
    const refcount = h.store.getBlobRefcount(PROJECT_ID, a.hash)
    expect(refcount).toBe(2)
    // Only one blob on disk.
    const fanout = join(h.blobs_root, a.hash.slice(0, 2))
    const files = readdirSync(fanout)
    expect(files.length).toBe(1)
  })

  it('overwriting a path with NEW content decrements old hash + increments new', async () => {
    const first = pngBytes()
    const second = altPngBytes()
    const a = await h.store.put(PROJECT_ID, 'shot.png', first, 'image/png')
    const b = await h.store.put(PROJECT_ID, 'shot.png', second, 'image/png')
    expect(a.hash).not.toBe(b.hash)
    expect(h.store.getBlobRefcount(PROJECT_ID, a.hash)).toBe(null)
    expect(h.store.getBlobRefcount(PROJECT_ID, b.hash)).toBe(1)
  })

  it('overwriting with identical content updates modified_at without inserting a new blob', async () => {
    const bytes = pngBytes()
    const a = await h.store.put(PROJECT_ID, 'shot.png', bytes, 'image/png')
    await new Promise((r) => setTimeout(r, 4))
    const b = await h.store.put(PROJECT_ID, 'shot.png', bytes, 'image/png')
    expect(a.hash).toBe(b.hash)
    expect(b.modified_at).toBeGreaterThanOrEqual(a.modified_at)
    expect(h.store.getBlobRefcount(PROJECT_ID, a.hash)).toBe(1)
  })

  it('rejects oversize uploads', async () => {
    const small = makeHarness({ max_bytes: PNG_PREFIX.length + 4 })
    try {
      const tooBig = pngBytes(64)
      await expect(
        small.store.put(PROJECT_ID, 'big.png', tooBig, 'image/png'),
      ).rejects.toBeInstanceOf(BinarySizeError)
    } finally {
      small.close()
    }
  })

  it('rejects unwhitelisted MIME (executable bytes)', async () => {
    const bytes = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]) // PE header
    await expect(
      h.store.put(PROJECT_ID, 'evil.png', bytes, 'image/png'),
    ).rejects.toBeInstanceOf(BinaryTypeError)
  })

  it('rejects declared/sniffed MIME mismatch as content_type_spoof', async () => {
    const bytes = jpegBytes()
    const err = await h.store
      .put(PROJECT_ID, 'shot.png', bytes, 'image/png')
      .catch((e) => e)
    expect(err).toBeInstanceOf(BinaryTypeError)
    expect((err as BinaryTypeError).code).toBe('content_type_spoof')
  })

  it('canonicalizes legacy MIME aliases (image/jpg ≡ image/jpeg)', async () => {
    const bytes = jpegBytes()
    const out = await h.store.put(PROJECT_ID, 'shot.jpg', bytes, 'image/jpg')
    expect(out.content_type).toBe('image/jpeg')
  })

  it('rejects path-traversal and hidden segments', async () => {
    const bytes = pngBytes()
    const traversal = await h.store
      .put(PROJECT_ID, '../etc/passwd.png', bytes, 'image/png')
      .catch((e) => e)
    expect((traversal as { code?: string }).code).toBe('invalid_path')
    const hidden = await h.store
      .put(PROJECT_ID, '.docs-blobs/oops.png', bytes, 'image/png')
      .catch((e) => e)
    expect((hidden as { code?: string }).code).toBe('hidden_segment')
    const absolute = await h.store
      .put(PROJECT_ID, '/etc/passwd.png', bytes, 'image/png')
      .catch((e) => e)
    expect((absolute as { code?: string }).code).toBe('invalid_path')
  })

  it('rejects non-binary extensions', async () => {
    const bytes = pngBytes()
    const err = await h.store
      .put(PROJECT_ID, 'foo.md', bytes, 'image/png')
      .catch((e) => e)
    expect(err).toBeDefined()
    expect((err as { code?: string }).code).toBe('invalid_extension')
  })
})

describe('BinaryStore — delete + refcount', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => h.close())

  it('delete with refcount=1 unlinks the blob', async () => {
    const out = await h.store.put(PROJECT_ID, 'shot.png', pngBytes(), 'image/png')
    const blob_path = join(h.blobs_root, out.hash.slice(0, 2), out.hash.slice(2))
    expect(existsSync(blob_path)).toBe(true)
    await h.store.delete(PROJECT_ID, 'shot.png')
    expect(existsSync(blob_path)).toBe(false)
    expect(h.store.getBlobRefcount(PROJECT_ID, out.hash)).toBe(null)
  })

  it('delete with refcount>1 (another path holds the same hash) keeps the blob', async () => {
    const bytes = pngBytes()
    const a = await h.store.put(PROJECT_ID, 'a.png', bytes, 'image/png')
    await h.store.put(PROJECT_ID, 'b.png', bytes, 'image/png')
    await h.store.delete(PROJECT_ID, 'a.png')
    const blob_path = join(h.blobs_root, a.hash.slice(0, 2), a.hash.slice(2))
    expect(existsSync(blob_path)).toBe(true)
    expect(h.store.getBlobRefcount(PROJECT_ID, a.hash)).toBe(1)
  })

  it('delete returns still_referenced_by when markdown links remain', async () => {
    // Markdown at notes/foo.md with `![](shot.png)` resolves the
    // relative ref against the markdown's dir → notes/shot.png. Store
    // the binary at that path so the link sticks.
    await h.store.put(PROJECT_ID, 'notes/shot.png', pngBytes(), 'image/png')
    h.store.syncMarkdownLinks(PROJECT_ID, 'notes/foo.md', '![](shot.png)\n')
    const refs = h.store.listMarkdownReferences(PROJECT_ID, 'notes/shot.png')
    expect(refs).toEqual(['notes/foo.md'])
    const result = await h.store.delete(PROJECT_ID, 'notes/shot.png')
    expect(result.still_referenced_by).toEqual(['notes/foo.md'])
  })

  it('throws BinaryNotFoundError on delete of an unknown path', async () => {
    await h.store.ensureInit(PROJECT_ID)
    await expect(h.store.delete(PROJECT_ID, 'missing.png')).rejects.toBeInstanceOf(
      BinaryNotFoundError,
    )
  })
})

describe('BinaryStore — markdown integration', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => h.close())

  it('syncMarkdownLinks bumps refcount on linked binary paths', async () => {
    // Markdown link refs are resolved against the markdown's dir, so
    // `notes/a.md` linking `shot.png` resolves to `notes/shot.png` —
    // store the binary at that path to match.
    const a = await h.store.put(PROJECT_ID, 'notes/shot.png', pngBytes(), 'image/png')
    h.store.syncMarkdownLinks(PROJECT_ID, 'notes/a.md', '![shot](shot.png)\n')
    expect(h.store.getBlobRefcount(PROJECT_ID, a.hash)).toBe(2)
    h.store.syncMarkdownLinks(PROJECT_ID, 'notes/b.md', '![](shot.png)\n')
    expect(h.store.getBlobRefcount(PROJECT_ID, a.hash)).toBe(3)
  })

  it('removing the link from a markdown doc decrements the blob refcount', async () => {
    const a = await h.store.put(PROJECT_ID, 'notes/shot.png', pngBytes(), 'image/png')
    h.store.syncMarkdownLinks(PROJECT_ID, 'notes/a.md', '![](shot.png)\n')
    expect(h.store.getBlobRefcount(PROJECT_ID, a.hash)).toBe(2)
    h.store.syncMarkdownLinks(PROJECT_ID, 'notes/a.md', 'no link anymore\n')
    expect(h.store.getBlobRefcount(PROJECT_ID, a.hash)).toBe(1)
  })

  it('dropMarkdownLinks (deleteDoc proxy) decrements every linked blob', async () => {
    const a = await h.store.put(PROJECT_ID, 'notes/shot.png', pngBytes(), 'image/png')
    h.store.syncMarkdownLinks(PROJECT_ID, 'notes/a.md', '![](shot.png)\n')
    expect(h.store.getBlobRefcount(PROJECT_ID, a.hash)).toBe(2)
    h.store.dropMarkdownLinks(PROJECT_ID, 'notes/a.md')
    expect(h.store.getBlobRefcount(PROJECT_ID, a.hash)).toBe(1)
  })

  it('renameMarkdownLinks updates the markdown_path column', async () => {
    await h.store.put(PROJECT_ID, 'notes/shot.png', pngBytes(), 'image/png')
    h.store.syncMarkdownLinks(PROJECT_ID, 'notes/a.md', '![](shot.png)\n')
    h.store.renameMarkdownLinks(PROJECT_ID, 'notes/a.md', 'notes/renamed.md')
    expect(h.store.listMarkdownReferences(PROJECT_ID, 'notes/shot.png')).toEqual([
      'notes/renamed.md',
    ])
  })

  it('broken-ref markdown links are silently dropped (no refcount drift)', async () => {
    // Markdown references a binary path that doesn't exist in binary_path.
    h.store.syncMarkdownLinks(PROJECT_ID, 'notes/a.md', '![](missing.png)\n')
    // No exception; missing.png isn't in binary_path → no link inserted.
    expect(h.store.listMarkdownReferences(PROJECT_ID, 'missing.png')).toEqual([])
  })
})

describe('BinaryStore — failure modes + GC', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => h.close())

  it('get against a missing path throws BinaryNotFoundError', async () => {
    await h.store.ensureInit(PROJECT_ID)
    expect(() => h.store.get(PROJECT_ID, 'missing.png')).toThrow(BinaryNotFoundError)
  })

  it('get against a sidecar row whose blob is missing throws BinaryCorruptedError', async () => {
    const out = await h.store.put(PROJECT_ID, 'shot.png', pngBytes(), 'image/png')
    const blob_path = join(h.blobs_root, out.hash.slice(0, 2), out.hash.slice(2))
    // Externally delete the blob — the sidecar row is now corrupted.
    rmSync(blob_path)
    expect(() => h.store.get(PROJECT_ID, 'shot.png')).toThrow(BinaryCorruptedError)
  })

  it('GC unlinks orphan blobs left behind by mid-txn crashes', async () => {
    // Make sure the project is initialized first so .docs-blobs/ exists
    // before we plant the orphan.
    await h.store.ensureInit(PROJECT_ID)
    const orphan_dir = join(h.blobs_root, 'aa')
    mkdirSync(orphan_dir, { recursive: true })
    // Filename must match HEX_NAME_RE — 62 hex chars (full hash minus
    // the 2-char fanout prefix).
    const orphan_name = 'b'.repeat(62)
    const orphan_path = join(orphan_dir, orphan_name)
    writeFileSync(orphan_path, 'not a real blob')
    // Close all handles and re-init to trigger gc() on the fresh handle.
    h.store.closeAll()
    await h.store.ensureInit(PROJECT_ID)
    expect(existsSync(orphan_path)).toBe(false)
  })
})

describe('parseMarkdownBinaryLinks', () => {
  it('captures ![alt](rel.png) image syntax', () => {
    const result = parseMarkdownBinaryLinks('![cat](cat.png)\n', '')
    expect([...result]).toEqual(['cat.png'])
  })

  it('captures [text](rel.pdf) plain link to a binary extension', () => {
    const result = parseMarkdownBinaryLinks('see [the PDF](report.pdf)', '')
    expect([...result]).toEqual(['report.pdf'])
  })

  it('skips external URLs and anchors', () => {
    const result = parseMarkdownBinaryLinks(
      '![ext](https://example.com/x.png)\n[anchor](#sec-1)\n',
      '',
    )
    expect([...result]).toEqual([])
  })

  it('skips out-of-tree relative paths (escape from project root)', () => {
    // At project root, `../escape.png` resolves to `..` which is
    // out-of-tree → dropped.
    const result = parseMarkdownBinaryLinks('![](../escape.png)', '')
    expect([...result]).toEqual([])
  })

  it('joins relative refs against markdown_dir', () => {
    const result = parseMarkdownBinaryLinks('![](shot.png)', 'notes')
    expect([...result]).toEqual(['notes/shot.png'])
  })

  it('skips markdown-to-markdown links', () => {
    const result = parseMarkdownBinaryLinks('see [other](other.md)', '')
    expect([...result]).toEqual([])
  })
})

describe('BinaryStore — PDF + SVG sniffing', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => h.close())

  it('accepts a %PDF- prefixed file', async () => {
    const out: BinaryPutResult = await h.store.put(
      PROJECT_ID,
      'doc.pdf',
      pdfBytes(),
      'application/pdf',
    )
    expect(out.content_type).toBe('application/pdf')
  })

  it('sniffs an SVG payload', async () => {
    const svg = new TextEncoder().encode(
      '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    )
    const out = await h.store.put(PROJECT_ID, 'icon.svg', svg, 'image/svg+xml')
    expect(out.content_type).toBe('image/svg+xml')
  })

  // Round-2 MINOR #2 — SVG sniff window was bumped from 512 → 2048 bytes
  // so a real-world SVG with a long XML prolog + copyright comment + DTD
  // is still recognised.
  it('sniffs an SVG even when `<svg` sits past the original 512-byte window', async () => {
    const comment = '<!-- ' + 'x'.repeat(1500) + ' -->\n'
    const payload = `<?xml version="1.0" encoding="UTF-8"?>\n${comment}<svg xmlns="http://www.w3.org/2000/svg"></svg>`
    const bytes = new TextEncoder().encode(payload)
    expect(bytes.length).toBeGreaterThan(1500)
    const out = await h.store.put(PROJECT_ID, 'big-svg.svg', bytes, 'image/svg+xml')
    expect(out.content_type).toBe('image/svg+xml')
  })
})

describe('BinaryStore — MPEG-2.5 frame sync (round-2 MINOR #1)', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => h.close())

  // Round-2 MINOR #1 — Voice-Memo / Xing-VBR encoders emit MPEG-2.5
  // frame syncs (byte[1] in 0xE0..0xEF). Earlier the sniff masked only
  // 0xF_ values and the upload 415'd.
  it('accepts an MPEG-2.5 layer III frame sync (FF E3)', async () => {
    const mp3 = new Uint8Array([0xff, 0xe3, 0x40, 0x00, 0, 0, 0, 0, 0, 0, 0, 0])
    const out = await h.store.put(PROJECT_ID, 'memo.mp3', mp3, 'audio/mpeg')
    expect(out.content_type).toBe('audio/mpeg')
  })

  it('still accepts the original MPEG-1 / MPEG-2 layer III syncs (FF FB / FF F3)', async () => {
    const mp3a = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0, 0, 0, 0, 0])
    const out_a = await h.store.put(PROJECT_ID, 'a.mp3', mp3a, 'audio/mpeg')
    expect(out_a.content_type).toBe('audio/mpeg')
    const mp3b = new Uint8Array([0xff, 0xf3, 0x90, 0x00, 0, 0, 0, 0, 0, 0, 0, 0])
    const out_b = await h.store.put(PROJECT_ID, 'b.mp3', mp3b, 'audio/mpeg')
    expect(out_b.content_type).toBe('audio/mpeg')
  })
})

describe('BinaryStore — GC race fix (round-2 BLOCKING #1)', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => h.close())

  // Round-2 BLOCKING #1 — gc() used to fire on every `ensureInit(true)`
  // call (i.e. every PUT). A concurrent PUT could unlink another PUT's
  // just-renamed blob between the rename and the COMMIT. The fix gates
  // gc behind a once-per-boot flag.
  it('two concurrent PUTs of distinct content do NOT unlink each other’s blobs', async () => {
    // Fire ensureInit once so the initial GC sweep runs and the gate
    // flips to "swept". Subsequent PUTs must NOT re-fire gc.
    await h.store.ensureInit(PROJECT_ID)
    // Two distinct payloads → two distinct hashes → two on-disk blobs.
    const a = pngBytes(64)
    const b = altPngBytes()
    const [out_a, out_b] = await Promise.all([
      h.store.put(PROJECT_ID, 'a.png', a, 'image/png'),
      h.store.put(PROJECT_ID, 'b.png', b, 'image/png'),
    ])
    // Both blobs survive. Before the fix, one was unlinked by the other
    // PUT's gc sweep BETWEEN the rename and the COMMIT, and the
    // subsequent GET surfaced BinaryCorruptedError.
    const blob_a = join(h.blobs_root, out_a.hash.slice(0, 2), out_a.hash.slice(2))
    const blob_b = join(h.blobs_root, out_b.hash.slice(0, 2), out_b.hash.slice(2))
    expect(existsSync(blob_a)).toBe(true)
    expect(existsSync(blob_b)).toBe(true)
    // GETs succeed without throwing — the race surfaced as
    // BinaryCorruptedError on the next read.
    expect(() => h.store.get(PROJECT_ID, 'a.png')).not.toThrow()
    expect(() => h.store.get(PROJECT_ID, 'b.png')).not.toThrow()
  })

  it('orphan blobs from a PRIOR boot are still cleaned on first ensureInit', async () => {
    // Set up an orphan, close handles to simulate a process restart,
    // re-init → the first ensureInit after close MUST still sweep.
    await h.store.ensureInit(PROJECT_ID)
    const orphan_dir = join(h.blobs_root, 'cc')
    mkdirSync(orphan_dir, { recursive: true })
    const orphan_name = 'd'.repeat(62)
    const orphan_path = join(orphan_dir, orphan_name)
    writeFileSync(orphan_path, 'orphan from prior boot')
    h.store.closeAll()
    await h.store.ensureInit(PROJECT_ID)
    expect(existsSync(orphan_path)).toBe(false)
  })

  it('orphan blobs planted AFTER the initial sweep are NOT cleaned on subsequent ensureInits', async () => {
    // Confirms the once-per-boot gate: post-init orphans survive
    // (intentional — the GC sweep is a startup-only defense; mid-life
    // orphans are out of scope and would otherwise re-arm the race).
    await h.store.ensureInit(PROJECT_ID)
    const orphan_dir = join(h.blobs_root, 'ee')
    mkdirSync(orphan_dir, { recursive: true })
    const orphan_name = 'f'.repeat(62)
    const orphan_path = join(orphan_dir, orphan_name)
    writeFileSync(orphan_path, 'planted after init')
    await h.store.ensureInit(PROJECT_ID)
    await h.store.ensureInit(PROJECT_ID)
    // Still there — the gate skipped re-sweep.
    expect(existsSync(orphan_path)).toBe(true)
  })
})

describe('BinaryStore — recursive prefix delete (round-2 IMPORTANT #5)', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => h.close())

  it('deletePrefix unlinks every binary under the prefix in one txn', async () => {
    const a = await h.store.put(PROJECT_ID, 'media/a.png', pngBytes(), 'image/png')
    const b = await h.store.put(PROJECT_ID, 'media/sub/b.png', altPngBytes(), 'image/png')
    // Sibling outside the prefix must remain.
    const outside = await h.store.put(
      PROJECT_ID,
      'other.png',
      pngBytes(48),
      'image/png',
    )
    const result = await h.store.deletePrefix(PROJECT_ID, 'media')
    expect(result.deleted_paths.sort()).toEqual(['media/a.png', 'media/sub/b.png'])
    expect(h.store.getBlobRefcount(PROJECT_ID, a.hash)).toBe(null)
    expect(h.store.getBlobRefcount(PROJECT_ID, b.hash)).toBe(null)
    // Sibling untouched.
    expect(h.store.getBlobRefcount(PROJECT_ID, outside.hash)).toBe(1)
  })

  it('deletePrefix surfaces still_referenced_by for any markdown links left dangling', async () => {
    await h.store.put(PROJECT_ID, 'media/cover.png', pngBytes(), 'image/png')
    h.store.syncMarkdownLinks(
      PROJECT_ID,
      'notes/post.md',
      'header\n![](../media/cover.png)\n',
    )
    const result = await h.store.deletePrefix(PROJECT_ID, 'media')
    expect(result.deleted_paths).toEqual(['media/cover.png'])
    expect(result.still_referenced_by).toEqual(['notes/post.md'])
  })

  it('deletePrefix rejects path-shape violations via BinaryPathError', async () => {
    await h.store.ensureInit(PROJECT_ID)
    await expect(
      h.store.deletePrefix(PROJECT_ID, '../escape'),
    ).rejects.toMatchObject({ code: 'invalid_path' })
    await expect(
      h.store.deletePrefix(PROJECT_ID, '.hidden'),
    ).rejects.toMatchObject({ code: 'hidden_segment' })
  })
})

describe('BinaryStore — listPaths LIMIT (round-2 IMPORTANT #3)', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => h.close())

  it('listPaths(project, limit) caps the returned set', async () => {
    for (let i = 0; i < 5; i++) {
      const bytes = pngBytes(8 + i)
      await h.store.put(PROJECT_ID, `f${i}.png`, bytes, 'image/png')
    }
    const all = h.store.listPaths(PROJECT_ID)
    expect(all.length).toBe(5)
    const capped = h.store.listPaths(PROJECT_ID, 2)
    expect(capped.length).toBe(2)
    // Sorted by path ASC — the first 2 rows are `f0.png` / `f1.png`.
    expect(capped[0]!.path).toBe('f0.png')
    expect(capped[1]!.path).toBe('f1.png')
  })

  it('listPaths(project, 0) returns an empty set without hitting the DB', async () => {
    await h.store.put(PROJECT_ID, 'shot.png', pngBytes(), 'image/png')
    expect(h.store.listPaths(PROJECT_ID, 0)).toEqual([])
  })
})

describe('DocStore hooks — log on best-effort refcount failure (round-2 IMPORTANT #4)', () => {
  // We can't import DocStore at the top of this file without cycling
  // through git/version-store deps that need fixture setup; require it
  // lazily inside the describe so the rest of the file stays untouched.
  it('writeDoc swallow-path emits docs.binary.sync_links_failed when the hook throws', async () => {
    const { DocStore } = await import('../http/doc-store.ts')
    const tmp = mkdtempSync(join(tmpdir(), 'neutron-doc-hook-'))
    const owner_home = join(tmp, 'home')
    mkdirSync(owner_home, { recursive: true })
    // DocStore.writeDoc realpaths intermediate ancestors — create the
    // docs root so the symlink-escape ancestor check passes.
    const docsRoot = join(owner_home, 'Projects', PROJECT_ID, 'docs')
    mkdirSync(docsRoot, { recursive: true })
    const events: { event: string; fields: Record<string, unknown> }[] = []
    const binary = new BinaryStore({
      owner_home,
      logger: (event, fields) => events.push({ event, fields }),
    })
    await binary.ensureInit(PROJECT_ID)
    // Monkey-patch the syncMarkdownLinks call to throw so the hook
    // exercises the catch branch (production failures here are e.g. a
    // sqlite SQLITE_BUSY under contention or a transient I/O error).
    const original = binary.syncMarkdownLinks.bind(binary)
    binary.syncMarkdownLinks = ((..._args: unknown[]) => {
      throw new Error('boom')
    }) as typeof binary.syncMarkdownLinks
    try {
      const store = new DocStore({ owner_home, binaryStore: binary })
      // The write must SUCCEED (best-effort hook is independent of the
      // markdown write) but the failure event must show up in the log
      // sink — round-2 IMPORTANT #4 makes this observable instead of
      // silently swallowed.
      const result = await store.writeDoc({
        project_id: PROJECT_ID,
        path: 'notes/post.md',
        content: '![](shot.png)\n',
      })
      expect(result.path).toBe('notes/post.md')
      expect(events.length).toBeGreaterThanOrEqual(1)
      const event = events.find(
        (e) => e.event === 'docs.binary.sync_links_failed',
      )
      expect(event).toBeDefined()
      expect(event!.fields).toMatchObject({
        project_id: PROJECT_ID,
        path: 'notes/post.md',
        op: 'writeDoc',
      })
      expect(typeof event!.fields.error).toBe('string')
    } finally {
      binary.syncMarkdownLinks = original
      binary.closeAll()
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('BinaryStore — structured logger (round-2 IMPORTANT #4)', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => h.close())

  // The store accepts a `logger` injection via constructor options.
  // Confirm the public `logEvent` forwards to the injected logger so
  // DocStore's hook surfaces can fan out drift events to ops.
  it('logEvent forwards (event, fields) to the injected logger', () => {
    const events: { event: string; fields: Record<string, unknown> }[] = []
    const store = new BinaryStore({
      owner_home: h.owner_home,
      logger: (event, fields) => events.push({ event, fields }),
    })
    store.logEvent('docs.binary.sync_links_failed', {
      project_id: 'p',
      path: 'x.md',
      op: 'writeDoc',
      error: 'boom',
    })
    expect(events.length).toBe(1)
    expect(events[0]!.event).toBe('docs.binary.sync_links_failed')
    expect(events[0]!.fields).toMatchObject({ op: 'writeDoc', error: 'boom' })
    store.closeAll()
  })
})
