import { dlopen, FFIType, ptr } from 'bun:ffi'

// systemd's sd_notify protocol: send a UTF-8 message to the AF_UNIX SOCK_DGRAM
// socket whose path is in $NOTIFY_SOCKET. Standard messages: "READY=1" (boot
// complete), "WATCHDOG=1" (heartbeat), "STOPPING=1" (graceful shutdown). Bun
// (≤1.3.x) has no native AF_UNIX SOCK_DGRAM primitive — `Bun.connect({ unix })`
// is SOCK_STREAM only and `Bun.udpSocket` is IP-only (oven-sh/bun#17802) — so
// we bind libc socket()/sendto()/close() via bun:ffi. Per the locked decision
// in docs/engineering-plan.md § B.P1, this beats shelling out to systemd-notify
// (which requires NotifyAccess=all, wider security surface) and the unix-dgram
// npm package (native build step in CI).
//
// Cross-platform sockaddr_un layout:
//   Linux: { sa_family_t (2 bytes); char sun_path[108]; }
//   macOS: { uint8_t sun_len; uint8_t sun_family; char sun_path[104]; }
// Both have offsetof(sun_path) == 2, so addrlen = 2 + path-byte-length on both
// platforms. macOS additionally consults sun_len for bind() / sendto(); Linux
// ignores it. We set sun_len on macOS to keep darwin-side dev-mode tests honest.

const AF_UNIX = 1
const SOCK_DGRAM = 2

// SOL_SOCKET / SO_RCVTIMEO option codes; values differ between Linux and Darwin.
// Used only by the test-mode helper (gateway/sd-notify.test.ts), but kept here
// alongside the rest of the platform constants so they live in one place.
const IS_DARWIN = process.platform === 'darwin'
export const SO_LEVEL_SOCKET = IS_DARWIN ? 0xffff : 1
export const SO_RCVTIMEO = IS_DARWIN ? 0x1006 : 20

// Lazy-loaded libc handle. Keeps gateway boot resilient on platforms where the
// gateway imports this module but never runs under systemd (Forge's macOS dev
// box is the load-bearing case): dlopen runs only on the first sdNotify() call
// with a non-empty NOTIFY_SOCKET, not at module-import time.
let libcSymbols: ReturnType<typeof openLibc>['symbols'] | null = null

function openLibc() {
  // macOS: `libc.dylib` is resolved via the dyld shared cache (the file isn't
  // on disk after Big Sur). Linux: `libc.so.6` is the standard glibc soname.
  const path = IS_DARWIN ? 'libc.dylib' : 'libc.so.6'
  return dlopen(path, {
    socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    sendto: {
      args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i64,
    },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
  })
}

function getLibc(): NonNullable<typeof libcSymbols> {
  if (libcSymbols === null) {
    libcSymbols = openLibc().symbols
  }
  return libcSymbols
}

/**
 * Build a sockaddr_un buffer for AF_UNIX. Returns the buffer and the addrlen
 * argument that should be passed to bind() / sendto(). Path may be a regular
 * filesystem path OR a Linux-extension "abstract" socket name written with the
 * `@name` shorthand that systemd uses for the notify socket on user-manager
 * sessions (`man sd_notify(3)`: "If the first character of $NOTIFY_SOCKET is
 * '@', the string [...] refers to a Linux abstract namespace socket").
 *
 * Abstract socket encoding: the leading `@` is translated to a NUL byte
 * (the abstract-namespace marker), the rest of the name follows verbatim, and
 * — crucially — the addrlen is offsetof(sun_path) + name_length WITHOUT a
 * trailing NUL. Pathname sockets, by contrast, are NUL-terminated by the
 * zero-init of the sockaddr buffer; both layouts work because the kernel
 * uses addrlen to determine where the path/name ends.
 *
 * Path-length check matches sun_path[]: 108 on Linux, 104 on Darwin. We use
 * 104 uniformly to keep the upper bound conservative on both platforms —
 * paths in tmpdir (or `/run/systemd/notify`, the systemd default) sit well
 * under that. Abstract sockets get the same byte budget.
 */
export function buildSockaddrUn(path: string): { sockaddr: Uint8Array; addrLen: number } {
  const isAbstract = path.startsWith('@')
  const pathBytes = new TextEncoder().encode(path)
  if (pathBytes.byteLength > 104) {
    throw new Error(`sd_notify: socket path too long (${pathBytes.byteLength} > 104 bytes)`)
  }
  // 110 = max sun_family (2) + max sun_path (108). Zero-init means trailing NUL.
  const sockaddr = new Uint8Array(110)
  if (IS_DARWIN) {
    // Darwin doesn't support Linux abstract sockets — there is no honoured
    // leading-NUL convention. Treat `@`-prefixed paths as literal pathnames so
    // tests on macOS still exercise the kernel's bind/sendto code path; on
    // production Linux gateways the abstract branch below runs.
    sockaddr[0] = 2 + pathBytes.byteLength
    sockaddr[1] = AF_UNIX
    sockaddr.set(pathBytes, 2)
    return { sockaddr, addrLen: 2 + pathBytes.byteLength }
  }
  // Linux: sa_family_t is little-endian uint16.
  new DataView(sockaddr.buffer).setUint16(0, AF_UNIX, true)
  if (isAbstract) {
    // Abstract namespace: leading NUL marker + name bytes (skip the literal
    // '@' from the input). addrlen is offsetof(sun_path) + 1 (NUL marker) +
    // name length, with NO trailing NUL — abstract names are length-delimited.
    sockaddr[2] = 0
    const nameBytes = pathBytes.subarray(1)
    sockaddr.set(nameBytes, 3)
    return { sockaddr, addrLen: 2 + 1 + nameBytes.byteLength }
  }
  // Pathname socket: copy bytes; trailing NUL comes for free from zero-init.
  sockaddr.set(pathBytes, 2)
  return { sockaddr, addrLen: 2 + pathBytes.byteLength }
}

/**
 * Send a single sd_notify message. Returns true if the bytes were sent, false
 * if `$NOTIFY_SOCKET` is unset (dev mode, macOS without systemd, etc.). Throws
 * a real Error when `$NOTIFY_SOCKET` IS set but the socket call fails — that's
 * the systemd-side error path the gateway must surface so a missed READY=1
 * doesn't get silently swallowed.
 *
 * Standard messages per `man sd_notify(3)`:
 *   - "READY=1"      (boot complete; main process ready)
 *   - "WATCHDOG=1"   (heartbeat for WatchdogSec= units)
 *   - "STOPPING=1"   (graceful shutdown started)
 *   - "STATUS=<text>" (free-form status surfaced by `systemctl status`)
 */
export function sdNotify(message: string): boolean {
  const socketPath = process.env['NOTIFY_SOCKET']
  if (socketPath === undefined || socketPath === '') {
    return false
  }

  const libc = getLibc()
  const sock = libc.socket(AF_UNIX, SOCK_DGRAM, 0)
  if (sock < 0) {
    throw new Error(`sd_notify: socket(AF_UNIX, SOCK_DGRAM) failed`)
  }
  try {
    const { sockaddr, addrLen } = buildSockaddrUn(socketPath)
    const messageBytes = new TextEncoder().encode(message)
    const sent = libc.sendto(
      sock,
      messageBytes,
      BigInt(messageBytes.byteLength),
      0,
      sockaddr,
      addrLen,
    )
    if (sent < 0n) {
      throw new Error(`sd_notify: sendto() returned ${sent.toString()} for NOTIFY_SOCKET=${socketPath}`)
    }
    if (sent !== BigInt(messageBytes.byteLength)) {
      throw new Error(
        `sd_notify: short send (sent ${sent.toString()} of ${String(messageBytes.byteLength)} bytes)`,
      )
    }
    return true
  } finally {
    libc.close(sock)
  }
}

/** Internal — exported for the test, not for callers. */
export const __forTest = {
  IS_DARWIN,
  AF_UNIX,
  SOCK_DGRAM,
}
