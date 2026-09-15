#!/usr/bin/env bun

type PullRequest = { number: number }
type PullRequestFile = { filename: string; status: string }
type Event = { pull_request?: { number?: number; base?: { sha?: string } } }

const migrationPattern = /^migrations\/(\d{4})_[^/]+\.sql$/

export function addedOrdinals(files: PullRequestFile[]): Set<string> {
  return new Set(
    files.flatMap((file) => {
      const match = file.status === 'added' ? migrationPattern.exec(file.filename) : null
      const ordinal = match?.[1]
      return ordinal ? [ordinal] : []
    }),
  )
}

export function findOrdinalCollisions(
  currentNumber: number,
  filesByPullRequest: Map<number, PullRequestFile[]>,
): Array<{ ordinal: string; currentNumber: number; otherNumber: number }> {
  const ours = addedOrdinals(filesByPullRequest.get(currentNumber) ?? [])
  const collisions: Array<{ ordinal: string; currentNumber: number; otherNumber: number }> = []
  for (const [otherNumber, files] of filesByPullRequest) {
    if (otherNumber === currentNumber) continue
    for (const ordinal of addedOrdinals(files)) {
      if (ours.has(ordinal)) collisions.push({ ordinal, currentNumber, otherNumber })
    }
  }
  return collisions.sort((a, b) => a.ordinal.localeCompare(b.ordinal) || a.otherNumber - b.otherNumber)
}

export function skippedOrdinals(baseHighest: number, ours: Set<string>): string[] {
  return [...ours]
    .filter((ordinal) => Number.parseInt(ordinal, 10) > baseHighest + 1)
    .sort()
}

async function githubPages<T>(fetcher: typeof fetch, apiUrl: string, token: string, path: string): Promise<T[]> {
  const values: T[] = []
  for (let page = 1; ; page += 1) {
    const separator = path.includes('?') ? '&' : '?'
    const response = await fetcher(`${apiUrl}${path}${separator}per_page=100&page=${page}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` },
    })
    if (!response.ok) throw new Error(`GitHub API ${path} returned ${response.status}`)
    const pageValues = (await response.json()) as T[]
    if (!Array.isArray(pageValues)) throw new Error(`GitHub API ${path} did not return a list`)
    values.push(...pageValues)
    if (pageValues.length < 100) return values
  }
}

function highestBaseOrdinal(baseSha: string): number {
  const result = Bun.spawnSync(['git', 'ls-tree', '-r', '--name-only', baseSha, '--', 'migrations'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(`cannot read migrations from base ${baseSha}`)
  const ordinals = result.stdout
    .toString()
    .split('\n')
    .flatMap((path) => migrationPattern.exec(path)?.[1] ?? [])
    .map(Number)
  if (ordinals.length === 0) throw new Error(`parsed zero migrations from base ${baseSha}`)
  return Math.max(...ordinals)
}

export async function run(
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
  readEvent: (path: string) => Promise<Event> = async (path) => Bun.file(path).json(),
  baseHighestReader: (sha: string) => number = highestBaseOrdinal,
): Promise<{ errors: string[]; warnings: string[] }> {
  if (env.GITHUB_EVENT_NAME !== 'pull_request') return { errors: [], warnings: [] }
  const eventPath = env.GITHUB_EVENT_PATH
  const repository = env.GITHUB_REPOSITORY
  const token = env.GITHUB_TOKEN
  const apiUrl = env.GITHUB_API_URL ?? 'https://api.github.com'
  if (!eventPath || !repository || !token) throw new Error('missing GitHub event path, repository, or token')

  const event = await readEvent(eventPath)
  const currentNumber = event.pull_request?.number
  const baseSha = event.pull_request?.base?.sha
  if (!currentNumber || !baseSha) throw new Error('pull request event is missing its number or base SHA')

  const pulls = await githubPages<PullRequest>(fetcher, apiUrl, token, `/repos/${repository}/pulls?state=open`)
  if (!pulls.some((pull) => pull.number === currentNumber)) {
    throw new Error(`open pull request list did not contain current PR #${currentNumber}`)
  }

  const filesByPullRequest = new Map<number, PullRequestFile[]>()
  await Promise.all(
    pulls.map(async (pull) => {
      const files = await githubPages<PullRequestFile>(
        fetcher,
        apiUrl,
        token,
        `/repos/${repository}/pulls/${pull.number}/files`,
      )
      filesByPullRequest.set(pull.number, files)
    }),
  )

  const errors = findOrdinalCollisions(currentNumber, filesByPullRequest).map(
    ({ ordinal, otherNumber }) => `PR #${currentNumber} and PR #${otherNumber} both add migration ordinal ${ordinal}`,
  )
  const warnings = skippedOrdinals(
    baseHighestReader(baseSha),
    addedOrdinals(filesByPullRequest.get(currentNumber) ?? []),
  ).map((ordinal) => `PR #${currentNumber} adds migration ordinal ${ordinal}, leaving a gap above the base branch`)
  return { errors, warnings }
}

if (import.meta.main) {
  try {
    const { errors, warnings } = await run()
    for (const warning of warnings) console.warn(`MIGRATION ORDINAL CHECK: WARNING — ${warning}`)
    if (errors.length > 0) {
      for (const error of errors) console.error(`MIGRATION ORDINAL CHECK: FAIL — ${error}`)
      process.exit(1)
    }
    console.log('MIGRATION ORDINAL CHECK: ok — no added ordinal is claimed by another open PR')
  } catch (error) {
    console.error(`MIGRATION ORDINAL CHECK: FAIL — ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
}
