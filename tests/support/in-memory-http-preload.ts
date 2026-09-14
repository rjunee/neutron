// Test-only preload for execution environments without listening sockets.
// Routes real Request/Response objects through registered Bun.serve handlers.
// Use with bun test --preload ./tests/support/in-memory-http-preload.ts.
const servers = new Map<number, { fetch: (request: Request) => Response | Promise<Response> }>()
let nextPort = 40000
Bun.serve = ((options: { port?: number; fetch: (request: Request) => Response | Promise<Response> }) => {
  const port = options.port || nextPort++
  if (servers.has(port)) throw new Error('test port already bound')
  servers.set(port, options)
  return { port, stop: () => servers.delete(port), unref() {} }
}) as unknown as typeof Bun.serve
globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
  const request = input instanceof Request ? input : new Request(String(input), init)
  const server = servers.get(Number(new URL(request.url).port))
  if (!server) throw new Error('No in-memory HTTP server registered for request')
  return server.fetch(request)
}) as typeof fetch
