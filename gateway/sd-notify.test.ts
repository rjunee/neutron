import { afterEach, describe, expect, test } from 'bun:test'
import { dlopen, FFIType, ptr } from 'bun:ffi'
import { unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SO_LEVEL_SOCKET,
  SO_RCVTIMEO,
  buildSockaddrUn,
  sdNotify,
} from './sd-notify.ts'

// Test-only libc binding for receiver side: bind() + recvfrom() + setsockopt().
// We use the same FFI machinery the production module uses, with extra symbols
// added so we can stand up an AF_UNIX SOCK_DGRAM listener inside the test process
// and verify sdNotify() actually delivered bytes.
const IS_DARWIN = process.platform === 'darwin'
const libc = dlopen(IS_DARWIN ? 'libc.dylib' : 'libc.so.6', {
  socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  bind: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  recvfrom: {
    args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i64,
  },
  setsockopt: {
    args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32],
    returns: FFIType.i32,
  },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
})

const AF_UNIX = 1
const SOCK_DGRAM = 2

interface ListenerHandle {
  fd: number
  path: string
}

function openDgramListener(label: string): ListenerHandle {
  const path = join(tmpdir(), `neutron-sd-${process.pid}-${Date.now()}-${label}.sock`)
  try {
    unlinkSync(path)
  } catch {
    // Stale socket is fine — bind() will recreate. ENOENT is expected.
  }

  const fd = libc.symbols.socket(AF_UNIX, SOCK_DGRAM, 0)
  if (fd < 0) throw new Error(`socket() failed: ${fd}`)

  const { sockaddr, addrLen } = buildSockaddrUn(path)
  const bindRc = libc.symbols.bind(fd, ptr(sockaddr), addrLen)
  if (bindRc !== 0) {
    libc.symbols.close(fd)
    throw new Error(`bind(${path}) failed: ${bindRc}`)
  }

  // 1-second SO_RCVTIMEO so a missed delivery surfaces as a recvfrom < 0 instead
  // of hanging the test forever.
  const tv = new Uint8Array(16)
  const tvView = new DataView(tv.buffer)
  tvView.setBigInt64(0, 1n, true)
  tvView.setUint32(8, 0, true)
  const rc = libc.symbols.setsockopt(fd, SO_LEVEL_SOCKET, SO_RCVTIMEO, ptr(tv), 16)
  if (rc !== 0) {
    libc.symbols.close(fd)
    throw new Error(`setsockopt(SO_RCVTIMEO) failed: ${rc}`)
  }

  return { fd, path }
}

function closeListener(h: ListenerHandle): void {
  libc.symbols.close(h.fd)
  try {
    unlinkSync(h.path)
  } catch {
    // Best-effort cleanup; tmpdir gets nuked by test runner shutdown anyway.
  }
}

function recvOnce(h: ListenerHandle, bufSize = 256): string {
  const buf = new Uint8Array(bufSize)
  // src_addr (sockaddr_un at most 110 bytes) and addrlen_ptr (socklen_t = 4 bytes,
  // initialised to the buffer's capacity per the recvfrom(2) contract). Could be
  // NULL/NULL but Bun's FFI ptr type rejects null, and stack-allocating two tiny
  // scratch buffers per call is essentially free.
  const srcAddr = new Uint8Array(110)
  const addrLenPtr = new Uint8Array(4)
  new DataView(addrLenPtr.buffer).setUint32(0, srcAddr.byteLength, true)
  const got = libc.symbols.recvfrom(
    h.fd,
    ptr(buf),
    BigInt(bufSize),
    0,
    ptr(srcAddr),
    ptr(addrLenPtr),
  )
  if (got < 0n) throw new Error(`recvfrom() returned ${got.toString()}`)
  return new TextDecoder().decode(buf.subarray(0, Number(got)))
}

afterEach(() => {
  delete process.env['NOTIFY_SOCKET']
})

describe('sdNotify', () => {
  test('returns false (no-op) when NOTIFY_SOCKET is unset', () => {
    delete process.env['NOTIFY_SOCKET']
    expect(sdNotify('READY=1')).toBe(false)
  })

  test('returns false (no-op) when NOTIFY_SOCKET is empty string', () => {
    process.env['NOTIFY_SOCKET'] = ''
    expect(sdNotify('READY=1')).toBe(false)
  })

  test('round-trips bytes via AF_UNIX SOCK_DGRAM', () => {
    const listener = openDgramListener('roundtrip')
    try {
      process.env['NOTIFY_SOCKET'] = listener.path
      expect(sdNotify('READY=1')).toBe(true)
      expect(recvOnce(listener)).toBe('READY=1')
    } finally {
      closeListener(listener)
    }
  })

  test('round-trips multiple sequential messages (READY then WATCHDOG then STOPPING)', () => {
    const listener = openDgramListener('multi')
    try {
      process.env['NOTIFY_SOCKET'] = listener.path
      expect(sdNotify('READY=1')).toBe(true)
      expect(recvOnce(listener)).toBe('READY=1')
      expect(sdNotify('WATCHDOG=1')).toBe(true)
      expect(recvOnce(listener)).toBe('WATCHDOG=1')
      expect(sdNotify('STOPPING=1')).toBe(true)
      expect(recvOnce(listener)).toBe('STOPPING=1')
    } finally {
      closeListener(listener)
    }
  })

  test('throws when NOTIFY_SOCKET points to a non-existent path', () => {
    process.env['NOTIFY_SOCKET'] = join(tmpdir(), `neutron-sd-doesnotexist-${process.pid}.sock`)
    expect(() => sdNotify('READY=1')).toThrow(/sd_notify/)
  })
})

describe('buildSockaddrUn', () => {
  test('produces 2-byte family prefix + path bytes + addrLen for pathname sockets', () => {
    const { sockaddr, addrLen } = buildSockaddrUn('/tmp/foo.sock')
    expect(addrLen).toBe(2 + '/tmp/foo.sock'.length)
    if (IS_DARWIN) {
      expect(sockaddr[0]).toBe(addrLen)
      expect(sockaddr[1]).toBe(AF_UNIX)
    } else {
      // little-endian u16
      expect(new DataView(sockaddr.buffer).getUint16(0, true)).toBe(AF_UNIX)
    }
    expect(new TextDecoder().decode(sockaddr.subarray(2, 2 + '/tmp/foo.sock'.length))).toBe(
      '/tmp/foo.sock',
    )
  })

  test('encodes Linux abstract namespace sockets with leading NUL byte (skipping the literal @)', () => {
    // systemd's `sd_notify(3)` documents `@name` as the abstract-namespace
    // shorthand on Linux user managers. The kernel expects byte 0 of sun_path
    // to be NUL; the rest of the name follows verbatim, length-delimited via
    // addrlen. On Darwin the abstract namespace doesn't exist — the leading
    // `@` is treated as a literal pathname byte (validated below).
    const { sockaddr, addrLen } = buildSockaddrUn('@neutron-test-abstract')
    if (IS_DARWIN) {
      // Darwin path: literal '@', addrLen = 2 + 22 = 24
      expect(addrLen).toBe(2 + '@neutron-test-abstract'.length)
      expect(sockaddr[0]).toBe(addrLen)
      expect(sockaddr[1]).toBe(AF_UNIX)
      expect(sockaddr[2]).toBe('@'.charCodeAt(0))
    } else {
      // Linux abstract: NUL marker at offset 2, name starting at offset 3,
      // addrLen = 2 (sun_family) + 1 (NUL) + 21 (name without leading '@')
      expect(addrLen).toBe(2 + 1 + 'neutron-test-abstract'.length)
      expect(new DataView(sockaddr.buffer).getUint16(0, true)).toBe(AF_UNIX)
      expect(sockaddr[2]).toBe(0) // abstract-namespace marker
      expect(new TextDecoder().decode(sockaddr.subarray(3, 3 + 'neutron-test-abstract'.length))).toBe(
        'neutron-test-abstract',
      )
    }
  })

  test('throws on path > 104 bytes (sun_path bound on Darwin)', () => {
    const tooLong = '/' + 'x'.repeat(110)
    expect(() => buildSockaddrUn(tooLong)).toThrow(/too long/i)
  })
})
