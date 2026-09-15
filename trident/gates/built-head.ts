export const BUILT_HEAD_READ_ATTEMPTS = 3

export interface BuiltHeadDependencies {
  forgeBranch: string
  repoPath: string
  shSingleQuote(value: string): string
  seatAttempt<T>(label: string, operation: () => Promise<T>): Promise<T | null>
  agent(prompt: string, options: unknown): Promise<any>
  withModel(options: unknown): unknown
  normalizeOid(value: unknown): string
  log(message: string): void
  branchHeadSchema: unknown
}

/** Bind the workflow capabilities used by the unchanged built-head gate. */
export function createBuiltHeadGate(deps: BuiltHeadDependencies) {
  const { forgeBranch, repoPath, shSingleQuote, seatAttempt, agent, withModel, normalizeOid, log } = deps
  const BRANCH_HEAD_SCHEMA = deps.branchHeadSchema

  return async function readBuiltHead(tag: string): Promise<string> {
    const ref = shSingleQuote(`refs/heads/${forgeBranch}^{commit}`)
    const cmd = `cd ${shSingleQuote(repoPath)} && { git rev-parse --verify --quiet ${ref} || { git rev-parse --git-dir >/dev/null 2>&1 && echo absent; }; }`
    for (let attempt = 1; attempt <= BUILT_HEAD_READ_ATTEMPTS; attempt++) {
      const res = await seatAttempt(`head-probe-round-built-${tag}`, () =>
        agent(
          `Run EXACTLY this single Bash command and report the ONE token it prints via the schema — a full 40- or 64-character sha, or the literal word absent. Report head='' if it prints nothing or errors. Do NOT interpret the value, do NOT run anything else, do NOT modify any file.\n${cmd}`,
          withModel({ label: `head-probe-round-built-${tag}`, phase: 'Build', schema: BRANCH_HEAD_SCHEMA }),
        ),
      )
      const raw = (res && typeof res.head === 'string' ? res.head : '').trim().toLowerCase()
      if (raw === 'absent') return 'absent'
      const head = normalizeOid(raw)
      if (head !== '') return head
      log(`trident-v2 head-probe-round-built-${tag}: attempt ${attempt}/${BUILT_HEAD_READ_ATTEMPTS} did not return a head (${res === null ? 'seat died' : 'empty/garbled answer'})`)
    }
    return ''
  }
}
