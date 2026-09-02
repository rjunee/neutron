/**
 * THE DOCUMENTED COUNT IS EXECUTED, NOT ASSERTED.
 *
 * `docs/AS_BUILT.md`'s 2026-08-31 entry publishes the canonical SQL for "how many
 * of these rejections are real" and "which never-reviewed terminals still hold
 * salvageable work". The whole point of the card is that a future measurement is a
 * QUERY rather than an argument — which is worth nothing if the query and the
 * authoritative classifier (`terminalRunDisposition`) disagree.
 *
 * The first draft of that entry disagreed twice, and both were found by reading
 * rather than by running:
 *
 *   1. the "REAL rejections" count had no findings clause, so it returned the same
 *      untrustworthy 160 the card exists to replace — the 97 findings-free rows
 *      included; and its first repair used a STRING predicate
 *      (`TRIM(...) NOT IN ('','[]')`) that counts `{}`, `null`, `[ ]` and a
 *      truncated `{` as real rejections, none of which `parseCheckpointFindings`
 *      — the write-site semantics — calls findings at all;
 *   2. its disposition CASE used `GLOB 'fix-round-[0-9]*'` (which also matches
 *      `fix-round-1x`) and `GLOB 'outer-published:*'` (which matches a name
 *      carrying no OID at all), while the classifier requires `^fix-round-\d+$`
 *      and a full 40-hex oid.
 *
 * So this file EXTRACTS the statements from the doc and runs them, against a corpus
 * built from exactly those adversarial shapes. A doc edit that loosens the SQL
 * fails here; so does a classifier change that the doc no longer describes.
 *
 * TWO RULES THIS FILE OBEYS, because breaking either turns it back into decoration:
 * the expectations are computed by CALLING the production code
 * (`terminalRunDisposition`, `parseCheckpointFindings`) and never by re-stating its
 * rule in a second dialect — a re-implementation drifts in lockstep with the bug it
 * was meant to catch. And the disposition agreement is checked ROW FOR ROW, not
 * bucket-total against bucket-total, in which two opposite misclassifications
 * cancel.
 */

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { terminalRunDisposition } from './run-disposition.ts'
import { parseCheckpointFindings } from './checkpoint-findings.ts'
import { makeTridentRun } from './testing/make-trident-run.ts'
import type { TridentPhase, TridentVerdict } from './store.ts'

const DOC = fileURLToPath(new URL('../docs/AS_BUILT.md', import.meta.url))
const OID = 'a'.repeat(40)

/**
 * The three statements of the entry's `sql` fence, in order. Located by the
 * entry's own heading so an unrelated `sql` block elsewhere in a 26k-line
 * append-only log can never be picked up instead.
 */
function documentedStatements(): string[] {
  const doc = readFileSync(DOC, 'utf8')
  const heading = doc.indexOf('## 2026-08-31 — a run that never reviewed is no longer recorded as a rejection')
  expect(heading).toBeGreaterThan(-1)
  const open = doc.indexOf('```sql', heading)
  expect(open).toBeGreaterThan(heading)
  const close = doc.indexOf('```', open + 6)
  expect(close).toBeGreaterThan(open)
  const statements = doc
    .slice(open + 6, close)
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => `${s};`)
  expect(statements).toHaveLength(3)
  return statements
}

interface Row {
  phase?: TridentPhase
  verdict?: TridentVerdict | null
  checkpoint?: string | null
  findings?: string | null
  /**
   * Findings given as RAW BYTES (hex), for the shapes a JS string cannot hold — a
   * malformed UTF-8 sequence is the r3 blocker and it has no `findings` spelling at
   * all. The row is inserted as a SQL literal (see `corpusDb`) and the classifier
   * side is fed `readerValue()`, i.e. what the driver actually hands production.
   */
  findingsHex?: string
}

/**
 * WHAT bun:sqlite's DRIVER DELIVERS for a column holding these bytes — which is the
 * value `parseCheckpointFindings` is handed in production, and the whole of the r3
 * blocker: for bytes that are not well-formed UTF-8 the driver returns the EMPTY
 * STRING, so the classifier sees no findings while SQLite's JSON functions, reading
 * the same bytes, see a perfectly good one-element array. Round-tripped through the
 * driver rather than asserted, so this file never states a second opinion about what
 * the reader does.
 */
function readerValue(hex: string): string {
  const db = new Database(':memory:')
  db.run('CREATE TABLE v (x TEXT)')
  db.run(`INSERT INTO v (x) VALUES (CAST(x'${hex}' AS TEXT))`)
  const out = (db.query('SELECT x FROM v').get() as { x: string }).x
  db.close()
  return out
}

/**
 * The corpus. Every row is labelled with what the CLASSIFIER says about it, so the
 * SQL is checked against `terminalRunDisposition` rather than against a second
 * hand-written expectation that could be wrong in the same way.
 */
const CORPUS: ReadonlyArray<readonly [string, Row]> = [
  // ── rejections, both shapes ───────────────────────────────────────────────
  ['rejected with findings', { verdict: 'REQUEST_CHANGES', findings: '[{"title":"real"}]' }],
  ['rejected with findings (2)', { verdict: 'REQUEST_CHANGES', findings: '[{"title":"also real"}]' }],
  ['LEGACY rejection, empty findings', { verdict: 'REQUEST_CHANGES', checkpoint: 'forge-done', findings: '[]' }],
  ['LEGACY rejection, NULL findings', { verdict: 'REQUEST_CHANGES', checkpoint: 'inner-error', findings: null }],
  ['LEGACY rejection, whitespace findings', { verdict: 'REQUEST_CHANGES', findings: '  \n' }],
  // SEMANTICALLY EMPTY, and every one of these is non-'[]' text a string predicate
  // counts as a real rejection while `parseCheckpointFindings` returns [] for it.
  ['LEGACY rejection, findings {}', { verdict: 'REQUEST_CHANGES', findings: '{}' }],
  ['LEGACY rejection, findings null', { verdict: 'REQUEST_CHANGES', findings: 'null' }],
  ['LEGACY rejection, findings [ ]', { verdict: 'REQUEST_CHANGES', findings: '[ ]' }],
  ['LEGACY rejection, findings truncated', { verdict: 'REQUEST_CHANGES', findings: '{' }],
  ['LEGACY rejection, findings a JSON object', { verdict: 'REQUEST_CHANGES', findings: '{"a":1}' }],
  // THE NESTING-DEPTH BOUNDARY the two dialects must agree on (Argus r7,
  // reproduced): SQLite's json_valid enforces JSON_MAX_DEPTH (1000), so depth
  // 1001 is INVALID to the SQL while JSON.parse accepts it (outer length 1).
  // Without the parser's explicit bound this row was a REAL rejection to the
  // store and a legacy one to the counting SQL.
  ['LEGACY rejection, findings nested 1001 deep', { verdict: 'REQUEST_CHANGES', findings: '['.repeat(1001) + '0' + ']'.repeat(1001) }],
  // …and the boundary itself is REAL in BOTH dialects — the bound is >1000, not >=1000.
  ['rejected, findings nested exactly 1000 deep', { verdict: 'REQUEST_CHANGES', findings: '['.repeat(1000) + '0' + ']'.repeat(1000) }],
  // A LEADING BYTE-ORDER MARK (Argus r15). `parseCheckpointFindings` answers [] for
  // it by an explicit clause, so the counting SQL must too — hence the
  // `SUBSTR(…, 1, 1) <> CHAR(65279)` pin in the documented statements. The bytes
  // reach the table as bytes: see `corpusDb`, where a bound parameter would have
  // lost the mark before SQLite ever saw it.
  ['LEGACY rejection, findings behind a BOM', { verdict: 'REQUEST_CHANGES', findings: '\uFEFF[{"title":"looks real, is not"}]' }],
  // AN EMBEDDED NUL, the findings-side twin of the checkpoint-side NUL rows below
  // (Argus r18, which found the hardening on one statement and not on the counting
  // pair). SQLite's JSON functions stop at the NUL, so the prefix alone is a valid
  // non-empty array and the row scored as a REAL rejection; `parseCheckpointFindings`
  // hands the WHOLE value to JSON.parse, which throws on the trailing bytes and
  // answers []. The `INSTR(inner_checkpoint_findings, CHAR(0)) = 0` clause in both
  // documented statements is the pin, and this row is what executes it.
  ['LEGACY rejection, real findings then a NUL', { verdict: 'REQUEST_CHANGES', findings: '[{"title":"real"}]\u0000garbage' }],
  // MALFORMED UTF-8, the unguarded sibling of the two shapes above (Argus r3,
  // blocker, reproduced). SQLite's JSON parser accepts any byte >= 0x20 inside a
  // string literal, so these bytes are json_valid = 1, an array, one element long —
  // a REAL rejection to the counting SQL — while bun:sqlite's driver returns the
  // EMPTY STRING for the same column and `parseCheckpointFindings` therefore answers
  // []. One row, two answers, in the direction that matters: the SQL crediting a
  // reason to a rejection that states none. Three shapes, because they fail three
  // different ways in SQLite's own UTF-8 reader (orphan continuation byte, truncated
  // sequence, surrogate) and only the re-encoding test catches all three.
  ['LEGACY rejection, findings holding an orphan continuation byte', { verdict: 'REQUEST_CHANGES', findingsHex: '5b7b227469746c65223a2280227d5d' }],
  ['LEGACY rejection, findings holding a truncated 3-byte sequence', { verdict: 'REQUEST_CHANGES', findingsHex: '5b7b227469746c65223a22e280227d5d' }],
  ['LEGACY rejection, findings holding a surrogate sequence', { verdict: 'REQUEST_CHANGES', findingsHex: '5b7b227469746c65223a22eda080227d5d' }],
  // …AND THE POSITIVE CONTROLS THAT KEEP THE NEW CLAUSE FROM EATING REAL FINDINGS.
  // Both are well-formed UTF-8 the driver reads perfectly, so both must stay REAL
  // rejections. The second is the exception the clause spells out by hand: U+FFFF is
  // valid UTF-8 that SQLite's own reader folds to U+FFFD, so a re-encoding test
  // without the `NOT IN (x'EFBFBE', x'EFBFBF')` escape hatch would demote it.
  ['rejected, findings holding a 4-byte emoji', { verdict: 'REQUEST_CHANGES', findingsHex: '5b7b227469746c65223a22f09f9880227d5d' }],
  ['rejected, findings holding U+FFFF', { verdict: 'REQUEST_CHANGES', findingsHex: '5b7b227469746c65223a22efbfbf227d5d' }],
  // ── never reviewed, with a resumable build ────────────────────────────────
  ['forge-done', { checkpoint: 'forge-done' }],
  ['forge-done, legacy null verdict', { checkpoint: 'forge-done', verdict: null }],
  ['fix-round-3', { checkpoint: 'fix-round-3' }],
  ['fix-round-007', { checkpoint: 'fix-round-007' }],
  ['outer-published', { checkpoint: `outer-published:${OID}:0:1` }],
  ['outer-published deviated', { checkpoint: `outer-published:${OID}:2:6:deviated` }],
  ['a checkpoint with stray whitespace', { checkpoint: '  forge-done  ' }],
  // ── never reviewed, nothing this dispatch may resume ──────────────────────
  ['null checkpoint', { checkpoint: null }],
  ['inner-error', { checkpoint: 'inner-error' }],
  ['awaiting-trailer', { checkpoint: 'awaiting-trailer' }],
  ['ralph-task-built', { checkpoint: 'ralph-task-built' }],
  // ── THE ADVERSARIAL SHAPES the loose query got wrong ──────────────────────
  ['fix-round-1x', { checkpoint: 'fix-round-1x' }],
  ['fix-round- (no digits)', { checkpoint: 'fix-round-' }],
  ['outer-published with no oid', { checkpoint: 'outer-published:not-an-oid:1:2' }],
  ['outer-published, UPPERCASE oid', { checkpoint: `outer-published:${OID.toUpperCase()}:1:2` }],
  ['outer-published, 39-hex oid', { checkpoint: `outer-published:${'a'.repeat(39)}:1:2` }],
  ['outer-published, missing tail', { checkpoint: `outer-published:${OID}:1` }],
  ['outer-published, non-numeric tail', { checkpoint: `outer-published:${OID}:1:x` }],
  ['outer-published, extra field', { checkpoint: `outer-published:${OID}:1:2:3` }],
  ['outer-published, unknown suffix', { checkpoint: `outer-published:${OID}:1:2:deviant` }],
  // NON-TRAILING ':deviated'. A REPLACE(tail, ':deviated', '') strips every
  // occurrence and calls this salvageable; the classifier's anchored
  // `(?::deviated)?$` does not.
  ['outer-published, doubled deviated', { checkpoint: `outer-published:${OID}:1:2:deviated:deviated` }],
  ['outer-published, deviated mid-name', { checkpoint: `outer-published:${OID}:1:deviated:2` }],
  // UPPERCASE ':DEVIATED'. SQLite's LIKE is ASCII case-insensitive, so the first
  // draft's `LIKE '%:deviated'` stripped this suffix and called the row salvageable
  // while the classifier's lowercase `(?::deviated)?$` rejects the whole name. GLOB
  // is case-sensitive; this row is what says so.
  ['outer-published, UPPERCASE deviated', { checkpoint: `outer-published:${OID}:1:2:DEVIATED` }],
  // THE NINE-DIGIT ROUND DOMAIN, shared with `checkpointRound` and its bash mirror.
  // A tenth digit is not one of these shapes anywhere, and a SQL copy without the
  // LENGTH bounds would call both of these salvageable.
  ['fix-round-, ten digits', { checkpoint: 'fix-round-1234567890' }],
  ['fix-round-, nine digits', { checkpoint: 'fix-round-123456789' }],
  ['outer-published, ten-digit round', { checkpoint: `outer-published:${OID}:1:1234567890` }],
  ['outer-published, nine-digit round', { checkpoint: `outer-published:${OID}:1:123456789` }],
  // WHITESPACE PARITY, all six ASCII characters both dialects strip — the SQL TRIM
  // set is ' ', TAB, LF, VT, FF, CR and the classifier trims exactly those. A
  // three-character TRIM set left the VT/FF rows on the died-before-build side.
  ['a checkpoint padded with a vertical tab', { checkpoint: '\u000bforge-done\u000b' }],
  ['a checkpoint padded with a form feed', { checkpoint: '\fforge-done\f' }],
  ['a checkpoint padded with tab and CR', { checkpoint: '\tforge-done\r' }],
  // …and the one kind of padding NEITHER dialect strips: JS `.trim()` would eat
  // this NBSP, which is why the classifier does not use it.
  ['a checkpoint padded with NBSP', { checkpoint: '\u00a0forge-done\u00a0' }],
  // AN EMBEDDED NUL (Argus r17). SQLite's LENGTH and GLOB stop at the NUL, so
  // 'fix-round-3' + NUL + 'junk' satisfies the fix-round shape AND its round bound
  // (LENGTH answers 11, not 16) and was counted salvageable, while the classifier's
  // anchored `^fix-round-\d+$` rejects the whole value — one row, two answers, in the
  // direction that matters: the SQL calling resumable work what the code does not.
  // `INSTR(ck, CHAR(0)) = 0` is the pin, and these rows are what execute it.
  ['fix-round-3 with an embedded NUL', { checkpoint: 'fix-round-3\u0000junk' }],
  ['outer-published with an embedded NUL', { checkpoint: `outer-published:${OID}:1:2\u0000junk` }],
  // The same byte where the shape does NOT depend on truncation: `ck = 'forge-done'`
  // compares the whole stored value, NUL included, so this row agreed already. It stays
  // as the control that says the guard costs nothing where nothing was wrong.
  ['forge-done with an embedded NUL', { checkpoint: 'forge-done\u0000junk' }],
  // ── and the rows the queries must leave alone ─────────────────────────────
  ['approved', { phase: 'done', verdict: 'APPROVE', checkpoint: 'argus-approved' }],
  ['STILL RUNNING at forge-done', { phase: 'forge-init', checkpoint: 'forge-done' }],
  ['STILL RUNNING and rejected', { phase: 'argus', verdict: 'REQUEST_CHANGES', findings: '[{"t":1}]' }],
]

function rowOf(over: Row) {
  return makeTridentRun({
    phase: over.phase ?? 'failed',
    inner_verdict: over.verdict === undefined ? 'REVIEW_NOT_RUN' : over.verdict,
    inner_checkpoint: over.checkpoint ?? null,
    // A raw-byte row is fed to the classifier AS THE DRIVER DELIVERS IT. Hard-coding
    // '' for the malformed rows would assert bun's behaviour instead of executing it,
    // and the positive controls below would then prove nothing about the real reader.
    inner_checkpoint_findings:
      over.findingsHex !== undefined
        ? readerValue(over.findingsHex)
        : over.findings === undefined
          ? null
          : over.findings,
  })
}

/**
 * A table with exactly the four columns the documented SQL reads. The row set is a
 * parameter so the per-row equivalence test below can put ONE corpus row in front
 * of a COUNT statement — see there for why a total is not enough.
 */
function corpusDb(rows: ReadonlyArray<readonly [string, Row]> = CORPUS): Database {
  const db = new Database(':memory:')
  db.run(
    `CREATE TABLE code_trident_runs (
       id TEXT PRIMARY KEY, phase TEXT NOT NULL, inner_verdict TEXT,
       inner_checkpoint TEXT, inner_checkpoint_findings TEXT
     )`,
  )
  const insert = db.prepare(
    'INSERT INTO code_trident_runs (id, phase, inner_verdict, inner_checkpoint, inner_checkpoint_findings) VALUES (?, ?, ?, ?, ?)',
  )
  // THE BOM ROW IS INSERTED AS BYTES, not as a bound parameter: bun:sqlite's driver
  // STRIPS a leading U+FEFF while binding, so `insert.run(…, '\uFEFF[…]')` would
  // store honestly-valid JSON and the row would be testing nothing at all. (That
  // stripping is also the whole of the reported "bun:sqlite says json_valid = 1"
  // disagreement — over the real bytes both engines answer 0.) `CHAR(65279) || ?`
  // re-attaches the mark inside SQLite, where it survives; `bomRowsStoreTheMark`
  // below is the assertion that it did.
  const insertBom = db.prepare(
    'INSERT INTO code_trident_runs (id, phase, inner_verdict, inner_checkpoint, inner_checkpoint_findings) VALUES (?, ?, ?, ?, CHAR(65279) || ?)',
  )
  for (const [name, over] of rows) {
    const r = rowOf(over)
    const f = r.inner_checkpoint_findings
    // RAW BYTES, for the same reason the BOM row uses a literal and more sharply: a
    // malformed UTF-8 findings value cannot be BOUND at all, because no JS string
    // holds those bytes. The hex comes straight from the corpus entry.
    if (typeof over.findingsHex === 'string') {
      db.run(
        `INSERT INTO code_trident_runs (id, phase, inner_verdict, inner_checkpoint, inner_checkpoint_findings)
         VALUES (?, ?, ?, ?, CAST(x'${over.findingsHex}' AS TEXT))`,
        [name, r.phase, r.inner_verdict, r.inner_checkpoint],
      )
    } else if (typeof f === 'string' && f.charCodeAt(0) === 0xfeff) {
      insertBom.run(name, r.phase, r.inner_verdict, r.inner_checkpoint, f.slice(1))
    } else {
      insert.run(name, r.phase, r.inner_verdict, r.inner_checkpoint, f)
    }
  }
  return db
}

/** The corpus rows whose findings are meant to carry a leading U+FEFF. */
const BOM_ROWS = CORPUS.filter(([, o]) => (o.findings ?? '').charCodeAt(0) === 0xfeff).map(([n]) => n)

describe("AS_BUILT's published counts are the classifier, executed", () => {
  test('the extraction found three real statements — not an empty slice', () => {
    // Guards the extraction itself: an empty slice would make every assertion
    // below pass by running nothing.
    const [real, legacy, split] = documentedStatements()
    expect(real).toContain('REQUEST_CHANGES')
    expect(real).toContain('inner_checkpoint_findings')
    // The JSON test, not a string one — the drift this file exists to catch.
    expect(real).toContain('json_array_length')
    // ...and the BOM pin, for the same reason the depth bound is pinned: the parser
    // has an EXPLICIT clause for a leading U+FEFF, so a doc edit that drops this one
    // re-opens the same one-row-two-answers gap on any engine that starts tolerating
    // the mark. Textual because it cannot be caught by execution — see the BOM test
    // below for what today's engines actually answer.
    expect(real).toContain('CHAR(65279)')
    expect(legacy).toContain('CHAR(65279)')
    // …and the NUL pin on BOTH, because "exact complement" is a property of the two
    // statements together: hardening one and not the other is the asymmetry r18
    // found, and it would make the pair double-count or drop the disputed rows.
    expect(real).toContain('INSTR(inner_checkpoint_findings, CHAR(0)) = 0')
    expect(legacy).toContain('INSTR(inner_checkpoint_findings, CHAR(0)) = 0')
    // …and the malformed-UTF-8 scan on both, for the third time for the third
    // reason (Argus r3). Unlike the BOM and NUL pins this one is NOT dormant — the
    // execution below shows it moving rows — but its PRESENCE in both statements is
    // still a textual property, because dropping it from one of the pair is what
    // breaks "exact complement" rather than what breaks a count.
    expect(real).toContain('CAST(CHAR(UNICODE(CAST(b AS TEXT))) AS BLOB)')
    expect(legacy).toContain('CAST(CHAR(UNICODE(CAST(b AS TEXT))) AS BLOB)')
    expect(real).toContain("x'EFBFBE', x'EFBFBF'")
    expect(legacy).toContain("x'EFBFBE', x'EFBFBF'")
    expect(legacy).toContain('NOT CASE WHEN json_valid')
    expect(split).toContain('built-never-reviewed')
    expect(split).toContain('died-before-build')
  })

  test('REAL rejections counts the ones that STATE A REASON, and not the legacy 97-shape', () => {
    const db = corpusDb()
    const [real, legacy] = documentedStatements()
    // THE EXPECTATION CALLS THE WRITE-SITE PARSER. Re-stating "non-empty findings"
    // as a second string predicate here is how the doc's own `TRIM(...) NOT IN
    // ('','[]')` bug survived review: the guard repeated the mistake it was
    // guarding.
    const rejections = CORPUS.filter(
      ([, o]) => terminalRunDisposition(rowOf(o)) === 'reviewed-rejected',
    )
    const expectedReal = rejections.filter(
      ([, o]) => parseCheckpointFindings(rowOf(o).inner_checkpoint_findings).length > 0,
    ).length
    // POSITIVE CONTROL: the corpus really does contain both shapes, so neither
    // count can pass by being zero — and the semantically-empty shapes sit on the
    // legacy side, not the real one.
    expect(expectedReal).toBe(5)
    expect(rejections.length - expectedReal).toBeGreaterThan(2)
    expect(db.query(real!).get()).toEqual({ n: expectedReal })
    // The legacy findings-free rejections stay countable — the card forbids
    // rewriting them — and they are exactly the ones the first count drops.
    expect(db.query(legacy!).get()).toEqual({ n: rejections.length - expectedReal })
    db.close()
  })

  test('the real/legacy split agrees with the classifier ROW BY ROW, not just in total', () => {
    // Argus r24 (minor, test strength): the totals above are counts, so a
    // COMPENSATING swap passes them — one row misclassified from real to legacy and
    // another from legacy to real leaves both totals exactly where they were, and
    // the split test's row-for-row keying covers only the never-reviewed CASE, not
    // these two statements. The disposition test earned its keying; these two had
    // not. Both are `SELECT COUNT(*)`, and rewriting the doc's SQL to project ids
    // would test a statement the doc does not publish — so the statements are run
    // VERBATIM against a table holding exactly ONE corpus row, where a count IS the
    // per-row answer and no other row can cancel it.
    const [real, legacy] = documentedStatements()
    let reals = 0
    let legacies = 0
    for (const entry of CORPUS) {
      const [name, over] = entry
      const row = rowOf(over)
      const rejected = terminalRunDisposition(row) === 'reviewed-rejected'
      const hasFindings = parseCheckpointFindings(row.inner_checkpoint_findings).length > 0
      const wantReal = rejected && hasFindings ? 1 : 0
      const wantLegacy = rejected && !hasFindings ? 1 : 0
      const db = corpusDb([entry])
      expect({ row: name, ...(db.query(real!).get() as { n: number }) }).toEqual({ row: name, n: wantReal })
      expect({ row: name, ...(db.query(legacy!).get() as { n: number }) }).toEqual({ row: name, n: wantLegacy })
      db.close()
      reals += wantReal
      legacies += wantLegacy
    }
    // POSITIVE CONTROLS: both sides are non-empty and no row lands on both, so this
    // loop cannot pass by having asserted `n: 0` twice for every row.
    expect(reals).toBeGreaterThan(0)
    expect(legacies).toBeGreaterThan(0)
    expect(reals + legacies).toBeLessThanOrEqual(CORPUS.length)
  })

  test('a BOM-prefixed findings array is EMPTY to the parser and to the documented count alike', () => {
    // Argus r15 blocker: the parser pins a leading U+FEFF as "not findings"
    // explicitly, and the canonical SQL did not — so the same bytes could be read as
    // a real rejection by the count and as empty by both write sites.
    //
    // WHAT WAS MEASURED HERE, rather than assumed: over a value whose STORED BYTES
    // begin EF BB BF, `json_valid` answers 0 on bun:sqlite 3.51.2 (this runner) and
    // on the sqlite3 CLI 3.45.1 (`checkpoint.sh`'s engine), so the pin is DORMANT
    // today and no executable mutant can distinguish it. What is executed here is
    // everything that CAN be: the bytes really are in the table, the parser really
    // does answer [], and the documented count really does leave the row on the
    // legacy side. The pin's presence is held by the extraction test above.
    const db = corpusDb()
    expect(BOM_ROWS.length).toBeGreaterThan(0) // positive control: the row exists
    const stored = db
      .query(
        `SELECT id, hex(SUBSTR(inner_checkpoint_findings, 1, 1)) AS h1,
                json_valid(inner_checkpoint_findings) AS jv
           FROM code_trident_runs WHERE id = ?`,
      )
    for (const name of BOM_ROWS) {
      const r = stored.get(name) as { h1: string; jv: number }
      // The mark survived the insert — otherwise this row is a plain valid array
      // wearing a BOM row's name.
      expect(r.h1).toBe('EFBBBF')
      const findings = CORPUS.find(([n]) => n === name)![1].findings!
      expect(parseCheckpointFindings(findings)).toEqual([])
      // The classifier reads it as a rejection (the verdict column is what decides
      // that) — it is the FINDINGS test that must call it reasonless.
      expect(terminalRunDisposition(rowOf({ verdict: 'REQUEST_CHANGES', findings }))).toBe(
        'reviewed-rejected',
      )
    }
    db.close()
  })

  test('MALFORMED UTF-8 findings are EMPTY to the reader and to the documented count alike', () => {
    // Argus r3 blocker, reproduced: `[{"title":"<0x80>"}]` is json_valid = 1, an array
    // and one element long to SQLite, so the counting SQL scored it a REAL rejection —
    // while bun:sqlite's driver, which every reader of this column goes through,
    // returns '' for a value that is not well-formed UTF-8, so
    // `parseCheckpointFindings` answered []. The row this card exists to make
    // impossible — a rejection that states no reason — was being counted as one that
    // does. The corpus could not reach the shape before: `findings` is a JS string and
    // no JS string holds these bytes, which is why `findingsHex` exists.
    const MALFORMED = [
      'LEGACY rejection, findings holding an orphan continuation byte',
      'LEGACY rejection, findings holding a truncated 3-byte sequence',
      'LEGACY rejection, findings holding a surrogate sequence',
    ]
    const WELL_FORMED = [
      'rejected, findings holding a 4-byte emoji',
      'rejected, findings holding U+FFFF',
    ]
    const db = corpusDb()
    const stored = db.query(
      `SELECT hex(CAST(inner_checkpoint_findings AS BLOB)) AS bytes,
              json_valid(inner_checkpoint_findings) AS jv,
              json_array_length(inner_checkpoint_findings) AS jal
         FROM code_trident_runs WHERE id = ?`,
    )
    for (const name of MALFORMED) {
      const entry = CORPUS.find(([n]) => n === name)!
      const r = stored.get(name) as { bytes: string; jv: number; jal: number }
      // The bytes really are in the table AND SQLite really does read them as a
      // non-empty array — otherwise there is nothing here for the clause to guard.
      expect(r.bytes).toBe(entry[1]!.findingsHex!.toUpperCase())
      expect([r.jv, r.jal]).toEqual([1, 1])
      // …and the driver really does empty them, so the classifier reads the row as a
      // rejection carrying no reason.
      expect(readerValue(entry[1]!.findingsHex!)).toBe('')
      expect(parseCheckpointFindings(rowOf(entry[1]!).inner_checkpoint_findings)).toEqual([])
      expect(terminalRunDisposition(rowOf(entry[1]!))).toBe('reviewed-rejected')
    }
    db.close()

    // EXECUTED AS A MUTANT rather than asserted textually: the documented statement is
    // re-run with the re-encoding test neutralized — which is exactly the query as it
    // stood before this round — and the malformed rows move to the REAL side.
    const [real, legacy] = documentedStatements()
    const PIN = 'b <> CAST(CHAR(UNICODE(CAST(b AS TEXT))) AS BLOB)'
    // Counted, not merely contained: the pin has to be in the EXECUTED SQL once, not
    // in a `--` note about it.
    expect(real!.split(PIN)).toHaveLength(2)
    const unpinned = real!.replace(PIN, '1 = 0')
    expect(unpinned).not.toBe(real)
    for (const name of MALFORMED) {
      const one = corpusDb([CORPUS.find(([n]) => n === name)!])
      expect({ row: name, ...(one.query(real!).get() as { n: number }) }).toEqual({ row: name, n: 0 })
      expect({ row: name, ...(one.query(legacy!).get() as { n: number }) }).toEqual({ row: name, n: 1 })
      expect({ row: name, ...(one.query(unpinned).get() as { n: number }) }).toEqual({ row: name, n: 1 })
      one.close()
    }

    // POSITIVE CONTROL: well-formed non-ASCII findings are not collateral — both rows
    // stay REAL rejections under the documented statement.
    for (const name of WELL_FORMED) {
      const entry = CORPUS.find(([n]) => n === name)!
      expect(parseCheckpointFindings(rowOf(entry[1]!).inner_checkpoint_findings)).toHaveLength(1)
      const one = corpusDb([entry])
      expect({ row: name, ...(one.query(real!).get() as { n: number }) }).toEqual({ row: name, n: 1 })
      one.close()
    }
    // …and the hand-written noncharacter escape is load-bearing, not decoration:
    // U+FFFF is well-formed UTF-8 that SQLite's OWN reader folds to U+FFFD, so without
    // the exclusion the re-encoding test demotes findings the parser reads perfectly
    // well. Removing it moves only that row; the emoji row is the control that says
    // the mutation did not simply break the query.
    const NONCHAR = "AND b NOT IN (x'EFBFBE', x'EFBFBF')"
    expect(real!.split(NONCHAR)).toHaveLength(2)
    const noEscape = real!.replace(NONCHAR, 'AND 1 = 1')
    const ffff = corpusDb([CORPUS.find(([n]) => n === 'rejected, findings holding U+FFFF')!])
    expect((ffff.query(noEscape).get() as { n: number }).n).toBe(0)
    ffff.close()
    const emoji = corpusDb([CORPUS.find(([n]) => n === 'rejected, findings holding a 4-byte emoji')!])
    expect((emoji.query(noEscape).get() as { n: number }).n).toBe(1)
    emoji.close()
  })

  test('the disposition split agrees with terminalRunDisposition, row for row', () => {
    const db = corpusDb()
    const [, , split] = documentedStatements()
    const rows = db.query(split!).all() as Array<{ id: string; disposition: string }>
    db.close()

    // ROW FOR ROW — keyed by the corpus label, so an over-count in one bucket can
    // never be cancelled by an under-count in the other.
    const expected = new Map<string, string>()
    for (const [name, over] of CORPUS) {
      const d = terminalRunDisposition(rowOf(over))
      if (d !== 'built-never-reviewed' && d !== 'died-before-build') continue
      expected.set(name, d)
    }
    // POSITIVE CONTROL: both buckets are non-empty, so an assertion that would
    // pass on an empty result set is not what is being read here.
    const values = [...expected.values()]
    expect(values.filter((d) => d === 'built-never-reviewed').length).toBeGreaterThan(0)
    expect(values.filter((d) => d === 'died-before-build').length).toBeGreaterThan(0)
    expect(new Map(rows.map((r) => [r.id, r.disposition]))).toEqual(expected)
  })

  test('MUTANT GUARD: without the NUL pin the split calls a TRUNCATED name salvageable', () => {
    // Argus r17: SQLite's LENGTH() and GLOB stop at an embedded NUL, so every shape
    // test in the CASE answers about a PREFIX while `terminalRunDisposition` answers
    // about the whole value — and it answers the wrong way round, calling work
    // resumable that the classifier does not. Executed as a MUTANT rather than
    // asserted textually: the documented statement is re-run with the pin neutralized
    // to `1 = 1`, which is exactly the query as it stood before this round.
    const db = corpusDb()
    const [, , split] = documentedStatements()
    // Positive control, and it counts rather than merely containing: the pin has to
    // be in the EXECUTED SQL, once, and not in a `--` comment about it — a mutation
    // that neutralizes prose proves nothing, and that is exactly what the first draft
    // of this test did (the doc's own note spelled the predicate out, `replace` took
    // the first occurrence, and the query underneath was left intact and still right).
    expect(split!.split('INSTR(ck, CHAR(0)) = 0')).toHaveLength(2)
    const unpinned = split!.replace('INSTR(ck, CHAR(0)) = 0', '1 = 1')
    expect(unpinned).not.toBe(split)
    const dispositions = (sql: string) =>
      new Map((db.query(sql).all() as Array<{ id: string; disposition: string }>).map((r) => [r.id, r.disposition]))
    const pinned = dispositions(split!)
    const mutant = dispositions(unpinned)
    // The bytes really are in the table — a driver that dropped the NUL on binding
    // would make every row below a plain well-formed checkpoint wearing a NUL row's
    // name (the same trap the BOM rows document).
    const nulAt = new Map(
      (
        db
          .query('SELECT id, INSTR(inner_checkpoint, CHAR(0)) AS i FROM code_trident_runs')
          .all() as Array<{ id: string; i: number }>
      ).map((r) => [r.id, r.i]),
    )
    db.close()

    // The two shapes whose SQL verdict DEPENDS on the truncation: the classifier
    // rejects them, the pinned query agrees, and the unpinned one does not.
    for (const id of ['fix-round-3 with an embedded NUL', 'outer-published with an embedded NUL']) {
      expect(nulAt.get(id)).toBeGreaterThan(0)
      expect(terminalRunDisposition(rowOf(CORPUS.find(([n]) => n === id)![1]))).toBe('died-before-build')
      expect(pinned.get(id)).toBe('died-before-build')
      expect(mutant.get(id)).toBe('built-never-reviewed')
    }
    // …and the control: `ck = 'forge-done'` compares the whole stored value, so this
    // row was never misread and the pin does not move it either.
    expect(pinned.get('forge-done with an embedded NUL')).toBe('died-before-build')
    expect(mutant.get('forge-done with an embedded NUL')).toBe('died-before-build')
  })

  test('MUTANT GUARD: the LOOSE version of the CASE would not pass this corpus', () => {
    // The exact query the review caught, run against the same rows: it swallows
    // `fix-round-1x` and every malformed `outer-published`, and therefore counts a
    // different split than the classifier. If this ever stops differing, the corpus
    // has lost the shapes that make the strict SQL worth its length.
    const db = corpusDb()
    const loose = db
      .query(
        `SELECT id, CASE
                  WHEN inner_checkpoint = 'forge-done'
                    OR inner_checkpoint GLOB 'fix-round-[0-9]*'
                    OR inner_checkpoint GLOB 'outer-published:*' THEN 'built-never-reviewed'
                  ELSE 'died-before-build'
                END AS disposition
           FROM code_trident_runs
          WHERE phase IN ('done','failed','stopped')
            AND (inner_verdict = 'REVIEW_NOT_RUN' OR inner_verdict IS NULL)`,
      )
      .all() as Array<{ id: string; disposition: string }>
    const [, , split] = documentedStatements()
    const strict = db.query(split!).all() as Array<{ id: string; disposition: string }>
    db.close()
    expect(loose).not.toEqual(strict)
  })

  test('MUTANT GUARD: a string-predicate findings clause would over-count REAL rejections', () => {
    // The exact predicate the first repair used, on the same rows: `{}`, `null`,
    // `[ ]` and `{` are all non-'[]' text, so it reports rejections the write site
    // would refuse and `parseCheckpointFindings` reads as empty. If this ever stops
    // differing, the corpus has lost the shapes that make the JSON test necessary.
    const db = corpusDb()
    const stringy = db
      .query(
        `SELECT COUNT(*) AS n FROM code_trident_runs
          WHERE phase IN ('done','failed','stopped')
            AND inner_verdict = 'REQUEST_CHANGES'
            AND inner_checkpoint_findings IS NOT NULL
            AND TRIM(inner_checkpoint_findings, ' ' || CHAR(9) || CHAR(10) || CHAR(13)) NOT IN ('', '[]')`,
      )
      .get() as { n: number }
    const [real] = documentedStatements()
    const documented = db.query(real!).get() as { n: number }
    db.close()
    expect(stringy.n).toBeGreaterThan(documented.n)
  })

  test('MUTANT GUARD: LIKE-ing the :deviated suffix would salvage an UPPERCASE one', () => {
    // SQLite's LIKE is ASCII case-insensitive, so the doc's first tail expression
    // stripped ':DEVIATED' and read the remains as a well-formed round — while the
    // classifier's `(?::deviated)?$` is lowercase and rejects the name outright. The
    // strict (GLOB) query must therefore see FEWER salvageable outer-published rows
    // than the LIKE one, and the classifier must agree with the strict one.
    const db = corpusDb()
    const likeSalvaged = db
      .query(
        `SELECT COUNT(*) AS n
           FROM (SELECT CASE WHEN SUBSTR(ck, 58) LIKE '%:deviated'
                               THEN SUBSTR(SUBSTR(ck, 58), 1, LENGTH(SUBSTR(ck, 58)) - 9)
                               ELSE SUBSTR(ck, 58) END AS tail
                   FROM (SELECT inner_checkpoint AS ck FROM code_trident_runs
                          WHERE inner_checkpoint GLOB 'outer-published:*'))
          WHERE tail GLOB '[0-9]*:[0-9]*' AND tail NOT GLOB '*[^0-9:]*'
            AND LENGTH(tail) - LENGTH(REPLACE(tail, ':', '')) = 1
            AND LENGTH(tail) - INSTR(tail, ':') <= 9`,
      )
      .get() as { n: number }
    const [, , split] = documentedStatements()
    const strict = (db.query(split!).all() as Array<{ id: string; disposition: string }>).filter(
      (r) => r.id.startsWith('outer-published') && r.disposition === 'built-never-reviewed',
    ).length
    db.close()
    expect(likeSalvaged.n).toBeGreaterThan(strict)
    // POSITIVE CONTROL: the uppercase row is the difference, and the classifier —
    // the authority — calls it died-before-build.
    expect(
      terminalRunDisposition(rowOf({ checkpoint: `outer-published:${OID}:1:2:DEVIATED` })),
    ).toBe('died-before-build')
    expect(terminalRunDisposition(rowOf({ checkpoint: `outer-published:${OID}:1:2:deviated` }))).toBe(
      'built-never-reviewed',
    )
  })

  test('MUTANT GUARD: REPLACE-ing every :deviated would salvage a name the classifier rejects', () => {
    // `outer-published:<oid>:1:2:deviated:deviated` — the shape that made the doc's
    // first tail expression disagree with the anchored `(?::deviated)?$`.
    const db = corpusDb()
    const replaced = db
      .query(
        `SELECT COUNT(*) AS n
           FROM (SELECT REPLACE(SUBSTR(inner_checkpoint, 58), ':deviated', '') AS tail
                   FROM code_trident_runs
                  WHERE inner_checkpoint GLOB 'outer-published:*')
          WHERE tail GLOB '[0-9]*:[0-9]*' AND tail NOT GLOB '*[^0-9:]*'
            AND LENGTH(tail) - LENGTH(REPLACE(tail, ':', '')) = 1`,
      )
      .get() as { n: number }
    const [, , split] = documentedStatements()
    const strict = (db.query(split!).all() as Array<{ id: string; disposition: string }>).filter(
      (r) => r.id.startsWith('outer-published') && r.disposition === 'built-never-reviewed',
    ).length
    db.close()
    expect(replaced.n).toBeGreaterThan(strict)
  })
})
