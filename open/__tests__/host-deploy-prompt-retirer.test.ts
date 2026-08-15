/**
 * T5 — the host-deploy prompt retirer (`open/wiring/host-deploy-prompt-retirer.ts`).
 *
 * The grant dies after five minutes; the `button_prompts` row it was drawn as
 * does not (its `expires_at` is a decade out), which is how the owner ended up
 * with an Approve button that was still tappable and connected to nothing.
 * These assertions are on the two writes that actually retire it: the
 * `__timeout__` sentinel resolve (so the row reads as SYSTEM-resolved, not as an
 * answer the owner gave) and the `recordPromptChoice` fan (which is what
 * collapses the button on every connected surface).
 */
import { describe, expect, test } from 'bun:test'
import { SYSTEM_SPEAKER_USER_ID } from '@neutronai/channels/button-store.ts'
import type { ButtonChoice } from '@neutronai/channels/button-primitive.ts'

import { buildHostDeployPromptRetirer } from '../wiring/host-deploy-prompt-retirer.ts'

type FanCall = {
  channel_topic_id: string
  prompt_id: string
  chosen_value: string
  project_id?: string
}

function stubs(opts: { resolveThrows?: boolean } = {}): {
  resolves: ButtonChoice[]
  fans: FanCall[]
  retire: (input: { prompt_id: string; topic_id: string }) => Promise<void>
} {
  const resolves: ButtonChoice[] = []
  const fans: FanCall[] = []
  const retire = buildHostDeployPromptRetirer({
    buttonStore: {
      resolve: async ({ choice }) => {
        resolves.push(choice)
        if (opts.resolveThrows === true) throw new Error('no such prompt row')
        return { was_new: true }
      },
    },
    recordPromptChoice: async (input) => {
      fans.push(input)
      return null
    },
  })
  return { resolves, fans, retire }
}

describe('buildHostDeployPromptRetirer', () => {
  test('resolves the prompt with the __timeout__ sentinel as the system speaker', async () => {
    const s = stubs()
    await s.retire({ prompt_id: 'bp-1', topic_id: 'app:owner:neutron-open' })

    expect(s.resolves).toHaveLength(1)
    const choice = s.resolves[0]!
    expect(choice.prompt_id).toBe('bp-1')
    // The sentinel is the whole point: a reserved value never renders as a user
    // reply and is never replayed to a late tap.
    expect(choice.choice_value).toBe('__timeout__')
    expect(choice.speaker_user_id).toBe(SYSTEM_SPEAKER_USER_ID)
    expect(choice.channel_kind).toBe('webhook')
  })

  test('fans the resolution on the prompt topic, with the project derived from it', async () => {
    const s = stubs()
    await s.retire({ prompt_id: 'bp-1', topic_id: 'app:owner:neutron-open' })

    expect(s.fans).toEqual([
      {
        channel_topic_id: 'app:owner:neutron-open',
        prompt_id: 'bp-1',
        chosen_value: '__timeout__',
        project_id: 'neutron-open',
      },
    ])
  })

  test('an owner-root topic carries no project_id', async () => {
    const s = stubs()
    await s.retire({ prompt_id: 'bp-2', topic_id: 'app:owner' })

    expect(s.fans).toHaveLength(1)
    expect(s.fans[0]!.channel_topic_id).toBe('app:owner')
    expect('project_id' in s.fans[0]!).toBe(false)
  })

  test('a resolve() throw does NOT stop the live fan', async () => {
    // The store row may be missing or already resolved; the fan is the only
    // thing the owner's screen reacts to, so it must still happen.
    const s = stubs({ resolveThrows: true })
    await expect(
      s.retire({ prompt_id: 'bp-3', topic_id: 'app:owner:neutron-open' }),
    ).resolves.toBeUndefined()

    expect(s.fans).toHaveLength(1)
    expect(s.fans[0]!.prompt_id).toBe('bp-3')
  })
})
