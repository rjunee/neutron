/**
 * gap-audit item 10 — unit coverage for the operating-doctrine layer
 * (`operating-doctrine.ts`). Asserts the doctrine is the SAME owner-agnostic
 * principle set on every surface, that it never leaks owner-specific content,
 * and that only the per-context weighting tail differs General vs project.
 */
import { describe, expect, test } from 'bun:test'

import {
  BUILD_ROUTING_DOCTRINE,
  DOCTRINE_PRINCIPLES,
  MISSING_CREDENTIAL_DOCTRINE,
  buildOperatingDoctrineFragment,
  type OperatingDoctrineInput,
} from '../operating-doctrine.ts'

describe('operating-doctrine — principle set', () => {
  test('every principle appears in the General fragment, numbered', () => {
    const frag = buildOperatingDoctrineFragment({ scope: 'general' })
    expect(DOCTRINE_PRINCIPLES.length).toBeGreaterThanOrEqual(6)
    for (let i = 0; i < DOCTRINE_PRINCIPLES.length; i++) {
      expect(frag).toContain(`${i + 1}. ${DOCTRINE_PRINCIPLES[i]}`)
    }
  })

  test('the lived "how you act" doctrine — anti-sycophancy, calibrated confidence, reframe — is present', () => {
    const frag = buildOperatingDoctrineFragment({ scope: 'general' })
    expect(frag).toContain('<operating_doctrine')
    expect(frag.toLowerCase()).toContain('no sycophancy')
    expect(frag.toLowerCase()).toContain('calibrated confidence')
    expect(frag.toLowerCase()).toContain('truth first')
    // The dharma/grounding-reframe layer, kept general (no owner reframes).
    expect(frag.toLowerCase()).toContain('grounding reframe')
    // It composes WITH the SOUL, deferring to a sharper owner rule.
    expect(frag.toLowerCase()).toContain('who you are')
    expect(frag.toLowerCase()).toContain('how you act')
  })

  test('build-routing heuristic (Part B, M-K) — self-route simple↔inline / complex↔trident', () => {
    for (const scope of ['general', 'project'] as const) {
      const frag = buildOperatingDoctrineFragment(
        scope === 'project' ? { scope, project_id: 'gondor' } : { scope },
      )
      // The heuristic is present every turn.
      expect(frag).toContain(BUILD_ROUTING_DOCTRINE)
      // It names the trident dispatch tool + tells the agent to self-route.
      expect(frag).toContain('work_board_dispatch_build')
      expect(frag.toLowerCase()).toContain('build routing')
      // SIMPLE → inline; COMPLEX → trident + tell the owner why. The permission
      // itself is deliberately kept: banning inline outright would push a one-line
      // fix through a full review loop.
      expect(frag).toContain('INLINE')
      expect(frag.toLowerCase()).toContain('complex')
      // THE ESCALATION TRIPWIRE is the part that was missing, and it is what this
      // assertion exists for. An agent judged the Email Core simple, built it
      // inline, and held one chat turn for 22 hours across 17 self-review rounds.
      // The initial call was defensible; nothing re-examined it once the work had
      // disproved it. So assert the MID-BUILD REVISION, not merely that the routing
      // rule mentions complexity — the old permissive text did that too and would
      // have satisfied a weaker assertion while permitting the 22-hour turn.
      expect(frag).toContain('MUST REVISE IT WHEN THE WORK PROVES YOU WRONG')
      expect(frag.toLowerCase()).toContain('more than twice')
      expect(frag.toLowerCase()).toContain('is not a reason to push on')
      expect(frag.toLowerCase()).toContain('tell the owner')
      // #334 — EVERY build (inline or trident, any project) must leave a card.
      expect(frag).toContain('MUST leave a trackable card')
      expect(frag).toContain('work_board_add')
      // #337 — an underspecified build asks a clarifying question IN THE CHAT and
      // never surfaces the raw rejection text.
      expect(frag).toContain('clarifying question IN THE CHAT')
      expect(frag.toLowerCase()).toContain('never surface the raw rejection')
    }
  })

  test('#379 — "leave a trackable card for ANY substantial work" is an UNCONDITIONAL principle, not gated on the build-dispatch tool', () => {
    // The card directive must live in the always-rendered DOCTRINE_PRINCIPLES set
    // (ships EVERY turn), NOT only inside BUILD_ROUTING_DOCTRINE (which is scoped
    // to explicit BUILDS + phrased "if you have the work_board_dispatch_build
    // tool"). Root of defect (1): a research/analysis job left no card because the
    // only card directive was build-scoped + credential-gated.
    const cardPrinciple = DOCTRINE_PRINCIPLES.find((p) => p.includes('work_board_add'))
    expect(cardPrinciple).toBeDefined()
    expect(cardPrinciple!.toLowerCase()).toContain('research')
    expect(cardPrinciple!.toLowerCase()).toContain('analysis')
    expect(cardPrinciple!.toLowerCase()).toContain('substantial')

    // It renders on EVERY surface even when the build-routing tool is not the
    // subject — the principle is present in the fragment for both scopes.
    for (const scope of ['general', 'project'] as const) {
      const frag = buildOperatingDoctrineFragment(
        scope === 'project' ? { scope, project_id: 'gondor' } : { scope },
      )
      expect(frag).toContain(cardPrinciple!)
      expect(frag).toContain('work_board_add')
      // The unconditional card rule does NOT depend on the credential-gated
      // dispatch tool name — it names the general add-a-card verb.
      expect(frag.toLowerCase()).toContain('trackable work is not only a build')
    }
  })

  test('#429 task 4 — the board principle requires a SPOKEN ack even though an automatic one is posted', () => {
    // The deterministic chat ack is mechanical; the agent's own reply must still
    // acknowledge the work in its voice. Pin that sentence to the always-rendered
    // board principle so it ships every turn on every surface.
    const cardPrinciple = DOCTRINE_PRINCIPLES.find((p) => p.includes('work_board_add'))
    expect(cardPrinciple).toBeDefined()
    expect(cardPrinciple!).toContain('a short automatic confirmation is posted to the chat for you')
    expect(cardPrinciple!.toLowerCase()).toContain('your reply must still acknowledge the work in your own voice')
    for (const scope of ['general', 'project'] as const) {
      const frag = buildOperatingDoctrineFragment(
        scope === 'project' ? { scope, project_id: 'gondor' } : { scope },
      )
      expect(frag).toContain('a short automatic confirmation is posted to the chat for you')
    }
  })

  test('missing-credential remedy (#552) — names a surface the owner can reach, never a shell', () => {
    for (const scope of ['general', 'project'] as const) {
      const frag = buildOperatingDoctrineFragment(
        scope === 'project' ? { scope, project_id: 'gondor' } : { scope },
      )
      expect(frag).toContain(MISSING_CREDENTIAL_DOCTRINE)
      // The remedy is a PLACE the owner can get to, named concretely enough to
      // act on — not "connect your account somewhere".
      expect(frag).toContain('Integrations')
      // Named as a control IN A ROW, not by one surface's button text: the web
      // button reads "Connect GitHub" and the phone's reads "Connect", so
      // quoting either as THE label sends half the owners looking for words that
      // are not on the screen in front of them.
      expect(frag).toContain('Connect control in the GitHub row')
      // And the specific failure the owner hit: a push / PR with no token.
      expect(frag.toLowerCase()).toContain('git push')
      expect(frag.toLowerCase()).toContain('pull request')
      // The prohibition is explicit, because the shell is what the agent can see
      // at the moment it fails and it will reach for it unless told not to.
      expect(frag).toContain('NEVER offer a terminal command as the remedy')
    }
  })

  test('the remedy rule is the SAME STRING for every input, and carries no deployment vocabulary', () => {
    // Named for what it actually checks. The old name promised an unconditional
    // RULE while the body only searched for four words, so a rule that really did
    // branch — in neutral wording, or on any input other than the one scope this
    // built — stayed green. Both halves are now here.
    //
    // STRUCTURAL half: the rule is emitted byte-identically for every input shape
    // the builder accepts. That is what "does not branch" means; it cannot be
    // inferred from vocabulary.
    const inputs: OperatingDoctrineInput[] = [
      { scope: 'general' },
      { scope: 'project' },
      { scope: 'project', project_id: 'gondor' },
      { scope: 'project', project_id: 'minas-tirith' },
    ]
    for (const input of inputs) {
      const frag = buildOperatingDoctrineFragment(input)
      // Positive control: the searches below are only meaningful if the rule
      // under test is actually in the string being searched.
      expect(frag).toContain(MISSING_CREDENTIAL_DOCTRINE)
      // The remedy names ONE place, with no "if you are running it this way".
      expect(frag).not.toContain('depending on')
    }

    // VOCABULARY half: naming the in-product surface is the right answer in EVERY
    // deployment, so a branch would be longer AND wrong somewhere. The literals
    // below are the words this repo does not carry, in prose or in code; this
    // array is the one place they are permitted to appear, because guarding
    // against them requires naming them exactly once.
    const general = buildOperatingDoctrineFragment({ scope: 'general' })
    for (const banned of ['self-host', 'hosted', 'tenan', 'instances']) {
      expect(general.toLowerCase()).not.toContain(banned)
    }
  })

  test('the principle body is byte-identical across surfaces (consistency)', () => {
    const general = buildOperatingDoctrineFragment({ scope: 'general' })
    const project = buildOperatingDoctrineFragment({ scope: 'project', project_id: 'gondor' })
    for (const principle of DOCTRINE_PRINCIPLES) {
      expect(general).toContain(principle)
      expect(project).toContain(principle)
    }
  })

  test('contains NO hardcoded owner-specific content (general / self-hoster doctrine)', () => {
    const frag = buildOperatingDoctrineFragment({ scope: 'general' })
    // No owner name, no the legacy harness archetypes, no owner-private reframes leaked in.
    for (const banned of ['Ryan', 'the legacy harness', 'Odin', 'Thoth', 'Padmasambhava', 'firewood']) {
      expect(frag).not.toContain(banned)
    }
  })
})

describe('operating-doctrine — per-context weighting', () => {
  test('General weights toward cross-project breadth', () => {
    const frag = buildOperatingDoctrineFragment({ scope: 'general' })
    expect(frag).toContain('scope="general"')
    expect(frag.toLowerCase()).toContain('cross-project')
    expect(frag.toLowerCase()).toContain('whole picture')
  })

  test('a project topic weights toward this-project craft and names the project', () => {
    const frag = buildOperatingDoctrineFragment({ scope: 'project', project_id: 'minas-tirith' })
    expect(frag).toContain('scope="project"')
    expect(frag).toContain('the "minas-tirith" project')
    expect(frag.toLowerCase()).toContain('keep any grounding reframe especially light')
  })

  test('project scope without a project_id still renders (generic "this project")', () => {
    const frag = buildOperatingDoctrineFragment({ scope: 'project' })
    expect(frag).toContain('scope="project"')
    expect(frag).toContain('this project')
  })
})
