/**
 * WHERE THE PRODUCT'S CHAT-COMMAND FILTERS ARE, read out of the source.
 *
 * WHAT THIS REPLACED, AND WHY. The completeness gate next door used to read ONE
 * hardcoded path (`gateway/boot-chat-command-filters.ts`) with ONE regex
 * (`^export function build…ChatCommandFilter`). It reported 4 factories and
 * passed. The product had 10. The four it could not see —
 * `buildSkillForgeChatCommandFilter` (`skill-forge/command.ts:184`),
 * `createEmailChatCommandFilter` (`cores/free/email/src/chat-bridge.ts:72`),
 * `createResearchChatCommandFilter` (`cores/free/research/src/chat-bridge.ts:49`),
 * `createScrapingChatCommandFilter` (`cores/free/scraping/src/chat-bridge.ts:40`)
 * — were invisible for two independent reasons: they live outside that file, and
 * three of them are named `create…` rather than `build…`. Three of the four are
 * live in the composed chain today, so unwiring any of them turned nothing red.
 * A blind gate and a satisfied gate emit the identical green.
 *
 * WHAT THIS READER SEES. Every non-test `.ts`/`.tsx` file under the repo root,
 * minus `node_modules`, `vendor/` (Open consumed as a submodule elsewhere — not
 * this product's source), and build output. Within those, an exported function
 * declaration counts as a chat-command filter factory when EITHER its name ends
 * in `ChatCommandFilter` (any verb — `build`, `create`, or one nobody has
 * invented yet) OR its declared return type names a type ending in
 * `ChatCommandFilter`. The second rule is what stops a rename from hiding a
 * factory: `export function makeThing(): ScrapingChatCommandFilter` is caught by
 * its type even though its name says nothing.
 *
 * WHAT THIS READER CANNOT SEE — check these by hand, no gate covers them:
 *   • A factory with an UNINFORMATIVE NAME AND NO DECLARED RETURN TYPE
 *     (`export function makeThing(dep) { return { async match() {…} } }`). The
 *     return type is inferred, and this reader does not run the type checker.
 *   • A filter object defined INLINE at its composition site rather than by a
 *     factory (`buildChainedChatCommandFilter([{ async match() {…} }])`). There
 *     is no declaration to find. `open/__tests__/reachability.test.ts` — which
 *     types the command at a real socket — is the only thing that would catch a
 *     regression there, and only for commands listed in its inventory.
 *   • Anything inside `vendor/`.
 *   • Whether a factory it DID find is actually composed. This reader answers
 *     "does it exist", never "can it be typed" — see the note at the bottom of
 *     this file for why a static wiring check was written and then discarded.
 * The first two blind spots are shapes the repo does not currently use; if one
 * appears, this reader will under-report and say nothing. That is the same class
 * of defect as the one above, one level down, and the only thing standing
 * against it is someone reading this paragraph.
 *
 * SHAPES IT REFUSES RATHER THAN SKIPPING. An exported `const`/`let` binding
 * whose name or type annotation ends in `ChatCommandFilter` is a factory shape
 * this reader does not classify, so it throws instead of dropping it. Same for a
 * root that yields no source files, or source files that never mention the
 * concept at all — both mean the reader is pointed somewhere wrong, and a reader
 * pointed somewhere wrong must not report a clean bill of health. Sibling
 * precedent: `declared-composition-fields.ts`, which refuses on every shape its
 * parse cannot follow.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import ts from 'typescript'

/** One chat-command filter factory, with where it is declared. */
export interface ChatCommandFilterFactory {
  /** The exported function name, e.g. `createEmailChatCommandFilter`. */
  readonly name: string
  /** Repo-relative path of the declaring file. */
  readonly file: string
  /** 1-based line of the `export function`. */
  readonly line: number
}

/** Thrown for anything this reader cannot see or classify. Never swallowed. */
export class ChatCommandFilterScanError extends Error {}

/** The marker every filter declaration shares. Used to pre-filter files cheaply. */
const CONCEPT = 'ChatCommandFilter'

/** Directory names never walked. `vendor` is Open-as-a-submodule, not source. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'vendor',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
])

/**
 * Test files are excluded on purpose: they build filters by the dozen (fakes,
 * counting filters, passthroughs) and none of them ship. Including them would
 * flood the inventory with names no owner can type, and the inventory would stop
 * being read. The cost is that this reader cannot tell a filter that exists only
 * in a test from one that does not exist — which is fine, because a filter that
 * exists only in a test is not a command anyone has.
 */
function isTestFile(rel: string): boolean {
  const parts = rel.split(sep)
  if (parts.includes('__tests__') || parts.includes('__mocks__')) return true
  const base = parts[parts.length - 1] ?? ''
  return /\.(test|spec)\.tsx?$/.test(base)
}

function isSourceFile(rel: string): boolean {
  return /\.tsx?$/.test(rel) && !/\.d\.ts$/.test(rel) && !isTestFile(rel)
}

/**
 * Walk + read results, memoised per root.
 *
 * Not an optimisation for its own sake: without it every `referencesOutsideDefiningFile`
 * call re-walks and re-reads ~2000 files, and ten factories turn a millisecond
 * gate into a slow one. Slow gates get moved to nightly, and nightly gates get
 * ignored. Test runs are short-lived, so a process-lifetime cache cannot go stale
 * against edits made after it was populated.
 */
const walkCache = new Map<string, string[]>()
const readCache = new Map<string, string>()

function readSource(root: string, rel: string): string {
  const key = join(root, rel)
  const hit = readCache.get(key)
  if (hit !== undefined) return hit
  let text: string
  try {
    text = readFileSync(key, 'utf8')
  } catch {
    text = ''
  }
  readCache.set(key, text)
  return text
}

/** Every non-test TS source path under `root`, repo-relative. */
function sourceFiles(root: string): string[] {
  const cached = walkCache.get(root)
  if (cached !== undefined) return cached
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue
      const abs = join(dir, entry)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(abs)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(abs)
        continue
      }
      const rel = relative(root, abs)
      if (isSourceFile(rel)) out.push(rel)
    }
  }
  walk(root)
  out.sort()
  walkCache.set(root, out)
  return out
}

function parse(abs: string, text: string): ts.SourceFile {
  return ts.createSourceFile(abs, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
}

function lineOf(node: ts.Node, sf: ts.SourceFile): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

function isExported(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
  return (mods ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
}

/**
 * Every type-reference NAME mentioned in a type node, un-nested.
 *
 * The un-nesting is what keeps `Promise<ChatCommandFilterResult>` from reading
 * as a factory: this yields `Promise` and `ChatCommandFilterResult`, and neither
 * ENDS in the concept. `Promise<SkillForgeChatCommandFilter>` yields a name that
 * does. So the discriminator is the suffix on a resolved name, not a substring
 * of the printed type — `…FilterResult` / `…FilterInput` / `…FilterError` are
 * the return types of the command EXECUTORS that sit next to every factory, and
 * a substring test would have pulled all of them in.
 */
function typeRefNames(type: ts.TypeNode | undefined): string[] {
  if (type === undefined) return []
  const names: string[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isTypeReferenceNode(n)) {
      const tn = n.typeName
      names.push(ts.isIdentifier(tn) ? tn.text : tn.right.text)
    }
    ts.forEachChild(n, visit)
  }
  visit(type)
  return names
}

const namesTheConcept = (name: string): boolean => name.endsWith(CONCEPT)

/**
 * Read every chat-command filter factory under `root`.
 *
 * @param root repo root (absolute). Returned `file` paths are relative to it.
 * @throws ChatCommandFilterScanError when the root yields nothing to read, or
 *   when a file declares a factory shape this reader does not classify.
 */
export function scanChatCommandFilterFactories(root: string): ChatCommandFilterFactory[] {
  const files = sourceFiles(root)
  if (files.length === 0) {
    throw new ChatCommandFilterScanError(
      `${root} contains no non-test TypeScript sources. The scan root is wrong (a ` +
        `moved test file, a changed relative path). Refusing to report an empty ` +
        `factory set: that would mark every chat command accounted-for and pass ` +
        `vacuously, which is exactly how this gate was blind to 6 of the product's ` +
        `10 filters.`,
    )
  }

  const candidates: Array<{ rel: string; text: string }> = []
  for (const rel of files) {
    const text = readSource(root, rel)
    if (text.includes(CONCEPT)) candidates.push({ rel, text })
  }
  if (candidates.length === 0) {
    throw new ChatCommandFilterScanError(
      `None of the ${files.length} sources under ${root} mention '${CONCEPT}'. Either ` +
        `the scan root is wrong, or the filter contract was renamed and this reader ` +
        `now recognises nothing. Both are broken gates, not clean bills of health.`,
    )
  }

  const found: ChatCommandFilterFactory[] = []
  for (const { rel, text } of candidates) {
    const sf = parse(join(root, rel), text)
    for (const stmt of sf.statements) {
      if (ts.isFunctionDeclaration(stmt)) {
        if (!isExported(stmt) || stmt.name === undefined) continue
        const byName = namesTheConcept(stmt.name.text)
        const byType = typeRefNames(stmt.type).some(namesTheConcept)
        if (byName || byType) {
          found.push({ name: stmt.name.text, file: rel, line: lineOf(stmt, sf) })
        }
        continue
      }
      if (ts.isVariableStatement(stmt) && isExported(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          const declName = ts.isIdentifier(decl.name) ? decl.name.text : ''
          const hit = namesTheConcept(declName) || typeRefNames(decl.type).some(namesTheConcept)
          if (!hit) continue
          throw new ChatCommandFilterScanError(
            `${rel}:${lineOf(decl, sf)} — exported binding '${declName || '<destructured>'}' ` +
              `is a chat-command filter declared as a const/let rather than an ` +
              `\`export function\`. This reader classifies function declarations only, ` +
              `so it would drop this one and the command behind it would leave the ` +
              `reachability gate without anyone noticing. Either declare it as an ` +
              `exported function, or teach this reader the shape — do not let it pass ` +
              `unseen.`,
          )
        }
      }
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * WHY THERE IS NO `isWired(factory)` HERE, THOUGH THAT IS THE QUESTION EVERYONE
 * WANTS ANSWERED.
 *
 * The obvious companion to this scan is a static "is the factory referenced from
 * the composer?" check. It was written, run against this repo, and thrown away
 * because it cannot tell the two cases apart:
 *   • `createResearchChatCommandFilter` is called only inside its own core
 *     (`cores/free/research/src/wiring-production.ts:214`), and that wiring IS
 *     called from `gateway/cores/mount-open-cores.ts:312`. It is live.
 *   • `createScrapingChatCommandFilter` is called only inside its own core
 *     (`cores/free/scraping/src/wiring-production.ts:71`), and that wiring is
 *     called from NOWHERE. It is dead.
 * Both have exactly zero references outside their core. The difference lives one
 * import-graph level up, and a name-reference scan cannot see it, so a check
 * built on one would have reported research as unwired and taught everyone to
 * ignore it. Wiredness is answered by TYPING THE COMMAND at a real socket —
 * `reachability.test.ts`, both for the commands it expects to work and for the
 * ones it expects not to.
 */
