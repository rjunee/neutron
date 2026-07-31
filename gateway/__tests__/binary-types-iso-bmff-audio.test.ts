/**
 * ISO-BMFF audio-vs-video disambiguation.
 *
 * A `.m4a` voice note and an `.mp4` movie share the same `ftyp` prefix and,
 * very often, the same major brand. Android's MediaRecorder stamps `mp42` on
 * every `OUTPUT_FORMAT_MPEG_4` file it writes, audio-only ones included, so
 * classifying on the brand alone sends real voice notes down the video path —
 * where the chat-upload whitelist 415s them. These cases pin the fix: the
 * TRACK TABLE decides, and an unparsable file keeps the old video answer.
 *
 * Every fixture here is synthesised from box headers. There is no real audio,
 * no recording, and no media payload of any kind — the `mdat` bodies are zero
 * fill, which is all the walk ever needs to step over.
 */

import { describe, expect, it } from 'bun:test'

import { isoBmffTrackKinds, magicByteSniff } from '../storage/binary-types.ts'

// ── Synthetic ISO-BMFF builders ──────────────────────────────────────────────

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
}

function fourcc(s: string): number[] {
  return [s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)]
}

/** A standard box: 32-bit size, 4-char type, payload. */
function box(type: string, payload: number[]): number[] {
  return [...u32(payload.length + 8), ...fourcc(type), ...payload]
}

/** A box using the 64-bit `largesize` escape (`size == 1`). */
function bigBox(type: string, payload: number[]): number[] {
  const total = payload.length + 16
  return [...u32(1), ...fourcc(type), ...u32(0), ...u32(total), ...payload]
}

function ftyp(brand: string, compatible: string[] = ['isom', brand]): number[] {
  return box('ftyp', [...fourcc(brand), ...u32(0), ...compatible.flatMap(fourcc)])
}

/** `hdlr` FullBox — version/flags, pre_defined, handler type, reserved, name. */
function hdlr(handler: 'soun' | 'vide'): number[] {
  return box('hdlr', [
    ...u32(0), // version + flags
    ...u32(0), // pre_defined
    ...fourcc(handler),
    ...u32(0),
    ...u32(0),
    ...u32(0), // reserved[3]
    0, // empty name
  ])
}

function trak(handler: 'soun' | 'vide'): number[] {
  return box('trak', box('mdia', hdlr(handler)))
}

function moov(handlers: ('soun' | 'vide')[]): number[] {
  return box('moov', handlers.flatMap(trak))
}

function mdat(size_bytes = 64): number[] {
  return box('mdat', new Array<number>(size_bytes).fill(0))
}

const bytesOf = (...parts: number[][]): Uint8Array => Uint8Array.from(parts.flat())

// ── The regression these cases exist for ─────────────────────────────────────

describe('magicByteSniff — generic-brand ISO-BMFF', () => {
  it('classifies an AUDIO-ONLY mp42 file as audio/mp4 (the Android voice note)', () => {
    // Before the track-table check this returned 'video/mp4', which is absent
    // from CHAT_UPLOAD_MIME_WHITELIST — so every voice message recorded on
    // Android 415'd at the upload surface.
    const file = bytesOf(ftyp('mp42'), mdat(), moov(['soun']))
    expect(magicByteSniff(file)).toBe('audio/mp4')
  })

  it('classifies an audio-only isom file as audio/mp4 (desktop muxers)', () => {
    const file = bytesOf(ftyp('isom'), mdat(), moov(['soun']))
    expect(magicByteSniff(file)).toBe('audio/mp4')
  })

  it('still classifies a file WITH a video track as video/mp4', () => {
    const muxed = bytesOf(ftyp('mp42'), mdat(), moov(['soun', 'vide']))
    expect(magicByteSniff(muxed)).toBe('video/mp4')

    const silent_movie = bytesOf(ftyp('isom'), mdat(), moov(['vide']))
    expect(magicByteSniff(silent_movie)).toBe('video/mp4')
  })

  it('keeps the historical video/mp4 answer when the track table is unreadable', () => {
    // A header-only or truncated upload must not be upgraded to audio on a
    // guess — indeterminate stays video, exactly as it behaved before.
    expect(magicByteSniff(bytesOf(ftyp('mp42')))).toBe('video/mp4')
    expect(magicByteSniff(bytesOf(ftyp('isom'), mdat(2048)))).toBe('video/mp4')
  })

  it('leaves the explicit M4A brand alone', () => {
    expect(magicByteSniff(bytesOf(ftyp('M4A '), mdat(), moov(['soun'])))).toBe('audio/mp4')
  })
})

describe('isoBmffTrackKinds — box walking', () => {
  it('finds moov placed AFTER mdat, the layout MediaRecorder writes', () => {
    const trailing = bytesOf(ftyp('mp42'), mdat(4096), moov(['soun']))
    expect(isoBmffTrackKinds(trailing)).toEqual({ audio: true, video: false })
  })

  it('finds moov placed BEFORE mdat, the faststart layout', () => {
    const leading = bytesOf(ftyp('mp42'), moov(['soun']), mdat(4096))
    expect(isoBmffTrackKinds(leading)).toEqual({ audio: true, video: false })
  })

  it('steps over a 64-bit largesize mdat', () => {
    const large = bytesOf(ftyp('mp42'), bigBox('mdat', new Array<number>(128).fill(0)), moov(['soun']))
    expect(isoBmffTrackKinds(large)).toEqual({ audio: true, video: false })
  })

  it('handles a size-0 mdat that runs to end of file', () => {
    // `size == 0` swallows the rest of the file, so no track table follows.
    const to_eof = bytesOf(ftyp('mp42'), [...u32(0), ...fourcc('mdat'), 1, 2, 3, 4])
    expect(isoBmffTrackKinds(to_eof)).toEqual({ audio: false, video: false })
  })

  it('reports both kinds for a muxed file', () => {
    expect(isoBmffTrackKinds(bytesOf(ftyp('mp42'), moov(['vide', 'soun'])))).toEqual({
      audio: true,
      video: true,
    })
  })

  it('does not fall for the ASCII "hdlr" appearing inside mdat payload', () => {
    // A structural walk steps over mdat by size; a byte scan would match here
    // and mislabel an opaque payload as an audio track.
    const decoy = box('mdat', [...fourcc('hdlr'), ...u32(0), ...u32(0), ...fourcc('soun')])
    expect(isoBmffTrackKinds(bytesOf(ftyp('mp42'), decoy))).toEqual({
      audio: false,
      video: false,
    })
  })

  it('terminates on a malformed box rather than looping or overrunning', () => {
    // Size smaller than the header, and size larger than the buffer.
    const zero_size = bytesOf(ftyp('mp42'), [...u32(4), ...fourcc('moov')])
    expect(isoBmffTrackKinds(zero_size)).toEqual({ audio: false, video: false })

    const overrun = bytesOf(ftyp('mp42'), [...u32(0xffff), ...fourcc('moov')])
    expect(isoBmffTrackKinds(overrun)).toEqual({ audio: false, video: false })

    expect(isoBmffTrackKinds(new Uint8Array(0))).toEqual({ audio: false, video: false })
  })
})
