import { stripDocQuotes } from './output-scan.ts'
import { stripAnsi } from './pty-text.ts'

/** An observation, never a conclusion drawn from a clock or a live pid. */
export interface WorkerObservation {
  state: 'blocked' | 'working' | 'unknown'
  observed_at: string
  detail: string
  screen: string
}

/**
 * A CAPTURE ENDS IN BLANK VIEWPORT ROWS, AND THAT IS NOT THE END OF THE SCREEN.
 *
 * `pane.read` returns the viewport, and a dialog drawn part-way up a 54-row pane
 * comes back with every remaining row blank — MEASURED on four live panes: the
 * tool-permission prompt's capture carried twelve trailing blank rows after
 * `Esc to cancel · Tab to amend`. Every window below is anchored on the last
 * line that has content, so a footer instruction and the working chrome are both
 * reachable. Anchoring on the raw last line reads padding and classifies every
 * real screen `unknown`, which is what the first version of this file did.
 */
function contentLines(screen: string): string[] {
  const lines = stripAnsi(screen).split('\n').map((line) => line.replace(/\r/g, ''))
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
  return lines
}

/**
 * Claude Code's dialog chrome, as the CLI actually prints it. `Enter to confirm`
 * is the trust dialog (#751); `Esc to cancel · Tab to amend` is the tool-use
 * permission prompt, which is the shape #754 was filed on and which the
 * `enter to select` wording alone does not match. Verbs are listed rather than
 * globbed so ordinary prose ending in "to continue" cannot stand in for a dialog.
 */
const DIALOG_INSTRUCTION = /\b(?:enter|esc|tab)\s+to\s+(?:select|confirm|continue|cancel|reject|exit|amend)\b/i

/** Retain a bounded, line-structured capture even when it cannot be classified. */
export function observeWorkerScreen(
  screen: string,
  rendered: boolean,
  now = Date.now(),
): WorkerObservation {
  const tail = contentLines(screen).slice(-54).join('\n').slice(-8000)
  const observation: WorkerObservation = {
    state: 'unknown', observed_at: new Date(now).toISOString(), screen: tail,
    detail: rendered ? 'no recognized live prompt or working indicator' : 'byte history is not a current rendered screen',
  }
  if (!rendered) return observation
  // Strip fences before windowing, so a fence opened above the retained tail
  // cannot turn a quoted menu into a live one.
  const lines = stripDocQuotes(contentLines(screen)).slice(-54)
  const footer = lines.slice(-6).join(' ')
  // Working chrome vetoes menu text in scrollback. Merely being alive, or idle
  // at the normal input cursor, does not establish that a worker is working.
  if (/esc\s+to\s+interrupt/i.test(footer)) {
    return { ...observation, state: 'working', detail: 'live interrupt control is visible' }
  }
  // A normal empty input cursor after a quoted menu makes the menu history.
  if (lines.slice(-6).some((line) => /^❯\s*$/.test(line.trim()))) return observation
  // A LIVE SELECTION CURSOR IS NOT ENOUGH BY ITSELF: the composer draws `❯ <typed
  // text>` on a pane that is working or idle, so requiring only the cursor would
  // report a healthy worker blocked. A dialog additionally has at least one
  // SIBLING OPTION under the selected one, and prints its own key instruction.
  const cursor = lines.findLastIndex((line) => /^❯\s+\S/.test(line.trimStart()))
  if (cursor === -1) return observation
  const sibling = lines.slice(cursor + 1, cursor + 6).some((line) =>
    /^\s+\S/.test(line) && !/^[\s─│╭╰⏵●◯]+$/.test(line) && !DIALOG_INSTRUCTION.test(line))
  // The verb list is what keeps the composer's own `shift+tab to cycle` hint out:
  // `cycle` is not a dialog verb. Widen the verbs and this control loses its force.
  const instructed = DIALOG_INSTRUCTION.test(footer)
  if (sibling && instructed) {
    return { ...observation, state: 'blocked', detail: 'interactive selection awaits a keypress' }
  }
  return observation
}

/**
 * A capture that could not be TAKEN is unknown — never working, never blocked.
 * "I could not look" and "I looked and saw nothing" share a state here only
 * because both are unknown; they never share one with either positive state.
 */
export function unclassifiedObservation(detail: string, now = Date.now()): WorkerObservation {
  return { state: 'unknown', observed_at: new Date(now).toISOString(), detail, screen: '' }
}

export function describeWorkerObservation(o: WorkerObservation): string {
  return `worker=${o.state}; observed_at=${o.observed_at}; ${o.detail}; last screen:\n${o.screen || '(capture empty)'}`
}
