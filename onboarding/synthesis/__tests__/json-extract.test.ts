/**
 * Golden test for the tolerant JSON extractor extracted (K3, 2026-07-03)
 * from the deleted `history-import/substrate-callers.ts`. Cases are ported
 * verbatim from the retired `substrate-callers.test.ts` `extractJsonObject`
 * block so the behaviour the LIVE synthesis session depends on stays pinned
 * byte-for-byte, plus the escape-sequence edge the balanced-slice walker
 * guards.
 */
import { describe, expect, test } from 'bun:test'
import { extractJsonObject } from '../json-extract.ts'

describe('extractJsonObject — defensive parsing (K3 golden)', () => {
  test('direct JSON', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 })
  })

  test('markdown ```json fence', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  test('markdown unlabeled ``` fence', () => {
    expect(extractJsonObject('```\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  test('preamble + first-object slice', () => {
    expect(extractJsonObject('Here is the result: {"a":1, "b":[2,3]} done.')).toEqual({
      a: 1,
      b: [2, 3],
    })
  })

  test('preamble + nested object', () => {
    expect(extractJsonObject('Output: {"a":{"x":1}} ok')).toEqual({ a: { x: 1 } })
  })

  test('quoted-brace inside string does not unbalance', () => {
    expect(extractJsonObject('{ "k": "value with } brace" }')).toEqual({
      k: 'value with } brace',
    })
  })

  test('escaped quote inside string does not close the string early', () => {
    expect(extractJsonObject('prefix {"k": "a \\" } b"} suffix')).toEqual({
      k: 'a " } b',
    })
  })

  test('empty input → null', () => {
    expect(extractJsonObject('')).toBeNull()
    expect(extractJsonObject('   ')).toBeNull()
  })

  test('garbage → null', () => {
    expect(extractJsonObject('this is not JSON at all')).toBeNull()
  })
})
