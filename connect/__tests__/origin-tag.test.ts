import { describe, expect, test } from 'bun:test'
import {
  getOrigin,
  isTaggedContent,
  stampOriginInstance,
} from '../api/origin-tag.ts'

describe('stampOriginInstance', () => {
  test('returns wire-shape with origin_instance + payload', () => {
    const stamped = stampOriginInstance({ msg: 'hi' }, 'workspace-1')
    expect(stamped).toEqual({ origin_instance: 'workspace-1', payload: { msg: 'hi' } })
  })

  test('rejects malformed slug (defense-in-depth)', () => {
    expect(() => stampOriginInstance({}, 'UPPERCASE')).toThrow()
    expect(() => stampOriginInstance({}, '1abc')).toThrow() // leading digit
    expect(() => stampOriginInstance({}, 'ab')).toThrow() // below 3-char floor
    expect(() => stampOriginInstance({}, 'foo--bar')).toThrow() // double-hyphen
  })

  test('re-stamping replaces the slug (workspace forwards member reply)', () => {
    const inner = stampOriginInstance({ x: 1 }, 'alice')
    const outer = stampOriginInstance(inner, 'workspace-1')
    expect(outer.origin_instance).toBe('workspace-1')
    // Inner stamp is preserved as the payload — receivers wanting full
    // chain provenance can drill down.
    expect((outer.payload as { origin_instance: string }).origin_instance).toBe('alice')
  })

  test('survives JSON.stringify / parse round-trip', () => {
    const stamped = stampOriginInstance({ msg: 'hi' }, 'alice')
    const restored = JSON.parse(JSON.stringify(stamped))
    expect(isTaggedContent(restored)).toBe(true)
    expect(getOrigin(restored)).toBe('alice')
  })
})

describe('isTaggedContent / getOrigin', () => {
  test('rejects raw payloads', () => {
    expect(isTaggedContent({ msg: 'hi' })).toBe(false)
    expect(isTaggedContent('string')).toBe(false)
    expect(isTaggedContent(null)).toBe(false)
    expect(isTaggedContent(undefined)).toBe(false)
    expect(isTaggedContent(42)).toBe(false)
  })

  test('rejects empty origin_instance', () => {
    expect(isTaggedContent({ origin_instance: '', payload: {} })).toBe(false)
  })

  test('accepts well-formed tagged content', () => {
    expect(isTaggedContent({ origin_instance: 'alice', payload: { x: 1 } })).toBe(true)
  })

  test('getOrigin returns null on raw values', () => {
    expect(getOrigin('plain')).toBeNull()
    expect(getOrigin({ msg: 'untagged' })).toBeNull()
  })
})
