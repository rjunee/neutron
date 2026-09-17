import type { PtyChild, PtyHost } from '../pty-host.ts'
import { bakedChildSinkInfo } from '../persistent-repl-substrate.ts'

/** Ordered transcript of what the substrate did to the REPL: each PTY `write`
 *  (captures the `/clear`) and each dev-channel `/message` inject, in order. */
export type Timeline = Array<
  { kind: 'write'; data: string } | { kind: 'key'; key: string } | { kind: 'message'; text: string }
>

/** A fake `claude`+dev-channel that (a) echoes each /message back as a /reply and
 *  (b) records every raw PTY `write()` into a shared timeline, so a test can assert
 *  a `/clear` was written before a reused turn's inject. `seen` increments per turn
 *  within one REPL (the warm-reuse signal). */
export function makeRecordingHost(failSubmit?: string): {
  host: PtyHost
  spawnCount: () => number
  timeline: Timeline
  spawnArgv: string[][]
} {
  let spawns = 0
  const timeline: Timeline = []
  const spawnArgv: string[][] = []
  const host: PtyHost = {
    async spawn(argv: string[]): Promise<PtyChild> {
      spawns += 1
      spawnArgv.push([...argv])
      const pid = 200000 + spawns
      const i = argv.indexOf('--session-id')
      const r = argv.indexOf('--resume')
      const sid = (i >= 0 ? argv[i + 1] : r >= 0 ? argv[r + 1] : undefined) as string
      const { port: sinkPort, token } = bakedChildSinkInfo(argv)
      let hasExited = false
      let exitResolve: (code: number | null) => void = () => {}
      const exited = new Promise<number | null>((res) => {
        exitResolve = res
      })
      const post = (path: string, body: unknown): Promise<unknown> =>
        fetch(`http://127.0.0.1:${sinkPort}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Sink-Token': token },
          body: JSON.stringify(body),
        }).catch(() => undefined)
      let seen = 0
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        async fetch(req) {
          const url = new URL(req.url)
          if (url.pathname === '/health') return Response.json({ ok: true })
          if (req.method === 'POST' && url.pathname === '/message') {
            const body = (await req.json()) as { text: string; turn_id?: string }
            timeline.push({ kind: 'message', text: body.text })
            const reply = `seen=${seen} got=${body.text}`
            seen += 1
            void post('/reply', { session_id: sid, text: reply, turn_id: body.turn_id })
            return Response.json({ status: 'delivered' })
          }
          return new Response('nf', { status: 404 })
        },
      })
      void post('/channel-ready', { session_id: sid, channel_port: server.port, pid })
      void post('/channel-bound', { session_id: sid })
      return {
        pid,
        write(data: string | Uint8Array) {
          timeline.push({
            kind: 'write',
            data: typeof data === 'string' ? data : Buffer.from(data).toString('utf8'),
          })
        },
        // § herdr step 2b — the submit is a separate key; `pane.send_text` never
        // submits. Recorded so `CLEARS` can require the pair.
        writeKey(key) {
          timeline.push({ kind: 'key', key })
        },
        // The acknowledged pair — see `submitCommand`.
        async submitLine(command: string) {
          // A backend that REFUSES. The point of an acknowledged submit is that this
          // is distinguishable from a delivered one; the fire-and-forget pair it
          // replaces recorded both identically.
          if (failSubmit !== undefined) throw new Error(failSubmit)
          timeline.push({ kind: 'write', data: command })
          timeline.push({ kind: 'key', key: 'enter' })
        },
        kill() {
          if (hasExited) return
          hasExited = true
          try {
            server.stop(true)
          } catch {
            /* ignore */
          }
          exitResolve(143)
        },
        exited,
        hasExited: () => hasExited,
      }
    },
  }
  return { host, spawnCount: () => spawns, timeline, spawnArgv }
}
