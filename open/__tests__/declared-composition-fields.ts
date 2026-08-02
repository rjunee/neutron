/**
 * THE DECLARATION SIDE of the composition-field coverage gate — every field
 * `CompositionInput` declares, read out of the source with the TypeScript
 * parser.
 *
 * WHY THIS EXISTS AT ALL. The coverage check next door
 * (`composition-field-coverage.test.ts`) answers "which fields does the running
 * product actually set" by booting the real composition and reading
 * `Object.keys`. That is the correct way to ask the WIRED question, and it is
 * the only way that survives object shorthand and post-compose mutation. But it
 * is structurally incapable of asking the DECLARED question: a field that no
 * composer ever sets is `undefined` at runtime and therefore indistinguishable
 * from a field that does not exist. `push_dispatcher` was exactly that shape —
 * declared at `gateway/composition/input/misc-input.ts:30`, consumed at
 * `gateway/composition/build-core-modules.ts:396`, set by nobody, so push
 * registered devices and delivered to none of them. To notice that, something
 * has to read the DECLARATION.
 *
 * WHY THE PARSER AND NOT A REGEX. The obvious version is
 * `grep -rhoE "^\s+[a-z_][a-z_0-9]*\?:" gateway/composition/input/*.ts`. Run it
 * today and it reports 124 names. The real interface has 76. The difference is
 * not noise — the grep is counting members of NESTED interfaces and inline
 * option objects that live in the same files and are not composition fields at
 * all: `now?` and `owner_handle?` inside `AuthGateManagedComposition`
 * (`auth-input.ts:52,79`), `eventLogger?` / `sean_ellis?` / `instance?` nested
 * inside `onboarding_telemetry` (`onboarding-input.ts:23-49`), and so on. A
 * baseline built on that number would be 48 entries of pure fiction, and every
 * one of them would be permanently, inexplicably "unwired". A gate whose
 * allowlist is mostly fiction teaches people to stop reading it.
 *
 * WHY NOT THE FULL TYPE CHECKER. `ts.createProgram` + `getPropertiesOfType`
 * gives the same answer and is the most authoritative source there is — it is
 * what produced the 76/68 figures these functions are validated against (see
 * `declared-composition-fields.test.ts`). It costs ~30 s wall on this repo,
 * because it resolves the entire transitive import graph of every type these
 * interfaces mention. The coverage probe itself takes ~10 s. Tripling a gate's
 * runtime to re-derive a fact that a 12-file parse yields in milliseconds is a
 * bad trade, and slow gates get moved to nightly and then get ignored.
 *
 * So this parses. Parsing is not grepping: `ts.createSourceFile` produces the
 * compiler's own AST, so indentation, comment contents, multi-line types and
 * declaration order cannot mislead it. What parsing gives up versus the checker
 * is the ability to follow shapes the checker would resolve for it —
 * `extends Pick<X, 'a'>`, a mapped type, an index signature, an interface
 * re-exported through a barrel. Every one of those is REFUSED LOUDLY below
 * rather than silently under-reported, because under-reporting here means a
 * field quietly leaves the gate's world, which is the precise failure this file
 * exists to prevent.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import ts from 'typescript'

/** One field on `CompositionInput`, with where it is declared. */
export interface DeclaredCompositionField {
  readonly name: string
  /** `foo?: T` (a field a composer may legitimately omit) vs `foo: T`. */
  readonly optional: boolean
  /** Repo-relative path of the declaring file. */
  readonly file: string
  /** 1-based line of the declaration. */
  readonly line: number
}

/**
 * Floor for "did the reader actually read anything". Not the exact count —
 * that would be a second baseline to keep in sync, and the inventory next door
 * is already the baseline. It only has to be high enough that a reader which
 * resolved nothing (a moved file, a renamed interface, a refactor into a shape
 * the parse cannot follow) fails loudly instead of reporting a tiny declared
 * set — which would read as "almost everything is wired" and pass clean.
 */
export const MIN_EXPECTED_DECLARED_FIELDS = 60

/** Thrown for any shape this reader cannot follow. Never swallowed. */
export class DeclaredFieldsError extends Error {}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  )
}

function lineOf(node: ts.Node, sf: ts.SourceFile): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

function findInterface(sf: ts.SourceFile, name: string): ts.InterfaceDeclaration | undefined {
  let found: ts.InterfaceDeclaration | undefined
  ts.forEachChild(sf, (n) => {
    if (ts.isInterfaceDeclaration(n) && n.name.text === name) found = n
  })
  return found
}

/**
 * Resolve `import type { X } from './y.ts'` to an absolute path.
 *
 * Only relative specifiers are followed. A composition sub-interface arriving
 * from a package (or a barrel re-export) is a shape this reader cannot see
 * through, so it refuses rather than dropping that interface's fields on the
 * floor — silently returning fewer fields would mark them all "not declared"
 * and remove them from the gate.
 */
function resolveImportedFrom(sf: ts.SourceFile, typeName: string, root: string): string {
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    const clause = stmt.importClause
    if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue
    const hit = clause.namedBindings.elements.some((el) => el.name.text === typeName)
    if (!hit) continue
    const spec = stmt.moduleSpecifier
    if (!ts.isStringLiteral(spec)) continue
    if (!spec.text.startsWith('.')) {
      throw new DeclaredFieldsError(
        `CompositionInput extends '${typeName}', imported from the non-relative ` +
          `specifier '${spec.text}'. This reader only follows relative imports, so ` +
          `that interface's fields would silently vanish from the coverage gate. ` +
          `Keep the sub-interfaces in gateway/composition/input/, or teach this ` +
          `reader to resolve packages.`,
      )
    }
    return resolve(dirname(sf.fileName), spec.text)
  }
  throw new DeclaredFieldsError(
    `CompositionInput extends '${typeName}' but no relative import in ` +
      `${sf.fileName.replace(root + '/', '')} brings that name in. The reader cannot ` +
      `locate its declaration, so its fields would be missing from the gate.`,
  )
}

/** Every field of one sub-interface, refusing any member shape it cannot read. */
function fieldsOf(
  iface: ts.InterfaceDeclaration,
  sf: ts.SourceFile,
  root: string,
): DeclaredCompositionField[] {
  const rel = sf.fileName.replace(root + '/', '')
  const out: DeclaredCompositionField[] = []
  for (const member of iface.members) {
    if (!ts.isPropertySignature(member)) {
      throw new DeclaredFieldsError(
        `${rel}:${lineOf(member, sf)} — interface '${iface.name.text}' has a member ` +
          `that is not a plain property (index signature, call/construct signature, ` +
          `or method). The coverage gate compares field NAMES against the composed ` +
          `object's keys and has no way to check this one, so it must not pass ` +
          `silently. Either express it as a named property or exclude the interface ` +
          `from CompositionInput.`,
      )
    }
    if (!ts.isIdentifier(member.name)) {
      throw new DeclaredFieldsError(
        `${rel}:${lineOf(member, sf)} — interface '${iface.name.text}' declares a ` +
          `computed or string-literal member name. The gate keys on identifiers; a ` +
          `name it cannot read is a field it cannot check.`,
      )
    }
    out.push({
      name: member.name.text,
      optional: member.questionToken !== undefined,
      file: rel,
      line: lineOf(member, sf),
    })
  }
  return out
}

/**
 * Read every field `CompositionInput` declares, flattening its `extends` chain.
 *
 * @param root repo root (absolute). Field `file` paths come back relative to it.
 */
export function readDeclaredCompositionFields(root: string): DeclaredCompositionField[] {
  const entryRel = 'gateway/composition/input/composition-input.ts'
  const entry = resolve(root, entryRel)
  const sf = parse(entry)
  const iface = findInterface(sf, 'CompositionInput')
  if (!iface) {
    throw new DeclaredFieldsError(
      `${entryRel} declares no 'interface CompositionInput'. The type moved or was ` +
        `renamed, which means this reader is no longer looking where the composition ` +
        `fields live. Treat as a broken gate, not a clean bill of health.`,
    )
  }

  const fields: DeclaredCompositionField[] = fieldsOf(iface, sf, root)

  const heritage = iface.heritageClauses ?? []
  const extended: string[] = []
  for (const clause of heritage) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue
    for (const t of clause.types) {
      if (!ts.isIdentifier(t.expression) || t.typeArguments !== undefined) {
        throw new DeclaredFieldsError(
          `${entryRel}:${lineOf(t, sf)} — CompositionInput extends a computed or ` +
            `generic type (\`${t.getText(sf)}\`). This reader flattens plain ` +
            `\`extends SomeInterface\` only; a mapped/utility type would resolve to ` +
            `fields it cannot enumerate, and those fields would leave the gate ` +
            `without anyone noticing.`,
        )
      }
      extended.push(t.expression.text)
    }
  }
  if (extended.length === 0 && fields.length === 0) {
    throw new DeclaredFieldsError(
      `${entryRel} — CompositionInput has neither own fields nor an extends chain. ` +
        `Nothing to read; refusing to report an empty declared set (that would make ` +
        `every unwired field disappear and the gate pass vacuously).`,
    )
  }

  for (const name of extended) {
    const path = resolveImportedFrom(sf, name, root)
    const subSf = parse(path)
    const sub = findInterface(subSf, name)
    if (!sub) {
      throw new DeclaredFieldsError(
        `${path.replace(root + '/', '')} declares no 'interface ${name}', but ` +
          `CompositionInput extends it. Its fields would be missing from the gate.`,
      )
    }
    if (sub.heritageClauses && sub.heritageClauses.length > 0) {
      throw new DeclaredFieldsError(
        `${path.replace(root + '/', '')}:${lineOf(sub, subSf)} — '${name}' itself ` +
          `extends something. This reader flattens ONE level, matching the shape ` +
          `composition-input.ts has always had; a nested chain would drop the ` +
          `grandparent's fields. Flatten it, or make this reader recursive.`,
      )
    }
    fields.push(...fieldsOf(sub, subSf, root))
  }

  const seen = new Map<string, DeclaredCompositionField>()
  for (const f of fields) {
    const prior = seen.get(f.name)
    if (prior) {
      throw new DeclaredFieldsError(
        `Field '${f.name}' is declared twice — ${prior.file}:${prior.line} and ` +
          `${f.file}:${f.line}. Two declarations mean the gate cannot say which one ` +
          `a reviewer should look at, and TypeScript would only accept it if the ` +
          `types match exactly. Remove the duplicate.`,
      )
    }
    seen.set(f.name, f)
  }

  if (seen.size < MIN_EXPECTED_DECLARED_FIELDS) {
    throw new DeclaredFieldsError(
      `read only ${seen.size} CompositionInput fields, below the floor of ` +
        `${MIN_EXPECTED_DECLARED_FIELDS}. Either the interface shrank drastically ` +
        `(lower the floor deliberately, in the same PR) or this reader stopped ` +
        `resolving something. A small declared set makes almost everything look ` +
        `wired, so it fails here rather than passing quietly.`,
    )
  }

  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}
