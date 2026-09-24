import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

/** Select the parser from the admitted command/runner, never from output parse success. */
async function failureFormat(command: string, worktree?: string): Promise<'bun' | 'generic'> {
  const bun = /\bbun\s+test\b|(?:^|[ /])run-tests\.sh\b/
  if (bun.test(command)) return 'bun'
  if (worktree) {
    const script = command.match(/(?:^|\s)(?:bash|sh)\s+([\w./-]+\.sh)(?:\s|$)/)?.[1]
    if (script) {
      const path = resolve(worktree, script)
      if (path.startsWith(`${resolve(worktree)}${sep}`)) {
        try { if (bun.test(await readFile(path, 'utf8'))) return 'bun' } catch { /* Unreadable generic runner has no inferred parser. */ }
      }
    }
  }
  return 'generic'
}

/** Fatal runner markers: any of these voids failure identity. */
const FATAL = /^\s*(?:[1-9]\d* errors?\b|(?:error: )?(?:Cannot find module\b|ModuleNotFoundError:|SyntaxError:|Unhandled(?:PromiseRejection| exception| error)|Segmentation fault\b|SIG(?:KILL|SEGV|ABRT)\b|run-tests: FATAL\b|panic:|Killed\b))/
/** An error line; its trimmed text joins the failure identity. */
const ERROR_LINE = /^\s*(?:error|[A-Z]\w*Error):/
/** Line-start forms of every pattern the parser acts on. An oversized line whose
 * first 16 KiB matches none of them is diagnostic noise (a 21 KB
 * `[trident] event=mutation_proof_exempt ...` line, a JSON blob, a stack frame):
 * it is skipped without voiding the suite's failure identity. A prefix that
 * could itself be a failure, file-header, count, bookkeeping, error or fatal
 * line still voids identity, because its tail was not read. */
const LOAD_BEARING_PREFIXES = [/^\s*$/, /^bun test v/, /^\d+ tests? failed:/, /^Ran \d+ tests? across/, /^\s*\d+ fail\b/, FATAL, ERROR_LINE,
  /^.+\.(?:test|spec)\.[cm]?[jt]sx?:\s*$/, /^\(fail\) /]
const oversizedLineIsLoadBearing = (prefix: string): boolean => {
  const line = prefix.replace(/\x1b\[[0-9;]*m/g, '')
  return LOAD_BEARING_PREFIXES.some(pattern => pattern.test(line))
}

/** Stable named Bun failures, excluding timings, revision, round and log paths.
 * Generic runner evidence remains reviewer-adjudicated; failed Bun parsing does
 * not change the host-selected runner policy into that generic exemption. */
export async function suiteFailure(logPath: string, command: string, worktree?: string): Promise<{ hostFailureId?: string; hostDiagnostics: string; hostFailureFormat: 'bun' | 'generic' }> {
  const hostFailureFormat = await failureFormat(command, worktree)
  const failures = new Set<string>()
  const errors = new Set<string>()
  let file = ''
  let tail = ''
  let overflow = false
  let started = 0
  let finished = 0
  let failed = 0
  let reported = 0
  let summaryList = false
  const consume = (raw: string) => {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '')
    if (/^bun test v/.test(line)) { started++; summaryList = false; file = '' }
    if (/^\d+ tests? failed:/.test(line)) summaryList = true
    if (/^Ran \d+ tests? across \d+ files?\./.test(line)) finished++
    const count = line.match(/^\s*(\d+) fail\s*$/)
    if (count) reported += Number(count[1])
    if (FATAL.test(line)) overflow = true
    if (ERROR_LINE.test(line)) {
      if (errors.size >= 200) overflow = true
      else errors.add(line.trim())
    }
    const header = line.match(/^(.+\.(?:test|spec)\.[cm]?[jt]sx?):\s*$/)
    if (header) file = header[1]!
    const failure = line.match(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?\s*$/)
    if (failure && !summaryList) {
      failed++
      if (!file) overflow = true
      if (failures.size >= 200) overflow = true
      else failures.add(`${file}: ${failure[1]}`)
    }
  }
  try {
    let pending = ''
    let oversized = false
    for await (const chunk of createReadStream(logPath, { encoding: 'utf8' })) {
      tail = `${tail}${chunk}`.slice(-6000)
      const lines = String(chunk).split('\n')
      for (let index = 0; index < lines.length; index++) {
        pending += lines[index]
        if (pending.length > 16384) {
          if (!oversized && oversizedLineIsLoadBearing(pending.slice(0, 16384))) overflow = true
          pending = ''; oversized = true
        }
        if (index < lines.length - 1) {
          if (!oversized) consume(pending.replace(/\r$/, ''))
          pending = ''; oversized = false
        }
      }
    }
    if (!oversized && pending) consume(pending)
  } catch (error) { overflow = true; tail = `Log unavailable: ${String(error)}` }
  const names = [...failures].sort()
  const hostFailureId = hostFailureFormat === 'bun' && names.length > 0 && !overflow
    && started > 0 && started === finished && failed === reported
    ? `host-suite:${createHash('sha256').update(JSON.stringify([command, names, [...errors].sort()])).digest('hex')}` : undefined
  return {
    ...(hostFailureId ? { hostFailureId } : {}),
    hostFailureFormat,
    hostDiagnostics: `Host full suite log: ${logPath}\n${hostFailureId ? `Failure identity: ${hostFailureId}\nNamed failures:\n${names.join('\n')}\n` : hostFailureFormat === 'generic' ? 'Generic runner: the panel must verify the named failures and targeted base comparison.\n' : 'Complete Bun failure identity unavailable; this receipt cannot earn a pre-existing-red exemption.\n'}Log tail:\n${tail}`,
  }
}
