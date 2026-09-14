import { afterEach, describe, expect, it } from 'bun:test'
import { deleteOwnPoolEntry } from '../boot-adoption.ts'
import { pool } from '../pool-state.ts'
import { ReplSession } from '../repl-session.ts'

const KEY = 'inst adoption pool identity'
const SESSION_ID = '67967967-1111-2222-3333-444444444444'
const CHANNEL = 'neutron-67967967967967967967967967967967'

afterEach(() => pool.delete(KEY))

function session(generation: string): ReplSession {
  return new ReplSession(KEY, generation, SESSION_ID, CHANNEL, '/tmp')
}

describe('boot-adoption cleanup deletes only the entry the session was published under', () => {
  it('deletes its current fulfilled entry', () => {
    const mine = session('mine')
    const ownEntry = Promise.resolve(mine)
    mine.pooledAs = ownEntry
    pool.set(KEY, ownEntry)

    deleteOwnPoolEntry(KEY, mine)

    expect(pool.get(KEY)).toBeUndefined()
  })

  it('keeps a fulfilled replacement', () => {
    const mine = session('mine')
    mine.pooledAs = Promise.resolve(mine)
    const replacement = Promise.resolve(session('replacement'))
    pool.set(KEY, replacement)

    deleteOwnPoolEntry(KEY, mine)

    expect(pool.get(KEY)).toBe(replacement)
  })

  it('deletes its current rejected entry', () => {
    const mine = session('mine')
    const ownEntry = Promise.reject(new Error('spawn failed')) as Promise<ReplSession>
    ownEntry.catch(() => undefined)
    mine.pooledAs = ownEntry
    pool.set(KEY, ownEntry)

    deleteOwnPoolEntry(KEY, mine)

    expect(pool.get(KEY)).toBeUndefined()
  })

  it('keeps a rejected replacement', () => {
    const mine = session('mine')
    mine.pooledAs = Promise.reject(new Error('old spawn failed')) as Promise<ReplSession>
    mine.pooledAs.catch(() => undefined)
    const replacement = Promise.reject(new Error('replacement failed')) as Promise<ReplSession>
    replacement.catch(() => undefined)
    pool.set(KEY, replacement)

    deleteOwnPoolEntry(KEY, mine)

    expect(pool.get(KEY)).toBe(replacement)
  })
})
