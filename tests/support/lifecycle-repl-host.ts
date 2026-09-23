import { bakedChildSinkInfo } from '@neutronai/runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts'
import type { PtyChild, PtyHost, PtySpawnOpts } from '@neutronai/runtime/adapters/claude-code/persistent/pty-host.ts'

/** Real dev-channel HTTP peer behind an in-memory process boundary. Lifecycle
 * tests assert actual child kills, not merely an option named "ephemeral". */
export function lifecycleReplHost() {
  const children: Array<{ child: PtyChild; sessionId: string; prompts: string[] }> = []
  let replyGate: (() => Promise<void>) | undefined
  const host: PtyHost = {
    async spawn(argv: string[], _opts: PtySpawnOpts): Promise<PtyChild> {
      const index = argv.indexOf('--session-id')
      const sessionId = argv[index >= 0 ? index + 1 : argv.indexOf('--resume') + 1]!
      const { port, token } = bakedChildSinkInfo(argv)
      const pid = 780000 + children.length
      const prompts: string[] = []
      let dead = false
      let resolveExit!: (code: number | null) => void
      const exited = new Promise<number | null>(resolve => { resolveExit = resolve })
      const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sink-Token': token },
        body: JSON.stringify(body),
      })
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          const path = new URL(request.url).pathname
          if (path === '/health') return Response.json({ ok: true })
          if (path !== '/message') return new Response('missing', { status: 404 })
          const body = await request.json() as { text: string; turn_id: string }
          prompts.push(body.text)
          void (async () => {
            await replyGate?.()
            if (!dead) await post('/reply', { session_id: sessionId,
              text: 'Time to stretch.', turn_id: body.turn_id })
          })()
          return Response.json({ status: 'delivered' })
        },
      })
      const child: PtyChild = {
        pid, exited, hasExited: () => dead, wasKilledByUs: () => dead,
        write() {}, resize() {},
        kill() { if (!dead) { dead = true; server.stop(true); resolveExit(0) } },
      }
      children.push({ child, sessionId, prompts })
      void post('/channel-ready', { session_id: sessionId, channel_port: server.port, pid })
        .then(() => post('/channel-bound', { session_id: sessionId }))
      return child
    },
  }
  return { host, children, holdReplies(gate?: () => Promise<void>) { replyGate = gate } }
}
