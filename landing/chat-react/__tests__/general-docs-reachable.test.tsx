/**
 * GENERAL'S DOCUMENTS TAB — the whole chain, from tab set to URL.
 *
 * THE BUG THIS PINS. The owner had a work card in General whose plan-document
 * link did nothing, and General showed no documents at all. Three separate
 * things had to be true for that, and each looked correct on its own:
 *
 *   1. General's tab set was Chat + Work + Admin — no `documents` descriptor, so
 *      the doc-link resolver (`ProjectShell`'s `pendingDoc` effect) waited for a
 *      tab that never arrived and silently gave up.
 *   2. `ProjectShell` therefore SUPPRESSED the link for General on purpose
 *      (`isGeneral ? undefined : onOpenDocLink`) so the chip rendered as static
 *      text rather than a dead button. Correct for that tab set, and it encoded a
 *      fact about ANOTHER module with no mechanical link back to it.
 *   3. `docs-client.ts` interpolated the scope id into nine URLs raw, so even
 *      with a tab, General (`''`) would have requested `/api/app/projects//docs/…`
 *      and taken a 400.
 *
 * Fixing any ONE of the three changes nothing observable. That is what makes this
 * worth a test that walks the real chain instead of three unit tests that each
 * pass while the feature stays broken.
 *
 * WHY THE ASSERTIONS ARE SHAPED THIS WAY. The tab-order test walks the ACTUAL
 * injected array and finds targets by name; it never compares against a literal
 * list of keys, because a literal would need editing in lockstep with the code it
 * is supposed to be checking and would then agree with any change.
 */

import { describe, expect, it } from 'bun:test'

import { WebDocsClient } from '../docs-client.ts'
import { GENERAL_HTTP_ID, httpProjectSegment, httpProjectSegmentEncoded } from '../general-scope.ts'
import { CHAT_TAB, GENERAL_DOCS_TAB, GENERAL_WORK_TAB, canRenderTab } from '../tabs-client.ts'
import { workBoardPathSegment } from '../work-board-client.ts'

describe('general-scope — the one place General changes spelling', () => {
  it('maps every "no project" spelling the shell can produce to the HTTP id', () => {
    // The shell says `null`, the clients say `''`. A caller should never have to
    // know which one reached it — that ambiguity is the whole reason the raw
    // interpolation slipped through review.
    expect(httpProjectSegment('')).toBe(GENERAL_HTTP_ID)
    expect(httpProjectSegment(null)).toBe(GENERAL_HTTP_ID)
    expect(httpProjectSegment(undefined)).toBe(GENERAL_HTTP_ID)
  })

  it('passes a named project through untouched', () => {
    expect(httpProjectSegment('neutron')).toBe('neutron')
    // A project literally named "general" is indistinguishable from the sentinel
    // by design — the gateway resolves both to the same docs root. Pinned so the
    // collision is a recorded decision rather than a latent surprise.
    expect(httpProjectSegment(GENERAL_HTTP_ID)).toBe(GENERAL_HTTP_ID)
  })

  it('percent-encodes, so a scope id can never inject a path segment', () => {
    expect(httpProjectSegmentEncoded('a/b')).toBe('a%2Fb')
  })

  it('is the SAME rule the work-board client uses (delegation, not a copy)', () => {
    // `work-board-client` carried the only normaliser on the web while
    // `docs-client` carried none. Two private copies is how the two spellings
    // drift; this asserts there is now one rule with two callers.
    for (const scope of ['', 'neutron', 'a-b_c']) {
      expect(workBoardPathSegment(scope)).toBe(httpProjectSegment(scope))
    }
  })
})

describe('docs-client — General reaches a real URL', () => {
  /** Capture the path the client requests without standing up a server. */
  function captureUrl(): { client: WebDocsClient; urls: string[] } {
    const urls: string[] = []
    const fetchImpl = (input: string): Promise<Response> => {
      urls.push(input)
      return Promise.resolve(
        new Response(JSON.stringify({ tree: [], file_count: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    return {
      client: new WebDocsClient({ base_url: 'https://example.com', token: 't', fetchImpl }),
      urls,
    }
  }

  it('requests /projects/general/docs/tree for the General scope', async () => {
    const { client, urls } = captureUrl()
    await client.tree('')
    expect(urls).toHaveLength(1)
    // The FAILING form is the specific thing being excluded: a raw '' produced a
    // double slash, which the gateway rejects as an unparseable project id.
    expect(urls[0]).not.toContain('/projects//docs')
    expect(urls[0]).toContain(`/projects/${GENERAL_HTTP_ID}/docs/tree`)
  })

  it('still addresses a named project by its own id', async () => {
    const { client, urls } = captureUrl()
    await client.tree('neutron')
    expect(urls[0]).toContain('/projects/neutron/docs/tree')
  })
})

describe("General's tab set — chat → work → docs", () => {
  /**
   * The shell's injection, reproduced exactly as `ProjectShell` performs it. The
   * engine's global set is Admin-only, which is why both Work and Docs have to be
   * injected client-side rather than resolved.
   */
  const ADMIN_GLOBAL_TAB = {
    key: 'admin',
    label: 'Admin',
    scope: 'global',
    source: 'builtin',
    order: 90,
    mount: { kind: 'builtin', target: 'admin' },
  } as const
  const generalTabs = [
    CHAT_TAB,
    GENERAL_WORK_TAB,
    GENERAL_DOCS_TAB,
    ...[ADMIN_GLOBAL_TAB].filter(canRenderTab),
  ]

  it('contains a docs tab at all — the resolver waits for exactly this', () => {
    // `ProjectShell`'s pendingDoc effect does `tabs.find(t => t.mount.target === 'docs')`
    // and returns early when it is undefined. Absent this tab, a doc link is a
    // no-op with no error anywhere: the exact failure the owner reported.
    expect(generalTabs.find((t) => t.mount.target === 'docs')).toBeDefined()
  })

  it('orders them chat → work → docs by walking the array, not a literal', () => {
    const order = generalTabs
      .map((t) => t.mount.target)
      .filter((target) => target === 'chat' || target === 'workboard' || target === 'docs')
    expect(order).toEqual(['chat', 'workboard', 'docs'])
  })

  it('renders the docs tab (it is a builtin this client knows how to mount)', () => {
    // A descriptor the client cannot render is filtered out before it reaches the
    // bar, which would put us straight back to "no docs tab" with a tab defined.
    expect(canRenderTab(GENERAL_DOCS_TAB)).toBe(true)
  })
})

describe('ProjectShell no longer suppresses the doc link for General', () => {
  /**
   * A SOURCE assertion, deliberately, and narrow.
   *
   * The property that matters — "clicking a General work card's plan link opens
   * the doc" — is genuinely behavioural, and the honest way to check it is the
   * happy-dom shell render in `doc-link-open.test.tsx`. What this adds is cheap
   * insurance against the ONE line coming back, because the suppression was not
   * a bug when it was written: it was a correct response to General having no
   * Documents tab, and someone re-reading the resolver could reasonably
   * reintroduce it. The scoped string below names the exact expression, so it
   * cannot pass by accident on a rewritten conditional.
   */
  it('does not reintroduce the isGeneral guard on the work surface handler', async () => {
    const src = await Bun.file(new URL('../ProjectShell.tsx', import.meta.url)).text()
    // STRIP COMMENTS FIRST. This check caught itself on the first run: the
    // rewritten code carries a comment QUOTING the old expression to explain why
    // it was removed, and a naive substring search flagged the explanation as the
    // regression. A check on source text has to look at code, or it punishes the
    // documentation that makes the change legible.
    const code = src
      .split('\n')
      .filter((line) => {
        const t = line.trim()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')
    // `includes` rather than `toContain`: a failing `toContain` on a whole file
    // prints the whole file.
    expect(code.includes('isGeneral ? undefined : onOpenDocLink')).toBe(false)
    expect(code.includes('const workOpenDoc = onOpenDocLink')).toBe(true)
  })
})
