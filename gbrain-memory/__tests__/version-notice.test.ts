import { describe, test, expect } from 'bun:test'
import { parseUpgradeMarker, GBrainVersionNotice } from '../version-notice.ts'

describe('parseUpgradeMarker', () => {
  test('parses a well-formed UPGRADE_AVAILABLE marker', () => {
    expect(parseUpgradeMarker('UPGRADE_AVAILABLE 0.42.26.0 0.43.0.0')).toEqual({
      current: '0.42.26.0',
      latest: '0.43.0.0',
    })
  })
  test('tolerates surrounding whitespace', () => {
    expect(parseUpgradeMarker('  UPGRADE_AVAILABLE 0.42.0 0.43.0  ')).toEqual({
      current: '0.42.0',
      latest: '0.43.0',
    })
  })
  test('rejects non-marker lines', () => {
    expect(parseUpgradeMarker('gbrain 0.42 -> 0.43 available. Run: gbrain self-upgrade')).toBeNull()
    expect(parseUpgradeMarker('[gbrain-serve] shutdown: SIGTERM')).toBeNull()
    expect(parseUpgradeMarker('')).toBeNull()
  })
  test('rejects a forged marker with non-version tokens', () => {
    expect(parseUpgradeMarker('UPGRADE_AVAILABLE foo bar')).toBeNull()
    expect(parseUpgradeMarker('UPGRADE_AVAILABLE 0.42.0')).toBeNull()
  })
})

describe('GBrainVersionNotice', () => {
  test('records the latest notice from chunked stderr', () => {
    const n = new GBrainVersionNotice('notify')
    n.ingestStderr('[gbrain] starting\nUPGRADE_AVAIL')
    expect(n.current()).toBeNull()
    n.ingestStderr('ABLE 0.42.26.0 0.43.0.0\n')
    expect(n.current()).toEqual({ current: '0.42.26.0', latest: '0.43.0.0' })
  })
  test('off mode ignores markers', () => {
    const n = new GBrainVersionNotice('off')
    n.ingestStderr('UPGRADE_AVAILABLE 0.42.0 0.43.0\n')
    expect(n.current()).toBeNull()
  })
})
