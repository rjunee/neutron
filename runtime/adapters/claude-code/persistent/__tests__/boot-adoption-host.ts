/**
 * boot-adoption-host.ts — a fake {@link AdoptableHost} for the #539 suites.
 *
 * IT CAN FAIL IN EVERY DIRECTION THE REAL ONE CAN, deliberately. A host that always
 * answers `live` with the argv the test wanted makes the refuse paths unreachable and
 * every "it adopts" case pass for the wrong reason; the levers below exist so a case
 * can drive a pane that is gone, a host that cannot be asked, an attach that fails
 * after the pane was claimed, and a close that closes nothing.
 */

import type {
  AdoptableHost,
  HandleInspection,
  PtyChild,
  PtySpawnOpts,
} from '../pty-host.ts'
import type { Key } from '../keystrokes.ts'

export interface FakePane {
  argv: string[]
  /** Screens this pane will deliver, in order, once `beginOutput()` is called. */
  screens: string[]
  pid: number
}

/** One attached child, with everything a test needs to see what was done to it. */
export interface FakeAttachedChild extends PtyChild {
  /** Every key sequence any detector sent — THE assertion surface for the trap. */
  readonly keysSent: Key[][]
  /** Deliver another screen, as the poll loop would. */
  push(screen: string): void
}

export class FakeAdoptableHost implements AdoptableHost {
  readonly panes = new Map<string, FakePane>()
  readonly closed: string[] = []
  readonly attached: FakeAttachedChild[] = []
  /** Force `inspectHandle` to answer this regardless of pane state. */
  inspectOverride: HandleInspection | undefined
  /** Make `attach` reject. */
  attachError: Error | undefined
  /** Make `closeHandle` reject — a close that closes nothing. */
  closeError: Error | undefined
  /** Make the attached child's `beginOutput` throw, standing in for anything between
   *  the attach and the pool insert that can fail after a child exists. */
  beginOutputError: Error | undefined
  /** Held until released, so a test can drive the in-flight window. */
  private attachHold: Promise<void> | undefined
  private releaseAttach: (() => void) | undefined

  holdAttach(): () => void {
    this.attachHold = new Promise<void>((res) => {
      this.releaseAttach = res
    })
    return () => this.releaseAttach?.()
  }

  addPane(handle: string, pane: FakePane): void {
    this.panes.set(handle, pane)
  }

  async spawn(): Promise<PtyChild> {
    throw new Error('fake-adoptable-host: spawn is not part of these cases')
  }

  async inspectHandle(handle: string): Promise<HandleInspection> {
    if (this.inspectOverride !== undefined) return this.inspectOverride
    const pane = this.panes.get(handle)
    if (pane === undefined) return { kind: 'gone' }
    return { kind: 'live', argv: pane.argv, pid: pane.pid, label: 'neutron-repl' }
  }

  async attach(handle: string, opts: PtySpawnOpts): Promise<PtyChild> {
    if (this.attachHold !== undefined) await this.attachHold
    if (this.attachError !== undefined) throw this.attachError
    const pane = this.panes.get(handle)
    if (pane === undefined) throw new Error(`fake-adoptable-host: pane ${handle} does not exist`)
    let exited = false
    let killed = false
    let resolveExit: (v: number | null) => void = () => {}
    const exitedPromise = new Promise<number | null>((res) => {
      resolveExit = res
    })
    const keysSent: Key[][] = []
    const child: FakeAttachedChild = {
      pid: pane.pid,
      paneHandle: handle,
      keysSent,
      write: () => {},
      writeKey: (key: Key) => keysSent.push([key]),
      writeKeys: (keys: readonly Key[]) => keysSent.push([...keys]),
      kill: () => {
        killed = true
        exited = true
        resolveExit(null)
      },
      exited: exitedPromise,
      hasExited: () => exited,
      wasKilledByUs: () => killed,
      beginOutput: () => {
        if (this.beginOutputError !== undefined) throw this.beginOutputError
        for (const s of pane.screens) opts.onScreen?.(s)
      },
      push: (screen: string) => opts.onScreen?.(screen),
    }
    this.attached.push(child)
    return child
  }

  async closeHandle(handle: string): Promise<void> {
    if (this.closeError !== undefined) throw this.closeError
    this.panes.delete(handle)
    this.closed.push(handle)
  }
}
