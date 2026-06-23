/**
 * Unit tests for the web Documents API client (WAVE 3 PR-5). Pure — the
 * `fetchImpl` is injected, so no DOM and no live server.
 *
 * Covers: tree, readFile, listComments (incl. the comments_unavailable 503
 * graceful-degrade gate, plan §5 VERIFY), postComment, replyToComment,
 * resolveComment, escalateToChat, and the pure helpers (flattenDocFiles,
 * clampUtf8, buildAnchor).
 */

import { describe, expect, it } from 'bun:test'

import {
  WebDocsClient,
  DocsClientError,
  buildAnchor,
  byteLength,
  clampUtf8,
  flattenDocFiles,
  MAX_ANCHOR_CTX_BYTES,
  MAX_ANCHOR_EXCERPT_BYTES,
  type DocTreeNode,
} from '../docs-client.ts'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function fileNode(path: string): DocTreeNode {
  return {
    kind: 'file',
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    size_bytes: 10,
    modified_at: 1,
    content_type: null,
    referenced_by_count: null,
    origin: null,
    children: [],
  }
}
function folderNode(path: string, children: DocTreeNode[]): DocTreeNode {
  return {
    kind: 'folder',
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    size_bytes: null,
    modified_at: null,
    content_type: null,
    referenced_by_count: null,
    origin: 'markdown',
    children,
  }
}

describe('WebDocsClient.tree', () => {
  it('GETs the docs/tree route with a bearer header and returns the tree', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const client = new WebDocsClient({
      base_url: 'https://h/',
      token: 'dev:sam',
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return json({ ok: true, tree: [fileNode('a.md')], file_count: 1 })
      },
    })
    const res = await client.tree('acme')
    expect(calls[0]!.url).toBe('https://h/api/app/projects/acme/docs/tree')
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe('Bearer dev:sam')
    expect(res.file_count).toBe(1)
    expect(res.tree[0]!.path).toBe('a.md')
  })
})

describe('WebDocsClient.readFile', () => {
  it('GETs docs/file with the path query and returns the file', async () => {
    let seen = ''
    const client = new WebDocsClient({
      base_url: 'https://h',
      token: 't',
      fetchImpl: async (url) => {
        seen = url
        return json({ ok: true, file: { path: 'a.md', content: '# hi', size_bytes: 4, modified_at: 9 } })
      },
    })
    const f = await client.readFile('acme', 'notes/a.md')
    expect(seen).toBe('https://h/api/app/projects/acme/docs/file?path=notes%2Fa.md')
    expect(f.content).toBe('# hi')
    expect(f.modified_at).toBe(9)
  })
})

describe('WebDocsClient.writeFile (PR-6 edit parity)', () => {
  it('PUTs docs/file with the body + OCC baseline and returns the new stat', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const client = new WebDocsClient({
      base_url: 'https://h',
      token: 't',
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return json({ ok: true, file: { path: 'notes/a.md', size_bytes: 12, modified_at: 42 } })
      },
    })
    const res = await client.writeFile('acme', {
      path: 'notes/a.md',
      content: '# edited',
      expected_modified_at: 9,
    })
    expect(calls[0]!.url).toBe('https://h/api/app/projects/acme/docs/file')
    expect(calls[0]!.init?.method).toBe('PUT')
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      path: 'notes/a.md',
      content: '# edited',
      expected_modified_at: 9,
    })
    expect(res.modified_at).toBe(42)
    expect(res.size_bytes).toBe(12)
  })

  it('omits expected_modified_at when not provided (force write)', async () => {
    let bodySeen = ''
    const client = new WebDocsClient({
      base_url: 'https://h',
      token: 't',
      fetchImpl: async (_url, init) => {
        bodySeen = init?.body as string
        return json({ ok: true, file: { path: 'a.md', size_bytes: 1, modified_at: 2 } })
      },
    })
    await client.writeFile('acme', { path: 'a.md', content: 'x' })
    expect(JSON.parse(bodySeen)).toEqual({ path: 'a.md', content: 'x' })
  })

  it('throws a typed DocsClientError carrying current_modified_at on a 409 conflict', async () => {
    const client = new WebDocsClient({
      base_url: 'https://h',
      token: 't',
      // The gateway's PUT /docs/file conflict code is doc_modified_conflict.
      fetchImpl: async () =>
        json(
          { ok: false, code: 'doc_modified_conflict', message: 'stale', current_modified_at: 77 },
          409,
        ),
    })
    try {
      await client.writeFile('acme', { path: 'a.md', content: 'x', expected_modified_at: 1 })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DocsClientError)
      expect((err as DocsClientError).code).toBe('doc_modified_conflict')
      expect((err as DocsClientError).status).toBe(409)
      expect((err as DocsClientError).current_modified_at).toBe(77)
    }
  })
})

describe('WebDocsClient.listComments — comments_unavailable gate', () => {
  it('returns threads on a 200', async () => {
    const client = new WebDocsClient({
      base_url: 'https://h',
      token: 't',
      fetchImpl: async () => json({ ok: true, threads: [{ thread_root_id: 'T1' }], next_cursor: null }),
    })
    const res = await client.listComments('acme', 'a.md')
    expect(res.unavailable).toBe(false)
    expect(res.threads).toHaveLength(1)
  })

  it('degrades gracefully to { unavailable: true } on a 503 comments_unavailable', async () => {
    const client = new WebDocsClient({
      base_url: 'https://h',
      token: 't',
      fetchImpl: async () =>
        json({ ok: false, code: 'comments_unavailable', message: 'not wired' }, 503),
    })
    const res = await client.listComments('acme', 'a.md')
    expect(res.unavailable).toBe(true)
    expect(res.threads).toEqual([])
    expect(res.next_cursor).toBeNull()
  })

  it('still throws on OTHER non-2xx (e.g. 400)', async () => {
    const client = new WebDocsClient({
      base_url: 'https://h',
      token: 't',
      fetchImpl: async () => json({ ok: false, code: 'missing_path', message: 'bad' }, 400),
    })
    await expect(client.listComments('acme', 'a.md')).rejects.toMatchObject({ code: 'missing_path' })
  })
})

describe('WebDocsClient.postComment', () => {
  it('POSTs the anchor + body and returns the event', async () => {
    let body: unknown = null
    const client = new WebDocsClient({
      base_url: 'https://h',
      token: 't',
      fetchImpl: async (_url, init) => {
        body = JSON.parse(init!.body as string)
        return json({ ok: true, event: { event_id: 'E1' }, thread_root_id: 'E1' })
      },
    })
    const res = await client.postComment('acme', 'a.md', 'looks good', {
      anchor_start: 2,
      anchor_end: 6,
      anchor_text_excerpt: 'word',
      anchor_ctx_before: 'a ',
      anchor_ctx_after: ' z',
      based_on_modified_at: 99,
    })
    expect(res.thread_root_id).toBe('E1')
    expect(body).toMatchObject({
      path: 'a.md',
      body: 'looks good',
      anchor_start: 2,
      anchor_end: 6,
      based_on_modified_at: 99,
    })
  })

  it('surfaces doc_changed_underfoot as a typed DocsClientError', async () => {
    const client = new WebDocsClient({
      base_url: 'https://h',
      token: 't',
      fetchImpl: async () =>
        json({ ok: false, code: 'doc_changed_underfoot', message: 'stale', current_modified_at: 5 }, 409),
    })
    await expect(
      client.postComment('acme', 'a.md', 'x', {
        anchor_start: 0,
        anchor_end: 1,
        anchor_text_excerpt: 'h',
        anchor_ctx_before: '',
        anchor_ctx_after: '',
        based_on_modified_at: 1,
      }),
    ).rejects.toMatchObject({ code: 'doc_changed_underfoot', current_modified_at: 5 })
  })
})

describe('WebDocsClient reply / resolve / escalate', () => {
  it('replyToComment POSTs to the reply route', async () => {
    let seen = ''
    const client = new WebDocsClient({
      base_url: 'https://h',
      token: 't',
      fetchImpl: async (url) => {
        seen = url
        return json({ ok: true, event: { event_id: 'R1' }, thread_root_id: 'T1' })
      },
    })
    const res = await client.replyToComment('acme', 'T1', 'thanks')
    expect(seen).toBe('https://h/api/app/projects/acme/docs/comments/T1/reply')
    expect(res.event.event_id).toBe('R1')
  })

  it('resolveComment POSTs to the resolve route', async () => {
    let seen = ''
    const client = new WebDocsClient({
      base_url: 'https://h',
      token: 't',
      fetchImpl: async (url) => {
        seen = url
        return json({ ok: true, resolve_event_id: 'X', resolved_at: 7 })
      },
    })
    const res = await client.resolveComment('acme', 'T1')
    expect(seen).toBe('https://h/api/app/projects/acme/docs/comments/T1/resolve')
    expect(res.resolved_at).toBe(7)
  })

  it('escalateToChat POSTs the optional note', async () => {
    let body: unknown = null
    const client = new WebDocsClient({
      base_url: 'https://h',
      token: 't',
      fetchImpl: async (_url, init) => {
        body = JSON.parse(init!.body as string)
        return json({ ok: true, escalate_event_id: 'E', escalated_at: 3 })
      },
    })
    await client.escalateToChat('acme', 'T1', 'please look')
    expect(body).toEqual({ note: 'please look' })
  })
})

describe('flattenDocFiles', () => {
  it('returns only markdown file leaves, depth-first, dropping folders + binaries', () => {
    const binary: DocTreeNode = { ...fileNode('img.png'), kind: 'binary', content_type: 'image/png' }
    const tree = [
      fileNode('top.md'),
      folderNode('sub', [fileNode('sub/a.md'), binary, fileNode('sub/b.md')]),
    ]
    const flat = flattenDocFiles(tree)
    expect(flat.map((n) => n.path)).toEqual(['top.md', 'sub/a.md', 'sub/b.md'])
  })
})

describe('clampUtf8', () => {
  it('keeps whole strings under the cap untouched', () => {
    expect(clampUtf8('hello', 100)).toBe('hello')
  })
  it('truncates from the head by default', () => {
    expect(clampUtf8('abcdef', 3)).toBe('abc')
  })
  it('truncates from the tail when keepTail is set (keeps closest chars)', () => {
    expect(clampUtf8('abcdef', 3, true)).toBe('def')
  })
  it('never splits a multi-byte code point', () => {
    // '€' is 3 bytes; cap of 4 fits exactly one.
    expect(clampUtf8('€€', 4)).toBe('€')
    expect(byteLength(clampUtf8('€€', 4))).toBeLessThanOrEqual(4)
  })
})

describe('buildAnchor', () => {
  const content = 'The quick brown fox jumps over the lazy dog.'
  it('builds excerpt + before/after context from raw offsets', () => {
    const start = content.indexOf('brown')
    const end = start + 'brown'.length
    const a = buildAnchor(content, start, end, 42)!
    expect(a.anchor_text_excerpt).toBe('brown')
    expect(a.anchor_start).toBe(start)
    expect(a.anchor_end).toBe(end)
    expect(a.anchor_ctx_before.endsWith('quick ')).toBe(true)
    expect(a.anchor_ctx_after.startsWith(' fox')).toBe(true)
    expect(a.based_on_modified_at).toBe(42)
  })
  it('returns null for a collapsed / inverted / whitespace selection', () => {
    expect(buildAnchor(content, 5, 5, 1)).toBeNull()
    expect(buildAnchor(content, 8, 3, 1)).toBeNull()
    expect(buildAnchor('   \n  ', 0, 5, 1)).toBeNull()
  })
  it('clamps a huge excerpt + context to the gateway byte caps', () => {
    const big = 'x'.repeat(5000)
    const a = buildAnchor(big, 0, 5000, 1)!
    expect(byteLength(a.anchor_text_excerpt)).toBeLessThanOrEqual(MAX_ANCHOR_EXCERPT_BYTES)
    const a2 = buildAnchor('a'.repeat(500) + 'TARGET' + 'b'.repeat(500), 500, 506, 1)!
    expect(byteLength(a2.anchor_ctx_before)).toBeLessThanOrEqual(MAX_ANCHOR_CTX_BYTES)
    expect(byteLength(a2.anchor_ctx_after)).toBeLessThanOrEqual(MAX_ANCHOR_CTX_BYTES)
  })
})

describe('DocsClientError', () => {
  it('wraps a network failure with code "network"', async () => {
    const client = new WebDocsClient({
      base_url: 'https://h',
      token: 't',
      fetchImpl: async () => {
        throw new Error('offline')
      },
    })
    await expect(client.tree('acme')).rejects.toBeInstanceOf(DocsClientError)
  })
})
