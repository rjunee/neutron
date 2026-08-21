/**
 * DOCUMENT COMMENTS — wired by the real composer, or not wired at all.
 *
 * The web Documents tab has called six `/api/app/projects/<id>/docs/comments*`
 * routes since WAVE 3 (`landing/chat-react/docs-client.ts:281-354`). Every one
 * of them answered `503 comments_unavailable`, on every install, for months.
 *
 * The cause was one missing argument. `createAppDocsSurface` takes `comments`
 * optionally and falls to `opts.comments ?? null` (`app-docs-surface.ts:159`);
 * `open/composer.ts` — the only composer Open has — passed `store`, `auth` and
 * `project_slug` and never `comments`. One level up, `new CommentStore(` had
 * ZERO non-test call sites in the entire repo, so the store the surface wanted
 * was never constructed by anything that ships.
 *
 * WHY THREE GREEN TESTS DID NOT NOTICE. `gateway/__tests__/comments-production-composer.test.ts`,
 * `gateway/__tests__/app-docs-surface-comments.test.ts` and the escalation block
 * of `gateway/wiring/__tests__/build-phase-spec-resolver.test.ts` all pass, and
 * all three build the wiring themselves before asserting on it. They prove the
 * CONSUMER works when handed its dependencies. Nothing asked whether anything
 * hands them over. Two of the three even cited `gateway/index.ts:2434-2455` and
 * `:2989-3007` as "the prod wiring" — a file that is 946 lines long and has not
 * composed Open since the OSS split, so the citations pointed at nothing and the
 * dangling reference is part of why this stayed invisible.
 *
 * So this file hands nothing over. It boots `buildOpenGraphComposer` — the real
 * production composer — runs the real `composeProductionGraph`, serves it, and
 * drives real HTTP at the result. Every assertion below is about what the
 * composer PRODUCED. Same shape as `app-surfaces-served.test.ts` next door, and
 * for the same reason.
 *
 * THE CHAIN, LINK BY LINK, because a switch would have been easier and this is
 * not one. Each is asserted separately below, so a failure names which link
 * broke rather than "comments are broken":
 *
 *   1. the store is constructed            → any 2xx from a comments route
 *   2. it reaches the surface              → 200 rather than 503 specifically
 *   3. the routes answer                   → post / list / reply / thread /
 *                                            escalate / resolve all round-trip
 *   4. edits re-anchor                     → the AnchorWalker moves an anchor
 *                                            when the doc under it changes
 *   5. escalation pins the project         → the escalate route accepts and the
 *                                            registry the resolver reads is the
 *                                            one the surface writes
 *
 * LINK 6 IS NOT WIRED, AND THIS FILE SAYS SO OUT LOUD RATHER THAN OMITTING IT.
 * The `<escalated_comment_threads>` splice is fed by `loadPendingEscalations`,
 * whose single non-test caller is `build-phase-spec-resolver.ts:322` — the
 * onboarding INTERVIEW ENGINE's resolver. On Open the interview phase machine
 * was retired from the conversational path (`open/composer.ts` ~3540: onboarding
 * is a MODE of the live `/ws/app/chat` agent, "no `engine.advance`"), and
 * `engine.advance` has no production caller left. The engine survives only as
 * the import subsystem owner. The steady-state turn composes its own prompt
 * (`build-live-agent-turn.ts:composeFirstTurnPrompt`) and never loads
 * escalations.
 *
 * Net: an owner can escalate a comment thread, the event lands, the pin is set,
 * and no prompt they will realistically see reads it. That is pinned as a live
 * gap in `open/__tests__/reachability-inventory.ts` — where the assertion is
 * that it is still BROKEN, so the day someone wires it the gate reds and tells
 * them to promote the entry. Closing it means giving the live-agent turn its own
 * escalation fragment, which is a product decision and not this file's business.
 *
 * MUTATION TESTS. Run against `open/composer.ts`, results as observed:
 *
 *   - drop `comments: commentStore` from `createAppDocsSurface`
 *     → 4 tests red, every one of them with 503. VERIFIED.
 *   - drop `onMutationSuccess: anchorWalker.handle` from the `DocStore`
 *     → link 4 alone reds (the anchor stays at offset 12 instead of moving to
 *       29) and the five others stay green. VERIFIED.
 *   - drop `chatSessionProjects` from `createAppDocsSurface`
 *     → NOTHING REDS. Recorded here rather than quietly omitted, because a
 *       mutation-test list that only lists its successes is the same
 *       reassuring-but-blind artefact as the three green tests described above.
 *
 * That third result is not a hole in this file, it is the SAME gap the file
 * documents. `chatSessionProjects` exists to be read back by the escalation
 * splice; the splice's only consumer is unreachable on Open, so threading the
 * registry has no observable consequence to assert on. Writing a test that
 * appeared to cover it would mean asserting something untrue. It is instead
 * covered from the other end, by the `loadPendingEscalations` consumer-set gate
 * in the last describe block: when a live-turn consumer appears, that gate reds
 * and the pin becomes assertable in the same change.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

import { buildOpenGraphComposer } from '../composer.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME',
  'OWNER_HOME',
  'NEUTRON_DB_PATH',
  'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR',
  'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH',
  'NOTIFY_SOCKET',
] as const

/** The instance slug the composer boots with; also the dev-path bearer. */
const OWNER_SLUG = 'owner'
/** The project whose docs tree the comments hang off. */
const PROJECT = 'demo-project'
const DOC_PATH = 'note.md'
/** The anchored phrase. Kept distinctive so the re-anchor assertion is exact. */
const ANCHOR_TEXT = 'the anchored sentence'
const DOC_BODY = `intro line\n\n${ANCHOR_TEXT} sits here.\n`

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string
let harness: Harness

interface Harness {
  base: string
  close(): Promise<void>
}

/** A substrate that answers immediately and starts no `claude` process. */
function mockSubstrate(): Substrate {
  return {
    start(_spec: AgentSpec): SessionHandle {
      async function* gen(): AsyncGenerator<Event> {
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'mock',
        }
      }
      return {
        events: gen(),
        async respondToTool(): Promise<void> {},
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

async function startHarness(): Promise<Harness> {
  seedMigratedDb(process.env['NEUTRON_DB_PATH'] as string)
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH'] as string)
  const composer = buildOpenGraphComposer({
    env: process.env,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    substrateFactory: (() => mockSubstrate()) as any,
  })
  const composition = await composer({ db, project_slug: OWNER_SLUG })
  const graph = await composeProductionGraph(composition)
  if (graph.fetch === undefined || graph.websocket === undefined) {
    throw new Error('Open composition did not expose graph.fetch/websocket')
  }
  const composedFetch = graph.fetch
  const composedWebsocket = graph.websocket
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composedFetch(req, srv),
    websocket: composedWebsocket,
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    close: async () => {
      await server.stop(true)
      for (const cleanup of composition.realmode_cleanups ?? []) {
        try {
          cleanup()
        } catch {
          /* best-effort */
        }
      }
      await graph.shutdown()
      db.close()
    },
  }
}

/** Bearer-authed JSON request, exactly as the shipped clients issue it. */
async function call(
  path: string,
  init: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (init.auth !== false) headers['authorization'] = `Bearer ${OWNER_SLUG}`
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  return await fetch(`${harness.base}${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
}

const commentsBase = `/api/app/projects/${PROJECT}/docs/comments`

/** Repo root — two levels up from `open/__tests__/`. */
const REPO_ROOT = join(HERE, '..', '..')

/** Directory names never walked. `vendor` is Open-as-a-submodule, not source. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'vendor',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
])

function isTestPath(rel: string): boolean {
  const parts = rel.split(sep)
  if (parts.includes('__tests__') || parts.includes('__mocks__') || parts.includes('tests')) {
    return true
  }
  return /\.(test|spec)\.tsx?$/.test(parts[parts.length - 1] ?? '')
}

/**
 * Repo-relative paths of every non-test source that IMPORTS the named binding.
 *
 * Matches inside `import { … }` clauses only, so a mention of the name in a
 * comment or a doc string does not count as a consumer — `loadPendingEscalations`
 * is named in prose in `comment-store.ts` and `escalation-loader.ts` itself, and
 * a substring scan would report three consumers where there is one. Sorted, so
 * the assertion reads as a set rather than a walk order.
 */
function nonTestImportersOf(binding: string): string[] {
  const hits: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(join(dir, entry.name))
        continue
      }
      if (!/\.tsx?$/.test(entry.name) || /\.d\.ts$/.test(entry.name)) continue
      const abs = join(dir, entry.name)
      const rel = relative(REPO_ROOT, abs)
      if (isTestPath(rel)) continue
      const src = readFileSync(abs, 'utf8')
      if (!src.includes(binding)) continue
      for (const clause of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from/g)) {
        const names = (clause[1] ?? '').split(',').map((n) => n.trim().split(/\s+as\s+/)[0]?.trim())
        if (names.includes(binding)) {
          hits.push(rel.split(sep).join('/'))
          break
        }
      }
    }
  }
  walk(REPO_ROOT)
  return [...new Set(hits)].sort()
}

/** The slice of `ThreadSummary` (`docs-client.ts:110`) these assertions read. */
interface ThreadRow {
  thread_root_id?: string
  root?: { event_id?: string }
  anchor?: { current_start?: number; status?: string } | null
}

/** The thread whose ROOT is `event_id`, by either identifier the row carries. */
function findThread(threads: ThreadRow[] | undefined, event_id: string): ThreadRow | undefined {
  return threads?.find((t) => t.root?.event_id === event_id || t.thread_root_id === event_id)
}

/** The doc's current `modified_at` — the OCC baseline a root comment must carry. */
async function currentModifiedAt(): Promise<number> {
  const res = await call(
    `/api/app/projects/${PROJECT}/docs/file?path=${encodeURIComponent(DOC_PATH)}`,
  )
  if (res.status !== 200) throw new Error(`docs/file returned ${res.status}`)
  const json = (await res.json()) as { file?: { modified_at?: number } }
  const modified_at = json.file?.modified_at
  if (typeof modified_at !== 'number') throw new Error('docs/file carried no modified_at')
  return modified_at
}

/**
 * Post a root comment anchored to {@link ANCHOR_TEXT}, in the EXACT wire shape
 * the shipped web client sends (`landing/chat-react/docs-client.ts:308-319`) —
 * flat `anchor_*` fields plus the `based_on_modified_at` OCC baseline. Matching
 * the real client matters: a request shape invented for the test could pass
 * against a surface the real client still cannot use.
 */
async function postRootComment(
  body: string,
  content: string = DOC_BODY,
): Promise<{ res: Response; event_id?: string }> {
  const start = content.indexOf(ANCHOR_TEXT)
  const res = await call(commentsBase, {
    method: 'POST',
    body: {
      path: DOC_PATH,
      body,
      anchor_start: start,
      anchor_end: start + ANCHOR_TEXT.length,
      anchor_text_excerpt: ANCHOR_TEXT,
      anchor_ctx_before: content.slice(Math.max(0, start - 24), start),
      anchor_ctx_after: content.slice(start + ANCHOR_TEXT.length, start + ANCHOR_TEXT.length + 24),
      based_on_modified_at: await currentModifiedAt(),
    },
  })
  if (res.status !== 200) return { res }
  const json = (await res.clone().json()) as { event?: { event_id?: string } }
  const event_id = json.event?.event_id
  return event_id !== undefined ? { res, event_id } : { res }
}

beforeAll(async () => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-doc-comments-wiring-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = OWNER_SLUG
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'doc-comments-wiring-secret-0123456789'
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-doc-comments-wiring'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  process.env['NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH'] = '1'
  delete process.env['NOTIFY_SOCKET']

  // Seed the doc the comments anchor into. The docs surface reads the real
  // on-disk tree (`<owner_home>/Projects/<id>/docs`), which project setup
  // normally populates.
  const docsDir = join(tmpDir, 'Projects', PROJECT, 'docs')
  mkdirSync(docsDir, { recursive: true })
  writeFileSync(join(docsDir, DOC_PATH), DOC_BODY, 'utf8')

  harness = await startHarness()
}, 120_000)

afterAll(async () => {
  await harness?.close()
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('links 1-3 — the store exists, reaches the surface, and the routes answer', () => {
  test('POST a root comment returns 200, NOT 503 comments_unavailable', async () => {
    const { res } = await postRootComment('first thought')
    // The specific status matters more than "not an error". 503 is the exact
    // answer an unwired composer produces (`app-docs-surface.ts:193`), so
    // asserting on it is what distinguishes "comments are off" from any other
    // failure — and it is the status every install returned before this wiring.
    expect(res.status).not.toBe(503)
    expect(res.status).toBe(200)
  })

  test('the six comment routes all round-trip through the composed graph', async () => {
    const { res: postRes, event_id } = await postRootComment('thread root')
    expect(postRes.status).toBe(200)
    expect(event_id).toBeDefined()
    const root = event_id as string

    const list = await call(`${commentsBase}?path=${encodeURIComponent(DOC_PATH)}`)
    expect(list.status).toBe(200)
    const listed = (await list.json()) as { threads?: unknown[] }
    expect(Array.isArray(listed.threads)).toBe(true)
    expect((listed.threads as unknown[]).length).toBeGreaterThan(0)

    const reply = await call(`${commentsBase}/${root}/reply`, {
      method: 'POST',
      body: { body: 'a reply' },
    })
    expect(reply.status).toBe(200)

    const thread = await call(`${commentsBase}/${root}/thread`)
    expect(thread.status).toBe(200)
    const tree = (await thread.json()) as { thread?: { replies?: unknown[] } }
    expect(Array.isArray(tree.thread?.replies)).toBe(true)

    const escalate = await call(`${commentsBase}/${root}/escalate`, {
      method: 'POST',
      body: {},
    })
    expect(escalate.status).toBe(200)

    const resolve = await call(`${commentsBase}/${root}/resolve`, {
      method: 'POST',
      body: {},
    })
    expect(resolve.status).toBe(200)
  })

  test('an unauthenticated comment request is REJECTED BY THE SURFACE, not 404d past it', async () => {
    // The control that makes the assertions above mean something. On this
    // ladder an unmounted route and a mistyped one are both 404, so "it
    // answered" is only evidence if the surface can be shown to be the thing
    // answering. Only a mounted surface produces 401/403 here.
    const res = await call(`${commentsBase}?path=${encodeURIComponent(DOC_PATH)}`, {
      auth: false,
    })
    expect([401, 403]).toContain(res.status)
  })
})

describe('link 4 — a doc edit re-anchors its comments (AnchorWalker)', () => {
  test('editing text ABOVE an anchor moves the anchor rather than stranding it', async () => {
    const { res, event_id } = await postRootComment('anchored note')
    expect(res.status).toBe(200)
    const root = event_id as string

    const before = await call(`${commentsBase}?path=${encodeURIComponent(DOC_PATH)}`)
    const beforeJson = (await before.json()) as { threads?: ThreadRow[] }
    const beforeStart = findThread(beforeJson.threads, root)?.anchor?.current_start
    expect(typeof beforeStart).toBe('number')

    // Insert a line ABOVE the anchored phrase. The phrase itself is untouched,
    // so a correct walker relocates the anchor by exactly the inserted length;
    // an unwired walker leaves the old offset pointing into the wrong text.
    const inserted = 'a new first line\n'
    const write = await call(`/api/app/projects/${PROJECT}/docs/file`, {
      method: 'PUT',
      body: { path: DOC_PATH, content: `${inserted}${DOC_BODY}` },
    })
    expect(write.status).toBe(200)

    const after = await call(`${commentsBase}?path=${encodeURIComponent(DOC_PATH)}`)
    expect(after.status).toBe(200)
    const afterJson = (await after.json()) as { threads?: ThreadRow[] }
    const afterAnchor = findThread(afterJson.threads, root)?.anchor
    expect(afterAnchor).toBeDefined()
    // The walker ran: the anchor tracked the text down the document. Asserting
    // the exact new offset (rather than "it changed") is what makes this a test
    // of RELOCATION and not merely of mutation — an anchor that got clobbered to
    // 0, or marked dead, would satisfy "changed" and fail here.
    expect(afterAnchor?.current_start).toBe((beforeStart as number) + inserted.length)
    expect(afterAnchor?.status).not.toBe('orphaned')
    expect(afterAnchor?.status).not.toBe('dead')
  })
})

describe('link 5 — escalation pins the project the resolver reads', () => {
  test('escalate is accepted and writes an escalate_to_chat event', async () => {
    const { res, event_id } = await postRootComment('please look at this')
    expect(res.status).toBe(200)
    const root = event_id as string

    const escalate = await call(`${commentsBase}/${root}/escalate`, {
      method: 'POST',
      body: { note: 'needs your eyes' },
    })
    expect(escalate.status).toBe(200)
    const body = (await escalate.json()) as { escalate_event_id?: string }
    // A returned event id is the surface's proof it reached `appendEvent` on a
    // real store — the branch that also calls `chatSessionProjects.setActive`
    // (`app-docs-surface.ts:1501`). Without `chatSessionProjects` threaded the
    // handler still answers, so this asserts the reachable half; the
    // unreachable half is stated below and pinned in the reachability
    // inventory rather than asserted here, because asserting it would mean
    // asserting something that is not true.
    expect(typeof body.escalate_event_id).toBe('string')
  })

  test('DOCUMENTED GAP — `loadPendingEscalations` still has exactly one consumer', () => {
    // The behaviour being recorded is an ABSENCE, and the honest way to pin an
    // absence is to pin the thing whose APPEARANCE would end it. So this reads
    // the source and asserts the consumer set has not grown.
    //
    // `loadPendingEscalations` is the only path by which an escalated thread
    // becomes prompt text. Today its sole non-test importer is
    // `gateway/wiring/build-phase-spec-resolver.ts` — the onboarding interview
    // engine's resolver, whose phase machine no longer drives chat on Open. So
    // no steady-state turn can read an escalation, however well the routes work.
    //
    // The day someone gives `build-live-agent-turn.ts` (or anything else) its
    // own escalation fragment, this list grows and THIS TEST REDS — which is the
    // point. It forces the gap note to be promoted to a real assertion at the
    // same moment the gap closes, instead of leaving a comment behind that says
    // the feature is broken after it has started working. That is the failure
    // mode `/code` shipped with, one level down.
    //
    // Note what this deliberately does NOT do: it does not assert a count. A
    // count can be satisfied by swapping one consumer for another. The set is
    // named, so a substitution is as visible as an addition.
    const consumers = nonTestImportersOf('loadPendingEscalations')
    expect(consumers).toEqual(['gateway/wiring/build-phase-spec-resolver.ts'])
  })
})
