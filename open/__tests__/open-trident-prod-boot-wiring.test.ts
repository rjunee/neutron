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
import ts from 'typescript'
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
    // AND A BLOCK COMMENT IS A COMMENT (Argus r4 blocker, reproduced). The strip
    // above knew only about a comment's FIRST line: wrapping the live
    // `hostRunner: tridentHostRunner,` in `/* … */` dropped the two delimiter lines
    // and KEPT the property between them, so every count and every site scan below
    // read the site as wired while the runtime object carried no `hostRunner` at
    // all — and `BoardBoundBuildDeps.hostRunner` is OPTIONAL, so tsc says nothing
    // either. The strip carries block state across lines, and the mutant is
    // applied to the real source at the bottom of this test and must come out RED.
    //
    // AND A BLOCK COMMENT MAY OPEN ANYWHERE ON A LINE (Argus r5 blocker, with an
    // executed repro). The strip that answered r4 was still LINE-oriented: a line
    // entered block state only when its TRIMMED text STARTED with `/*`. So
    // appending ` /*` to the property line ABOVE the pair — `resolveMergeMode:
    // resolveTridentMergeMode, /*` — kept that line, kept `landedProbe:` and
    // `hostRunner:` after it, and then DISCARDED the closing `*/` line through the
    // `startsWith('*')` branch: every count equal, every site paired and bound,
    // and production carrying NEITHER half at runtime, with tsc silent because
    // both fields are optional. No line-prefix rule can close that, because a
    // comment's boundaries are token positions and not line positions. So the
    // strip is now the COMPILER'S OWN PARSE — which also stops it mistaking the
    // `//` inside a string (`https://…`, and the `Projects/*/STATUS.md` globs
    // written inside comments, both of which `composer.ts` has) for a delimiter.
    // The boundary mutant is applied to the real source at the bottom of this test
    // and must come out RED.
    /**
     * `text` with every comment blanked to spaces — what is commented out is not
     * wiring.
     *
     * Blanked rather than deleted so that every position in the result is the
     * position the file really has, which is what the line-anchored scans below
     * read. The comment ranges come from TypeScript's own parse of the file, so a
     * comment is whatever the COMPILER says a comment is — no line-prefix rule,
     * and template literals, nested substitutions and regex literals are the
     * parser's problem rather than this test's. (A hand-driven `ts.createScanner`
     * is NOT enough here: a raw scan loop does not re-scan a template's `}` as a
     * template middle, so everything after the first `${…}` is read as code and
     * the `/*` inside a later comment opens a block that eats a third of the file.)
     */
    const executable = (text: string): string => {
      const parsed = ts.createSourceFile(
        'composer.scan.ts',
        text,
        ts.ScriptTarget.Latest,
        /* setParentNodes */ true,
        ts.ScriptKind.TS,
      )
      const chars = text.split('')
      const blank = (range: ts.CommentRange): void => {
        for (let i = range.pos; i < range.end; i++) if (chars[i] !== '\n') chars[i] = ' '
      }
      const visit = (node: ts.Node): void => {
        // Every comment in the file is leading or trailing trivia of exactly one
        // token, and the EOF token carries the ones at the end.
        for (const range of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []) blank(range)
        for (const range of ts.getTrailingCommentRanges(text, node.getEnd()) ?? []) blank(range)
        for (const child of node.getChildren(parsed)) visit(child)
      }
      visit(parsed)
      return chars.join('')
    }
    // The two cases the line-prefix rule got wrong, one in each direction: a block
    // that OPENS mid-line is stripped, and a `//` inside a string is NOT.
    expect(executable('const a = { x: 1, /*\n  y: 2,\n*/\n}')).not.toMatch(/y: 2/)
    expect(executable("const u = 'https://example'")).toContain('https://example')
    const raw = readFileSync(join(HERE, '..', 'composer.ts'), 'utf8')
    const src = executable(raw)
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

    /** The `{ … }` enclosing `text[idx]`, by bracket depth — its brace positions. */
    const enclosingObjectRange = (text: string, idx: number): [number, number] | null => {
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
      return start === -1 || end === -1 ? null : [start, end]
    }

    /** The body of that literal — everything between its braces, nesting included. */
    const enclosingObject = (text: string, idx: number): string | null => {
      const range = enclosingObjectRange(text, idx)
      return range === null ? null : text.slice(range[0] + 1, range[1])
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

    // AND THE ANCHOR CANNOT SAY *WHICH LITERALS HAD TO CARRY IT* (Argus r21
    // blocker, with a working mutant). Every scan above starts from the landed
    // probe, so a mutant that deletes BOTH properties from a dispatch site and
    // re-spells the PAIR in a decoy `void { … }` beside the definitions keeps the
    // counts equal AND leaves every anchored literal validly paired — the site is
    // simply no longer looked at. An anchor-driven scan can only ever check the
    // sites that still carry the anchor, which is the one thing the mutant
    // removes.
    //
    // So the site set is derived from the shape the CHOKEPOINT REQUIRES, not from
    // the property under test: `dispatchBoardBoundBuild`'s deps (and the
    // composition's `trident_build_dispatch`, its snake-cased twin) are the object
    // literals carrying a direct `store:` AND a direct `repo_path:`. Those are
    // required fields — a mutant cannot drop them to hide from this scan without
    // failing to compile — and a decoy `void { … }` has neither, so it is not a
    // site. Every site must then carry the probe AND the runner as direct
    // properties of ITSELF.
    /**
     * AND THE LITERAL IS NOT NECESSARILY THE ARGUMENT (Argus r6 blocker, codex's
     * mutant, confirmed by the synthesizer). Every rule below reads the LITERAL —
     * but the chokepoint is handed an EXPRESSION, and an expression may wrap the
     * literal and rewrite it on the way past:
     * `Object.assign({ store, repo_path, landedProbe: …, hostRunner: … }, { hostRunner: undefined })`
     * leaves the wired literal untouched — every count equal, every site paired,
     * every mention still last, nothing computed and nothing spread — while the
     * second literal carries neither `store:` nor `repo_path:`, so it is not a
     * site and is never read. Production takes the uncredentialed fallback with
     * this test green.
     *
     * Chasing wrapper SPELLINGS cannot work (`Object.assign` today, a local alias
     * or a merge helper of one's own tomorrow). So, as with legibility, the rule
     * runs the other way round and FAILS CLOSED: the site's literal must sit in
     * one of the hand-off positions this file actually uses, read off
     * TypeScript's OWN parse tree — a `return` OF THE FUNCTION THAT IS ITSELF
     * HANDED OVER (`resolve_context`, not any nested helper), a property value,
     * an arrow's concise body, or a direct argument of `dispatchBoardBoundBuild`.
     * Anything else is reported UNWIRED, because "something else receives this
     * literal first" is not "the chokepoint receives this literal".
     */
    const parseSource = (text: string): ts.SourceFile =>
      ts.createSourceFile(
        'composer.scan.ts',
        text,
        ts.ScriptTarget.Latest,
        /* setParentNodes */ true,
        ts.ScriptKind.TS,
      )

    /** The INNERMOST object literal whose extent covers `idx`. */
    const innermostObjectAt = (
      file: ts.SourceFile,
      idx: number,
    ): ts.ObjectLiteralExpression | null => {
      // Outermost first, so the last one pushed is the innermost.
      const covering: ts.ObjectLiteralExpression[] = []
      const visit = (node: ts.Node): void => {
        if (node.getFullStart() > idx || node.getEnd() <= idx) return
        if (ts.isObjectLiteralExpression(node)) covering.push(node)
        ts.forEachChild(node, visit)
      }
      ts.forEachChild(file, visit)
      return covering[covering.length - 1] ?? null
    }

    /** The function whose `return` this node is — the nearest function-like ancestor. */
    const enclosingFunction = (node: ts.Node): ts.Node | null => {
      for (let p: ts.Node | undefined = node.parent; p !== undefined; p = p.parent) {
        if (ts.isFunctionLike(p)) return p
      }
      return null
    }

    /** True when the literal at `idx` is what its consumer receives, unmodified. */
    const handedOverDirectly = (file: ts.SourceFile, idx: number): boolean => {
      const lit = innermostObjectAt(file, idx)
      if (lit === null) return false
      const parent = lit.parent
      // `/code`'s `resolve_context`: `return { … }` — AND ONLY THE RETURN OF
      // `resolve_context` ITSELF (Argus r29 blocker, re-executed by synthesis).
      // Accepting ANY return statement re-opened the wrapper hole this whole rule
      // exists to close, from the inside: put the wired literal in an inner
      // function and hand the outer function's caller the wrapper —
      // `return Object.assign((() => { return { … } })(), { hostRunner: undefined })`
      // — and the literal is in a `return` position, every count is equal, every
      // site is paired and bound, and the filter receives an object whose
      // `hostRunner` is undefined. A `return` only reaches the chokepoint when the
      // FUNCTION it belongs to is itself the value handed over, so the rule asks
      // that question instead of trusting the keyword.
      if (ts.isReturnStatement(parent)) {
        const fn = enclosingFunction(parent)
        if (fn === null) return false
        const owner = fn.parent
        return (
          ts.isPropertyAssignment(owner) &&
          owner.initializer === fn &&
          ts.isIdentifier(owner.name) &&
          owner.name.text === 'resolve_context'
        )
      }
      // The agent-native entry: `trident_build_dispatch: { … }`.
      if (ts.isPropertyAssignment(parent)) return parent.initializer === lit
      // The hold sweep: `makeDispatchDeps: (hold) => ({ … })`.
      if (ts.isParenthesizedExpression(parent)) {
        return ts.isArrowFunction(parent.parent) && parent.parent.body === parent
      }
      if (ts.isArrowFunction(parent)) return parent.body === lit
      // The app's ▶: `dispatchBoardBoundBuild(request, { … })` — the chokepoint BY
      // NAME, so a merging helper cannot stand in for it under another identifier.
      return (
        ts.isCallExpression(parent) &&
        parent.arguments.some((arg) => arg === lit) &&
        ts.isIdentifier(parent.expression) &&
        parent.expression.text === 'dispatchBoardBoundBuild'
      )
    }

    /**
     * AND A NAME IS NOT A VALUE (Argus r8 BLOCKER, codex's executed mutant). Every
     * rule above reads the SPELLING `hostRunner: tridentHostRunner` and asks where
     * that literal goes — but JavaScript does not resolve an identifier by its
     * spelling, it resolves it by its BINDING. Declaring
     * `const tridentHostRunner = async () => ({ ok: false, … })` inside
     * `boardStartBuild`, one line above the `dispatchBoardBoundBuild(` call, shadows
     * the credentialed runner for that whole closure: the wired property line is
     * untouched, so every count is equal, the pair is paired, the literal is legible,
     * the runner is still the last mention on its own wired line and the literal is
     * still a direct argument of the chokepoint BY NAME — and the object the ▶ site
     * hands over carries an uncredentialed stub. `tsc --noEmit` is silent, because
     * shadowing is legal and `BoardBoundBuildDeps.hostRunner` is structurally
     * satisfied by the stub.
     *
     * The behavioural half of this test proves ONE value credentialed by running it:
     * `tbd.host_runner` — the composition's own `host_runner: tridentHostRunner`
     * site — exports the planted token (above). What that cannot say by itself is
     * that the OTHER three sites name the SAME value, and that is exactly what a
     * shadowing binding breaks. So the scan asks the only question that closes the
     * gap: at each site's position, how many declarations of `tridentHostRunner` (and
     * of `tridentLandedProbe`) are IN SCOPE? Exactly one — the composer-level `const`
     * the behavioural probe ran — means the site's reference is that value. Two means
     * the reference is ambiguous to this scan, and an ambiguous reference is reported
     * UNWIRED, on the same "I could not tell is not it is wired" rule as legibility.
     *
     * It is scope-resolution rather than a name count on purpose: the count would red
     * on any unrelated local of the same name anywhere in a 7,000-line file, while
     * this reds only a binding that actually covers a dispatch site. The mutant is
     * applied to the real source at the bottom of this test and must come out RED.
     */
    const bindingScopesOf = (file: ts.SourceFile, name: string): ts.Node[] => {
      /** The node whose scope a declaration belongs to — its nearest scope ancestor. */
      const scopeOf = (decl: ts.Node): ts.Node => {
        for (let p: ts.Node | undefined = decl.parent; p !== undefined; p = p.parent) {
          if (
            ts.isSourceFile(p) ||
            ts.isBlock(p) ||
            ts.isModuleBlock(p) ||
            ts.isCaseBlock(p) ||
            ts.isForStatement(p) ||
            ts.isForInStatement(p) ||
            ts.isForOfStatement(p) ||
            ts.isCatchClause(p) ||
            ts.isFunctionLike(p)
          ) {
            return p
          }
        }
        return file
      }
      const out: ts.Node[] = []
      const visit = (node: ts.Node): void => {
        const named =
          ts.isVariableDeclaration(node) ||
          ts.isParameter(node) ||
          ts.isBindingElement(node) ||
          ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isImportSpecifier(node) ||
          ts.isImportClause(node)
        if (named && node.name !== undefined && ts.isIdentifier(node.name) && node.name.text === name) {
          out.push(scopeOf(node))
        }
        ts.forEachChild(node, visit)
      }
      ts.forEachChild(file, visit)
      return out
    }
    /** How many declarations of `name` have `idx` inside their scope. */
    const bindingsCovering = (file: ts.SourceFile, name: string, idx: number): number =>
      bindingScopesOf(file, name).filter(
        (scope) =>
          ts.isSourceFile(scope) || (scope.getStart(file) <= idx && scope.getEnd() >= idx),
      ).length

    interface DepsSite {
      /** Everything between the literal's braces, nesting included. */
      body: string
      /** The lines of that body that are its DIRECT properties. */
      lines: string[]
      /** Whether THAT literal is the value the chokepoint receives. */
      handedOver: boolean
      /** Whether the wired identifiers resolve unambiguously at THIS position. */
      unshadowed: boolean
    }
    const dispatchDepsSites = (text: string): DepsSite[] => {
      const file = parseSource(text)
      const re = /^[ \t]*repo_path:[ \t]/gm
      const out: DepsSite[] = []
      for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        const range = enclosingObjectRange(text, m.index)
        if (range === null) continue
        const body = text.slice(range[0] + 1, range[1])
        const lines = directPropertyLines(body)
        // Self-check, as above: the anchor line must come back as a DIRECT
        // property of the literal the scan found, or the scan mis-parsed.
        if (!lines.some((l) => /^[ \t]*repo_path:[ \t]/.test(l))) continue
        if (!lines.some((l) => /^[ \t]*store:[ \t]/.test(l))) continue
        out.push({
          body,
          lines,
          handedOver: handedOverDirectly(file, range[0]),
          unshadowed:
            bindingsCovering(file, 'tridentHostRunner', range[0]) === 1 &&
            bindingsCovering(file, 'tridentLandedProbe', range[0]) === 1,
        })
      }
      return out
    }
    /**
     * The property is BOUND to the wired value when the last thing anywhere in the
     * literal that so much as NAMES it is the wired property line itself.
     *
     * AND THE PRESENCE OF A LINE IS NOT THE VALUE OF THE PROPERTY (Argus r22
     * blocker, codex's executed mutant). `...{ hostRunner: undefined }` spliced in
     * AFTER the wired property deletes nothing: every count stays equal, every
     * literal stays "paired", the spelling is still right there — it is simply
     * overwritten, and production takes the uncredentialed fallback again. A plain
     * duplicate key (`hostRunner: undefined,`) is the same override without the
     * spread. Last-mention-wins covers both, and it covers them wherever in the
     * literal they are written, because a later key is what JS itself honours.
     * These literals name each half exactly once today, so nothing legitimate is
     * caught by it — including the hold sweep's site, which DOES carry conditional
     * spreads, none of which mention either half.
     *
     * RE-RAISED IN r3 AS STILL-OPEN, AND RE-RUN HERE RATHER THAN ARGUED: splicing
     * `...{ hostRunner: undefined },` in after the wired property at the app's ▶
     * site in the real `composer.ts` REDS this test (2 pass / 1 fail, on "EVERY
     * dispatch site that gets the landed probe gets the host runner with it"), and
     * reverting restores 3 pass / 0 fail. It is caught because the spread SPELLS
     * `hostRunner`, so it becomes the last mention and is not the wired line — which
     * is exactly what this rule was written for. Writing it on the SAME line as the
     * wired property does not help either: `propLine` is anchored `^…$`, so a line
     * carrying anything after the binding matches nothing.
     */
    const boundTo = (site: DepsSite, prop: string, value: string): boolean => {
      const named = new RegExp(`\\b${prop}\\b`)
      const mentions = site.body.split('\n').filter((l) => named.test(l))
      const last = mentions[mentions.length - 1]
      return (
        last !== undefined &&
        propLine(prop, value).test(last) &&
        site.lines.some((l) => propLine(prop, value).test(l))
      )
    }
    /**
     * The balanced text of every spread in the literal — `{ … }` or `( … )` for a
     * spread of something inline, and the bare token otherwise (`...deps`), which
     * is enough to see that it is NOT inline.
     */
    const spreadPayloads = (body: string): string[] => {
      const out: string[] = []
      for (let i = body.indexOf('...'); i !== -1; i = body.indexOf('...', i + 3)) {
        let k = i + 3
        while (k < body.length && /\s/.test(body[k]!)) k++
        const open = body[k]
        if (open !== '{' && open !== '(') {
          out.push(body.slice(k, k + 1))
          continue
        }
        let depth = 0
        let end = k
        for (; end < body.length; end++) {
          const c = body[end]
          if (c === '{' || c === '(' || c === '[') depth++
          else if (c === '}' || c === ')' || c === ']') {
            depth--
            if (depth === 0) break
          }
        }
        out.push(body.slice(k, end + 1))
      }
      return out
    }

    /**
     * A LITERAL THIS SCAN CANNOT READ IS NOT A WIRED LITERAL (Argus r23 blocker,
     * codex's executed mutant). `...{ ['host' + 'Runner']: undefined },` spliced in
     * after the wired property binds `hostRunner` to `undefined` at runtime while
     * spelling no `hostRunner` TOKEN anywhere — so the last-mention scan above sees
     * nothing to be last, every count stays equal, and production takes the
     * uncredentialed fallback with this test green. Chasing the spelling cannot
     * work: no text scan evaluates `'host' + 'Runner'`, and the next spelling is
     * free. So the answer is the other way round — a literal that contains a
     * construct this scan cannot statically READ is reported UNWIRED, because "I
     * could not tell" is not "it is wired".
     *
     * Two constructs are unreadable, and neither appears in any of the four
     * production sites: a COMPUTED KEY (`[` in key position — nothing else can name
     * a property without spelling it), and a spread of anything but an inline
     * object literal (`...deps`, `...overrides()`, `...(cond ? {…} : other)` — its
     * keys live somewhere this scan is not looking). The hold sweep's site, the one
     * legitimate user of spreads, writes every one of them as
     * `...(x !== undefined ? { k: x } : {})`: both branches inline literals with
     * identifier keys, which stays readable and stays wired.
     */
    const legible = (site: DepsSite): boolean => {
      // A computed key, in key position: at the start of the literal, or after a
      // `{` or a `,`. An array VALUE (`k: [1, 2]`) follows a `:` and is untouched.
      if (/(^|[{,])\s*\[/.test(site.body)) return false
      return spreadPayloads(site.body).every((payload) => {
        if (!payload.startsWith('{') && !payload.startsWith('(')) return false
        // Every branch of the spread must be an inline object literal: strip the
        // balanced `{ … }` groups and no `?`/`:` may still be followed by a name.
        let stripped = payload
        for (let prev = ''; prev !== stripped; ) {
          prev = stripped
          stripped = stripped.replace(/\{[^{}]*\}/g, '')
        }
        return /\{|\}/.test(payload) && !/[?:]\s*\w/.test(stripped)
      })
    }

    const siteIsWired = (site: DepsSite): boolean => {
      // A literal the chokepoint never receives is not a wired literal, whatever
      // it says inside itself.
      if (!site.handedOver) return false
      if (!legible(site)) return false
      // …and a literal whose wired identifiers do not resolve to the ONE
      // credentialed binding is not a wired literal either, whatever it spells.
      if (!site.unshadowed) return false
      const has = (prop: string, value: string): boolean =>
        site.lines.some((l) => propLine(prop, value).test(l))
      if (has('landedProbe', 'tridentLandedProbe')) {
        return (
          boundTo(site, 'landedProbe', 'tridentLandedProbe') &&
          boundTo(site, 'hostRunner', 'tridentHostRunner')
        )
      }
      if (has('landed_probe', 'tridentLandedProbe')) {
        return (
          boundTo(site, 'landed_probe', 'tridentLandedProbe') &&
          boundTo(site, 'host_runner', 'tridentHostRunner')
        )
      }
      // Neither half — the site takes the uncredentialed fallback for both reads.
      return false
    }

    // The four production entries into the chokepoint, in file order: `/code`'s
    // `resolve_context`, the app's ▶ `boardStartBuild`, the hold sweep's
    // `makeDispatchDeps`, and the agent-native `trident_build_dispatch`. Pinned
    // exactly, so a FIFTH entry cannot be added without being wired here too —
    // and so a site that quietly disappears cannot read as "all sites paired".
    expect(dispatchDepsSites(src).length).toBe(4)
    // Positive control for the hand-off gate: all four production literals ARE
    // what their consumer receives, so it cannot be answering "unwired" for
    // everything below.
    expect(dispatchDepsSites(src).filter((site) => site.handedOver).length).toBe(4)
    // Positive control for the scope gate, same reason: all four production sites
    // see exactly ONE binding of each wired identifier today, so it cannot be
    // answering "unwired" for everything below.
    expect(dispatchDepsSites(src).filter((site) => site.unshadowed).length).toBe(4)
    expect(dispatchDepsSites(src).filter((site) => !siteIsWired(site)).length).toBe(0)

    // THE REVIEWERS' MUTANTS, APPLIED TO THE REAL SOURCE. Both unwire the app's ▶
    // dispatch site — the second camel-cased entry — and re-spell what they took
    // in a decoy object beside the runner's definition.
    const lines = src.split('\n')
    const anchorAt = lines.reduce<number[]>(
      (acc, l, i) => (propLine('landedProbe', 'tridentLandedProbe').test(l) ? [...acc, i] : acc),
      [],
    )
    expect(anchorAt.length).toBeGreaterThanOrEqual(2)
    const victimProbe = anchorAt[1]!
    const victimRunner = lines.findIndex(
      (l, i) => i > victimProbe && propLine('hostRunner', 'tridentHostRunner').test(l),
    )
    expect(victimRunner).toBeGreaterThan(victimProbe)
    const decoyAt = lines.findIndex((l) => l.includes('const tridentHostRunner ='))
    expect(decoyAt).toBeGreaterThan(-1)
    /**
     * Delete `drop` and splice a decoy in after `decoyAt` IN ONE PASS over the
     * ORIGINAL array. Argus r21 (minor) caught the two-pass form: it compared a
     * post-`filter` index against a `decoyAt` computed before the filter, so the
     * decoy landed one line off the moment the definition sat below the victim —
     * silently changing what the mutant proved.
     */
    const mutate = (drop: number[], decoy: string[]): string =>
      lines
        .flatMap((l, i) =>
          drop.includes(i) ? [] : i === decoyAt ? [l, 'void {', ...decoy, '}'] : [l],
        )
        .join('\n')

    // r20 — unwire the RUNNER only, and re-spell it beside the definition.
    const runnerMutant = mutate([victimRunner], ['  hostRunner: tridentHostRunner,'])
    // The count this test used to rest on is STILL EQUAL under it — which is
    // exactly why counting is not the assertion.
    expect(count('hostRunner', 'tridentHostRunner', runnerMutant)).toBe(
      count('landedProbe', 'tridentLandedProbe', runnerMutant),
    )
    // …and the per-literal pairing says what the count cannot: one anchored
    // literal now takes the landed probe WITHOUT the credentialed runner beside it.
    expect(camelPairs(runnerMutant).filter((paired) => !paired).length).toBe(1)
    expect(dispatchDepsSites(runnerMutant).filter((site) => !siteIsWired(site)).length).toBe(1)

    // r21 — unwire the WHOLE site: take BOTH properties and re-spell the pair in
    // the decoy. This is the mutant the anchored scan cannot see.
    const siteMutant = mutate(
      [victimProbe, victimRunner],
      ['  landedProbe: tridentLandedProbe,', '  hostRunner: tridentHostRunner,'],
    )
    expect(count('landedProbe', 'tridentLandedProbe', siteMutant)).toBe(
      count('landedProbe', 'tridentLandedProbe'),
    )
    expect(count('hostRunner', 'tridentHostRunner', siteMutant)).toBe(
      count('hostRunner', 'tridentHostRunner'),
    )
    // The anchored scan is BLIND to it — every literal it finds is validly paired,
    // because the unwired one no longer carries the anchor it scans for.
    expect(camelPairs(siteMutant).every((paired) => paired)).toBe(true)
    // The site-derived scan is not: the ▶ deps literal still has `store:` and
    // `repo_path:`, and now carries neither half of the credentialed pair.
    expect(dispatchDepsSites(siteMutant).length).toBe(4)
    expect(dispatchDepsSites(siteMutant).filter((site) => !siteIsWired(site)).length).toBe(1)

    // r22 — codex's mutant, the one that DELETES NOTHING. The wired property stays
    // exactly where it is and a spread OVERRIDES it one line below, so every count
    // and every per-literal pairing is untouched while JS binds `hostRunner` to
    // `undefined` and the site falls back to the uncredentialed reader.
    const splice = (at: number, added: string[]): string =>
      lines.flatMap((l, i) => (i === at ? [l, ...added] : [l])).join('\n')
    const spreadMutant = splice(victimRunner, ['        ...{ hostRunner: undefined },'])
    expect(count('hostRunner', 'tridentHostRunner', spreadMutant)).toBe(
      count('hostRunner', 'tridentHostRunner'),
    )
    // Both scans that read PRESENCE are blind to it — which is why the site scan
    // now reads the last line that can BIND the property instead.
    expect(camelPairs(spreadMutant).every((paired) => paired)).toBe(true)
    expect(dispatchDepsSites(spreadMutant).length).toBe(4)
    expect(dispatchDepsSites(spreadMutant).filter((site) => !siteIsWired(site)).length).toBe(1)

    // …and the same override spelled as a plain duplicate key, no spread involved.
    const overrideMutant = splice(victimRunner, ['        hostRunner: undefined,'])
    expect(count('hostRunner', 'tridentHostRunner', overrideMutant)).toBe(
      count('hostRunner', 'tridentHostRunner'),
    )
    expect(camelPairs(overrideMutant).every((paired) => paired)).toBe(true)
    expect(dispatchDepsSites(overrideMutant).filter((site) => !siteIsWired(site)).length).toBe(1)

    // r23 — codex's mutant again, one indirection further: the override NAMES
    // NOTHING. A computed key assembled from two fragments binds `hostRunner` to
    // `undefined` while the token `hostRunner` never appears, so last-mention-wins
    // has no later mention to find. Caught by legibility, not by spelling.
    const computedMutant = splice(victimRunner, ["        ...{ ['host' + 'Runner']: undefined },"])
    expect(computedMutant).not.toMatch(/\.\.\.\{ hostRunner/)
    expect(count('hostRunner', 'tridentHostRunner', computedMutant)).toBe(
      count('hostRunner', 'tridentHostRunner'),
    )
    // Every scan that reads a SPELLING is blind to it — the token is not there to
    // read — and the site scan still reports the site unwired.
    expect(camelPairs(computedMutant).every((paired) => paired)).toBe(true)
    expect(dispatchDepsSites(computedMutant).length).toBe(4)
    expect(dispatchDepsSites(computedMutant).filter((site) => !siteIsWired(site)).length).toBe(1)

    // …and the same override hidden behind a spread of a name defined elsewhere,
    // which is the other construct a text scan cannot follow.
    const opaqueMutant = splice(victimRunner, ['        ...runnerOverride,'])
    expect(count('hostRunner', 'tridentHostRunner', opaqueMutant)).toBe(
      count('hostRunner', 'tridentHostRunner'),
    )
    expect(camelPairs(opaqueMutant).every((paired) => paired)).toBe(true)
    expect(dispatchDepsSites(opaqueMutant).filter((site) => !siteIsWired(site)).length).toBe(1)

    // POSITIVE CONTROL FOR THE LEGIBILITY GATE: it must not answer "unwired" for
    // everything. The hold sweep's site carries five conditional spreads today and
    // is legible; so is a NEW conditional spread added to the victim site, which is
    // the shape a future edit is most likely to add.
    const legitSpreadMutant = splice(victimRunner, [
      '                ...(chatId !== null ? { chat_id: chatId } : {}),',
    ])
    expect(dispatchDepsSites(legitSpreadMutant).filter((site) => !siteIsWired(site)).length).toBe(0)

    // r6 — the wrapper mutant: DELETE NOTHING, CHANGE NOTHING INSIDE, and hand the
    // chokepoint something else. The victim literal is spliced verbatim into
    // `Object.assign(…, { hostRunner: undefined })`, so JS binds `hostRunner` to
    // undefined in the object the call actually receives while the literal every
    // scan above reads is character-for-character the wired one.
    const offsetOfLine = (n: number): number =>
      lines.slice(0, n).reduce((acc, l) => acc + l.length + 1, 0)
    const victimRange = enclosingObjectRange(src, offsetOfLine(victimProbe))
    expect(victimRange).not.toBeNull()
    const [victimOpen, victimClose] = victimRange!
    const wrap = (callee: string): string =>
      `${src.slice(0, victimOpen)}${callee}(${src.slice(victimOpen, victimClose + 1)}, { hostRunner: undefined })${src.slice(victimClose + 1)}`
    const wrappedMutant = wrap('Object.assign')
    // The wired literal survives the mutation byte for byte…
    expect(wrappedMutant).toContain(src.slice(victimOpen, victimClose + 1))
    expect(count('hostRunner', 'tridentHostRunner', wrappedMutant)).toBe(
      count('hostRunner', 'tridentHostRunner'),
    )
    expect(count('landedProbe', 'tridentLandedProbe', wrappedMutant)).toBe(
      count('landedProbe', 'tridentLandedProbe'),
    )
    // …so every rule that reads the literal is blind: the pairs are paired, the
    // site is still a site, it is legible, and each half is still last-mentioned
    // on its own wired line.
    expect(camelPairs(wrappedMutant).every((paired) => paired)).toBe(true)
    expect(dispatchDepsSites(wrappedMutant).length).toBe(4)
    expect(
      dispatchDepsSites(wrappedMutant).filter((site) => legible(site) && site.handedOver).length,
    ).toBe(3)
    // The hand-off gate is not: one site's literal is no longer what the
    // chokepoint receives.
    expect(dispatchDepsSites(wrappedMutant).filter((site) => !siteIsWired(site)).length).toBe(1)

    // …and the same wrapper under a name of its own, because the rule is a
    // whitelist of hand-off positions and not a blocklist of `Object.assign`.
    const aliasWrappedMutant = wrap('mergeDeps')
    expect(count('hostRunner', 'tridentHostRunner', aliasWrappedMutant)).toBe(
      count('hostRunner', 'tridentHostRunner'),
    )
    expect(camelPairs(aliasWrappedMutant).every((paired) => paired)).toBe(true)
    expect(dispatchDepsSites(aliasWrappedMutant).length).toBe(4)
    expect(
      dispatchDepsSites(aliasWrappedMutant).filter((site) => !siteIsWired(site)).length,
    ).toBe(1)

    // r29 — THE SAME WRAPPER, HIDDEN BEHIND A `return` (Argus r29 blocker,
    // re-executed by synthesis: the docblock above promised this shape was
    // reported UNWIRED and it was not). The victim is `/code`'s `resolve_context`
    // — the ONE site whose hand-off position is a return statement — and the
    // mutant moves its literal into an inner function, so the literal is still
    // returned, by a function nobody hands over, while what `resolve_context`
    // returns is the wrapper. Nothing inside the literal changes.
    const codeRange = enclosingObjectRange(src, offsetOfLine(anchorAt[0]!))
    expect(codeRange).not.toBeNull()
    const [codeOpen, codeClose] = codeRange!
    const innerReturnMutant = `${src.slice(0, codeOpen)}Object.assign((() => { return ${src.slice(
      codeOpen,
      codeClose + 1,
    )} })(), { hostRunner: undefined })${src.slice(codeClose + 1)}`
    // The wired literal survives byte for byte, and every count-and-pair rule is
    // as blind to it as it was to the outer wrapper…
    expect(innerReturnMutant).toContain(src.slice(codeOpen, codeClose + 1))
    expect(count('hostRunner', 'tridentHostRunner', innerReturnMutant)).toBe(
      count('hostRunner', 'tridentHostRunner'),
    )
    expect(camelPairs(innerReturnMutant).every((paired) => paired)).toBe(true)
    expect(dispatchDepsSites(innerReturnMutant).length).toBe(4)
    // …but the hand-off gate now asks WHOSE return it is, so the site is unwired.
    expect(
      dispatchDepsSites(innerReturnMutant).filter((site) => !siteIsWired(site)).length,
    ).toBe(1)

    // r8 — codex's mutant, and the one every rule above missed because every rule
    // above reads a SPELLING: DELETE NOTHING, CHANGE NOTHING, SHADOW THE NAME. An
    // uncredentialed `const tridentHostRunner` declared inside `boardStartBuild`,
    // immediately above the `dispatchBoardBoundBuild(` call, rebinds the identifier
    // for that closure only — so the ▶ site hands the chokepoint a stub while its
    // wired property line is byte-for-byte the one this file has always asserted.
    // The ▶ site is the only production entry that CALLS the chokepoint inline, so
    // this line is its call and the victim literal opens just below it.
    const dispatchCallAt = lines.findIndex((l) => l.includes('await dispatchBoardBoundBuild('))
    expect(dispatchCallAt).toBeGreaterThan(-1)
    expect(lines.filter((l) => l.includes('await dispatchBoardBoundBuild(')).length).toBe(1)
    expect(dispatchCallAt).toBeLessThan(victimProbe)
    const shadowMutant = lines
      .flatMap((l, i) =>
        i === dispatchCallAt
          ? [
              '            const tridentHostRunner = async () => ({ ok: false as const, stdout: 0, stderr: 0, exit_code: 1 })',
              l,
            ]
          : [l],
      )
      .join('\n')
    // The mutant DELETES NOTHING: every wired property line is still spelled,
    // character for character, and both counts are untouched.
    expect(count('hostRunner', 'tridentHostRunner', shadowMutant)).toBe(
      count('hostRunner', 'tridentHostRunner'),
    )
    expect(count('landedProbe', 'tridentLandedProbe', shadowMutant)).toBe(
      count('landedProbe', 'tridentLandedProbe'),
    )
    // Every rule this file had before is blind to it — the pairs pair, the sites
    // are sites, each is legible, each is handed over, and each half is still the
    // last mention on its own wired line.
    expect(camelPairs(shadowMutant).every((paired) => paired)).toBe(true)
    expect(dispatchDepsSites(shadowMutant).length).toBe(4)
    expect(
      dispatchDepsSites(shadowMutant).filter((site) => site.handedOver && legible(site)).length,
    ).toBe(4)
    // The scope gate is not: at the ▶ site TWO declarations of `tridentHostRunner`
    // are in scope, so what that site's property names is no longer decidable — and
    // exactly one site, the mutated one, is reported unwired.
    expect(dispatchDepsSites(shadowMutant).filter((site) => !site.unshadowed).length).toBe(1)
    expect(dispatchDepsSites(shadowMutant).filter((site) => !siteIsWired(site)).length).toBe(1)
    // …and the gate is positional, not a name count: a same-named local in a scope
    // that covers NO dispatch site leaves every site wired.
    const unrelatedLocalMutant = splice(0, [
      'const unrelated = () => { const tridentHostRunner = 1; return tridentHostRunner }',
    ])
    expect(dispatchDepsSites(unrelatedLocalMutant).filter((site) => !siteIsWired(site)).length).toBe(
      0,
    )

    // FAIL-CLOSED, PROVEN RATHER THAN CLAIMED (Argus r8 major). The hand-off rule
    // names `resolve_context` because that is the one production entry whose
    // hand-off position is a `return`, and accepting ANY return re-opens the r29
    // wrapper hole. The cost of naming it is that a RENAME of that property reads as
    // unwired — which is the safe direction, and is asserted here so nobody has to
    // take the docblock's word for it: the site goes red and has to be re-declared
    // above, rather than silently ceasing to be checked.
    const renamedHandoffMutant = src.replace('resolve_context: (input) =>', 'resolveContext: (input) =>')
    expect(renamedHandoffMutant).not.toBe(src)
    expect(dispatchDepsSites(renamedHandoffMutant).length).toBe(4)
    expect(
      dispatchDepsSites(renamedHandoffMutant).filter((site) => !siteIsWired(site)).length,
    ).toBe(1)

    // r4 — the simplest mutant of all, and the one every rule above missed: DELETE
    // NOTHING, COMMENT IT OUT. The wired property stays spelled exactly as it is,
    // between a `/*` and a `*/`, and the old line-prefix strip removed only the two
    // delimiters — so the property survived into the "executable" text, every count
    // stayed equal, every site stayed paired and bound, and production carried no
    // `hostRunner`. Applied to the REAL source, before the strip, because that is
    // where a comment can exist at all.
    const rawLines = raw.split('\n')
    const rawAnchors = rawLines.reduce<number[]>(
      (acc, l, i) => (propLine('landedProbe', 'tridentLandedProbe').test(l) ? [...acc, i] : acc),
      [],
    )
    expect(rawAnchors.length).toBeGreaterThanOrEqual(2)
    const rawRunner = rawLines.findIndex(
      (l, i) => i > rawAnchors[1]! && propLine('hostRunner', 'tridentHostRunner').test(l),
    )
    expect(rawRunner).toBeGreaterThan(rawAnchors[1]!)
    const commentedRaw = rawLines
      .flatMap((l, i) => (i === rawRunner ? ['/*', l, '*/'] : [l]))
      .join('\n')
    // The mutant DELETES NOTHING: the property line is still spelled, character for
    // character, in the mutated source — which is exactly why a scan over the raw
    // file cannot tell it from the wired file.
    expect(commentedRaw.split('\n').filter((l) => propLine('hostRunner', 'tridentHostRunner').test(l))
      .length).toBe(rawLines.filter((l) => propLine('hostRunner', 'tridentHostRunner').test(l)).length)
    const commentedMutant = executable(commentedRaw)
    // The strip takes it out of the executable text…
    expect(count('hostRunner', 'tridentHostRunner', commentedMutant)).toBe(
      count('hostRunner', 'tridentHostRunner') - 1,
    )
    // …and the site-derived scan says which site lost it, with the other three and
    // the site count untouched.
    expect(dispatchDepsSites(commentedMutant).length).toBe(4)
    expect(dispatchDepsSites(commentedMutant).filter((site) => !siteIsWired(site)).length).toBe(1)

    // r5 — the same "delete nothing, comment it out", one character further in:
    // the block does not OPEN on its own line. Hanging ` /*` off the END of the
    // property line above the pair and closing it after the runner comments BOTH
    // halves out at runtime, and the line-prefix strip that answered r4 kept both
    // property lines and ate the `*/`. Applied to the REAL source.
    const beforeProbe = rawAnchors[1]! - 1
    // The mutant only proves something if the line it hangs the `/*` off is
    // executable code today — a `//` line would swallow it and prove nothing.
    expect(rawLines[beforeProbe]!.trimStart().startsWith('//')).toBe(false)
    expect(rawLines[beforeProbe]!.trimEnd().endsWith(',')).toBe(true)
    const inlineOpenRaw = rawLines
      .flatMap((l, i) => (i === beforeProbe ? [`${l} /*`] : i === rawRunner ? [l, '*/'] : [l]))
      .join('\n')
    // Again: the mutant DELETES NOTHING. Both property lines are still spelled,
    // character for character, in the mutated source.
    expect(
      inlineOpenRaw.split('\n').filter((l) => propLine('hostRunner', 'tridentHostRunner').test(l))
        .length,
    ).toBe(rawLines.filter((l) => propLine('hostRunner', 'tridentHostRunner').test(l)).length)
    expect(
      inlineOpenRaw
        .split('\n')
        .filter((l) => propLine('landedProbe', 'tridentLandedProbe').test(l)).length,
    ).toBe(rawLines.filter((l) => propLine('landedProbe', 'tridentLandedProbe').test(l)).length)
    const inlineOpenMutant = executable(inlineOpenRaw)
    // …and the scanner-backed strip takes BOTH halves out of the executable text,
    // exactly as the runtime object does.
    expect(count('hostRunner', 'tridentHostRunner', inlineOpenMutant)).toBe(
      count('hostRunner', 'tridentHostRunner') - 1,
    )
    expect(count('landedProbe', 'tridentLandedProbe', inlineOpenMutant)).toBe(
      count('landedProbe', 'tridentLandedProbe') - 1,
    )
    // The site is still a site — it keeps `store:` and `repo_path:` — and it is
    // now unwired, with the other three untouched.
    expect(dispatchDepsSites(inlineOpenMutant).length).toBe(4)
    expect(dispatchDepsSites(inlineOpenMutant).filter((site) => !siteIsWired(site)).length).toBe(1)
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
