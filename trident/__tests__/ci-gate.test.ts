/**
 * THE CI GATE — a review panel cannot see a red build, so something else has to.
 *
 * WHY IT EXISTS. Four reviewers read the DIFF. None runs the tests, so a change that
 * type-errors or reds a shard can be unanimously APPROVED — and on a repo without
 * branch protection it merges. The reference deployment is protected by a GitHub
 * setting, which means the discipline lived in repository CONFIGURATION rather than in
 * this harness: **every self-hoster and every local-merge run had nothing at all.**
 *
 * TESTED AGAINST THE REAL FUNCTIONS, extracted from the `.mjs` source and evaluated —
 * the same technique the cross-model gate tests already use, and for the same reason:
 * a hand-copied TypeScript duplicate is a test that cannot fail for the reason it
 * claims to check. The workflow script genuinely cannot be imported (no module
 * resolution; its top-level `return` is the Workflow runtime's result API).
 */

import { describe, expect, test } from 'bun:test'

const SRC = await Bun.file(new URL('../inner-workflow.mjs', import.meta.url)).text()

interface CiResult {
  status: string
  failing: Array<{ name: string; state: string; link: string | null }>
}

/** Brace-match one function out of the source and evaluate it. */
function grab(name: string): string {
  const at = SRC.indexOf(`function ${name}(`)
  if (at === -1) throw new Error(`${name} is missing from inner-workflow.mjs`)
  let depth = 0
  let started = false
  for (let i = at; i < SRC.length; i += 1) {
    const c = SRC[i]
    if (c === '{') {
      depth += 1
      started = true
    } else if (c === '}') {
      depth -= 1
      if (started && depth === 0) return SRC.slice(at, i + 1)
    }
  }
  throw new Error(`could not brace-match ${name}`)
}

function loadReal(): {
  classifyCi: (probe: unknown) => CiResult
  ciBlockerFindings: (ci: CiResult) => Array<{ severity: string; title: string; evidence: string }>
  ciDeferredPeer: (ci: CiResult) => { name: string; evidence: string }
} {
  // The state sets are consts the functions close over, so they come along.
  const consts = SRC.slice(
    SRC.indexOf('const CI_FAILED_STATES'),
    SRC.indexOf('/**', SRC.indexOf('const CI_PENDING_STATES')),
  )
  const factory = new Function(
    `${consts}\n${grab('classifyCi')}\n${grab('ciBlockerFindings')}\n${grab('ciDeferredPeer')}\nreturn { classifyCi, ciBlockerFindings, ciDeferredPeer }`,
  ) as () => ReturnType<typeof loadReal>
  return factory()
}

/** A `gh pr checks --json` reply, as the probe reports it. */
const probe = (rows: unknown, exit = 0): { raw: string; exit_code: number } => ({
  raw: `${JSON.stringify(rows)}\n___EXIT=${exit}`,
  exit_code: exit,
})

describe('the extraction itself works (a guard that cannot load is a guard that cannot fail)', () => {
  // Loaded INSIDE a test, never at describe time: a load failure at describe time
  // DELETES the tests instead of failing them, which is the same cannot-fail shape
  // this file exists to prevent.
  test('the three functions are extractable', () => {
    const r = loadReal()
    expect(typeof r.classifyCi).toBe('function')
    expect(typeof r.ciBlockerFindings).toBe('function')
    expect(typeof r.ciDeferredPeer).toBe('function')
  })
})

describe('classifyCi — every answer is derived in code, never read by a model', () => {
  test('all SUCCESS → green', () => {
    const { classifyCi } = loadReal()
    expect(
      classifyCi(probe([{ name: 'test', state: 'SUCCESS' }, { name: 'lint', state: 'SUCCESS' }]))
        .status,
    ).toBe('green')
  })

  test('one FAILURE → red, and it names the check', () => {
    const { classifyCi } = loadReal()
    const out = classifyCi(
      probe([
        { name: 'test', state: 'SUCCESS' },
        { name: 'shard 3/4', state: 'FAILURE', link: 'https://ci.example.com/1' },
      ]),
    )
    expect(out.status).toBe('red')
    expect(out.failing).toHaveLength(1)
    expect(out.failing[0]!.name).toBe('shard 3/4')
    expect(out.failing[0]!.link).toBe('https://ci.example.com/1')
  })

  test('every terminal-failure state counts as red', () => {
    // GitHub reports several ways for a check to have finished badly. Treating only
    // FAILURE as red would let a cancelled or timed-out gate merge.
    const { classifyCi } = loadReal()
    for (const state of ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']) {
      expect(classifyCi(probe([{ name: 'x', state }])).status).toBe('red')
    }
  })

  test('a still-running check is PENDING, not green', () => {
    const { classifyCi } = loadReal()
    for (const state of ['PENDING', 'QUEUED', 'IN_PROGRESS']) {
      expect(classifyCi(probe([{ name: 'x', state }, { name: 'y', state: 'SUCCESS' }])).status).toBe(
        'pending',
      )
    }
  })

  test('RED BEATS PENDING — a known failure does not wait for the rest', () => {
    // Reporting pending here would defer (infra-only, loop exits) instead of sending
    // Forge to fix a failure we can already see.
    const { classifyCi } = loadReal()
    expect(
      classifyCi(probe([{ name: 'a', state: 'IN_PROGRESS' }, { name: 'b', state: 'FAILURE' }]))
        .status,
    ).toBe('red')
  })

  test('SKIPPED and NEUTRAL are not failures', () => {
    // A path-filtered workflow skips legitimately; treating that as red would block
    // every diff that misses a filter.
    const { classifyCi } = loadReal()
    expect(classifyCi(probe([{ name: 'a', state: 'SKIPPED' }, { name: 'b', state: 'SUCCESS' }])).status).toBe('green')
    expect(classifyCi(probe([{ name: 'a', state: 'NEUTRAL' }])).status).toBe('green')
  })

  test('NO checks configured is `none`, distinct from green', () => {
    // A repo with no CI has nothing to wait for. Blocking it would deadlock every
    // self-hoster who has not set any up.
    const { classifyCi } = loadReal()
    expect(classifyCi(probe([])).status).toBe('none')
  })

  test('an unreadable reply is UNKNOWN, and unknown is NEVER green', () => {
    // "Could not tell" and "it passed" are different answers, and only one of them is
    // safe to merge on. gh missing, unauthenticated, a deleted PR — all land here.
    const { classifyCi } = loadReal()
    expect(classifyCi({ raw: 'gh: command not found\n___EXIT=127', exit_code: 127 }).status).toBe('unknown')
    expect(classifyCi({ raw: 'not json at all', exit_code: 1 }).status).toBe('unknown')
    expect(classifyCi({ raw: '[broken', exit_code: 1 }).status).toBe('unknown')
    // Exit 0 does NOT rescue an unparseable reply: reading a clean exit as "no
    // checks" would produce no gate at all. `gh` prints `[]` for a repo with no
    // checks, so the real no-checks case never lands here.
    expect(classifyCi({ raw: '{"not":"an array"}', exit_code: 0 }).status).toBe('unknown')
    expect(classifyCi(null).status).toBe('unknown')
    expect(classifyCi(undefined).status).toBe('unknown')
  })

  test('a NON-ZERO exit with parseable rows still trusts the rows', () => {
    // `gh pr checks` exits 8 for pending and 1 for failures, so a non-zero exit is
    // normal. Treating it as an error would make every red build "unknown" — a
    // deferral instead of a fix.
    const { classifyCi } = loadReal()
    expect(classifyCi(probe([{ name: 'a', state: 'FAILURE' }], 1)).status).toBe('red')
    expect(classifyCi(probe([{ name: 'a', state: 'PENDING' }], 8)).status).toBe('pending')
  })

  test('surrounding noise around the JSON is tolerated', () => {
    // The probe captures stdout AND stderr, so a warning line can precede the array.
    const { classifyCi } = loadReal()
    const raw = `warning: something\n[{"name":"test","state":"SUCCESS"}]\n___EXIT=0`
    expect(classifyCi({ raw, exit_code: 0 }).status).toBe('green')
  })

  test('a nameless or state-less row does not crash the classifier', () => {
    const { classifyCi } = loadReal()
    expect(classifyCi(probe([{}, { name: 'ok', state: 'SUCCESS' }])).status).toBe('green')
    expect(classifyCi(probe([{ state: 'FAILURE' }])).failing[0]!.name).toBe('unnamed check')
  })
})

describe('what the gate DOES with each answer', () => {
  test('a red check becomes a BLOCKER finding naming the check and its link', () => {
    const { classifyCi, ciBlockerFindings } = loadReal()
    const ci = classifyCi(probe([{ name: 'typecheck', state: 'FAILURE', link: 'https://ci.example.com/9' }]))
    const findings = ciBlockerFindings(ci)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.severity).toBe('blocker')
    expect(findings[0]!.title).toContain('typecheck')
    // The reviewers cannot see any of this from the diff, so the evidence has to
    // carry it.
    expect(findings[0]!.evidence).toContain('typecheck')
    expect(findings[0]!.evidence).toContain('https://ci.example.com/9')
  })

  test('green / none produce NO findings at all', () => {
    const { classifyCi, ciBlockerFindings } = loadReal()
    expect(ciBlockerFindings(classifyCi(probe([{ name: 'a', state: 'SUCCESS' }])))).toEqual([])
    expect(ciBlockerFindings(classifyCi(probe([])))).toEqual([])
  })

  test('pending becomes a DEFERRED PEER, worded as "not approved", not as a code fault', () => {
    // Shaped as a peer on purpose: it flows into the existing cross-model gate, which
    // refuses to APPROVE, and `classifyBlock` then returns 'infra-only' so the loop
    // EXITS instead of re-Forging against a timer. There is nothing in the code to fix.
    const { classifyCi, ciDeferredPeer } = loadReal()
    const peer = ciDeferredPeer(classifyCi(probe([{ name: 'a', state: 'IN_PROGRESS' }])))
    expect(peer.name).toBe('CI')
    expect(peer.evidence).toContain('had not finished')
  })

  test('unknown becomes a deferred peer that says we could not TELL', () => {
    const { classifyCi, ciDeferredPeer } = loadReal()
    const peer = ciDeferredPeer(classifyCi({ raw: 'gh: not found', exit_code: 127 }))
    expect(peer.name).toBe('CI')
    expect(peer.evidence).toContain('could not be read')
  })
})

describe('the gate is WIRED, not merely written', () => {
  const code = SRC.split('\n')
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')

  test('the probe is invoked during review', () => {
    expect(code.includes('const ci = await probeCi(prForCi, round)')).toBe(true)
  })

  test('RED FORCES THE VERDICT, it does not merely append findings', () => {
    // The hole this nearly shipped with: `enforceCrossModelGate` returns the synthesis
    // UNTOUCHED when there are no deferred peers, so attaching CI blockers without
    // setting the verdict would have produced an APPROVE carrying a "CI FAILING"
    // finding — merging a red build, the exact bug the gate exists to prevent.
    const at = code.indexOf('const withCi =')
    expect(at).toBeGreaterThan(-1)
    const block = code.slice(at, code.indexOf('const peers =', at))
    expect(block.includes("verdict: 'REQUEST_CHANGES'")).toBe(true)
    expect(block.includes('ciBlockerFindings(ci)')).toBe(true)
  })

  test('an unusable CI answer joins the EXISTING peer list — one gate, peers as data', () => {
    // Not a second gate. The file's own rule: a second near-identical gate is how one
    // of the two quietly stops being enforced.
    const at = code.indexOf('const peers =')
    const block = code.slice(at, code.indexOf('const gated =', at))
    expect(block.includes('ciDeferredPeer(ci)')).toBe(true)
    expect(block.includes('...deferred')).toBe(true)
  })

  test('classifyBlock reads the peers INCLUDING the CI one', () => {
    // Otherwise a CI deferral would not classify as infra-only and the loop would
    // re-Forge against a pending check.
    expect(code.includes('classifyBlock(gated, peers)')).toBe(true)
  })

  test('LOCAL mode never spends an agent on a PR that does not exist', () => {
    const at = code.indexOf('async function probeCi(')
    const block = code.slice(at, code.indexOf('\n}', at))
    expect(block.includes('if (!isPr')).toBe(true)
    expect(block.includes("status: 'none'")).toBe(true)
  })

  test('the probe asks for RAW OUTPUT and forbids interpretation', () => {
    // A model asked "is CI green?" can answer yes for a plausible-looking wall of
    // text, and a hallucinated green merges a broken build.
    const at = SRC.indexOf('async function probeCi(')
    const block = SRC.slice(at, SRC.indexOf('\n}', at))
    expect(block).toContain('VERBATIM')
    expect(block).toContain('do NOT decide whether CI passed')
  })
})
