/**
 * @neutronai/notes — chat-command parser + dispatcher tests.
 *
 * Per docs/plans/notes-core-tier1-brief.md § 3.2.
 *
 * Pure parser cases first (every subcommand happy + malformed path),
 * then the dispatcher integration via the in-tree NotesStore.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createInMemoryActiveDrawerStore,
  executeNoteCommand,
  NotesStoreResolver,
  parseNoteCommand,
  type NoteCommand,
} from '../index.ts'

let tmp: string
let resolver: NotesStoreResolver

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'notes-chat-'))
  resolver = new NotesStoreResolver({ owner_home: tmp })
})

afterEach(() => {
  resolver.closeAll()
  rmSync(tmp, { recursive: true, force: true })
})

describe('parseNoteCommand — pure parser', () => {
  const cases: ReadonlyArray<[string, NoteCommand['kind'], (cmd: NoteCommand) => void]> = [
    ['/note', 'help', () => {}],
    ['/note help', 'help', () => {}],
    [
      '/note hello world',
      'capture',
      (cmd) => {
        if (cmd.kind === 'capture') expect(cmd.body).toBe('hello world')
      },
    ],
    [
      '/note find shopify analytics',
      'search',
      (cmd) => {
        if (cmd.kind === 'search') expect(cmd.query).toBe('shopify analytics')
      },
    ],
    [
      '/note drawer ideas',
      'drawer',
      (cmd) => {
        if (cmd.kind === 'drawer') expect(cmd.name).toBe('ideas')
      },
    ],
    [
      '/note tunnel abc xyz',
      'tunnel',
      (cmd) => {
        if (cmd.kind === 'tunnel') {
          expect(cmd.from).toBe('abc')
          expect(cmd.to).toBe('xyz')
        }
      },
    ],
    ['  /note  hello with leading spaces', 'capture', (cmd) => {
      if (cmd.kind === 'capture') expect(cmd.body).toBe('hello with leading spaces')
    }],
    ['hello world (not a /note)', 'unrecognized', () => {}],
    ['/noteFOO (missing space)', 'unrecognized', () => {}],
    ['/note find', 'unrecognized', () => {}],
    ['/note tunnel only-one-arg', 'unrecognized', () => {}],
    ['/note tunnel too many args here', 'unrecognized', () => {}],
    ['/note drawer', 'unrecognized', () => {}],
  ]

  for (const [input, expectedKind, assertion] of cases) {
    test(`parse: ${input}`, () => {
      const cmd = parseNoteCommand(input)
      expect(cmd.kind).toBe(expectedKind)
      assertion(cmd)
    })
  }
})

describe('executeNoteCommand — dispatcher integration', () => {
  test('capture stores a note under the active drawer when set; otherwise inbox', async () => {
    const store = await resolver.resolve('proj1')
    const active = createInMemoryActiveDrawerStore()
    // First capture — no active drawer → falls through to inbox.
    const r1 = await executeNoteCommand(parseNoteCommand('/note first thought'), {
      store,
      project_id: 'proj1',
      user_id: 'u1',
      project_slug: 't1',
      activeDrawerStore: active,
    })
    expect(r1.text).toContain('captured')
    expect(r1.error).toBeUndefined()
    expect(store.listNotes().length).toBe(1)
    expect(store.findDrawerByName('inbox')).not.toBeNull()

    // Switch to a custom drawer.
    const drawerRes = await executeNoteCommand(parseNoteCommand('/note drawer ideas'), {
      store,
      project_id: 'proj1',
      user_id: 'u1',
      project_slug: 't1',
      activeDrawerStore: active,
    })
    expect(drawerRes.text).toContain('Active drawer')

    // Next capture lands in ideas.
    await executeNoteCommand(parseNoteCommand('/note second thought'), {
      store,
      project_id: 'proj1',
      user_id: 'u1',
      project_slug: 't1',
      activeDrawerStore: active,
    })
    const ideas = store.findDrawerByName('ideas')
    expect(ideas?.note_count).toBe(1)
  })

  test('search returns hits when the FTS5 index matches', async () => {
    const store = await resolver.resolve('proj2')
    store.write({ content: 'shopify orders by region 2024' })
    store.write({ content: 'unrelated note about cooking' })
    const cmd = parseNoteCommand('/note find shopify')
    const r = await executeNoteCommand(cmd, {
      store,
      project_id: 'proj2',
      user_id: 'u1',
      project_slug: 't1',
    })
    expect(r.error).toBeUndefined()
    expect(r.text).toContain('shopify')
  })

  test('tunnel between two notes creates a KG edge', async () => {
    const store = await resolver.resolve('proj3')
    const a = store.write({ content: 'A note' })
    const b = store.write({ content: 'B note' })
    const r = await executeNoteCommand(parseNoteCommand(`/note tunnel ${a.id} ${b.id}`), {
      store,
      project_id: 'proj3',
      user_id: 'u1',
      project_slug: 't1',
    })
    expect(r.error).toBeUndefined()
    expect((r.data as { edge_id: string } | undefined)?.edge_id.length ?? 0).toBeGreaterThan(0)
  })

  test('tunnel to unknown note surfaces store_error in the response envelope', async () => {
    const store = await resolver.resolve('proj4')
    const a = store.write({ content: 'A note' })
    const r = await executeNoteCommand(
      parseNoteCommand(`/note tunnel ${a.id} unknown-id`),
      {
        store,
        project_id: 'proj4',
        user_id: 'u1',
        project_slug: 't1',
      },
    )
    expect(r.error).toBeDefined()
    expect(r.error?.code).toBe('unknown_note')
  })

  test('help command returns the cheatsheet', async () => {
    const store = await resolver.resolve('proj5')
    const r = await executeNoteCommand(parseNoteCommand('/note help'), {
      store,
      project_id: 'proj5',
      user_id: 'u1',
      project_slug: 't1',
    })
    expect(r.text).toContain('/note')
    expect(r.error).toBeUndefined()
  })
})
