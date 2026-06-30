/**
 * Component test for the web DOCUMENTS tab (WAVE 3 PR-5). Renders `DocumentsTab`
 * in happy-dom over an injected `fetchImpl` serving the docs + comments surface.
 * Asserts:
 *   - the doc LIST renders the markdown leaves from /docs/tree;
 *   - clicking a doc OPENS it (content + comment threads render);
 *   - selecting text + posting a COMMENT round-trips through the anchor builder;
 *   - the comments_unavailable 503 gate degrades gracefully (plan §5 VERIFY):
 *     the doc still views and the composer is hidden.
 *   - EDIT (PR-6): Edit → change the textarea → Save PUTs the new content with
 *     the OCC baseline and returns to the read view; a 409 doc_changed_underfoot
 *     keeps edit mode and shows a conflict message.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://sam.neutron.test/chat?client=react' })
  const g = globalThis as unknown as Record<string, unknown>
  g['IS_REACT_ACT_ENVIRONMENT'] = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const PROJECT = 'acme'
const tick = () => new Promise((r) => setTimeout(r, 0))

const TREE = [
  {
    kind: 'folder',
    path: 'notes',
    name: 'notes',
    size_bytes: null,
    modified_at: null,
    content_type: null,
    referenced_by_count: null,
    origin: 'markdown',
    children: [
      {
        kind: 'file',
        path: 'notes/intro.md',
        name: 'intro.md',
        size_bytes: 20,
        modified_at: 5,
        content_type: null,
        referenced_by_count: null,
        origin: null,
        children: [],
      },
    ],
  },
  {
    kind: 'file',
    path: 'readme.md',
    name: 'readme.md',
    size_bytes: 12,
    modified_at: 7,
    content_type: null,
    referenced_by_count: null,
    origin: null,
    children: [],
  },
]

const FILE_CONTENT = 'The quick brown fox jumps over the lazy dog.'

const config = {
  wsUrl: 'wss://t/ws/app/chat',
  topicId: 'app:sam',
  userId: 'sam',
  projectId: PROJECT,
  projects: [{ id: PROJECT, label: 'Acme' }],
  origin: 'https://sam.neutron.test',
  deviceId: 'dev-test',
  token: 'dev:sam',
}

type Handler = (url: string, init?: RequestInit) => Response | null

async function mount(handler: Handler): Promise<{
  container: HTMLElement
  root: { unmount: () => void }
  act: (cb: () => void | Promise<void>) => Promise<void>
  calls: string[]
}> {
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const { DocumentsTab } = await import('../DocumentsTab.tsx')
  const React = await import('react')

  const calls: string[] = []
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    const res = handler(url, init)
    if (res !== null) return res
    return new Response(JSON.stringify({ ok: false, code: 'request_failed' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <React.StrictMode>
        <DocumentsTab projectId={PROJECT} config={config} fetchImpl={fetchImpl} />
      </React.StrictMode>,
    )
  })
  await act(async () => {
    await tick()
    await tick()
  })
  return {
    container,
    root: root as unknown as { unmount: () => void },
    act: act as unknown as (cb: () => void | Promise<void>) => Promise<void>,
    calls,
  }
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Switch the open doc from the default Rendered (markdown) view to the raw
 *  Source `<pre>` — needed before any selection→offset comment flow or any
 *  assertion over the raw `.cdoc-content` text. */
async function clickSource(
  container: HTMLElement,
  act: (cb: () => void | Promise<void>) => Promise<void>,
): Promise<void> {
  const toggle = Array.from(container.querySelectorAll('.cdoc-view-toggle')).find(
    (b) => (b.textContent ?? '') === 'Source',
  ) as HTMLButtonElement | undefined
  if (toggle === undefined) throw new Error('Source toggle not found')
  await act(async () => {
    toggle.click()
    await tick()
  })
}

describe('DocumentsTab (happy-dom)', () => {
  it('renders the doc list, opens a doc, and lists its comments', async () => {
    let threadsServed = false
    const handler: Handler = (url) => {
      if (url.endsWith('/docs/tree')) return jsonRes({ ok: true, tree: TREE, file_count: 2 })
      if (url.includes('/docs/file?path=')) {
        return jsonRes({
          ok: true,
          file: { path: 'notes/intro.md', content: FILE_CONTENT, size_bytes: 44, modified_at: 5 },
        })
      }
      if (url.includes('/docs/comments?path=')) {
        threadsServed = true
        return jsonRes({
          ok: true,
          threads: [
            {
              thread_root_id: 'T1',
              doc_path: 'notes/intro.md',
              anchor: { current_start: 4, current_end: 9, status: 'live', drift_hint_start: null, drift_hint_end: null, excerpt: 'quick' },
              root: { event_id: 'T1', event_kind: 'comment_posted', author_kind: 'user', author_id: 'sam', body: 'nice phrase', anchor_text_excerpt: 'quick', created_at: 1 },
              reply_count: 0,
              last_reply_at: 1,
              latest_event_kind: 'comment_posted',
            },
          ],
          next_cursor: null,
        })
      }
      return null
    }
    const { container, root, act } = await mount(handler)

    // Doc list shows both markdown leaves (folders flattened away).
    const listItems = Array.from(container.querySelectorAll('.cdoc-list-item')).map((b) => b.textContent ?? '')
    expect(listItems.some((t) => t.includes('intro.md'))).toBe(true)
    expect(listItems.some((t) => t.includes('readme.md'))).toBe(true)

    // Open the first doc.
    const introBtn = Array.from(container.querySelectorAll('.cdoc-list-item')).find(
      (b) => (b.textContent ?? '').includes('intro.md'),
    ) as HTMLButtonElement
    await act(async () => {
      introBtn.click()
      await tick()
      await tick()
    })

    // Content (rendered markdown) + comment thread render.
    expect(container.querySelector('.cdoc-md')?.textContent).toContain('quick brown fox')
    expect(threadsServed).toBe(true)
    expect(container.textContent).toContain('nice phrase')
    expect(container.textContent).toContain('“quick”')

    await act(async () => {
      root.unmount()
    })
  })

  it('posts a comment on a text selection (anchor round-trips)', async () => {
    let posted: Record<string, unknown> | null = null
    const handler: Handler = (url, init) => {
      if (url.endsWith('/docs/tree')) return jsonRes({ ok: true, tree: TREE, file_count: 2 })
      if (url.includes('/docs/file?path=')) {
        return jsonRes({
          ok: true,
          file: { path: 'notes/intro.md', content: FILE_CONTENT, size_bytes: 44, modified_at: 5 },
        })
      }
      if (url.includes('/docs/comments?path=')) {
        return jsonRes({ ok: true, threads: [], next_cursor: null })
      }
      if (url.endsWith('/docs/comments') && (init?.method ?? 'GET') === 'POST') {
        posted = JSON.parse(init!.body as string) as Record<string, unknown>
        return jsonRes({ ok: true, event: { event_id: 'E1' }, thread_root_id: 'E1' })
      }
      return null
    }
    const { container, root, act } = await mount(handler)

    const introBtn = Array.from(container.querySelectorAll('.cdoc-list-item')).find(
      (b) => (b.textContent ?? '').includes('intro.md'),
    ) as HTMLButtonElement
    await act(async () => {
      introBtn.click()
      await tick()
      await tick()
    })

    // Commenting maps to RAW offsets, so switch to the Source view first.
    await clickSource(container, act)
    // Select "brown" (offsets 10-15) inside the raw-content <pre>.
    const pre = container.querySelector('.cdoc-content') as HTMLElement
    const textNode = pre.firstChild as Node
    const start = FILE_CONTENT.indexOf('brown')
    const range = document.createRange()
    range.setStart(textNode, start)
    range.setEnd(textNode, start + 'brown'.length)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    await act(async () => {
      pre.dispatchEvent(new Event('mouseup', { bubbles: true }))
      await tick()
    })

    // Open the composer, type, and post.
    const commentBtn = container.querySelector('.cdoc-comment-btn') as HTMLButtonElement
    expect(commentBtn.disabled).toBe(false)
    await act(async () => {
      commentBtn.click()
      await tick()
    })
    const textarea = container.querySelector('.cdoc-composer-input') as HTMLTextAreaElement
    const { act: actFn } = await import('react')
    await actFn(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )!.set!
      setter.call(textarea, 'great wording')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      await tick()
    })
    const postBtn = Array.from(container.querySelectorAll('.cdoc-btn-primary')).find(
      (b) => (b.textContent ?? '').includes('Post'),
    ) as HTMLButtonElement
    await act(async () => {
      postBtn.click()
      await tick()
      await tick()
    })

    expect(posted).not.toBeNull()
    expect(posted!.body).toBe('great wording')
    expect(posted!.anchor_text_excerpt).toBe('brown')
    expect(posted!.based_on_modified_at).toBe(5)

    await act(async () => {
      root.unmount()
    })
  })

  it('degrades gracefully when comments are unavailable (503 gate)', async () => {
    const handler: Handler = (url) => {
      if (url.endsWith('/docs/tree')) return jsonRes({ ok: true, tree: TREE, file_count: 2 })
      if (url.includes('/docs/file?path=')) {
        return jsonRes({
          ok: true,
          file: { path: 'notes/intro.md', content: FILE_CONTENT, size_bytes: 44, modified_at: 5 },
        })
      }
      if (url.includes('/docs/comments?path=')) {
        return jsonRes({ ok: false, code: 'comments_unavailable', message: 'not wired' }, 503)
      }
      return null
    }
    const { container, root, act } = await mount(handler)

    const introBtn = Array.from(container.querySelectorAll('.cdoc-list-item')).find(
      (b) => (b.textContent ?? '').includes('intro.md'),
    ) as HTMLButtonElement
    await act(async () => {
      introBtn.click()
      await tick()
      await tick()
    })

    // The doc still views (rendered markdown); comments pane shows the graceful
    // note; no composer. (The Comment affordance is also hidden because it only
    // appears in Source mode, but here the 503 gate independently suppresses it.)
    expect(container.querySelector('.cdoc-md')?.textContent).toContain('quick brown fox')
    expect(container.textContent).toContain('Comments aren’t available on this server.')
    expect(container.querySelector('.cdoc-comment-btn')).toBeNull()

    await act(async () => {
      root.unmount()
    })
  })

  it('edits a doc and saves it over PUT with the OCC baseline (PR-6)', async () => {
    let put: { url: string; body: Record<string, unknown> } | null = null
    let commentReloads = 0
    const handler: Handler = (url, init) => {
      if (url.endsWith('/docs/tree')) return jsonRes({ ok: true, tree: TREE, file_count: 2 })
      if (url.includes('/docs/file?path=')) {
        return jsonRes({
          ok: true,
          file: { path: 'notes/intro.md', content: FILE_CONTENT, size_bytes: 44, modified_at: 5 },
        })
      }
      if (url.endsWith('/docs/file') && (init?.method ?? 'GET') === 'PUT') {
        put = { url, body: JSON.parse(init!.body as string) as Record<string, unknown> }
        return jsonRes({ ok: true, file: { path: 'notes/intro.md', size_bytes: 9, modified_at: 99 } })
      }
      if (url.includes('/docs/comments?path=')) {
        commentReloads += 1
        return jsonRes({ ok: true, threads: [], next_cursor: null })
      }
      return null
    }
    const { container, root, act } = await mount(handler)

    const introBtn = Array.from(container.querySelectorAll('.cdoc-list-item')).find(
      (b) => (b.textContent ?? '').includes('intro.md'),
    ) as HTMLButtonElement
    await act(async () => {
      introBtn.click()
      await tick()
      await tick()
    })
    const reloadsAfterOpen = commentReloads

    // Enter edit mode.
    const editBtn = container.querySelector('.cdoc-edit-btn') as HTMLButtonElement
    expect(editBtn).not.toBeNull()
    await act(async () => {
      editBtn.click()
      await tick()
    })

    // The editor textarea is seeded with the raw file content.
    const editor = container.querySelector('.cdoc-editor') as HTMLTextAreaElement
    expect(editor).not.toBeNull()
    expect(editor.value).toBe(FILE_CONTENT)

    // Save is disabled until the draft actually differs.
    const saveBtnInitial = Array.from(container.querySelectorAll('.cdoc-btn-primary')).find(
      (b) => (b.textContent ?? '').includes('Save'),
    ) as HTMLButtonElement
    expect(saveBtnInitial.disabled).toBe(true)

    // Edit the draft.
    const { act: actFn } = await import('react')
    await actFn(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )!.set!
      setter.call(editor, '# Rewritten')
      editor.dispatchEvent(new Event('input', { bubbles: true }))
      await tick()
    })

    const saveBtn = Array.from(container.querySelectorAll('.cdoc-btn-primary')).find(
      (b) => (b.textContent ?? '').includes('Save'),
    ) as HTMLButtonElement
    expect(saveBtn.disabled).toBe(false)
    await act(async () => {
      saveBtn.click()
      await tick()
      await tick()
    })

    // PUT carried the new content + the OCC baseline (the open file's mtime).
    expect(put).not.toBeNull()
    expect(put!.body).toEqual({
      path: 'notes/intro.md',
      content: '# Rewritten',
      expected_modified_at: 5,
    })
    // Back to the read view, now showing the saved content; comments reloaded.
    expect(container.querySelector('.cdoc-editor')).toBeNull()
    // Switch to Source to assert on the raw saved markdown ('# Rewritten').
    await clickSource(container, act)
    expect(container.querySelector('.cdoc-content')?.textContent).toContain('# Rewritten')
    expect(commentReloads).toBeGreaterThan(reloadsAfterOpen)

    await act(async () => {
      root.unmount()
    })
  })

  it('surfaces a conflict when the doc changed underfoot (409)', async () => {
    const handler: Handler = (url, init) => {
      if (url.endsWith('/docs/tree')) return jsonRes({ ok: true, tree: TREE, file_count: 2 })
      if (url.includes('/docs/file?path=')) {
        return jsonRes({
          ok: true,
          file: { path: 'notes/intro.md', content: FILE_CONTENT, size_bytes: 44, modified_at: 5 },
        })
      }
      if (url.endsWith('/docs/file') && (init?.method ?? 'GET') === 'PUT') {
        // PUT /docs/file surfaces a stale OCC baseline as doc_modified_conflict
        // (DocConflictError), the real gateway code for write conflicts.
        return jsonRes(
          { ok: false, code: 'doc_modified_conflict', message: 'stale', current_modified_at: 88 },
          409,
        )
      }
      if (url.includes('/docs/comments?path=')) return jsonRes({ ok: true, threads: [], next_cursor: null })
      return null
    }
    const { container, root, act } = await mount(handler)

    const introBtn = Array.from(container.querySelectorAll('.cdoc-list-item')).find(
      (b) => (b.textContent ?? '').includes('intro.md'),
    ) as HTMLButtonElement
    await act(async () => {
      introBtn.click()
      await tick()
      await tick()
    })
    await act(async () => {
      ;(container.querySelector('.cdoc-edit-btn') as HTMLButtonElement).click()
      await tick()
    })
    const editor = container.querySelector('.cdoc-editor') as HTMLTextAreaElement
    const { act: actFn } = await import('react')
    await actFn(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(editor, 'conflicting edit')
      editor.dispatchEvent(new Event('input', { bubbles: true }))
      await tick()
    })
    const saveBtn = Array.from(container.querySelectorAll('.cdoc-btn-primary')).find(
      (b) => (b.textContent ?? '').includes('Save'),
    ) as HTMLButtonElement
    await act(async () => {
      saveBtn.click()
      await tick()
      await tick()
    })

    // Stays in edit mode, draft preserved, with a conflict message.
    expect(container.querySelector('.cdoc-editor')).not.toBeNull()
    expect((container.querySelector('.cdoc-editor') as HTMLTextAreaElement).value).toBe('conflicting edit')
    expect(container.textContent).toContain('changed since you opened it')

    await act(async () => {
      root.unmount()
    })
  })

  it('does not leave Save stuck-disabled when navigating away mid-save', async () => {
    // The PUT for doc A is held open; navigating to doc B must reset `saving` so
    // doc B's edit controls aren't stuck-disabled when the stale PUT settles.
    let releasePut: (() => void) | null = null
    const putGate = new Promise<void>((resolve) => {
      releasePut = resolve
    })
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { DocumentsTab } = await import('../DocumentsTab.tsx')
    const React = await import('react')

    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith('/docs/tree')) return jsonRes({ ok: true, tree: TREE, file_count: 2 })
      if (url.includes('/docs/file?path=')) {
        const isReadme = url.includes('readme.md')
        return jsonRes({
          ok: true,
          file: {
            path: isReadme ? 'readme.md' : 'notes/intro.md',
            content: isReadme ? 'README body' : FILE_CONTENT,
            size_bytes: 11,
            modified_at: isReadme ? 7 : 5,
          },
        })
      }
      if (url.endsWith('/docs/file') && (init?.method ?? 'GET') === 'PUT') {
        await putGate // held until the test releases it
        return jsonRes({ ok: true, file: { path: 'notes/intro.md', size_bytes: 3, modified_at: 50 } })
      }
      if (url.includes('/docs/comments?path=')) return jsonRes({ ok: true, threads: [], next_cursor: null })
      return new Response(JSON.stringify({ ok: false, code: 'request_failed' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <React.StrictMode>
          <DocumentsTab projectId={PROJECT} config={config} fetchImpl={fetchImpl} />
        </React.StrictMode>,
      )
    })
    await act(async () => {
      await tick()
      await tick()
    })

    const open = async (name: string): Promise<void> => {
      const btn = Array.from(container.querySelectorAll('.cdoc-list-item')).find(
        (b) => (b.textContent ?? '').includes(name),
      ) as HTMLButtonElement
      await act(async () => {
        btn.click()
        await tick()
        await tick()
      })
    }
    const setEditorValue = async (v: string): Promise<void> => {
      const editor = container.querySelector('.cdoc-editor') as HTMLTextAreaElement
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
        setter.call(editor, v)
        editor.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
      })
    }
    const clickEdit = async (): Promise<void> => {
      await act(async () => {
        ;(container.querySelector('.cdoc-edit-btn') as HTMLButtonElement).click()
        await tick()
      })
    }
    const saveBtn = (): HTMLButtonElement =>
      Array.from(container.querySelectorAll('.cdoc-btn-primary')).find((b) =>
        (b.textContent ?? '').includes('Sav'),
      ) as HTMLButtonElement

    // Doc A: edit, change, Save → PUT is now in flight (held by putGate).
    await open('intro.md')
    await clickEdit()
    await setEditorValue('A edit')
    await act(async () => {
      saveBtn().click()
      await tick()
    })

    // Navigate to doc B while the save is still in flight.
    await open('readme.md')

    // Release the stale PUT; its continuation must bail (seq mismatch).
    await act(async () => {
      releasePut!()
      await tick()
      await tick()
    })

    // Doc B can be edited + its Save enables once the draft differs — i.e. the
    // controls are NOT stuck-disabled from the abandoned save.
    await clickEdit()
    await setEditorValue('B edit')
    expect(saveBtn().disabled).toBe(false)
    expect(saveBtn().textContent).toContain('Save')

    await act(async () => {
      root.unmount()
    })
  })
})
