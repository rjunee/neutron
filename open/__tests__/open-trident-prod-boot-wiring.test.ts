import { asOwnerHandle } from '@neutronai/persistence/index.ts'
/**
 * Open foundational-Trident prod-boot wiring — the anti-"built-but-not-wired"
 * gate for the `/code <task>` autonomous build runner.
 *
 * THE GAP (Trident-port, this PR): `cores/free/code-gen/src/backend.ts` throws
 * `CodegenNotConfiguredError` because the production runner was never wired into
 * prod boot — the Open composer never set `CompositionInput.trident`, so the
 * trident tick loop fell back to `stubAdvanceDeps()` (advances nothing) and
 * `/code` could not dispatch a real build.
 *
 * THE FIX (Trident v2 · Phase 2a exec-model): `open/composer.ts` builds a warm
 * FIRE seam (`buildSubstrateWorkflowFire`, over a non-ephemeral `cc-trident-fire-*`
 * substrate on the single-owner credential pool) and threads
 * `trident: { fire_inner_workflow }` onto the returned `CompositionInput`, so
 * `build-core-modules.ts` wires the REAL `buildWorkflowFirer` +
 * `buildTridentOrchestrator` step (the inner loop is a CC Dynamic Workflow, FIRED
 * on the warm substrate + harvested from the DB — billing-exempt, no `claude -p`).
 *
 * Per CLAUDE.md (the 2026-05-13 "built but never invoked" incident class) this
 * asserts the wiring ACTUALLY produces a working runner — it boots the REAL Open
 * composer with a SYNTHETIC credential, then:
 *   1. `composition.trident.fire_inner_workflow` is a wired function (not
 *      skeleton/stub). The live `Workflow`-fire exercise is the real-run
 *      acceptance, not this unit test.
 *   2. With NO credential the runner degrades cleanly: `composition.trident` is
 *      unset (the loop stays on its restart-safe no-op).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

/** A synthetic credential — the owner's real token never enters a test. */
const PLANTED_TOKEN = 'ghp_BOOT_WIRING_SENTINEL_0001'

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME',
  'OWNER_HOME',
  'NEUTRON_DB_PATH',
  'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR',
  'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH',
  'NOTIFY_SOCKET',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string
let db: ProjectDb

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-trident-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-trident-test-secret-0123456789'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  process.env['NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH'] = '1' // force handoff default: ignore any host `claude` login (#101 Keychain probe)
  delete process.env['NOTIFY_SOCKET']
  seedMigratedDb(process.env['NEUTRON_DB_PATH'])
  db = ProjectDb.open(process.env['NEUTRON_DB_PATH'])
})

afterEach(() => {
  db.close()
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

/** Mocked substrate shared across every substrate the composer builds. Records
 *  the prompt it was handed and answers with a Forge-contract-shaped completion
 *  so a dispatched Trident turn returns deterministic terminal text. */
function recordingSubstrate(prompts: string[]): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      prompts.push(spec.prompt)
      async function* gen(): AsyncGenerator<Event> {
        yield { kind: 'token', text: 'built it\nPR_NUMBER=11\nBRANCH=trident/x\nWORKTREE=/repo' }
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'mock-trident',
        }
      }
      return {
        events: gen(),
        async respondToTool(): Promise<void> {
          throw new Error('mock substrate: no external tools')
        },
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

describe('Open foundational-Trident prod-boot wiring', () => {
  test('a credentialed boot wires composition.trident.fire_inner_workflow to a REAL warm-substrate fire seam', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-trident-test'
    const prompts: string[] = []
    const composer = buildOpenGraphComposer({
      env: process.env,
      // Mock every substrate the composer builds (no real `claude`) — including
      // the warm `cc-trident-fire-*` substrate the fire seam runs its launching
      // turn on.
      substrateFactory: ((_opts: { cwd?: string }) => {
        return recordingSubstrate(prompts)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    })
    const composition = await composer({ db, project_slug: 'owner' })

    // The runner is wired — not the skeleton/stub. Phase 2a threads a warm
    // FIRE seam that invokes the `Workflow` tool + settles the launching turn;
    // the workflow's result is harvested from the DB. The fire closure is built
    // eagerly (no turn until a real run), so a credentialed boot exposes it as a
    // function. The live `Workflow`-fire round-trip is the real-run acceptance,
    // not this unit test.
    expect(composition.trident).toBeDefined()
    expect(typeof composition.trident!.fire_inner_workflow).toBe('function')

    // X5 — the real composer wires `composition.channel_router` (the ONE
    // delivery seam) with the durable app-ws adapter registered for the
    // `app_socket` kind every Open run carries. Trident terminal delivery falls
    // back to THIS router (no `delivery_sink` override), so a completion posts
    // through `router.send` → the app-ws adapter. Assert the seam is live at boot
    // (anti "built-but-not-wired") and that its boot-conformance guard is
    // satisfied.
    expect(composition.channel_router).toBeDefined()
    expect(composition.channel_router!.getAdapter('app_socket')).toBeDefined()
    expect(() => composition.channel_router!.assertAdaptersFor(['app_socket'])).not.toThrow()
    // The delivery seam actually flows: a terminal run stamped `app_socket` with
    // a chat_id delivers through router.send → the app-ws adapter (no live socket
    // → `app-ws:dropped:` id, but it DISPATCHED — the pre-X5 bare router threw).
    const { buildTridentDelivery } = await import('@neutronai/trident/delivery.ts')
    const delivery = buildTridentDelivery({ sink: composition.channel_router! })
    let delivered = false
    const origSend = composition.channel_router!.getAdapter('app_socket')!.send.bind(
      composition.channel_router!.getAdapter('app_socket')!,
    )
    composition.channel_router!.getAdapter('app_socket')!.send = async (m) => {
      delivered = true
      return origSend(m)
    }
    await delivery.onTerminal({
      // Minimal terminal run shape the delivery path reads (phase/task/chat_id/
      // channel_kind); other fields are unread by `buildTridentDelivery`.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      phase: 'done',
      task: 'X5 seam smoke',
      chat_id: 'app:owner',
      thread_id: null,
      channel_kind: 'app_socket',
      merge_mode: 'local',
      pr: null,
      failure_reason: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    expect(delivered).toBe(true)

    // Phase 2b — the agent-native board-bound build dispatch is wired on the
    // SAME credential gate, backed by a TridentRunStore + the shared board.
    // Reachability (anti "built-but-not-wired"): boot → create a ready Plan item
    // → dispatch via the wired surface → a code_trident_runs row exists, BOUND.
    expect(composition.trident_build_dispatch).toBeDefined()
    const tbd = composition.trident_build_dispatch!
    expect(typeof tbd.repo_path).toBe('string')
    const { dispatchBoardBoundBuild } = await import('@neutronai/trident/board-dispatch.ts')
    const { detectMergeMode } = await import('@neutronai/trident/git-mode.ts')
    const { WorkBoardStore } = await import('@neutronai/work-board/store.ts')
    const board = new WorkBoardStore(db)
    const item = await board.create('owner', {
      title: 'wire the export button to the new CSV endpoint with tests',
    })
    const res = await dispatchBoardBoundBuild(
      { board_item_id: item.id, task: 'build the export' },
      {
        store: tbd.store,
        board: tbd.work_board,
        project_slug: 'owner',
        repo_path: tbd.repo_path,
        // Identity workspace resolver — this boot-wiring test asserts reachability,
        // not the real git workspace (covered in build-workspace.test.ts); keep it
        // off the real filesystem.
        resolveBuildRepo: async (home) => home,
        // THE COMPOSED PROBE, through the exact expression `work_board_start`
        // uses (`registerTridentBuildToolSurface` → `detectMergeMode(path,
        // deps.merge_mode_probe)`). Round 2 hardcoded `async () => 'local'` here,
        // which bypassed the very path this test claims to guard.
        //
        // Hermetic and offline BY CONSTRUCTION rather than by luck: `tmpDir` is
        // not a git repo, so `hasGithubOrigin` fails first and `detectMergeMode`
        // returns 'local' without ever reaching `publisherAvailable` — no `gh`,
        // no network. The credential half is proven below through the store.
        resolveMergeMode: (path) => detectMergeMode(path, tbd.merge_mode_probe),
        resolveRalph: async () => false,
        // THE COMPOSED RUNNER, by VALUE and not by a count of its spelling (Argus
        // r17). This is the object both dispatch tools hand the seed's branch-tip
        // probe; a boot that left it undefined puts every re-dispatch back on the
        // uncredentialed `spawnCapture` this seam exists to replace. The per-entry
        // BEHAVIOUR against a private origin is proven in
        // `trident/work-board-build-tool.test.ts`.
        hostRunner: tbd.host_runner!,
      },
    )
    expect(typeof tbd.host_runner).toBe('function')
    expect(typeof tbd.landed_probe).toBe('function')
    expect(res.ok).toBe(true)
    // The run row exists and the Plan item is bound (fork ⑂ lit).
    expect(board.get('owner', item.id)?.linked_run_id).toBe(res.ok ? res.run.id : '')
    expect(board.get('owner', item.id)?.status).toBe('in_progress')

    // THE MERGE-MODE PROBE REACHED BY `work_board_start` IS CREDENTIALED.
    //
    // Anti "built-but-not-wired". Round 1 of this fix asserted only
    // `typeof tbd.resolveMergeMode === 'function'`, which the PRE-FIX composer
    // also satisfied — the assertion could not fail, so it guarded nothing. The
    // dispatch seam now carries the PROBE, whose `publisher` names the credential
    // it will consult, so the wiring is inspectable at the exact seam
    // `work_board_start` runs through (build-core-modules registers the tool
    // surface from this same object).
    expect(tbd.merge_mode_probe.credential.owner_handle).toBe('owner')
    expect(tbd.merge_mode_probe.credential.source).toBe('the instance secrets store')
    // …and specifically NOT the "nothing was wired here" placeholder, which is
    // what an unwired composition would have produced.
    expect(tbd.merge_mode_probe.credential.owner_handle).not.toBe('unknown')

    const publisherCredential = composition.onboarding_overnight_cron!.publisher_credential
    // The board seam and the overnight seam resolve the SAME credential — one
    // connection in chat serves both. IDENTITY, not shape: the previous round
    // compared `owner_handle`/`source` strings, and `git-mode.ts` cloned those
    // strings onto the probe, so a probe backed by the WRONG STORE with matching
    // labels passed. `toBe` on the source object cannot be satisfied that way.
    expect(tbd.merge_mode_probe.credential).toBe(publisherCredential)

    expect(publisherCredential.owner_handle).toBe('owner')
    expect(publisherCredential.source).toBe('the instance secrets store')
    // Nothing connected yet → empty, and reported as empty.
    expect(await publisherCredential.load()).toEqual({})
    // Connect a token through the real credential path; the SAME source picks it
    // up on the next call, with no re-composition — which is what makes a
    // chat-time `Connect GitHub` take effect without a restart.
    const { storeGitHubToken } = await import('@neutronai/github/credential.ts')
    // The probe's OWN credential is empty right up to this point, so the
    // assertion below cannot pass on a pre-existing value.
    expect(await tbd.merge_mode_probe.credential.load()).toEqual({})
    await storeGitHubToken(
      composition.cores!.secretsStore,
      asOwnerHandle('owner'),
      PLANTED_TOKEN,
    )
    expect((await publisherCredential.load())['GH_TOKEN']).toBe(PLANTED_TOKEN)

    // AND THE STORE THE `work_board_start` PROBE READS IS THIS BOOT'S OWN,
    // proven by round-trip rather than by label. The token was planted through
    // `composition.cores.secretsStore`; it comes back out of the probe's own
    // credential. A probe wired to any OTHER store — including one carrying
    // identical `owner_handle`/`source` labels, which is exactly what round 2's
    // string comparison would have accepted — returns `{}` here.
    expect((await tbd.merge_mode_probe.credential.load())['GH_TOKEN']).toBe(PLANTED_TOKEN)

    // AND THE DISPATCH SEAM CARRIES THE CREDENTIALED HOST RUNNER (Argus r16
    // blocker). The built-never-reviewed salvage — the whole point of the seed —
    // probes the build branch's tip with `git ls-remote origin`. That read was
    // credentialed ONLY when a caller passed `secretsStore` + `owner_handle`, and
    // no production caller does: they inject `resolveMergeMode` instead, because
    // the composition root owns the token. So the probe ran on a bare process env
    // and, against a PRIVATE origin, answered '' — no seed, and a commit that was
    // already built got rebuilt from scratch. Proven by RUNNING the wired runner
    // and reading back the token it exports, not by `typeof`: the pre-fix
    // composition has no such property at all, and one wired to any other source
    // prints nothing here.
    expect(typeof tbd.host_runner).toBe('function')
    const runnerEnv = await tbd.host_runner!(['sh', '-c', 'printf %s "$GH_TOKEN"'], tmpDir)
    expect(runnerEnv.ok).toBe(true)
    expect(runnerEnv.stdout).toBe(PLANTED_TOKEN)

    // Part B — the Connect Codex surface + agent-tool service are wired, and the
    // trident loop threads the per-project CODEX_HOME (resolveCodexHome). Anti
    // "built-but-not-wired": connect a subscription auth via the wired service →
    // status connected + the loop's codex_home points at the same materialized dir.
    expect(composition.app_codex_credential_surface).toBeDefined()
    expect(composition.codex_credential).toBeDefined()
    expect(typeof composition.trident!.codex_home).toBe('string')
    const codexSvc = composition.codex_credential!.service
    const connect = await codexSvc.connect(
      asOwnerHandle('owner'),
      JSON.stringify({ tokens: { access_token: 'a', refresh_token: 'r' }, last_refresh: 'x' }),
    )
    expect(connect.ok).toBe(true)
    expect(codexSvc.status(asOwnerHandle('owner')).status).toBe('connected')

    for (const cleanup of composition.realmode_cleanups ?? []) {
      try {
        cleanup()
      } catch {
        /* best-effort */
      }
    }
  }, 20_000)

  test('EVERY dispatch site that gets the landed probe gets the host runner with it', () => {
    // The boot assertion above reaches ONE of the four production entries into
    // `dispatchBoardBoundBuild` — the agent-native tool deps, the only one the
    // composition exposes as an object. The other three (`/code`'s context, the
    // app's ▶ `boardStartBuild`, and the hold sweep's `makeDispatchDeps`) are
    // closures built inside the composer, and wiring a shared credential
    // per-entry is exactly how this repo has repeatedly shipped a seam that was
    // live on one path and inert on the rest (see the `preflight` and `holds`
    // notes in `board-dispatch.ts`).
    //
    // So the pin is the PAIRING: `landedProbe` and `hostRunner` are the same
    // credentialed object serving the same class of remote read, and a site that
    // takes one without the other is the drift this catches. Textual because
    // these sites are unreachable except by booting each surface, and a shape
    // assertion on a closure could not tell a wired site from an unwired one.
    // COMMENTS ARE NOT WIRING (Argus r17). The count used to run over the raw
    // file, so commenting the live `hostRunner: tridentHostRunner` out and
    // re-adding it as a comment kept every count equal — a mutant that unwires
    // production and leaves this green. Line comments are stripped first, so only
    // executable spellings are counted.
    //
    // AND A STRING IS NOT A PROPERTY EITHER (Argus r18, with a working mutant).
    // Counting the bare SUBSTRING also survived
    // `['hostRunner: tridentHostRunner']: undefined,` — executable, so the comment
    // strip above does not touch it, and it keeps the count equal while removing
    // the property production reads. So the count is now line-ANCHORED: the
    // spelling has to be a real object property, i.e. begin its line after nothing
    // but whitespace. The mutant's line begins with `[` and no longer counts, and
    // every genuine site in `composer.ts` is written exactly this way.
    const src = readFileSync(join(HERE, '..', 'composer.ts'), 'utf8')
      .split('\n')
      .filter((l) => {
        const t = l.trimStart()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')
    const propLine = (prop: string, value: string): RegExp =>
      new RegExp(`^[ \\t]*${prop}: ${value},?[ \\t]*$`)
    const count = (prop: string, value: string, text: string = src): number =>
      (text.match(new RegExp(propLine(prop, value).source, 'gm')) ?? []).length
    // Positive control: the anchors themselves are still spelled this way, so an
    // equality of two zeroes cannot pass this test.
    expect(count('landedProbe', 'tridentLandedProbe')).toBeGreaterThanOrEqual(3)
    expect(count('landed_probe', 'tridentLandedProbe')).toBeGreaterThanOrEqual(1)
    expect(count('hostRunner', 'tridentHostRunner')).toBe(count('landedProbe', 'tridentLandedProbe'))
    expect(count('host_runner', 'tridentHostRunner')).toBe(count('landed_probe', 'tridentLandedProbe'))

    // AND A COUNT CANNOT SAY *WHICH OBJECT* CARRIES THE PROPERTY (Argus r20
    // blocker, with a working mutant). Deleting `hostRunner: tridentHostRunner`
    // from the ▶ dispatch site and re-spelling it in a decoy object beside the
    // runner's definition keeps every count above equal, so production goes
    // unwired with this test green — and the compiler does not object either,
    // because `BoardBoundBuildDeps.hostRunner` is OPTIONAL (it falls back to the
    // uncredentialed reader, which is exactly the silent failure this seam is
    // about). So the real assertion is per OBJECT LITERAL: each literal carrying
    // the landed probe must carry the host runner as a DIRECT property of ITSELF.
    // A sibling object elsewhere in the file is not an answer. The reviewer's own
    // mutant is applied to the real source at the bottom of this test and must
    // come out RED.

    /** The `{ … }` body enclosing `text[idx]`, by bracket depth. */
    const enclosingObject = (text: string, idx: number): string | null => {
      let depth = 0
      let end = -1
      for (let k = idx; k < text.length; k++) {
        const c = text[k]
        if (c === '{' || c === '(' || c === '[') depth++
        else if (c === ')' || c === ']') depth--
        else if (c === '}') {
          if (depth === 0) {
            end = k
            break
          }
          depth--
        }
      }
      depth = 0
      let start = -1
      for (let k = idx; k >= 0; k--) {
        const c = text[k]
        if (c === '}' || c === ')' || c === ']') depth++
        else if (c === '(' || c === '[') depth--
        else if (c === '{') {
          if (depth === 0) {
            start = k
            break
          }
          depth--
        }
      }
      return start === -1 || end === -1 ? null : text.slice(start + 1, end)
    }

    /** The lines of `body` that sit at ITS top level — i.e. its direct properties. */
    const directPropertyLines = (body: string): string[] => {
      const out: string[] = []
      let depth = 0
      let lineDepth = 0
      let lineStart = 0
      for (let k = 0; k <= body.length; k++) {
        const c = body[k]
        if (c === undefined || c === '\n') {
          if (lineDepth === 0) out.push(body.slice(lineStart, k))
          lineStart = k + 1
          lineDepth = depth
          continue
        }
        if (c === '{' || c === '(' || c === '[') depth++
        else if (c === '}' || c === ')' || c === ']') depth--
      }
      return out
    }

    /**
     * One entry per object literal carrying `<anchor>` as a direct property: true
     * when that SAME literal carries `<sibling>` as a direct property too.
     */
    const pairedSites = (
      text: string,
      anchor: string,
      anchorValue: string,
      sibling: string,
      siblingValue: string,
    ): boolean[] => {
      const anchorRe = new RegExp(propLine(anchor, anchorValue).source, 'gm')
      const out: boolean[] = []
      for (let m = anchorRe.exec(text); m !== null; m = anchorRe.exec(text)) {
        const body = enclosingObject(text, m.index)
        const lines = body === null ? [] : directPropertyLines(body)
        // Self-check: the anchor must come back as a DIRECT property of the literal
        // the scan found, or the scan mis-parsed and its answer means nothing.
        expect(lines.some((l) => propLine(anchor, anchorValue).test(l))).toBe(true)
        out.push(lines.some((l) => propLine(sibling, siblingValue).test(l)))
      }
      return out
    }

    const camelPairs = (text: string): boolean[] =>
      pairedSites(text, 'landedProbe', 'tridentLandedProbe', 'hostRunner', 'tridentHostRunner')
    const snakePairs = (text: string): boolean[] =>
      pairedSites(text, 'landed_probe', 'tridentLandedProbe', 'host_runner', 'tridentHostRunner')

    // Positive control again: the sites are FOUND, by count, before anything is
    // asserted about their pairing — an empty scan cannot read as a pass.
    expect(camelPairs(src).length).toBe(count('landedProbe', 'tridentLandedProbe'))
    expect(snakePairs(src).length).toBe(count('landed_probe', 'tridentLandedProbe'))
    expect(camelPairs(src).every((paired) => paired)).toBe(true)
    expect(snakePairs(src).every((paired) => paired)).toBe(true)

    // THE REVIEWER'S MUTANT, APPLIED TO THE REAL SOURCE: unwire ONE dispatch site
    // and re-spell the property in a decoy object beside the runner's definition.
    const lines = src.split('\n')
    const anchorAt = lines.reduce<number[]>(
      (acc, l, i) => (propLine('landedProbe', 'tridentLandedProbe').test(l) ? [...acc, i] : acc),
      [],
    )
    expect(anchorAt.length).toBeGreaterThanOrEqual(2)
    const victim = lines.findIndex(
      (l, i) => i > anchorAt[1]! && propLine('hostRunner', 'tridentHostRunner').test(l),
    )
    expect(victim).toBeGreaterThan(anchorAt[1]!)
    const decoyAt = lines.findIndex((l) => l.includes('const tridentHostRunner ='))
    expect(decoyAt).toBeGreaterThan(-1)
    const mutant = lines
      .filter((_, i) => i !== victim)
      .flatMap((l, i) => (i === decoyAt ? [l, 'void {', '  hostRunner: tridentHostRunner,', '}'] : [l]))
      .join('\n')

    // The count this test used to rest on is STILL EQUAL under that mutant — which
    // is exactly why counting is no longer the assertion.
    expect(count('hostRunner', 'tridentHostRunner', mutant)).toBe(
      count('landedProbe', 'tridentLandedProbe', mutant),
    )
    // …and the pairing says what the count cannot: one dispatch site now takes the
    // landed probe WITHOUT the credentialed runner beside it.
    expect(camelPairs(mutant).filter((paired) => !paired).length).toBe(1)
  })

  test('an LLM-less boot (no credential) leaves composition.trident unset (clean degrade)', async () => {
    delete process.env['ANTHROPIC_API_KEY']
    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db, project_slug: 'owner' })

    expect(composition.trident).toBeUndefined()
    expect(composition.trident_build_dispatch).toBeUndefined()

    for (const cleanup of composition.realmode_cleanups ?? []) {
      try {
        cleanup()
      } catch {
        /* best-effort */
      }
    }
  }, 20_000)
})
