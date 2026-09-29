/**
 * STRICT TASK-LEDGER DECODER (test support).
 *
 * Decodes a deliberately narrow synthetic ledger grammar into an ordered list
 * of `{ label, completed }` tasks, and summarizes a decoded ledger. This is a
 * fixture format for build E2E assertions, NOT the production plan parser
 * (which is intentionally looser) and it imports nothing from the harness.
 *
 * Grammar, exactly:
 *   - one or more task lines separated by a single LF, with at most ONE
 *     optional trailing LF;
 *   - each line is `- [ ] LABEL` (unchecked) or `- [x] LABEL` (checked,
 *     lowercase only);
 *   - LABEL is nonempty, has no leading or trailing whitespace, contains no
 *     CR, LF or other control character (U+0000-U+001F, U+007F), and is unique
 *     by exact string equality within the ledger.
 *
 * Labels are retained byte-for-byte: no trimming, case folding or whitespace
 * collapsing. Pure: the input is only read, fresh objects are returned on
 * every call, and `decodeLedger` never throws. Rejection reasons name the
 * violated rule and a zero-based line index only, never any input bytes.
 */

export interface LedgerTask {
  readonly label: string
  readonly completed: boolean
}

export interface DecodedLedger {
  readonly tasks: readonly LedgerTask[]
}

export interface LedgerSummary {
  readonly completed: number
  readonly remaining: number
  readonly firstUnchecked: string | null
}

export type LedgerDecodeResult =
  | { readonly ok: true; readonly ledger: DecodedLedger }
  | { readonly ok: false; readonly reason: string }

const UNCHECKED_PREFIX = '- [ ] '
const CHECKED_PREFIX = '- [x] '

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function reject(reason: string): LedgerDecodeResult {
  return { ok: false, reason }
}

export function decodeLedger(input: unknown): LedgerDecodeResult {
  if (typeof input !== 'string') return reject('input is not a string')
  if (input.length === 0) return reject('input is empty')
  const body = input.endsWith('\n') ? input.slice(0, -1) : input
  const lines = body.split('\n')
  const tasks: LedgerTask[] = []
  const seen = new Set<string>()
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (line.trim().length === 0) return reject(`line ${index}: blank line`)
    let completed: boolean
    if (line.startsWith(UNCHECKED_PREFIX)) completed = false
    else if (line.startsWith(CHECKED_PREFIX)) completed = true
    else return reject(`line ${index}: malformed task line`)
    const label = line.slice(UNCHECKED_PREFIX.length)
    if (label.length === 0) return reject(`line ${index}: empty label`)
    if (hasControlCharacter(label)) return reject(`line ${index}: label contains a control character`)
    if (label !== label.trim()) return reject(`line ${index}: label has leading or trailing whitespace`)
    if (seen.has(label)) return reject(`line ${index}: duplicate label`)
    seen.add(label)
    tasks.push({ label, completed })
  }
  return { ok: true, ledger: { tasks } }
}

export function summarizeLedger(ledger: DecodedLedger): LedgerSummary {
  let completed = 0
  let remaining = 0
  let firstUnchecked: string | null = null
  for (const task of ledger.tasks) {
    if (task.completed) {
      completed += 1
      continue
    }
    remaining += 1
    if (firstUnchecked === null) firstUnchecked = `${UNCHECKED_PREFIX}${task.label}`
  }
  return { completed, remaining, firstUnchecked }
}
