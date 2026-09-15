import { describe, expect, test } from 'bun:test'

import { addedOrdinals, findOrdinalCollisions, run, skippedOrdinals } from './open-pr-migration-ordinal-check.ts'

const migration = (ordinal: string) => ({
  filename: `migrations/${ordinal}_change.sql`,
  status: 'added',
})

describe('open PR migration ordinal check', () => {
  test('constructs a two-PR collision and names both PRs plus the ordinal', async () => {
    const responses = new Map<string, unknown>([
      ['/repos/example/project/pulls?state=open&per_page=100&page=1', [{ number: 919 }, { number: 922 }]],
      ['/repos/example/project/pulls/919/files?per_page=100&page=1', [migration('0146')]],
      ['/repos/example/project/pulls/922/files?per_page=100&page=1', [migration('0146')]],
    ])
    const fetcher = (async (url: string | URL | Request) => {
      const body = responses.get(new URL(String(url)).pathname + new URL(String(url)).search)
      return body === undefined ? new Response('missing fixture', { status: 404 }) : Response.json(body)
    }) as typeof fetch

    const result = await run(
      {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: 'event.json',
        GITHUB_REPOSITORY: 'example/project',
        GITHUB_TOKEN: 'test-token',
        GITHUB_API_URL: 'https://api.example.test',
      },
      fetcher,
      async () => ({ pull_request: { number: 922, base: { sha: 'base-sha' } } }),
      () => 145,
    )

    expect(result.errors).toEqual(['PR #922 and PR #919 both add migration ordinal 0146'])
  })

  test('does not compare a PR with itself and accepts migration-free PRs', () => {
    const files = new Map([
      [919, [migration('0146')]],
      [922, [{ filename: 'README.md', status: 'modified' }]],
    ])
    expect(findOrdinalCollisions(919, files)).toEqual([])
    expect(findOrdinalCollisions(922, files)).toEqual([])
  })

  test('enumerates later API pages before deciding the ordinal is free', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ number: index + 1 }))
    const fetcher = (async (url: string | URL | Request) => {
      const parsed = new URL(String(url))
      if (parsed.pathname.endsWith('/pulls')) {
        return Response.json(parsed.searchParams.get('page') === '1' ? firstPage : [{ number: 101 }])
      }
      const number = Number(parsed.pathname.match(/pulls\/(\d+)\/files/)?.[1])
      return Response.json(number === 1 || number === 101 ? [migration('0146')] : [])
    }) as typeof fetch

    const result = await run(
      {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: 'event.json',
        GITHUB_REPOSITORY: 'example/project',
        GITHUB_TOKEN: 'test-token',
      },
      fetcher,
      async () => ({ pull_request: { number: 1, base: { sha: 'base-sha' } } }),
      () => 145,
    )

    expect(result.errors).toEqual(['PR #1 and PR #101 both add migration ordinal 0146'])
  })

  test('only added top-level migration files claim ordinals', () => {
    expect(
      addedOrdinals([
        migration('0148'),
        { filename: 'migrations/0149_old.sql', status: 'modified' },
        { filename: 'migrations/nexus/0150_nested.sql', status: 'added' },
      ]),
    ).toEqual(new Set(['0148']))
  })

  test('flags a skipped ordinal relative to the base without flagging the immediate next one', () => {
    expect(skippedOrdinals(145, new Set(['0146', '0147']))).toEqual(['0147'])
  })

  test('fails closed when the open PR list cannot be read', async () => {
    await expect(
      run(
        {
          GITHUB_EVENT_NAME: 'pull_request',
          GITHUB_EVENT_PATH: 'event.json',
          GITHUB_REPOSITORY: 'example/project',
          GITHUB_TOKEN: 'test-token',
        },
        (async () => new Response('unavailable', { status: 503 })) as unknown as typeof fetch,
        async () => ({ pull_request: { number: 922, base: { sha: 'base-sha' } } }),
        () => 145,
      ),
    ).rejects.toThrow('returned 503')
  })
})
