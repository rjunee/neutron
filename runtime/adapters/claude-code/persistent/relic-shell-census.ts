import { readFileSync, readdirSync, statSync } from 'node:fs'

export interface RelicProcReader {
  read(path: string): string
  list(path: string): string[]
  uid(path: string): number
}
const kernel: RelicProcReader = {
  read: path => readFileSync(path, 'utf8'), list: path => readdirSync(path), uid: path => statSync(path).uid,
}
export interface RelicShellIdentity { pid: number; startTicks: string; bootId: string; session: number; tty: number; uid: number }

/** Input must already be held. A shell-looking foreground is not proof that its
 * background jobs have ended. Any unreadable possible member refuses cleanup. */
export function inspectIdleRelicShell(pid: number, proc: RelicProcReader = kernel, expectedUid = process.getuid?.()): RelicShellIdentity | undefined {
  try {
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
    const procMount = () => {
      const raw = proc.read('/proc/self/mountinfo')
      if (raw.length > 4 * 1024 * 1024) throw new Error('mount observation too large')
      const mounts = raw.trim().split('\n').map(line => line.split(' '))
      const roots = mounts.filter(fields => fields[4] === '/proc')
      if (roots.length !== 1) throw new Error('proc mount ambiguous')
      const root = roots[0]!, separator = root.indexOf('-')
      if (root[3] !== '/' || separator < 6 || root[separator + 1] !== 'proc'
        || !root[5] || !root[separator + 3]) throw new Error('unverified proc mount')
      const options = [...root[5].split(','), ...root[separator + 3]!.split(',')]
      if (options.some(option => option === 'hidepid' || option.startsWith('hidepid=') && option !== 'hidepid=0')) {
        throw new Error('filtered proc visibility')
      }
      // A bind/overlay of one PID could hide a member despite an unfiltered root.
      if (mounts.some(fields => /^\/proc\/[0-9]+(?:\/|$)/.test(fields[4] ?? ''))) throw new Error('overmounted process evidence')
      return root.join(' ')
    }
    const mountedProc = procMount()
    const parse = (id: number) => {
      const raw = proc.read(`/proc/${id}/stat`), close = raw.lastIndexOf(')')
      if (raw.length > 8192 || close < 0 || raw.slice(0, raw.indexOf(' ')) !== String(id)) throw new Error('invalid process stat')
      const fields = raw.slice(close + 2).trim().split(/\s+/)
      if (fields.length < 20 || !/^\d+$/.test(fields[19]!)) throw new Error('invalid process stat')
      const parent = Number(fields[1]), session = Number(fields[3]), tty = Number(fields[4])
      if (![parent, session, tty].every(Number.isSafeInteger)) throw new Error('invalid process stat')
      return { parent, session, tty, startTicks: fields[19]! }
    }
    const bootId = proc.read('/proc/sys/kernel/random/boot_id').trim()
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(bootId)) return undefined
    const before = parse(pid), uid = proc.uid(`/proc/${pid}`)
    if (before.session !== pid || before.tty === 0 || uid !== expectedUid) return undefined
    const entries = proc.list('/proc').filter(entry => /^[1-9]\d*$/.test(entry))
    if (entries.length > 1_000_000) return undefined
    // Both subject and observer must actually be enumerated, not a partial/empty
    // mocked or inaccessible process directory that falsely proves absence.
    if (!entries.includes(String(pid)) || !entries.includes(String(process.pid))) return undefined
    for (const entry of entries) {
      const id = Number(entry)
      let observed: ReturnType<typeof parse>
      try { observed = parse(id) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      if (id !== pid && (observed.parent === pid || observed.session === before.session || observed.tty === before.tty)) return undefined
    }
    const after = parse(pid)
    if (JSON.stringify(before) !== JSON.stringify(after) || proc.uid(`/proc/${pid}`) !== uid
      || proc.read('/proc/sys/kernel/random/boot_id').trim() !== bootId || procMount() !== mountedProc) return undefined
    return { pid, startTicks: before.startTicks, bootId, session: before.session, tty: before.tty, uid }
  } catch { return undefined }
}
