/**
 * @neutronai/research-core — web-fetch allow-list + capability tests.
 *
 * Per docs/plans/research-core-tier1-brief.md § 2.3.
 */

import { describe, expect, test } from 'bun:test'

import {
  BlockedDestinationError,
  WebFetchCapabilityDeniedError,
  applyPin,
  isAllowlisted,
  isBlockedIp,
  isUnconditionallyBlocked,
  resolveAndAssertPublic,
  webFetch,
  type DnsLookupFn,
} from '../src/web-fetch.ts'
import { DEFAULT_WEB_FETCH_ALLOWLIST } from '../src/web-fetch-allowlist.ts'
import { loadManifest } from '../src/manifest.ts'

function withBrowseManifest(): import('@neutronai/cores-sdk').NeutronManifest {
  return loadManifest()
}

function withoutBrowseManifest(): import('@neutronai/cores-sdk').NeutronManifest {
  const m = loadManifest()
  return {
    ...m,
    capabilities: m.capabilities.filter((c) => c !== 'network:browse'),
  }
}

describe('isUnconditionallyBlocked', () => {
  test('RFC-1918 IPv4 rejected (10.x)', () => {
    expect(isUnconditionallyBlocked(new URL('http://10.0.0.1/')).blocked).toBe(true)
  })
  test('RFC-1918 IPv4 rejected (172.16-31.x)', () => {
    expect(isUnconditionallyBlocked(new URL('http://172.20.1.1/')).blocked).toBe(true)
    expect(isUnconditionallyBlocked(new URL('http://172.15.1.1/')).blocked).toBe(false)
  })
  test('RFC-1918 IPv4 rejected (192.168.x)', () => {
    expect(isUnconditionallyBlocked(new URL('http://192.168.1.1/')).blocked).toBe(true)
  })
  test('loopback rejected (127.x)', () => {
    expect(isUnconditionallyBlocked(new URL('http://127.0.0.1/')).blocked).toBe(true)
  })
  test('link-local + cloud metadata rejected (169.254.x)', () => {
    expect(isUnconditionallyBlocked(new URL('http://169.254.169.254/')).blocked).toBe(true)
  })
  test('localhost hostname rejected', () => {
    expect(isUnconditionallyBlocked(new URL('http://localhost/')).blocked).toBe(true)
  })
  test('file:// rejected', () => {
    expect(isUnconditionallyBlocked(new URL('file:///etc/passwd')).blocked).toBe(true)
  })
  test('ftp:// rejected', () => {
    expect(isUnconditionallyBlocked(new URL('ftp://example.com/x')).blocked).toBe(true)
  })
  test('data: scheme rejected', () => {
    expect(isUnconditionallyBlocked(new URL('data:text/plain,hi')).blocked).toBe(true)
  })
  test('xip.io DNS-rebinding rejected', () => {
    expect(isUnconditionallyBlocked(new URL('http://10.0.0.1.xip.io/')).blocked).toBe(true)
  })
  test('public domain passes the unconditional gate', () => {
    expect(isUnconditionallyBlocked(new URL('https://en.wikipedia.org/x')).blocked).toBe(false)
  })
})

describe('isAllowlisted', () => {
  test('exact match passes', () => {
    expect(isAllowlisted('github.com', ['github.com'])).toBe(true)
  })
  test('subdomain match passes', () => {
    expect(isAllowlisted('docs.github.com', ['github.com'])).toBe(true)
    expect(isAllowlisted('en.wikipedia.org', DEFAULT_WEB_FETCH_ALLOWLIST)).toBe(true)
  })
  test('non-listed domain rejected', () => {
    expect(isAllowlisted('attacker.com', DEFAULT_WEB_FETCH_ALLOWLIST)).toBe(false)
  })
  test('.gov / .edu suffix match', () => {
    expect(isAllowlisted('census.gov', DEFAULT_WEB_FETCH_ALLOWLIST)).toBe(true)
    expect(isAllowlisted('mit.edu', DEFAULT_WEB_FETCH_ALLOWLIST)).toBe(true)
  })
})

describe('webFetch — capability + allowlist', () => {
  test('throws WebFetchCapabilityDeniedError when manifest omits network:browse', async () => {
    await expect(
      webFetch(
        { url: 'https://en.wikipedia.org/wiki/Water' },
        { manifest: withoutBrowseManifest(), fetcher: stubFetcher(), lookup: publicLookup() },
      ),
    ).rejects.toThrow(WebFetchCapabilityDeniedError)
  })

  test('throws BlockedDestinationError for unconditionally-blocked URL', async () => {
    await expect(
      webFetch(
        { url: 'http://169.254.169.254/latest/meta-data/' },
        { manifest: withBrowseManifest(), fetcher: stubFetcher(), lookup: publicLookup() },
      ),
    ).rejects.toThrow(BlockedDestinationError)
  })

  test('throws BlockedDestinationError for non-allowlisted public domain', async () => {
    await expect(
      webFetch(
        { url: 'https://example-attacker.com/foo' },
        { manifest: withBrowseManifest(), fetcher: stubFetcher(), lookup: publicLookup() },
      ),
    ).rejects.toThrow(BlockedDestinationError)
  })

  test('allow-listed domain passes; returns body + status', async () => {
    const result = await webFetch(
      { url: 'https://en.wikipedia.org/wiki/Water' },
      {
        manifest: withBrowseManifest(),
        fetcher: stubFetcher({ body: 'water is a chemical compound', content_type: 'text/html' }),
        lookup: publicLookup(),
      },
    )
    expect(result.status).toBe(200)
    expect(result.body_text).toContain('water')
    expect(result.content_type).toBe('text/html')
  })

  test('redirect-follow safety — refuses redirect to RFC-1918', async () => {
    await expect(
      webFetch(
        { url: 'https://en.wikipedia.org/x' },
        {
          manifest: withBrowseManifest(),
          fetcher: redirectingFetcher('http://10.0.0.1/internal'),
          lookup: publicLookup(),
        },
      ),
    ).rejects.toThrow(BlockedDestinationError)
  })

  test('redirect-follow safety — refuses redirect to non-allowlisted public', async () => {
    await expect(
      webFetch(
        { url: 'https://en.wikipedia.org/x' },
        {
          manifest: withBrowseManifest(),
          fetcher: redirectingFetcher('https://attacker-domain.com/x'),
          lookup: publicLookup(),
        },
      ),
    ).rejects.toThrow(BlockedDestinationError)
  })

  test('content-type sniff — refuses image/png', async () => {
    await expect(
      webFetch(
        { url: 'https://en.wikipedia.org/x.png' },
        {
          manifest: withBrowseManifest(),
          fetcher: stubFetcher({ body: 'PNG', content_type: 'image/png' }),
          lookup: publicLookup(),
        },
      ),
    ).rejects.toThrow(BlockedDestinationError)
  })

  test('size cap — refuses oversized body', async () => {
    const big = 'A'.repeat(1024 * 1024 * 2)
    await expect(
      webFetch(
        { url: 'https://en.wikipedia.org/x', max_bytes: 1024 },
        {
          manifest: withBrowseManifest(),
          fetcher: stubFetcher({ body: big, content_type: 'text/plain' }),
          lookup: publicLookup(),
        },
      ),
    ).rejects.toThrow(BlockedDestinationError)
  })
})

describe('isBlockedIp (ISSUES #21)', () => {
  test('RFC-1918 IPv4 addresses are rejected', () => {
    expect(isBlockedIp('10.0.0.1').blocked).toBe(true)
    expect(isBlockedIp('172.20.0.1').blocked).toBe(true)
    expect(isBlockedIp('192.168.1.1').blocked).toBe(true)
  })
  test('loopback + link-local IPv4 are rejected', () => {
    expect(isBlockedIp('127.0.0.1').blocked).toBe(true)
    expect(isBlockedIp('169.254.169.254').blocked).toBe(true)
  })
  test('public IPv4 addresses pass', () => {
    expect(isBlockedIp('8.8.8.8').blocked).toBe(false)
    expect(isBlockedIp('1.1.1.1').blocked).toBe(false)
  })
  test('IPv6 loopback / link-local / ULA rejected', () => {
    expect(isBlockedIp('::1').blocked).toBe(true)
    expect(isBlockedIp('fe80::1').blocked).toBe(true)
    expect(isBlockedIp('fd00::1').blocked).toBe(true)
  })
  // ISSUES #21 follow-up (Argus r1 BLOCKER 2): IPv4-mapped IPv6
  // (`::ffff:a.b.c.d`) was not caught by either the IPv4 set (string
  // carries the `::ffff:` prefix) or the IPv6 set (literal doesn't
  // start with `fe80:` / `fc__:` / `fd__:`). Node's TCP stack happily
  // connects to the underlying IPv4 — so an attacker-controlled AAAA
  // record pointing at `::ffff:127.0.0.1` or `::ffff:169.254.169.254`
  // reached internal IPs. Fix strips the prefix and re-checks the
  // unwrapped IPv4 against the IPv4 reject ranges.
  test('IPv4-mapped IPv6 loopback rejected (::ffff:127.0.0.1)', () => {
    expect(isBlockedIp('::ffff:127.0.0.1').blocked).toBe(true)
  })
  test('IPv4-mapped IPv6 link-local rejected (::ffff:169.254.169.254 / AWS metadata)', () => {
    expect(isBlockedIp('::ffff:169.254.169.254').blocked).toBe(true)
  })
  test('IPv4-mapped IPv6 RFC-1918 rejected (::ffff:10.0.0.1 / ::ffff:192.168.1.1)', () => {
    expect(isBlockedIp('::ffff:10.0.0.1').blocked).toBe(true)
    expect(isBlockedIp('::ffff:192.168.1.1').blocked).toBe(true)
    expect(isBlockedIp('::ffff:172.20.0.1').blocked).toBe(true)
  })
  test('IPv4-translated IPv6 form `::ffff:0:a.b.c.d` (NAT64/DNS64) also rejected', () => {
    expect(isBlockedIp('::ffff:0:127.0.0.1').blocked).toBe(true)
    expect(isBlockedIp('::ffff:0:169.254.169.254').blocked).toBe(true)
  })
  test('IPv4-mapped IPv6 wrapping a public IPv4 still passes', () => {
    expect(isBlockedIp('::ffff:8.8.8.8').blocked).toBe(false)
    expect(isBlockedIp('::ffff:1.1.1.1').blocked).toBe(false)
  })
})

describe('webFetch — ISSUES #21 SSRF DNS-resolution gap', () => {
  test('rejects when an allowlisted domain DNS-resolves to RFC-1918 (`evil` → 10.0.0.1)', async () => {
    // Closing condition from ISSUES #21 — synthetic DNS fixture where an
    // allowlisted hostname maps to an internal IP. Pre-fix this passed
    // the string allowlist check and the fetch proceeded against the
    // RFC-1918 destination; post-fix the resolver-check refuses with
    // an `ssrf_blocked` code BEFORE any network IO.
    let fetchCalls = 0
    const fetcher = (async () => {
      fetchCalls += 1
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })
    }) as unknown as typeof fetch
    let err: unknown = null
    try {
      await webFetch(
        { url: 'https://en.wikipedia.org/foo' },
        {
          manifest: withBrowseManifest(),
          fetcher,
          lookup: poisonedLookup({ 'en.wikipedia.org': '10.0.0.1' }),
        },
      )
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(BlockedDestinationError)
    expect((err as BlockedDestinationError).code).toBe('ssrf_blocked')
    expect(fetchCalls).toBe(0) // no network IO before the SSRF refusal
  })

  test('rejects when allowlisted domain DNS-resolves to AWS metadata (169.254.169.254)', async () => {
    await expect(
      webFetch(
        { url: 'https://en.wikipedia.org/foo' },
        {
          manifest: withBrowseManifest(),
          fetcher: stubFetcher(),
          lookup: poisonedLookup({ 'en.wikipedia.org': '169.254.169.254' }),
        },
      ),
    ).rejects.toThrow(BlockedDestinationError)
  })

  test('rejects when DNS lookup fails (resolver unhealthy ≠ safe to fetch)', async () => {
    const lookup: DnsLookupFn = async () => {
      throw new Error('ENOTFOUND')
    }
    await expect(
      webFetch(
        { url: 'https://en.wikipedia.org/foo' },
        { manifest: withBrowseManifest(), fetcher: stubFetcher(), lookup },
      ),
    ).rejects.toThrow(/ssrf_blocked/)
  })

  test('rejects redirect hop whose hostname resolves to RFC-1918', async () => {
    // wikipedia.org → arxiv.org (both allowlisted); but `arxiv.org`'s
    // synthetic resolver-record points at 192.168.0.5. The hop-level
    // DNS check must catch this even though the redirect-string check
    // would have passed.
    let hop = 0
    const fetcher = (async () => {
      hop += 1
      if (hop === 1) {
        return new Response(null, { status: 302, headers: { location: 'https://arxiv.org/abs/1' } })
      }
      return new Response('done', { status: 200, headers: { 'content-type': 'text/plain' } })
    }) as unknown as typeof fetch
    await expect(
      webFetch(
        { url: 'https://en.wikipedia.org/x' },
        {
          manifest: withBrowseManifest(),
          fetcher,
          lookup: poisonedLookup({
            'en.wikipedia.org': '208.80.154.224', // real public IP
            'arxiv.org': '192.168.0.5',           // poisoned hop
          }),
        },
      ),
    ).rejects.toThrow(BlockedDestinationError)
  })
})

describe('webFetch — ISSUES #22 streaming + Content-Length cap', () => {
  test('rejects upfront when Content-Length exceeds max_bytes (no body read)', async () => {
    // The probe lives in `pull()` so a consumer read (the thing the cap
    // exists to prevent) is observable; the `{ highWaterMark: 0 }`
    // queueing strategy suppresses Bun's auto-pull at Response wrap time
    // so `pulled === true` only fires from a real downstream read. We
    // also observe `cancel()` as a positive signal that the pre-flight
    // dropped the underlying socket without reading.
    let pulled = false
    let cancelled = false
    const fetcher = (async () => {
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulled = true
            controller.enqueue(new TextEncoder().encode('a'.repeat(1024)))
            controller.close()
          },
          cancel() {
            cancelled = true
          },
        },
        { highWaterMark: 0 },
      )
      return new Response(stream, {
        status: 200,
        headers: {
          'content-type': 'text/plain',
          'content-length': String(10 * 1024 * 1024), // 10 MB announced
        },
      })
    }) as unknown as typeof fetch
    await expect(
      webFetch(
        { url: 'https://en.wikipedia.org/big', max_bytes: 1024 },
        { manifest: withBrowseManifest(), fetcher, lookup: publicLookup() },
      ),
    ).rejects.toThrow(/Content-Length/)
    // The body stream must NOT have been pulled — the pre-flight
    // Content-Length check fires before any chunk read. AND the socket
    // must have been cancelled so we don't leak the open connection.
    expect(pulled).toBe(false)
    expect(cancelled).toBe(true)
  })

  test('streaming cap — aborts mid-stream when body exceeds max_bytes despite missing Content-Length', async () => {
    const max_bytes = 4 * 1024 // 4 KB
    let totalEnqueued = 0
    const fetcher = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          // Enqueue 1 KB at a time; if the streaming cap works the
          // reader will cancel us well before we reach 100 KB.
          if (totalEnqueued >= 100 * 1024) {
            controller.close()
            return
          }
          const chunk = new TextEncoder().encode('a'.repeat(1024))
          totalEnqueued += chunk.byteLength
          controller.enqueue(chunk)
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })
    }) as unknown as typeof fetch
    await expect(
      webFetch(
        { url: 'https://en.wikipedia.org/big', max_bytes },
        { manifest: withBrowseManifest(), fetcher, lookup: publicLookup() },
      ),
    ).rejects.toThrow(/exceeds cap/)
    // The streaming cap must have cancelled the reader before the
    // server's full 100 KB body was sent.
    expect(totalEnqueued).toBeLessThan(100 * 1024)
  })

  test('streaming success — returns full body when under max_bytes', async () => {
    const fetcher = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('hello'))
          controller.enqueue(new TextEncoder().encode(' world'))
          controller.close()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })
    }) as unknown as typeof fetch
    const result = await webFetch(
      { url: 'https://en.wikipedia.org/ok', max_bytes: 1024 },
      { manifest: withBrowseManifest(), fetcher, lookup: publicLookup() },
    )
    expect(result.body_text).toBe('hello world')
    expect(result.bytes).toBe(11)
  })
})

describe('webFetch — ISSUE #25 DNS-rebind TOCTOU pin (Bun-native URL+SNI)', () => {
  // The pre-fix TOCTOU residual: pre-flight resolves the hostname to a
  // public IP, but Bun's stock `fetch` then re-resolves DNS at
  // connect-time. An attacker with a sub-ms flipping A record can
  // return public-IP to the predicate then RFC-1918 to the connect.
  //
  // Why the pin works under Bun (verified in 1.3.9): we REWRITE the URL
  // to contain the pre-flight-approved IP literal. Bun does NOT
  // re-resolve IP-literal hostnames — there's no second DNS lookup to
  // race. SNI (`tls.serverName`) + cert validation
  // (`tls.checkServerIdentity`) + Host header keep the TLS handshake +
  // virtual-host routing pinned to the ORIGINAL hostname so the server
  // serves the right site and the client validates the right cert.
  //
  // The canonical undici `Agent({ connect: { lookup } })` pattern is a
  // silent no-op under Bun: Bun's `fetch` ignores the `dispatcher`
  // option entirely AND Bun's bundled `undici.Agent` is a stub whose
  // `close` / `destroy` / `dispatch` are `undefined`. Confirmed by
  // direct probe at PR #292 r3 (Argus BLOCKER). The URL-rewrite +
  // `tls.serverName` + `tls.checkServerIdentity` pattern is the
  // Bun-supported equivalent.

  test('applyPin: 100 invocations all surface the pinned IP in the URL', () => {
    // Stress-spec from the brief: 100 iterations of pin construction
    // must ALWAYS produce a URL whose host is the pre-flight-approved
    // IP — never the rebind flip — regardless of the source hostname.
    const pinned = { address: '93.184.216.34', family: 4 as const }
    const sourceHosts = [
      'en.wikipedia.org',
      'arxiv.org',
      'github.com',
      'docs.aws.amazon.com',
      'developer.mozilla.org',
    ]
    let constructed = 0
    for (let i = 0; i < 100; i++) {
      const host = sourceHosts[i % sourceHosts.length] ?? 'fallback.example'
      const out = applyPin(new URL(`https://${host}/some/path?q=${i}`), pinned)
      // Pinned URL contains the IP literal in the host position.
      expect(new URL(out.url).host).toBe('93.184.216.34')
      // Path + query preserved.
      expect(new URL(out.url).pathname).toBe('/some/path')
      expect(new URL(out.url).searchParams.get('q')).toBe(String(i))
      // SNI pins back to ORIGINAL hostname (not the IP).
      expect(out.init.tls?.serverName).toBe(host)
      // Cert validation function present + non-trivial.
      expect(typeof out.init.tls?.checkServerIdentity).toBe('function')
      // Host header pins back to ORIGINAL host.
      expect(out.init.headers?.Host).toBe(host)
      constructed += 1
    }
    expect(constructed).toBe(100)
  })

  test('applyPin: pins IPv6 with bracket notation', () => {
    const pinned = { address: '2606:4700:4700::1111', family: 6 as const }
    const out = applyPin(new URL('https://cloudflare-dns.com/dns-query'), pinned)
    // Per RFC 3986 — IPv6 literal must be bracket-quoted in URL host.
    expect(new URL(out.url).hostname).toBe('[2606:4700:4700::1111]')
    expect(out.init.tls?.serverName).toBe('cloudflare-dns.com')
    expect(out.init.headers?.Host).toBe('cloudflare-dns.com')
  })

  test('applyPin: preserves explicit port', () => {
    const pinned = { address: '93.184.216.34', family: 4 as const }
    const out = applyPin(new URL('https://example.com:8443/foo'), pinned)
    expect(new URL(out.url).host).toBe('93.184.216.34:8443')
    expect(out.init.headers?.Host).toBe('example.com:8443')
  })

  test('applyPin: http (non-TLS) source — Host header pinned, no tls options', () => {
    const pinned = { address: '93.184.216.34', family: 4 as const }
    const out = applyPin(new URL('http://example.com/x'), pinned)
    expect(new URL(out.url).host).toBe('93.184.216.34')
    expect(out.init.headers?.Host).toBe('example.com')
    expect(out.init.tls).toBeUndefined()
  })

  test('applyPin: null pin (IP-literal source) — URL unchanged, init empty', () => {
    const out = applyPin(new URL('http://1.1.1.1/'), null)
    expect(out.url).toBe('http://1.1.1.1/')
    expect(out.init.tls).toBeUndefined()
    expect(out.init.headers).toBeUndefined()
  })

  test('resolveAndAssertPublic returns the first publicly-resolved record (pin source)', async () => {
    const lookup: DnsLookupFn = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]
    const pin = await resolveAndAssertPublic(
      new URL('https://en.wikipedia.org/x'),
      lookup,
      'https://en.wikipedia.org/x',
    )
    expect(pin).not.toBeNull()
    expect(pin?.address).toBe('93.184.216.34')
    expect(pin?.family).toBe(4)
  })

  test('resolveAndAssertPublic returns null for IP-literal hosts (no DNS to pin)', async () => {
    let lookupCalled = false
    const lookup: DnsLookupFn = async () => {
      lookupCalled = true
      return [{ address: '1.1.1.1', family: 4 }]
    }
    const pin = await resolveAndAssertPublic(
      new URL('http://1.1.1.1/'),
      lookup,
      'http://1.1.1.1/',
    )
    expect(pin).toBeNull()
    expect(lookupCalled).toBe(false)
  })

  test('webFetch: pre-flight lookup called exactly once per fetch (no double-resolution)', async () => {
    // Post-pin, the fetcher receives a URL containing the IP literal.
    // No further DNS resolution happens through our injectable
    // resolver, AND Bun won't re-resolve an IP literal. So an
    // adversarial flipping A record has nothing to race.
    let lookupCalls = 0
    const lookup: DnsLookupFn = async () => {
      lookupCalls += 1
      return [{ address: '93.184.216.34', family: 4 }]
    }
    const fetcher = (async () =>
      new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch
    await webFetch(
      { url: 'https://en.wikipedia.org/x' },
      { manifest: withBrowseManifest(), fetcher, lookup },
    )
    expect(lookupCalls).toBe(1)
  })

  test('webFetch: 100 sequential fetches — every fetcher invocation carries the pinned URL + tls.serverName + Host header', async () => {
    // Stress-spec from the brief: 100 fetches against a flipping mock.
    // We capture the URL string AND init the fetcher receives and
    // assert (a) URL host is the pre-flight IP for all 100 calls,
    // (b) tls.serverName pins back to the original hostname,
    // (c) Host header pins back to the original hostname,
    // (d) the pre-flight lookup count is exactly 100 (one per fetch,
    // no re-resolution path).
    let flip = 0
    const lookup: DnsLookupFn = async () => {
      flip += 1
      return [{ address: '93.184.216.34', family: 4 }]
    }
    const capturedUrls: string[] = []
    type Captured = { tls?: { serverName?: string } | undefined; headers?: Record<string, string> | undefined }
    const capturedInits: Captured[] = []
    const fetcher = (async (url: string, init?: RequestInit & Captured) => {
      capturedUrls.push(url)
      capturedInits.push({ tls: init?.tls, headers: init?.headers as Record<string, string> | undefined })
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })
    }) as unknown as typeof fetch
    for (let i = 0; i < 100; i++) {
      await webFetch(
        { url: 'https://en.wikipedia.org/x' },
        { manifest: withBrowseManifest(), fetcher, lookup },
      )
    }
    expect(capturedUrls.length).toBe(100)
    expect(flip).toBe(100) // one pre-flight per fetch, no double-resolution
    for (const u of capturedUrls) {
      // URL hands to fetcher: pinned IP, NOT the original hostname.
      expect(new URL(u).hostname).toBe('93.184.216.34')
    }
    for (const c of capturedInits) {
      expect(c.tls?.serverName).toBe('en.wikipedia.org')
      expect(c.headers?.Host).toBe('en.wikipedia.org')
    }
  })

  test('webFetch: redirect hop pre-flights AND re-pins the new hostname (rejects poisoned hop-2)', async () => {
    // First hop pre-flighted. The 302 Location header points at a
    // second allowlisted hostname whose pre-flight DNS record is
    // RFC-1918 — that hop must be REFUSED at the pre-flight SSRF
    // check, BEFORE the fetcher is invoked for hop 2.
    let hop = 0
    const fetcher = (async () => {
      hop += 1
      if (hop === 1) {
        return new Response(null, { status: 302, headers: { location: 'https://arxiv.org/abs/1' } })
      }
      return new Response('done', { status: 200, headers: { 'content-type': 'text/plain' } })
    }) as unknown as typeof fetch
    await expect(
      webFetch(
        { url: 'https://en.wikipedia.org/x' },
        {
          manifest: withBrowseManifest(),
          fetcher,
          lookup: poisonedLookup({
            'en.wikipedia.org': '93.184.216.34',
            'arxiv.org': '192.168.0.5',
          }),
        },
      ),
    ).rejects.toThrow(BlockedDestinationError)
    expect(hop).toBe(1) // second hop never fetched — refused at pre-flight
  })

  test('webFetch: successful redirect — second-hop URL carries the new hop\'s IP, NOT the first hop\'s', async () => {
    // Both hops pre-flight to DISTINCT public IPs. The fetcher's hop-2
    // URL must contain `arxiv.org`'s IP — proves fresh pin per hop.
    // Re-using the first hop's IP would dial the wrong host.
    const urls: string[] = []
    let hop = 0
    const fetcher = (async (url: string) => {
      urls.push(url)
      hop += 1
      if (hop === 1) {
        return new Response(null, { status: 302, headers: { location: 'https://arxiv.org/abs/1' } })
      }
      return new Response('done', { status: 200, headers: { 'content-type': 'text/plain' } })
    }) as unknown as typeof fetch
    await webFetch(
      { url: 'https://en.wikipedia.org/x' },
      {
        manifest: withBrowseManifest(),
        fetcher,
        lookup: poisonedLookup({
          'en.wikipedia.org': '93.184.216.34',
          'arxiv.org': '208.80.154.224',
        }),
      },
    )
    expect(urls.length).toBe(2)
    expect(new URL(urls[0]!).hostname).toBe('93.184.216.34') // wikipedia's IP
    expect(new URL(urls[1]!).hostname).toBe('208.80.154.224') // arxiv's IP
  })

  test('webFetch: relative Location resolves against the ORIGINAL hostname, NOT the pinned URL', async () => {
    // Critical safety property — if we resolved Location against the
    // pinned URL (`https://93.184.../foo`), a relative `Location: /bar`
    // would become `https://93.184.../bar` and the per-hop pin would
    // re-pin against the IP literal instead of re-resolving
    // wikipedia.org. The redirect chain would silently lose the
    // original hostname after hop 1.
    const urls: string[] = []
    type Captured = { tls?: { serverName?: string } | undefined; headers?: Record<string, string> | undefined }
    const inits: Captured[] = []
    let hop = 0
    const fetcher = (async (url: string, init?: RequestInit & Captured) => {
      urls.push(url)
      inits.push({ tls: init?.tls, headers: init?.headers as Record<string, string> | undefined })
      hop += 1
      if (hop === 1) {
        return new Response(null, { status: 302, headers: { location: '/article/bar' } })
      }
      return new Response('done', { status: 200, headers: { 'content-type': 'text/plain' } })
    }) as unknown as typeof fetch
    await webFetch(
      { url: 'https://en.wikipedia.org/article/foo' },
      {
        manifest: withBrowseManifest(),
        fetcher,
        lookup: poisonedLookup({ 'en.wikipedia.org': '93.184.216.34' }),
      },
    )
    expect(urls.length).toBe(2)
    // Hop 1: original path on pinned IP.
    expect(new URL(urls[0]!).pathname).toBe('/article/foo')
    expect(new URL(urls[0]!).hostname).toBe('93.184.216.34')
    // Hop 2: redirected path on pinned IP — the path comes from
    // resolving the relative Location against the ORIGINAL hostname
    // (wikipedia.org), not against the first hop's pinned URL.
    expect(new URL(urls[1]!).pathname).toBe('/article/bar')
    expect(new URL(urls[1]!).hostname).toBe('93.184.216.34')
    // BOTH hops MUST still send SNI=en.wikipedia.org — if Location
    // resolution had used the pinned URL, hop 2's serverName would
    // have been '93.184.216.34' (URL.hostname of the pinned URL).
    expect(inits[0]!.tls?.serverName).toBe('en.wikipedia.org')
    expect(inits[1]!.tls?.serverName).toBe('en.wikipedia.org')
  })

  test('webFetch: redirect-followed response body is cancelled before next hop (no dangling stream)', async () => {
    // The 30x response body is unconsumed by webFetch (we only read
    // Location). Without an explicit cancel, the underlying socket
    // stays half-open after redirect chain advances. We assert the
    // cancel callback fires positively.
    let firstHopCancelled = false
    let hop = 0
    const fetcher = (async () => {
      hop += 1
      if (hop === 1) {
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode('redirect-body'))
            controller.close()
          },
          cancel() { firstHopCancelled = true },
        })
        return new Response(stream, {
          status: 302,
          headers: { location: 'https://arxiv.org/abs/1', 'content-type': 'text/html' },
        })
      }
      return new Response('done', { status: 200, headers: { 'content-type': 'text/plain' } })
    }) as unknown as typeof fetch
    await webFetch(
      { url: 'https://en.wikipedia.org/x' },
      {
        manifest: withBrowseManifest(),
        fetcher,
        lookup: poisonedLookup({
          'en.wikipedia.org': '93.184.216.34',
          'arxiv.org': '208.80.154.224',
        }),
      },
    )
    expect(firstHopCancelled).toBe(true)
  })

  test('webFetch: content-type-rejected response body is cancelled before throw', async () => {
    let cancelled = false
    const fetcher = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode('PNG-bytes'))
          controller.close()
        },
        cancel() { cancelled = true },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'image/png' } })
    }) as unknown as typeof fetch
    await expect(
      webFetch(
        { url: 'https://en.wikipedia.org/x.png' },
        { manifest: withBrowseManifest(), fetcher, lookup: publicLookup() },
      ),
    ).rejects.toThrow(BlockedDestinationError)
    expect(cancelled).toBe(true)
  })

  test('webFetch: IP-literal host path skips pinning (URL unchanged, no tls options)', async () => {
    // IP literals already passed `isUnconditionallyBlocked` — no DNS
    // to pin. The fetcher must see the literal URL unchanged + no tls
    // pin options, so the runtime handles the connect directly.
    let capturedUrl: string | undefined
    type Captured = { tls?: unknown; headers?: Record<string, string> | undefined }
    let captured: Captured | undefined
    const fetcher = (async (url: string, init?: RequestInit & Captured) => {
      capturedUrl = url
      captured = { tls: init?.tls, headers: init?.headers as Record<string, string> | undefined }
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })
    }) as unknown as typeof fetch
    await webFetch(
      { url: 'http://1.1.1.1/', allowlist: ['1.1.1.1'] },
      {
        manifest: withBrowseManifest(),
        fetcher,
        lookup: async () => { throw new Error('lookup must not be called for IP literals') },
      },
    )
    expect(capturedUrl).toBe('http://1.1.1.1/')
    expect(captured?.tls).toBeUndefined()
    expect(captured?.headers).toBeUndefined()
  })

  test('webFetch: returns the ORIGINAL hostname in final_url, not the pinned IP', async () => {
    // The caller's `final_url` is for display/citations/logs. It MUST
    // remain the canonical original URL, not the rewritten pinned URL
    // (otherwise a citation in a research brief would show
    // `https://93.184.216.34/...` instead of `https://en.wikipedia.org/...`).
    const fetcher = (async () =>
      new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch
    const result = await webFetch(
      { url: 'https://en.wikipedia.org/article/foo' },
      {
        manifest: withBrowseManifest(),
        fetcher,
        lookup: poisonedLookup({ 'en.wikipedia.org': '93.184.216.34' }),
      },
    )
    expect(result.final_url).toBe('https://en.wikipedia.org/article/foo')
    expect(result.url).toBe('https://en.wikipedia.org/article/foo')
  })
})

// Real-fetch sanity test — opt-in via `NEUTRON_E2E_NETWORK=1`. Skipped
// by default because it depends on the public Internet (CI may not
// have stable network). Operationally PROVES the pin works under Bun
// — without this, the unit tests above only verify the pin-shape
// contract (which mocks could lie about).
const runRealFetch = process.env.NEUTRON_E2E_NETWORK === '1'
describe.skipIf(!runRealFetch)('webFetch — ISSUE #25 real-fetch closing condition (opt-in NEUTRON_E2E_NETWORK=1)', () => {
  test('real-fetch: pin example.com to its real IP — succeeds with body', async () => {
    // Pre-flight resolves example.com → real IP via the real resolver.
    // The pin rewrites the URL to that IP. Fetch succeeds; cert
    // validation passes against `example.com` via tls.serverName +
    // tls.checkServerIdentity.
    const result = await webFetch(
      { url: 'https://www.example.com/', allowlist: ['example.com'] },
      { manifest: withBrowseManifest() },
    )
    expect(result.status).toBe(200)
    expect(result.body_text).toContain('Example Domain')
    expect(result.final_url).toBe('https://www.example.com/')
  }, 15000)

  test('real-fetch: poisoned-A-record sinkhole IP — fetch times out (proves pin dials the IP, NOT DNS)', async () => {
    // Simulate the rebind attack: synthetic lookup returns the unroutable
    // sinkhole IP 203.0.113.1 (TEST-NET-3, guaranteed unreachable).
    // If the pin works, fetch attempts to connect to 203.0.113.1 and
    // times out (the SSRF DNS check approves the IP because TEST-NET-3
    // isn't in the RFC-1918 blocklist — wrong defense surface for
    // unroutable but technically-public space). If the pin DIDN'T
    // work, Bun would re-resolve example.com to the real public IP
    // and the fetch would succeed.
    const lookup: DnsLookupFn = async () => [{ address: '203.0.113.1', family: 4 }]
    await expect(
      webFetch(
        { url: 'https://www.example.com/', allowlist: ['example.com'], timeout_ms: 3000 },
        { manifest: withBrowseManifest(), lookup },
      ),
    ).rejects.toThrow(/timeout/)
  }, 10000)
})

function stubFetcher(
  opts: { body?: string; content_type?: string; status?: number } = {},
): typeof fetch {
  const body = opts.body ?? 'ok'
  const ct = opts.content_type ?? 'text/plain'
  const status = opts.status ?? 200
  const fn = (async () =>
    new Response(body, { status, headers: { 'content-type': ct } })) as unknown as typeof fetch
  return fn
}

function redirectingFetcher(location: string): typeof fetch {
  let hop = 0
  const fn = (async () => {
    hop += 1
    if (hop === 1) {
      return new Response(null, { status: 302, headers: { location } })
    }
    return new Response('done', { status: 200, headers: { 'content-type': 'text/plain' } })
  }) as unknown as typeof fetch
  return fn
}

/**
 * Synthetic resolver that returns a fixed public-shaped IP for any
 * hostname. Used by the bulk of the test suite so DNS lookups don't
 * touch the real network and the existing assertions (allowlist,
 * redirect string check, content-type, etc.) keep their narrow scope.
 */
function publicLookup(): DnsLookupFn {
  return async () => [{ address: '93.184.216.34', family: 4 }] // example.com
}

/**
 * Synthetic poisoned resolver — drives the ISSUES #21 closing condition.
 * Returns the IP from `map` for matching hostnames; throws for unknown
 * hosts so a forgotten mapping is loud, not silently public.
 */
function poisonedLookup(map: Record<string, string>): DnsLookupFn {
  return async (host) => {
    const ip = map[host.toLowerCase()]
    if (ip === undefined) {
      throw new Error(`poisonedLookup: no entry for ${host} (test author bug)`)
    }
    const family = ip.includes(':') ? 6 : 4
    return [{ address: ip, family }]
  }
}
