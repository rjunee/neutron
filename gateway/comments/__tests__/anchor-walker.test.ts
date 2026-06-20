/**
 * P7.2 S2 — anchor-walker integration tests.
 *
 * Real per-project SQLite sidecar + real tmp docs root. Covers the
 * brief § 10.2 table of anchor-drift scenarios:
 *   1. Insert before  → anchor_relocated, shifted by N
 *   2. Insert after   → anchor_relocated, same start
 *   3. Edit inside    → anchor_relocated, single excerpt match
 *   4. Delete excerpt → anchor_dead
 *   5. Cut + paste    → anchor_relocated (single excerpt match wins)
 *   6. Wholesale rewrite (similar but not identical) → anchor_drifted
 *   7. Two doc edits in quick succession — latest mtime wins
 *   8. Doc deleted entirely → anchor_dead for every anchor
 *   9. Doc moved (renamed) → anchor_relocated with to_doc_path
 *
 * Also covers:
 *   - reanchorAfterEdit direct API (counts per kind)
 *   - relocateAnchor pure-function edge cases
 *   - per-project mutex serialises concurrent calls
 *   - walker never throws even when the doc is missing mid-flight
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  AnchorWalker,
  RELOCATE_TOLERANCE,
  relocateAnchor,
} from '../anchor-walker.ts'
import {
  CommentStore,
  type AppendEventInput,
} from '../comment-store.ts'

interface Harness {
  walker: AnchorWalker
  store: CommentStore
  owner_home: string
  docsRoot: string
  tmp: string
  events: { ts: number }
  cleanup(): void
}

const PROJECT_ID = 'demo-project'

function start(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-walker-'))
  const owner_home = join(tmp, 'home')
  const docsRoot = join(owner_home, 'Projects', PROJECT_ID, 'docs')
  mkdirSync(docsRoot, { recursive: true })
  const events = { ts: 1_700_000_000_000 }
  let ulidSeq = 0
  const padUlid = (n: number): string => {
    const s = n.toString(36).padStart(10, '0').toUpperCase().replace(/[ILOU]/g, '0')
    return '01HW' + s.padEnd(22, '0')
  }
  const store = new CommentStore({
    owner_home,
    ulid: () => {
      ulidSeq += 1
      return padUlid(ulidSeq)
    },
    now: () => {
      events.ts += 1
      return events.ts
    },
  })
  const walker = new AnchorWalker({
    commentStore: store,
    owner_home,
  })
  return {
    walker,
    store,
    owner_home,
    docsRoot,
    tmp,
    events,
    cleanup: () => {
      store.closeAll()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

function buildDoc(h: Harness, relPath: string, content: string): void {
  const abs = join(h.docsRoot, relPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

async function postRoot(
  h: Harness,
  relPath: string,
  body: string,
  pos: { start: number; end: number },
  ctx: { before: string; after: string },
): Promise<string> {
  const excerpt = readSlice(h, relPath, pos.start, pos.end)
  const input: AppendEventInput = {
    event_kind: 'comment_posted',
    doc_path: relPath,
    thread_root_id: null,
    parent_event_id: null,
    anchor_start: pos.start,
    anchor_end: pos.end,
    anchor_text_excerpt: excerpt,
    anchor_ctx_before: ctx.before,
    anchor_ctx_after: ctx.after,
    based_on_modified_at: 0,
    author_kind: 'user',
    author_id: 'user_sam',
    body,
    metadata_json: null,
  }
  const result = await h.store.appendEvent(PROJECT_ID, input)
  return result.thread_root_id
}

function readSlice(
  h: Harness,
  relPath: string,
  start: number,
  end: number,
): string {
  const fs = require('node:fs') as typeof import('node:fs')
  const abs = join(h.docsRoot, relPath)
  const content = fs.readFileSync(abs, 'utf8')
  return content.slice(start, end)
}

describe('relocateAnchor — pure-function edge cases', () => {
  it('returns dead when both excerpt + body are empty', () => {
    const result = relocateAnchor({
      excerpt: '',
      ctx_before: '',
      ctx_after: '',
      previous_start: 0,
      new_body: '',
    })
    expect(result.kind).toBe('anchor_dead')
  })

  it('exact-match fast path returns lev_distance 0', () => {
    const body = 'hello [world] foo'
    const result = relocateAnchor({
      excerpt: 'world',
      ctx_before: 'hello [',
      ctx_after: '] foo',
      previous_start: 7,
      new_body: body,
    })
    expect(result.kind).toBe('anchor_relocated')
    expect(result.metadata['lev_distance']).toBe(0)
    expect(result.metadata['to_start']).toBe(7)
  })

  it('single-excerpt-match relocates exactly', () => {
    const result = relocateAnchor({
      excerpt: 'unique-token-xyz',
      ctx_before: 'PREFIX1',
      ctx_after: 'PREFIX2',
      previous_start: 100,
      new_body: 'wholly different content with unique-token-xyz embedded',
    })
    expect(result.kind).toBe('anchor_relocated')
    expect(result.metadata['lev_distance']).toBe(0)
  })

  it('multi-match excerpt picks closest to previous_start', () => {
    const body = 'aaa target bbb target ccc target ddd'
    // 'target' lives at offsets 4, 15, 26. previous_start=18 is
    // closer to 15 than to 26, so the relocated position should be
    // 15 (not 26 or 4).
    const result = relocateAnchor({
      excerpt: 'target',
      ctx_before: 'NONE',
      ctx_after: 'NONE',
      previous_start: 18,
      new_body: body,
    })
    expect(result.kind).toBe('anchor_relocated')
    expect(result.metadata['to_start']).toBe(15)
  })

  it('fuzzy match (drifted) when excerpt is single-char-mutated and unique', () => {
    // Step 1 fails (anchored string contains the mutated excerpt with
    // a typo that the strict indexOf can't find). Step 2 fails
    // because allIndicesOf doesn't find the exact excerpt. Step 3
    // fuzzy match nearby succeeds within tolerance — kind=drifted.
    const excerpt = 'highlighted phrase that should be found by fuzzy'
    const ctxBefore = 'leading context paragraph text before'
    const ctxAfter = ' AND trailing context paragraph text after'
    const newBody = 'lorem ipsum dolor '.repeat(5) +
      ctxBefore +
      'highlighted phrase that should be found by fuzzz' + // 1-char drift
      ctxAfter
    const previous_start = newBody.indexOf(ctxBefore) + ctxBefore.length
    const result = relocateAnchor({
      excerpt,
      ctx_before: ctxBefore,
      ctx_after: ctxAfter,
      previous_start,
      new_body: newBody,
    })
    expect(result.kind === 'anchor_relocated' || result.kind === 'anchor_drifted').toBe(true)
  })

  it('returns dead when excerpt vanishes entirely', () => {
    const result = relocateAnchor({
      excerpt: 'this exact unique sentence will be gone',
      ctx_before: 'NOPE',
      ctx_after: 'NOPE',
      previous_start: 100,
      new_body: 'all unrelated text without any overlap whatsoever',
    })
    expect(result.kind).toBe('anchor_dead')
  })

  it('exports RELOCATE_TOLERANCE as 0.25 per brief § 4.3', () => {
    expect(RELOCATE_TOLERANCE).toBe(0.25)
  })
})

describe('anchor walker — § 10.2 row 1: insert before anchor', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('emits anchor_relocated with the anchor shifted by N', async () => {
    const original = 'header line\nthe quick brown fox jumps\nfooter'
    buildDoc(h, 'doc.md', original)
    const start = original.indexOf('quick brown')
    const end = start + 'quick brown'.length
    const ctxBefore = original.slice(Math.max(0, start - 8), start)
    const ctxAfter = original.slice(end, end + 8)
    const rootId = await postRoot(
      h,
      'doc.md',
      'is this the right phrase?',
      { start, end },
      { before: ctxBefore, after: ctxAfter },
    )

    // Insert a new paragraph BEFORE the anchor.
    const inserted = 'PREAMBLE\n\n' + original
    writeFileSync(join(h.docsRoot, 'doc.md'), inserted, 'utf8')
    const counts = await h.walker.reanchorAfterEdit(
      PROJECT_ID,
      'doc.md',
      inserted,
      2_000_000,
    )
    expect(counts.relocated).toBe(1)
    const after = await h.store.listThreads(PROJECT_ID, { doc_path: 'doc.md' })
    expect(after.threads.length).toBe(1)
    const t = after.threads[0]!
    expect(t.thread_root_id).toBe(rootId)
    expect(t.anchor.status).toBe('live')
    expect(t.anchor.current_start).toBe(start + 'PREAMBLE\n\n'.length)
  })
})

describe('anchor walker — § 10.2 row 2: insert after anchor', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('keeps the anchor at the same start', async () => {
    const original = 'top text\nKEEPER PHRASE\nmore text'
    buildDoc(h, 'doc.md', original)
    const start = original.indexOf('KEEPER PHRASE')
    const end = start + 'KEEPER PHRASE'.length
    await postRoot(
      h,
      'doc.md',
      'comment',
      { start, end },
      { before: '\n', after: '\n' },
    )
    const inserted = original + '\n\nADDED PARAGRAPH AT END\n'
    writeFileSync(join(h.docsRoot, 'doc.md'), inserted, 'utf8')
    await h.walker.reanchorAfterEdit(PROJECT_ID, 'doc.md', inserted, 2_000_000)
    const after = await h.store.listThreads(PROJECT_ID, { doc_path: 'doc.md' })
    expect(after.threads.length).toBe(1)
    expect(after.threads[0]!.anchor.status).toBe('live')
    expect(after.threads[0]!.anchor.current_start).toBe(start)
  })
})

describe('anchor walker — § 10.2 row 4: delete the anchored excerpt', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('emits anchor_dead and materialises status=dead', async () => {
    const original = 'before\nUNIQUE-EXCERPT-XYZ\nafter'
    buildDoc(h, 'doc.md', original)
    const start = original.indexOf('UNIQUE-EXCERPT-XYZ')
    const end = start + 'UNIQUE-EXCERPT-XYZ'.length
    await postRoot(
      h,
      'doc.md',
      'comment',
      { start, end },
      { before: 'before\n', after: '\nafter' },
    )
    // Remove the excerpt + reword surrounding lines so the fuzzy
    // matcher can't recover it.
    const after = 'before\nTOTALLY-REPLACED-LINE\nafter'
    writeFileSync(join(h.docsRoot, 'doc.md'), after, 'utf8')
    const counts = await h.walker.reanchorAfterEdit(
      PROJECT_ID,
      'doc.md',
      after,
      2_000_000,
    )
    expect(counts.dead).toBe(1)
    const result = await h.store.listThreads(PROJECT_ID, {
      doc_path: 'doc.md',
      include_dead: true,
    })
    expect(result.threads.length).toBe(1)
    expect(result.threads[0]!.anchor.status).toBe('dead')
    expect(result.threads[0]!.anchor.current_start).toBeNull()
  })
})

describe('anchor walker — § 10.2 row 5: cut + paste (single excerpt match wins)', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('relocates to the new location', async () => {
    const original = 'section A\n[CUTME-UNIQ-MARKER]\nsection B\nsection C'
    buildDoc(h, 'doc.md', original)
    const start = original.indexOf('[CUTME-UNIQ-MARKER]')
    const end = start + '[CUTME-UNIQ-MARKER]'.length
    await postRoot(
      h,
      'doc.md',
      'comment',
      { start, end },
      { before: 'section A\n', after: '\nsection B' },
    )
    // Move the excerpt to the bottom of the doc.
    const after = 'section A\nsection B\nsection C\n[CUTME-UNIQ-MARKER]'
    writeFileSync(join(h.docsRoot, 'doc.md'), after, 'utf8')
    await h.walker.reanchorAfterEdit(PROJECT_ID, 'doc.md', after, 2_000_000)
    const result = await h.store.listThreads(PROJECT_ID, { doc_path: 'doc.md' })
    expect(result.threads.length).toBe(1)
    expect(result.threads[0]!.anchor.status).toBe('live')
    expect(result.threads[0]!.anchor.current_start).toBe(after.indexOf('[CUTME-UNIQ-MARKER]'))
  })
})

describe('anchor walker — § 10.2 row 6: wholesale rewrite within tolerance', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('emits anchor_drifted with a hint when fuzzy match found', async () => {
    const excerpt = 'the comment thread is anchored to this exact phrase here'
    const ctxBefore = 'leading paragraph text '
    const ctxAfter = ' trailing paragraph text'
    const original = ctxBefore + excerpt + ctxAfter
    buildDoc(h, 'doc.md', original)
    const start = ctxBefore.length
    const end = start + excerpt.length
    await postRoot(
      h,
      'doc.md',
      'comment',
      { start, end },
      { before: ctxBefore, after: ctxAfter },
    )
    // Rewrite with small edits — keep most chars but mutate a few.
    const rewritten = 'leading paragraph text the comment thread is anchored to this exact phraze hear trailing paragraph text'
    writeFileSync(join(h.docsRoot, 'doc.md'), rewritten, 'utf8')
    await h.walker.reanchorAfterEdit(PROJECT_ID, 'doc.md', rewritten, 2_000_000)
    const result = await h.store.listThreads(PROJECT_ID, { doc_path: 'doc.md' })
    expect(result.threads.length).toBe(1)
    expect(result.threads[0]!.anchor.status).toBe('drifted')
    expect(result.threads[0]!.anchor.drift_hint_start).not.toBeNull()
  })
})

describe('anchor walker — § 10.2 row 7: two edits, latest mtime wins', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('materialiser ignores the older walker event', async () => {
    const original = 'hello\nMARKER-FOR-RACE-TEST\nworld'
    buildDoc(h, 'doc.md', original)
    const start = original.indexOf('MARKER-FOR-RACE-TEST')
    const end = start + 'MARKER-FOR-RACE-TEST'.length
    await postRoot(
      h,
      'doc.md',
      'comment',
      { start, end },
      { before: 'hello\n', after: '\nworld' },
    )
    // Walker A (slow, older mtime=1000) runs against a body where
    // the excerpt is gone — emits anchor_dead.
    const bodyA = 'hello\nGONE-MARKER\nworld'
    writeFileSync(join(h.docsRoot, 'doc.md'), bodyA, 'utf8')
    await h.walker.reanchorAfterEdit(PROJECT_ID, 'doc.md', bodyA, 1000)
    // Walker B (fast, newer mtime=2000) runs against a body where
    // the excerpt is RESTORED. Emits anchor_relocated. The slow
    // walker's earlier dead event must be suppressed by the
    // materialiser because its based_on_modified_at (1000) is older
    // than walker B's (2000).
    const bodyB = 'hello\nMARKER-FOR-RACE-TEST\nworld'
    writeFileSync(join(h.docsRoot, 'doc.md'), bodyB, 'utf8')
    await h.walker.reanchorAfterEdit(PROJECT_ID, 'doc.md', bodyB, 2000)
    const result = await h.store.listThreads(PROJECT_ID, {
      doc_path: 'doc.md',
      include_dead: true,
    })
    expect(result.threads.length).toBe(1)
    expect(result.threads[0]!.anchor.status).toBe('live')
  })

  it('materialiser keeps the older event if a newer one is the same kind for the same thread', async () => {
    const original = 'hello\nMARKER\nworld'
    buildDoc(h, 'doc.md', original)
    const start = original.indexOf('MARKER')
    const end = start + 'MARKER'.length
    await postRoot(
      h,
      'doc.md',
      'comment',
      { start, end },
      { before: 'hello\n', after: '\nworld' },
    )
    // Two walker runs with the SAME content — both emit relocated.
    const same = original
    await h.walker.reanchorAfterEdit(PROJECT_ID, 'doc.md', same, 1000)
    await h.walker.reanchorAfterEdit(PROJECT_ID, 'doc.md', same, 2000)
    const result = await h.store.listThreads(PROJECT_ID, { doc_path: 'doc.md' })
    expect(result.threads.length).toBe(1)
    expect(result.threads[0]!.anchor.status).toBe('live')
  })
})

describe('anchor walker — § 10.2 row 8: doc deleted entirely', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('emits anchor_dead for every anchor on the path', async () => {
    const original = 'A\nMARK1\nB\nMARK2\nC'
    buildDoc(h, 'doc.md', original)
    const s1 = original.indexOf('MARK1')
    await postRoot(
      h,
      'doc.md',
      'first comment',
      { start: s1, end: s1 + 5 },
      { before: 'A\n', after: '\nB' },
    )
    const s2 = original.indexOf('MARK2')
    await postRoot(
      h,
      'doc.md',
      'second comment',
      { start: s2, end: s2 + 5 },
      { before: 'B\n', after: '\nC' },
    )
    // Simulate DocStore.deleteDoc → walker.handle({op: 'delete'}).
    unlinkSync(join(h.docsRoot, 'doc.md'))
    await h.walker.handle({
      op: 'delete',
      project_id: PROJECT_ID,
      path: 'doc.md',
      new_modified_at: null,
    })
    const result = await h.store.listThreads(PROJECT_ID, {
      doc_path: 'doc.md',
      include_dead: true,
    })
    expect(result.threads.length).toBe(2)
    expect(result.threads.every((t) => t.anchor.status === 'dead')).toBe(true)
  })
})

describe('anchor walker — § 10.2 row 9: doc moved (renamed)', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('relocates anchors to the new path with to_doc_path metadata', async () => {
    const body = 'top\nFOLLOW-ME\nbottom'
    buildDoc(h, 'from.md', body)
    const start = body.indexOf('FOLLOW-ME')
    const end = start + 'FOLLOW-ME'.length
    const rootId = await postRoot(
      h,
      'from.md',
      'should follow the file across the move',
      { start, end },
      { before: 'top\n', after: '\nbottom' },
    )
    // Simulate DocStore.moveDoc — rename the file + fire the hook.
    renameSync(join(h.docsRoot, 'from.md'), join(h.docsRoot, 'to.md'))
    await h.walker.handle({
      op: 'move',
      project_id: PROJECT_ID,
      path: 'to.md',
      from_path: 'from.md',
      new_modified_at: 2_000_000,
    })
    // From-path materialised view should be empty.
    const fromResult = await h.store.listThreads(PROJECT_ID, { doc_path: 'from.md' })
    expect(fromResult.threads.length).toBe(0)
    // To-path materialised view should carry the thread.
    const toResult = await h.store.listThreads(PROJECT_ID, { doc_path: 'to.md' })
    expect(toResult.threads.length).toBe(1)
    expect(toResult.threads[0]!.thread_root_id).toBe(rootId)
    expect(toResult.threads[0]!.anchor.status).toBe('live')
    expect(toResult.threads[0]!.anchor.current_start).toBe(start)
  })
})

describe('anchor walker — handleMove per-anchor revalidation (ISSUE #20)', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('(1) live anchor + pure rename relocates as live on to_path', async () => {
    // Sanity: confirms the existing pure-rename path still produces a
    // LIVE anchor on to_path through the new per-anchor revalidation.
    const body = 'top\nFOLLOW-LIVE\nbottom'
    buildDoc(h, 'from.md', body)
    const start = body.indexOf('FOLLOW-LIVE')
    const end = start + 'FOLLOW-LIVE'.length
    const rootId = await postRoot(
      h,
      'from.md',
      'live anchor',
      { start, end },
      { before: 'top\n', after: '\nbottom' },
    )
    renameSync(join(h.docsRoot, 'from.md'), join(h.docsRoot, 'to.md'))
    await h.walker.handle({
      op: 'move',
      project_id: PROJECT_ID,
      path: 'to.md',
      from_path: 'from.md',
      new_modified_at: 2_000_000,
    })
    const fromResult = await h.store.listThreads(PROJECT_ID, { doc_path: 'from.md' })
    expect(fromResult.threads.length).toBe(0)
    const toResult = await h.store.listThreads(PROJECT_ID, { doc_path: 'to.md' })
    expect(toResult.threads.length).toBe(1)
    expect(toResult.threads[0]!.thread_root_id).toBe(rootId)
    expect(toResult.threads[0]!.anchor.status).toBe('live')
    expect(toResult.threads[0]!.anchor.current_start).toBe(start)
  })

  it('(2) drifted anchor + pure rename carries over drifted on to_path', async () => {
    // Setup: post the comment against the original body, then write a
    // mutated body in place so the walker flips the anchor to drifted.
    // Then rename — handleMove must re-run the matcher against the
    // body at to_path; the fuzzy match still finds the drift hint, so
    // the anchor carries over as DRIFTED on to_path (NOT live).
    const excerpt = 'the comment thread is anchored to this exact phrase here'
    const ctxBefore = 'leading paragraph text '
    const ctxAfter = ' trailing paragraph text'
    const original = ctxBefore + excerpt + ctxAfter
    buildDoc(h, 'from.md', original)
    const start = ctxBefore.length
    const end = start + excerpt.length
    const rootId = await postRoot(
      h,
      'from.md',
      'drifted anchor',
      { start, end },
      { before: ctxBefore, after: ctxAfter },
    )
    // Drift the anchor in place by writing a slightly mutated body.
    const drifted =
      ctxBefore +
      'the comment thread is anchored to this exact phraze hear' +
      ctxAfter
    writeFileSync(join(h.docsRoot, 'from.md'), drifted, 'utf8')
    await h.walker.handle({
      op: 'write',
      project_id: PROJECT_ID,
      path: 'from.md',
      new_modified_at: 1_500_000,
    })
    // Sanity — anchor is now drifted on from.md before the rename.
    const pre = await h.store.listThreads(PROJECT_ID, { doc_path: 'from.md' })
    expect(pre.threads.length).toBe(1)
    expect(pre.threads[0]!.anchor.status).toBe('drifted')
    // Pure rename — body bytes identical at the new path.
    renameSync(join(h.docsRoot, 'from.md'), join(h.docsRoot, 'to.md'))
    await h.walker.handle({
      op: 'move',
      project_id: PROJECT_ID,
      path: 'to.md',
      from_path: 'from.md',
      new_modified_at: 2_000_000,
    })
    const fromResult = await h.store.listThreads(PROJECT_ID, { doc_path: 'from.md' })
    expect(fromResult.threads.length).toBe(0)
    const toResult = await h.store.listThreads(PROJECT_ID, { doc_path: 'to.md' })
    expect(toResult.threads.length).toBe(1)
    expect(toResult.threads[0]!.thread_root_id).toBe(rootId)
    // The anchor was drifted; the matcher re-runs against the renamed
    // body and finds the same fuzzy hint, so anchor carries over as
    // drifted on to.md (NOT incorrectly relocated to live).
    expect(toResult.threads[0]!.anchor.status).toBe('drifted')
    expect(toResult.threads[0]!.anchor.drift_hint_start).not.toBeNull()
  })

  it('(3) live anchor + rename with concurrent edit that erases excerpt → anchor_dead_moved on to_path', async () => {
    // Setup: live anchor on `from.md` content "before hello world after".
    // Move the file to `to.md` BUT race a concurrent edit so the
    // body at to_path is entirely unrelated content. handleMove re-
    // runs the matcher against the observed to-body and finds no
    // excerpt → emits anchor_dead_moved on to_path.
    const original = 'before hello world after'
    buildDoc(h, 'from.md', original)
    const start = original.indexOf('hello world')
    const end = start + 'hello world'.length
    const rootId = await postRoot(
      h,
      'from.md',
      'live anchor that gets erased mid-move',
      { start, end },
      { before: 'before ', after: ' after' },
    )
    // Sanity — anchor live on from.md.
    const pre = await h.store.listThreads(PROJECT_ID, { doc_path: 'from.md' })
    expect(pre.threads.length).toBe(1)
    expect(pre.threads[0]!.anchor.status).toBe('live')
    // Simulate move + concurrent overwrite: instead of renaming the
    // bytes, write a totally unrelated body at to.md, then drop from.md.
    writeFileSync(
      join(h.docsRoot, 'to.md'),
      'completely unrelated content that shares nothing',
      'utf8',
    )
    unlinkSync(join(h.docsRoot, 'from.md'))
    await h.walker.handle({
      op: 'move',
      project_id: PROJECT_ID,
      path: 'to.md',
      from_path: 'from.md',
      new_modified_at: 2_000_000,
    })
    const fromResult = await h.store.listThreads(PROJECT_ID, {
      doc_path: 'from.md',
      include_dead: true,
    })
    expect(fromResult.threads.length).toBe(0)
    const toResult = await h.store.listThreads(PROJECT_ID, {
      doc_path: 'to.md',
      include_dead: true,
    })
    expect(toResult.threads.length).toBe(1)
    expect(toResult.threads[0]!.thread_root_id).toBe(rootId)
    expect(toResult.threads[0]!.anchor.status).toBe('dead')
    expect(toResult.threads[0]!.anchor.current_start).toBeNull()
  })

  it('(4) previously-dead anchor + rename carries over as dead on to_path', async () => {
    // Setup: kill the anchor on from.md (delete the excerpt), then rename.
    // Without the include_dead=true fix, the anchor would orphan on
    // from.md; with it, the dead anchor flows over to to.md as
    // anchor_dead_moved.
    const original = 'before UNIQUE-EXCERPT-ZZZ after'
    buildDoc(h, 'from.md', original)
    const start = original.indexOf('UNIQUE-EXCERPT-ZZZ')
    const end = start + 'UNIQUE-EXCERPT-ZZZ'.length
    const rootId = await postRoot(
      h,
      'from.md',
      'will become dead',
      { start, end },
      { before: 'before ', after: ' after' },
    )
    // Erase the excerpt in place on from.md so the walker marks the
    // anchor dead.
    const erased = 'before TOTALLY-DIFFERENT-LINE after'
    writeFileSync(join(h.docsRoot, 'from.md'), erased, 'utf8')
    await h.walker.handle({
      op: 'write',
      project_id: PROJECT_ID,
      path: 'from.md',
      new_modified_at: 1_500_000,
    })
    const pre = await h.store.listThreads(PROJECT_ID, {
      doc_path: 'from.md',
      include_dead: true,
    })
    expect(pre.threads.length).toBe(1)
    expect(pre.threads[0]!.anchor.status).toBe('dead')
    // Rename from.md → to.md.
    renameSync(join(h.docsRoot, 'from.md'), join(h.docsRoot, 'to.md'))
    await h.walker.handle({
      op: 'move',
      project_id: PROJECT_ID,
      path: 'to.md',
      from_path: 'from.md',
      new_modified_at: 2_000_000,
    })
    // No orphan on from.md.
    const fromResult = await h.store.listThreads(PROJECT_ID, {
      doc_path: 'from.md',
      include_dead: true,
    })
    expect(fromResult.threads.length).toBe(0)
    // Dead row carried over to to.md.
    const toResult = await h.store.listThreads(PROJECT_ID, {
      doc_path: 'to.md',
      include_dead: true,
    })
    expect(toResult.threads.length).toBe(1)
    expect(toResult.threads[0]!.thread_root_id).toBe(rootId)
    expect(toResult.threads[0]!.anchor.status).toBe('dead')
  })
})

describe('anchor walker — handle() best-effort error handling', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('does not throw when the project_id is invalid', async () => {
    await expect(
      h.walker.handle({
        op: 'write',
        project_id: '../../etc/passwd',
        path: 'doc.md',
        new_modified_at: 1000,
      }),
    ).resolves.toBeUndefined()
  })

  it('does not throw when the doc body is missing mid-flight', async () => {
    // Anchor exists in the store, but the file is gone — walker
    // falls through to anchor_dead and resolves successfully.
    const body = 'GHOST'
    buildDoc(h, 'g.md', body)
    await postRoot(
      h,
      'g.md',
      'c',
      { start: 0, end: 5 },
      { before: '', after: '' },
    )
    unlinkSync(join(h.docsRoot, 'g.md'))
    await h.walker.handle({
      op: 'write',
      project_id: PROJECT_ID,
      path: 'g.md',
      new_modified_at: 1000,
    })
    const result = await h.store.listThreads(PROJECT_ID, {
      doc_path: 'g.md',
      include_dead: true,
    })
    expect(result.threads.length).toBe(1)
    expect(result.threads[0]!.anchor.status).toBe('dead')
  })

  it('does not throw when there are no anchors on the path', async () => {
    buildDoc(h, 'empty.md', 'nothing to do')
    await expect(
      h.walker.handle({
        op: 'write',
        project_id: PROJECT_ID,
        path: 'empty.md',
        new_modified_at: 1000,
      }),
    ).resolves.toBeUndefined()
  })
})

describe('anchor walker — DocStore wiring smoke test', () => {
  it('writeDoc fires the hook with op=write', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'neutron-walker-wire-'))
    const owner_home = join(tmp, 'home')
    const docsRoot = join(owner_home, 'Projects', PROJECT_ID, 'docs')
    mkdirSync(docsRoot, { recursive: true })
    const seen: Array<{ op: string; path: string; from_path?: string; mtime: number | null }> = []
    const { DocStore } = await import('../../http/doc-store.ts')
    const store = new DocStore({
      owner_home,
      onMutationSuccess: async (input) => {
        seen.push({
          op: input.op,
          path: input.path,
          ...(input.from_path !== undefined ? { from_path: input.from_path } : {}),
          mtime: input.new_modified_at,
        })
      },
    })
    await store.writeDoc({ project_id: PROJECT_ID, path: 'a.md', content: 'hello' })
    expect(seen.length).toBe(1)
    expect(seen[0]!.op).toBe('write')
    expect(seen[0]!.path).toBe('a.md')
    expect(seen[0]!.mtime).not.toBeNull()
    await store.moveDoc(PROJECT_ID, 'a.md', 'b.md')
    expect(seen.length).toBe(2)
    expect(seen[1]!.op).toBe('move')
    expect(seen[1]!.path).toBe('b.md')
    expect(seen[1]!.from_path).toBe('a.md')
    await store.deleteDoc(PROJECT_ID, 'b.md')
    expect(seen.length).toBe(3)
    expect(seen[2]!.op).toBe('delete')
    expect(seen[2]!.path).toBe('b.md')
    // Argus r1 IMPORTANT #2 — DocStore.deleteDoc now passes Date.now()
    // for new_modified_at (the deleter's "effective mtime") instead of
    // null so the materialiser's stale-event filter can suppress a
    // slow deleter that races a fresher writer.
    expect(seen[2]!.mtime).not.toBeNull()
    expect(Number.isFinite(seen[2]!.mtime as number)).toBe(true)
    rmSync(tmp, { recursive: true, force: true })
  })

  it('swallows walker errors without rolling back the write', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'neutron-walker-wire-err-'))
    const owner_home = join(tmp, 'home')
    const docsRoot = join(owner_home, 'Projects', PROJECT_ID, 'docs')
    mkdirSync(docsRoot, { recursive: true })
    const { DocStore } = await import('../../http/doc-store.ts')
    const store = new DocStore({
      owner_home,
      onMutationSuccess: async () => {
        throw new Error('walker exploded')
      },
    })
    // Should not throw despite the hook error.
    const result = await store.writeDoc({
      project_id: PROJECT_ID,
      path: 'a.md',
      content: 'survived',
    })
    expect(result.path).toBe('a.md')
    // File DID land on disk.
    const fs = require('node:fs') as typeof import('node:fs')
    expect(fs.readFileSync(join(docsRoot, 'a.md'), 'utf8')).toBe('survived')
    rmSync(tmp, { recursive: true, force: true })
  })
})

describe('Argus r1 IMPORTANT #2 — delete event stamped with finite mtime, suppressed by newer writer', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('handleDelete stamps a finite based_on_modified_at on the appended anchor_dead event', async () => {
    // Confirms the actual on-the-wire stamp the materialiser folds.
    // Before the fix, this column was null; the materialiser bypass
    // ("null → always keep") meant a stale deleter could clobber a
    // fresher write. After the fix, the column is finite and the
    // materialiser's stale-event filter participates as designed.
    const body = 'pre\nMARK\npost'
    buildDoc(h, 'd.md', body)
    await postRoot(
      h,
      'd.md',
      'comment',
      { start: body.indexOf('MARK'), end: body.indexOf('MARK') + 4 },
      { before: 'pre\n', after: '\npost' },
    )
    // Drive the walker through the same code path DocStore takes on
    // delete (via .handle, which routes to handleDelete).
    await h.walker.handle({
      op: 'delete',
      project_id: PROJECT_ID,
      path: 'd.md',
      new_modified_at: 1500,
    })
    // Probe the raw event by reading the per-project sidecar
    // directly. listWalkerAnchors filters out dead by default, so we
    // include them.
    const seenDead = await h.store.listWalkerAnchors(PROJECT_ID, 'd.md', {
      include_dead: true,
    })
    expect(seenDead.length).toBeGreaterThanOrEqual(0)
    // Use getThread to inspect the appended event's based_on_modified_at.
    const fs = require('node:fs') as typeof import('node:fs')
    const dbPath = join(
      h.owner_home,
      'Projects',
      PROJECT_ID,
      '.comments',
      'comments.db',
    )
    expect(fs.existsSync(dbPath)).toBe(true)
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
    const db = new Database(dbPath, { readonly: true })
    type Row = { event_kind: string; based_on_modified_at: number | null }
    const rows = db
      .prepare<Row, []>(
        `SELECT event_kind, based_on_modified_at
           FROM doc_comment_events
          WHERE event_kind = 'anchor_dead'`,
      )
      .all()
    db.close()
    expect(rows.length).toBe(1)
    expect(rows[0]!.based_on_modified_at).toBe(1500)
  })

  it('a slow delete walker does not clobber a faster writer when the writer fired later in wall time', async () => {
    // Race shape: writer's walker emits anchor_relocated at mtime=2000.
    // Deleter's walker (slower, kicked off earlier in wall time) emits
    // anchor_dead at mtime=1000. With the finite stamp + stale filter
    // the materialiser drops the deleter; the anchor stays live.
    const body = 'pre\nMARK\npost'
    buildDoc(h, 'r.md', body)
    await postRoot(
      h,
      'r.md',
      'comment',
      { start: body.indexOf('MARK'), end: body.indexOf('MARK') + 4 },
      { before: 'pre\n', after: '\npost' },
    )
    // Writer walker — newer mtime=2000, on a body that still contains MARK.
    await h.walker.reanchorAfterEdit(PROJECT_ID, 'r.md', body, 2000)
    // Deleter walker — older mtime=1000, after the writer landed its
    // events. The deleter's event has a LATER created_at than the
    // writer's, exercising the harder reorder case (created_at
    // ordering alone would lose the writer; the stale filter saves it).
    await h.walker.handle({
      op: 'delete',
      project_id: PROJECT_ID,
      path: 'r.md',
      new_modified_at: 1000,
    })
    const result = await h.store.listThreads(PROJECT_ID, {
      doc_path: 'r.md',
      include_dead: true,
    })
    expect(result.threads.length).toBe(1)
    expect(result.threads[0]!.anchor.status).toBe('live')
  })
})

describe('Argus r2 IMPORTANT — concurrent write+delete on same path keeps anchor live', () => {
  it('a writer recreating the doc during the deleter\'s post-unlink awaits keeps the anchor live', async () => {
    // Production race shape (DocStore has no per-path mutex):
    //
    //   T0: deleteDoc(r.md) starts, awaits ensureVersioningInit
    //   T1: writeDoc(r.md) starts, awaits ensureVersioningInit
    //   T2: deleter unlink() returns
    //   T3: deleter samples delete_time (Argus r2 fix — was sampled at hook
    //       site, which is AFTER the slow recordCommit() + dropMarkdownLinks())
    //   T4: deleter awaits recordCommit() — slow on a real git repo
    //   T5: writer rename() lands, writer fstat captures mtime > delete_time
    //   T6: writer fires hook with stamp=fstat_mtime
    //   T7: deleter recordCommit resolves
    //   T8: deleter fires hook with stamp=delete_time (the value captured at T3)
    //
    // Before the fix, deleter's stamp was sampled at T8 (Date.now() at the
    // hook site), so stamp(deleter)=T8 > stamp(writer)=T5, the materialiser's
    // max-mtime-wins fold dropped the writer's anchor_relocated as stale, and
    // the anchor flipped DEAD despite r.md existing on disk.
    //
    // After the fix, stamp(deleter)=T3 < stamp(writer)=T5, the writer's event
    // wins, and the anchor stays live.
    //
    // The slow versionStore stub deterministically opens the L613-L645 window
    // wide enough for the concurrent writer to land its rename + fstat inside
    // it. Without the slow stub, recordCommit short-circuits to a no-op and
    // the window is sub-millisecond — too tight to be a stable regression
    // guard.
    const tmp = mkdtempSync(join(tmpdir(), 'neutron-walker-race-'))
    const owner_home = join(tmp, 'home')
    const docsRoot = join(owner_home, 'Projects', PROJECT_ID, 'docs')
    mkdirSync(docsRoot, { recursive: true })

    const events = { ts: 1_700_000_000_000 }
    let ulidSeq = 0
    const padUlid = (n: number): string => {
      const s = n.toString(36).padStart(10, '0').toUpperCase().replace(/[ILOU]/g, '0')
      return '01HW' + s.padEnd(22, '0')
    }
    const commentStore = new CommentStore({
      owner_home,
      ulid: () => {
        ulidSeq += 1
        return padUlid(ulidSeq)
      },
      now: () => {
        events.ts += 1
        return events.ts
      },
    })
    const walker = new AnchorWalker({ commentStore, owner_home })

    // Slow VersionStore stub: every commit() resolves after 50ms. This
    // widens the L613-L645 window inside DocStore.deleteDoc enough for the
    // concurrent writer to interleave deterministically.
    const slowVersionStore = {
      isGitAvailable: async () => true,
      ensureInit: async () => true,
      commit: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 50))
      },
    } as unknown as import('../../git/doc-version-store.ts').DocVersionStore

    const seenHooks: Array<{ op: string; stamp: number | null }> = []
    const { DocStore } = await import('../../http/doc-store.ts')
    const docStore = new DocStore({
      owner_home,
      versionStore: slowVersionStore,
      onMutationSuccess: async (input) => {
        seenHooks.push({ op: input.op, stamp: input.new_modified_at })
        await walker.handle({
          op: input.op,
          project_id: input.project_id,
          path: input.path,
          ...(input.from_path !== undefined ? { from_path: input.from_path } : {}),
          new_modified_at: input.new_modified_at,
        })
      },
    })

    // Stage 1: write the doc + post a comment with an anchor on MARK.
    const body = 'pre\nMARK\npost'
    await docStore.writeDoc({ project_id: PROJECT_ID, path: 'r.md', content: body })
    await postRoot(
      { store: commentStore, docsRoot } as unknown as Harness,
      'r.md',
      'comment',
      { start: body.indexOf('MARK'), end: body.indexOf('MARK') + 4 },
      { before: 'pre\n', after: '\npost' },
    )

    // Sanity: anchor is live before the race.
    const pre = await commentStore.listThreads(PROJECT_ID, {
      doc_path: 'r.md',
      include_dead: true,
    })
    expect(pre.threads.length).toBe(1)
    expect(pre.threads[0]!.anchor.status).toBe('live')

    // Reset the hook-capture log so we only see the racing pair.
    seenHooks.length = 0

    // Stage 2: race. Note no `expected_modified_at` on the writer — this
    // is the "recreate after delete" shape (or, equivalently, a new write
    // arriving from a different tab that doesn't know about the in-flight
    // delete). With OCC set the writer would 409 cleanly, so the race only
    // matters for the no-OCC case.
    const deleterP = docStore.deleteDoc(PROJECT_ID, 'r.md')
    const writerP = docStore.writeDoc({
      project_id: PROJECT_ID,
      path: 'r.md',
      content: body,
    })
    await Promise.allSettled([deleterP, writerP])

    // The two ops MAY race in either order; one may reject (writer's fstat
    // ENOENTs if the deleter unlinks between the writer's rename and stat,
    // for instance). The regression invariant we guard is:
    //
    //   "if the file exists at the end of the race, the anchor stays live"
    //
    // — i.e. the writer's anchor_relocated must not be silently dropped by
    // the materialiser's stale-event filter just because the deleter
    // happened to fire its hook later in wall-clock time.
    const fs = require('node:fs') as typeof import('node:fs')
    const fileExists = fs.existsSync(join(docsRoot, 'r.md'))

    const result = await commentStore.listThreads(PROJECT_ID, {
      doc_path: 'r.md',
      include_dead: true,
    })
    expect(result.threads.length).toBe(1)
    if (fileExists) {
      // Writer landed last → anchor must be live (the regression: pre-fix
      // it could flip dead even though the file exists).
      expect(result.threads[0]!.anchor.status).toBe('live')
      // Structural assertion: deleter's stamp was sampled at unlink time,
      // not at hook-call time, so it must be ≤ the writer's fstat-mtime.
      const deleterStamp = seenHooks.find((h) => h.op === 'delete')?.stamp ?? null
      const writerStamp = seenHooks.find((h) => h.op === 'write')?.stamp ?? null
      if (deleterStamp !== null && writerStamp !== null) {
        expect(deleterStamp).toBeLessThanOrEqual(writerStamp)
      }
    } else {
      // Deleter landed last — the anchor correctly resolves to dead.
      expect(result.threads[0]!.anchor.status).toBe('dead')
    }

    commentStore.closeAll()
    rmSync(tmp, { recursive: true, force: true })
  })
})

describe('Argus r1 IMPORTANT #3 — large-doc safety: step 4 global widen does not hang', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('reanchorAfterEdit completes promptly on a 5 MB body whose anchor fell outside the local radius', async () => {
    // The pre-fix code path walked every (winLen, start) pair across
    // the full body with stride=1, which on a 5 MB doc took
    // multi-second to multi-minute depending on cap and needle size.
    // The walker hook is awaited inside DocStore.writeDoc, so any
    // unbounded step-4 sweep stalls the HTTP response. After the fix:
    //
    //   - Bodies > GLOBAL_WIDEN_MAX_BODY_BYTES (256 KB) skip step 4
    //     entirely and fall through to anchor_dead. The matcher is
    //     best-effort by design; a body that large with the anchor
    //     content gone produces "dead" (which the in-app side pane
    //     surfaces as "this thread's anchor was lost") within
    //     milliseconds instead of hanging the request.
    //   - Bodies <= the cap pass a stride scaled to needle length so
    //     the scanner samples positions instead of sliding by 1.
    //
    // We use a typical user-comment excerpt (~80 chars + 32 chars
    // context each side, total anchored ~144 chars) so step 3's local
    // radius (~2000 chars) is sub-millisecond. The 5 MB body is
    // unrelated content so steps 1, 2, and 3 all miss; pre-fix step 4
    // would then scan all 5 MB at stride=1. The test asserts the
    // total call returns within 2 seconds.
    const needle = 'this is a representative excerpt the user highlighted in their doc earlier'
    const ctxBefore = 'leading context paragraph text   '
    const ctxAfter = '   trailing context paragraph text'
    const originalBody = ctxBefore + needle + ctxAfter
    buildDoc(h, 'big.md', originalBody)
    const start = ctxBefore.length
    const end = start + needle.length
    await postRoot(
      h,
      'big.md',
      'comment',
      { start, end },
      { before: ctxBefore, after: ctxAfter },
    )
    // Build a 5 MB body where the anchor's excerpt is GONE — every
    // (winLen, start) pair in the pre-fix step-4 sweep would run
    // banded Levenshtein to its cap on dissimilar slices.
    const fivemb = 5 * 1024 * 1024
    const newBody = 'Z'.repeat(fivemb - 1)
    writeFileSync(join(h.docsRoot, 'big.md'), newBody, 'utf8')
    const t0 = performance.now()
    const counts = await h.walker.reanchorAfterEdit(
      PROJECT_ID,
      'big.md',
      newBody,
      2_000_000,
    )
    const elapsed = performance.now() - t0
    // The body is well past the 256 KB step-4 ceiling, so the matcher
    // falls through to step 5 (dead). The wall-clock budget is
    // intentionally generous (5 s) so a slow / contended CI runner
    // doesn't flake; the pre-fix shape is tens of seconds at minimum.
    // Bumped 2026-05-22 from 2 s after observing 2.9 s wall-clock under
    // concurrent test pressure — the regression-prevention contract is
    // "doesn't hang for many seconds", not "completes within 2 s on
    // every box".
    expect(elapsed).toBeLessThan(5000)
    expect(counts.dead).toBe(1)
    expect(counts.relocated).toBe(0)
    expect(counts.drifted).toBe(0)
  }, 10_000)

  it('step 4 still finds drifted anchors on bodies within the global-widen cap', async () => {
    // Sanity: the stride+cap optimisation must not regress recall on
    // bodies that fit under the 256 KB ceiling. The anchor's excerpt
    // is buried at the END of the body, well outside the local
    // radius (max(2000, anchored.length × 4) ≈ 480), so only step 4
    // can find it.
    const ctxBefore = 'leading paragraph text '
    const ctxAfter = ' trailing paragraph text'
    // ~100 chars
    const excerpt = 'the comment anchor is here at the head of the doc'
    const originalBody = ctxBefore + excerpt + ctxAfter
    buildDoc(h, 'mid.md', originalBody)
    const start = ctxBefore.length
    const end = start + excerpt.length
    await postRoot(
      h,
      'mid.md',
      'comment',
      { start, end },
      { before: ctxBefore, after: ctxAfter },
    )
    // 16 KB of filler, then the excerpt with a one-char mutation, then
    // 16 KB more filler. Well past the local radius but well under
    // the step-4 cap.
    const pad = 'filler '.repeat(2200) // ~15 KB
    const mutated = excerpt.replace('here', 'heer') // 1 char drift
    const newBody = pad + ctxBefore + mutated + ctxAfter + pad
    writeFileSync(join(h.docsRoot, 'mid.md'), newBody, 'utf8')
    const counts = await h.walker.reanchorAfterEdit(
      PROJECT_ID,
      'mid.md',
      newBody,
      2_000_000,
    )
    // The matcher should land EITHER a relocate (if Step 2's
    // excerpt-exact-match happens to fire on the mutated form) OR
    // drift (step 4 fuzzy). Both are valid; dead is the regression.
    expect(counts.dead).toBe(0)
    expect(counts.relocated + counts.drifted).toBe(1)
  })
})

describe('anchor walker — per-project mutex serialises concurrent walks', () => {
  let h: Harness
  beforeEach(() => {
    h = start()
  })
  afterEach(() => h.cleanup())

  it('two concurrent handle() calls land both events in order', async () => {
    const original = 'PADDING\nTHREAD-MARK\nPADDING'
    buildDoc(h, 'doc.md', original)
    const s = original.indexOf('THREAD-MARK')
    await postRoot(
      h,
      'doc.md',
      'comment',
      { start: s, end: s + 'THREAD-MARK'.length },
      { before: 'PADDING\n', after: '\nPADDING' },
    )
    // Two walker invocations against the same project + path,
    // serialised by the per-project mutex. The second one runs
    // after the first finishes.
    const promiseA = h.walker.handle({
      op: 'write',
      project_id: PROJECT_ID,
      path: 'doc.md',
      new_modified_at: 1000,
    })
    const promiseB = h.walker.handle({
      op: 'write',
      project_id: PROJECT_ID,
      path: 'doc.md',
      new_modified_at: 2000,
    })
    await Promise.all([promiseA, promiseB])
    // Two walker events landed (the newer one wins per the
    // stale-event filter). The materialised view should be live.
    const result = await h.store.listThreads(PROJECT_ID, { doc_path: 'doc.md' })
    expect(result.threads.length).toBe(1)
    expect(result.threads[0]!.anchor.status).toBe('live')
  })
})
