import { stripDocQuotes } from './output-scan.ts'
import { stripAnsi } from './pty-text.ts'

/** An observation, never a conclusion drawn from a clock or a live pid. */
export interface WorkerObservation {
  state: 'blocked' | 'working' | 'unknown'
  observed_at: string
  detail: string
  screen: string
}

/** Retain a bounded, line-structured capture even when it cannot be classified. */
export function observeWorkerScreen(
  screen: string,
  rendered: boolean,
  now = Date.now(),
): WorkerObservation {
  const tail = stripAnsi(screen).split('\n').slice(-54).join('\n').slice(-8000)
  const observation: WorkerObservation = {
    state: 'unknown', observed_at: new Date(now).toISOString(), screen: tail,
    detail: rendered ? 'no recognized live prompt or working indicator' : 'byte history is not a current rendered screen',
  }
  if (!rendered) return observation
  // Strip fences before windowing, so a fence opened above the retained tail
  // cannot turn a quoted menu into a live one.
  const ctx = { lines: stripDocQuotes(stripAnsi(screen).split('\n')).slice(-54) }
  // Working chrome vetoes menu text in scrollback. Merely being alive, or idle
  // at the normal input cursor, does not establish that a worker is working.
  if (/esc\s+to\s+interrupt/i.test(ctx.lines.slice(-4).join(' '))) {
    return { ...observation, state: 'working', detail: 'live interrupt control is visible' }
  }
  // A normal empty input cursor after a quoted menu makes the menu history.
  if (ctx.lines.slice(-4).some((line) => /^❯\s*$/.test(line.trim()))) return observation
  const footer = ctx.lines.slice(-4).join(' ')
  const cursor = ctx.lines.slice(-34, -1).some((line) => /^❯\s*\S/.test(line.trimStart()))
  // Require both a live selection cursor and an explicit input instruction.
  // This covers numbered and unnumbered menus without guessing their wording.
  if (cursor && /enter\s+to\s+(?:select|confirm|continue)/i.test(footer)) {
    return { ...observation, state: 'blocked', detail: 'interactive selection awaits Enter' }
  }
  return observation
}

export function describeWorkerObservation(o: WorkerObservation): string {
  return `worker=${o.state}; observed_at=${o.observed_at}; ${o.detail}; last screen:\n${o.screen || '(capture empty)'}`
}
