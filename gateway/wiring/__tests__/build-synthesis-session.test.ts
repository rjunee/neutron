/**
 * @neutronai/gateway/wiring — build-synthesis-session tests.
 *
 * Verifies the production composer seam that SUPERSEDES the per-chunk import
 * job-runner: the synthesis pipeline runs through ONE accumulating substrate
 * (no `/clear`), produces per-project seed material, and the seed-writer
 * populates a project repo on accept. Also verifies the LLM-less degrade path
 * (null substrate → null result).
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Substrate, AgentSpec } from '@neutronai/runtime/substrate.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { ConversationRecord } from '@neutronai/onboarding/history-import/types.ts'
import { buildSynthesisSession } from '../build-synthesis-session.ts'

const tmpDirs: string[] = []
function freshTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'synth-composer-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

/** Fake substrate: routes read passes to one project; records prompts. */
function makeFakeSubstrate(): { substrate: Substrate; dispatched: string[] } {
  const dispatched: string[] = []
  const substrate: Substrate = {
    start(spec: AgentSpec): SessionHandle {
      dispatched.push(spec.prompt)
      let body = '{}'
      if (spec.prompt.includes('read pass')) {
        const ids = [...spec.prompt.matchAll(/id=(\S+)/g)].map((m) => m[1])
        body = JSON.stringify({
          projects: [
            {
              slug: 'topline',
              name: 'Topline Hospitality',
              status: 'active',
              overview: 'Hospitality sales pipeline.',
              open_threads: ['Q3 invoice to Priya'],
            },
          ],
          people: ['Priya Shah'],
          routing: ids.map((id) => ({ conversation_id: id, project_slugs: ['topline'] })),
        })
      } else if (spec.prompt.includes('accumulated model')) {
        body = JSON.stringify({ summary: 'You run Topline Hospitality.', style: { tone: 'terse' } })
      }
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        yield { kind: 'token', text: body }
        yield {
          kind: 'completion',
          usage: { input_tokens: 5, output_tokens: 5 },
          substrate_instance_id: 'cc-synthesis-fake',
        }
      })()
      return {
        events,
        respondToTool: async () => undefined,
        cancel: async () => undefined,
        tool_resolution: 'internal',
      }
    },
  }
  return { substrate, dispatched }
}

async function* records(): AsyncIterable<ConversationRecord> {
  yield {
    conversation_id: 'c-topline-1',
    title: 'Topline pipeline',
    created_at: Date.parse('2026-05-01T00:00:00Z'),
    messages: [{ role: 'user', text: 'Topline Hospitality Q3 invoice to Priya is overdue.' }],
  }
}

describe('buildSynthesisSession — production seam', () => {
  test('synthesizeImport runs through the accumulating substrate (no /clear) and seeds a project', async () => {
    const ownerHome = freshTmp()
    const { substrate, dispatched } = makeFakeSubstrate()
    const runner = buildSynthesisSession({ substrate, owner_home: ownerHome, timeout_ms: 5000 })

    const result = await runner.synthesizeImport(records())
    expect(result).not.toBeNull()
    expect(result!.source).toBe('import')
    expect(result!.user_model.projects[0]?.slug).toBe('topline')
    expect(result!.project_seeds.length).toBeGreaterThanOrEqual(1)
    // No /clear ever dispatched.
    for (const p of dispatched) expect(p).not.toContain('/clear')

    // Populate the project repo on accept.
    const seed = result!.project_seeds.find((s) => s.slug === 'topline')!
    const outcome = runner.writeSeed(seed)
    expect(outcome.reason).toBe('created')
    const statusPath = join(ownerHome, 'Projects', 'topline', 'STATUS.md')
    expect(existsSync(statusPath)).toBe(true)
    expect(readFileSync(statusPath, 'utf8')).toContain('Topline Hospitality')
    expect(outcome.transcripts_written).toBeGreaterThanOrEqual(1)
  })

  test('synthesizeInterviewOnly stands up >= 1 project (no-import path)', async () => {
    const ownerHome = freshTmp()
    const substrate: Substrate = {
      start(spec: AgentSpec): SessionHandle {
        const body = spec.prompt.includes('No chat history was imported')
          ? JSON.stringify({
              projects: [
                { slug: 'memoir', name: 'Memoir', status: 'active', overview: 'Writing a memoir.', open_threads: [] },
              ],
              summary: 'You are writing a memoir.',
            })
          : '{}'
        const events = (async function* (): AsyncGenerator<Event, void, void> {
          yield { kind: 'token', text: body }
          yield {
            kind: 'completion',
            usage: { input_tokens: 5, output_tokens: 5 },
            substrate_instance_id: 'cc-synthesis-fake',
          }
        })()
        return {
          events,
          respondToTool: async () => undefined,
          cancel: async () => undefined,
          tool_resolution: 'internal',
        }
      },
    }
    const runner = buildSynthesisSession({ substrate, owner_home: ownerHome, timeout_ms: 5000 })
    const result = await runner.synthesizeInterviewOnly([
      { prompt: 'What are you working on?', answer: 'Writing a memoir about my grandmother.' },
    ])
    expect(result).not.toBeNull()
    expect(result!.source).toBe('interview')
    expect(result!.user_model.projects.length).toBeGreaterThanOrEqual(1)
  })

  test('degrades to null when no substrate is wired (LLM-less box)', async () => {
    const ownerHome = freshTmp()
    const runner = buildSynthesisSession({ substrate: null, owner_home: ownerHome })
    expect(await runner.synthesizeImport(records())).toBeNull()
    expect(await runner.synthesizeInterviewOnly([{ prompt: 'q', answer: 'a' }])).toBeNull()
  })
})
