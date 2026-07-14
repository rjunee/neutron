import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { chunkMarkdown } from './chunk.ts'
import { DocSearchIndex, type IndexFileInput } from './store.ts'

function fileInput(project: string, relpath: string, content: string, mtimeMs = 1000): IndexFileInput {
  const { title, chunks } = chunkMarkdown(content, { filename: relpath })
  return { project, relpath, absPath: `/owner/Projects/${project}/${relpath}`, title, mtimeMs, chunks }
}

let index: DocSearchIndex

beforeEach(() => {
  index = DocSearchIndex.open(':memory:')
})
afterEach(() => {
  index.close()
})

describe('DocSearchIndex (lexical BM25)', () => {
  test('ranks the most relevant document first', async () => {
    await index.indexFile(
      fileInput('topline', 'docs/pricing.md', '# Pricing strategy\n\nWe discussed the pricing tiers and discount model in depth.'),
    )
    await index.indexFile(
      fileInput('topline', 'docs/hiring.md', '# Hiring plan\n\nWe need two engineers and a designer next quarter.'),
    )
    await index.indexFile(
      fileInput('atlas', 'STATUS.md', '# Status\n\nThe project is on track. No pricing concerns.'),
    )

    const hits = await index.search({ query: 'pricing tiers discount' })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.path).toBe('docs/pricing.md')
    expect(hits[0]!.project).toBe('topline')
    expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[hits.length - 1]!.score)
    expect(hits[0]!.snippet).toContain('[')
  })

  test('returns a heading and title for the matching section', async () => {
    await index.indexFile(
      fileInput('topline', 'docs/plan.md', '# Master plan\n\nintro\n\n## Launch checklist\n\nShip the beta to early users.'),
    )
    const hits = await index.search({ query: 'beta early users' })
    expect(hits[0]!.title).toBe('Master plan')
    expect(hits[0]!.heading).toBe('Launch checklist')
  })

  test('collapses multiple matching chunks to one hit per file', async () => {
    const md = '# Doc\n\n## One\n\nrocket rocket\n\n## Two\n\nrocket again rocket'
    await index.indexFile(fileInput('p', 'docs/a.md', md))
    const hits = await index.search({ query: 'rocket' })
    expect(hits.filter((h) => h.path === 'docs/a.md')).toHaveLength(1)
  })

  test('scopes results to a single project when asked', async () => {
    await index.indexFile(fileInput('alpha', 'notes/x.md', '# X\n\nwidget assembly notes'))
    await index.indexFile(fileInput('beta', 'notes/y.md', '# Y\n\nwidget assembly notes'))
    const scoped = await index.search({ query: 'widget assembly', project: 'beta' })
    expect(scoped).toHaveLength(1)
    expect(scoped[0]!.project).toBe('beta')
  })

  test('phrase / punctuation queries do not throw and find content', async () => {
    await index.indexFile(fileInput('p', 'docs/a.md', '# Tax\n\nThe NEAR operator and (parentheses) appear here.'))
    const hits = await index.search({ query: 'NEAR (parentheses)' })
    expect(hits.length).toBeGreaterThan(0)
  })

  test('hyphenated query terms are searchable (not parsed as FTS operators)', async () => {
    await index.indexFile(
      fileInput('p', 'docs/audit.md', '# Audit\n\nThe daily-driver gap-audit lists the QMD-equivalent doc search.'),
    )
    const hits = await index.search({ query: 'daily-driver gap-audit' })
    expect(hits.length).toBe(1)
    expect(hits[0]!.path).toBe('docs/audit.md')
  })

  test('document limit is applied per-file, not per-chunk (no single-file starvation)', async () => {
    // One huge file with MANY matching sections (> limit*4 chunks) must not
    // crowd out other relevant documents.
    const bigSections = Array.from({ length: 60 }, (_, i) => `## Section ${i}\n\nwidget widget widget`).join('\n\n')
    await index.indexFile(fileInput('p', 'docs/big.md', `# Big\n\n${bigSections}`))
    for (let i = 0; i < 5; i++) {
      await index.indexFile(fileInput('p', `docs/small-${i}.md`, `# Small ${i}\n\na single widget mention`))
    }
    const hits = await index.search({ query: 'widget', limit: 4 })
    expect(hits).toHaveLength(4)
    // The big file appears at most once, and other files get represented.
    expect(hits.filter((h) => h.path === 'docs/big.md')).toHaveLength(1)
    expect(new Set(hits.map((h) => h.path)).size).toBe(4)
  })

  test('empty / whitespace queries return nothing', async () => {
    await index.indexFile(fileInput('p', 'docs/a.md', '# A\n\nbody'))
    expect(await index.search({ query: '' })).toEqual([])
    expect(await index.search({ query: '   ' })).toEqual([])
  })

  test('clamps limit to [1,50]', async () => {
    for (let i = 0; i < 5; i++) {
      await index.indexFile(fileInput('p', `docs/${i}.md`, `# Doc ${i}\n\ncommon term here`))
    }
    const hits = await index.search({ query: 'common term', limit: 2 })
    expect(hits).toHaveLength(2)
  })
})

describe('DocSearchIndex (incremental reindex)', () => {
  test('replacing a file updates content and keeps one row set', async () => {
    await index.indexFile(fileInput('p', 'docs/a.md', '# A\n\noriginal apricot text'))
    expect((await index.search({ query: 'apricot' })).length).toBe(1)

    await index.indexFile(fileInput('p', 'docs/a.md', '# A\n\nrewritten banana text', 2000))
    expect(await index.search({ query: 'apricot' })).toEqual([])
    expect((await index.search({ query: 'banana' })).length).toBe(1)
    expect(index.fileMtimes('p').get('docs/a.md')).toBe(2000)
  })

  test('removeFile and removeProject drop content', async () => {
    await index.indexFile(fileInput('p', 'docs/a.md', '# A\n\ncherry'))
    await index.indexFile(fileInput('p', 'docs/b.md', '# B\n\ncherry'))
    await index.indexFile(fileInput('q', 'docs/c.md', '# C\n\ncherry'))

    index.removeFile('p', 'docs/a.md')
    expect((await index.search({ query: 'cherry', project: 'p' })).map((h) => h.path)).toEqual(['docs/b.md'])

    index.removeProject('p')
    expect(await index.search({ query: 'cherry', project: 'p' })).toEqual([])
    expect((await index.search({ query: 'cherry' })).length).toBe(1)
  })

  test('stats reflects projects / files / chunks', async () => {
    await index.indexFile(fileInput('p', 'docs/a.md', '# A\n\n## S1\n\none\n\n## S2\n\ntwo'))
    await index.indexFile(fileInput('q', 'docs/b.md', '# B\n\nbody'))
    const s = index.stats()
    expect(s.projects).toBe(2)
    expect(s.files).toBe(2)
    expect(s.chunks).toBeGreaterThanOrEqual(3)
  })
})

describe('DocSearchIndex (keyword-only; no dead embedder seam) — RA4', () => {
  // RA4 removed the never-wired optional `embedder` seam (a dead in-process
  // hybrid re-rank the composer never enabled and that could not share RA3's
  // out-of-process gbrain embedder). These tests are the DELETE mutation
  // guard: they RED if the dead embedder storage / API is re-introduced.

  test('the schema stores NO embedding column (pure lexical)', () => {
    const idx = DocSearchIndex.open(':memory:')
    const cols = idx
      .raw()
      .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('doc_chunks')`)
      .all()
      .map((c) => c.name)
    expect(cols).not.toContain('embedding')
    // The lexical columns that ARE load-bearing are still present.
    expect(cols).toContain('body')
    expect(cols).toContain('title')
    idx.close()
  })

  test('there is no semantic/embedder surface on the index or its factory', () => {
    const idx = DocSearchIndex.open(':memory:')
    // No leftover `semantic` getter and no embedder field.
    expect('semantic' in (idx as unknown as Record<string, unknown>)).toBe(false)
    expect((idx as unknown as Record<string, unknown>)['embedder']).toBeUndefined()
    // `open` takes a single path arg — the options/embedder param is gone.
    expect(DocSearchIndex.open.length).toBe(1)
    idx.close()
  })

  test('search returns keyword-ranked docs with in-range scores', async () => {
    await index.indexFile(fileInput('p', 'docs/revenue.md', '# Revenue\n\nquarterly revenue growth and churn metrics'))
    await index.indexFile(fileInput('p', 'docs/office.md', '# Office\n\nthe new office lease and desk layout'))
    const hits = await index.search({ query: 'revenue growth churn' })
    expect(hits[0]!.path).toBe('docs/revenue.md')
    for (const h of hits) {
      expect(h.score).toBeGreaterThanOrEqual(0)
      expect(h.score).toBeLessThanOrEqual(1)
    }
  })

  // ── Upgrade boundary: a PERSISTENT DB created by the pre-RA4 version still
  // carries `doc_chunks.embedding` on disk (CREATE TABLE IF NOT EXISTS never
  // alters it away). `open()` must detect the stale schema (unstamped →
  // user_version 0) and rebuild the rebuildable cache so the column is gone.
  // This is the mutation guard for the detect-and-rebuild path: drop the
  // migration and this test RESURFACES the embedding column → red.
  describe('reopening a legacy on-disk DB rebuilds away the embedding column', () => {
    let dir: string
    let dbPath: string

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'doc-search-legacy-'))
      dbPath = join(dir, 'index.db')
    })
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    function seedLegacyDb(path: string): void {
      // Recreate the PRE-RA4 schema verbatim: doc_chunks WITH an `embedding`
      // column, its FTS mirror + triggers, and NO user_version stamp (0).
      const legacy = new Database(path)
      legacy.exec(`
        CREATE TABLE doc_chunks (
          id INTEGER PRIMARY KEY, project TEXT NOT NULL, relpath TEXT NOT NULL,
          abs_path TEXT NOT NULL, title TEXT NOT NULL, heading TEXT NOT NULL,
          ordinal INTEGER NOT NULL, body TEXT NOT NULL, mtime_ms INTEGER NOT NULL,
          indexed_at INTEGER NOT NULL, embedding TEXT
        );
        CREATE VIRTUAL TABLE doc_fts USING fts5(
          title, heading, body, content='doc_chunks', content_rowid='id',
          tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER doc_chunks_ai AFTER INSERT ON doc_chunks BEGIN
          INSERT INTO doc_fts(rowid, title, heading, body)
          VALUES (new.id, new.title, new.heading, new.body);
        END;
        INSERT INTO doc_chunks
          (project, relpath, abs_path, title, heading, ordinal, body, mtime_ms, indexed_at, embedding)
        VALUES ('p', 'docs/old.md', '/o/p/docs/old.md', 'Old', '', 0, 'legacy widget body', 1000, 1, '[0.1,0.2]');
      `)
      // Sanity: the legacy DB really has the column and no stamp.
      const cols = legacy
        .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('doc_chunks')`)
        .all()
        .map((c) => c.name)
      expect(cols).toContain('embedding')
      expect(legacy.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(0)
      legacy.close()
    }

    test('drops the stale schema on open and search still works (keyword)', async () => {
      seedLegacyDb(dbPath)

      const reopened = DocSearchIndex.open(dbPath)
      // The rebuilt table no longer has the embedding column…
      const cols = reopened
        .raw()
        .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('doc_chunks')`)
        .all()
        .map((c) => c.name)
      expect(cols).not.toContain('embedding')
      // …and the version is stamped so a future reopen is a no-op.
      expect(reopened.raw().query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(1)

      // The stale legacy row was dropped with the table; the cache rebuilds
      // from source on the next index pass. Keyword search still works.
      await reopened.indexFile(fileInput('p', 'docs/new.md', '# New\n\nfresh widget content'))
      const hits = await reopened.search({ query: 'widget' })
      expect(hits.map((h) => h.path)).toEqual(['docs/new.md'])
      reopened.close()
    })

    test('a second reopen is idempotent (no rebuild once stamped)', async () => {
      seedLegacyDb(dbPath)
      const first = DocSearchIndex.open(dbPath)
      await first.indexFile(fileInput('p', 'docs/keep.md', '# Keep\n\npreserved gadget content'))
      first.close()

      // Already at SCHEMA_VERSION → open must NOT drop; the row survives.
      const second = DocSearchIndex.open(dbPath)
      const hits = await second.search({ query: 'gadget' })
      expect(hits.map((h) => h.path)).toEqual(['docs/keep.md'])
      second.close()
    })

    test('a genuinely-FUTURE-schema DB is REBUILT to the current schema (self-heal)', async () => {
      // Simulate a DB written by a NEWER binary whose schema DIVERGES from the
      // current one: doc_chunks has an EXTRA column, PLUS an extra index + extra
      // table, stamped user_version=2. The doc-search index is a REBUILDABLE
      // CACHE that MUST match the running binary — so a foreign stamp is NOT
      // trusted: the current binary rebuilds to its own schema.
      const future = new Database(dbPath)
      future.exec(`
        CREATE TABLE doc_chunks (
          id INTEGER PRIMARY KEY, project TEXT NOT NULL, relpath TEXT NOT NULL,
          abs_path TEXT NOT NULL, title TEXT NOT NULL, heading TEXT NOT NULL,
          ordinal INTEGER NOT NULL, body TEXT NOT NULL, mtime_ms INTEGER NOT NULL,
          indexed_at INTEGER NOT NULL,
          lang TEXT NOT NULL DEFAULT 'en'
        );
        CREATE INDEX idx_doc_chunks_lang ON doc_chunks(lang);
        CREATE TABLE doc_meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE VIRTUAL TABLE doc_fts USING fts5(
          title, heading, body, content='doc_chunks', content_rowid='id',
          tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER doc_chunks_ai AFTER INSERT ON doc_chunks BEGIN
          INSERT INTO doc_fts(rowid, title, heading, body)
          VALUES (new.id, new.title, new.heading, new.body);
        END;
        INSERT INTO doc_chunks
          (project, relpath, abs_path, title, heading, ordinal, body, mtime_ms, indexed_at, lang)
        VALUES ('p', 'docs/future.md', '/o/p/docs/future.md', 'Future', '', 0, 'futuristic sprocket body', 1000, 1, 'fr');
        PRAGMA user_version = 2;
      `)
      future.close()

      const reopened = DocSearchIndex.open(dbPath)

      // Rebuilt: stamp is DOWN to the current schema version (foreign stamp not trusted).
      expect(reopened.raw().query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(1)

      // Rebuilt to EXACTLY the CURRENT schema: our objects present, and ALL the
      // future-only divergent objects GONE — including the stray unrelated table
      // `doc_meta`. Full-owned-set rebuild removes foreign/stale objects (a
      // dedicated cache must contain exactly the current schema), superseding the
      // earlier "leave inert future tables in place" behaviour.
      const objNames = reopened
        .raw()
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`,
        )
        .all()
        .map((o) => o.name)
      expect(objNames).toContain('doc_chunks')
      expect(objNames).toContain('doc_fts')
      expect(objNames).toContain('idx_doc_chunks_file')
      expect(objNames).toContain('idx_doc_chunks_project')
      expect(objNames).not.toContain('idx_doc_chunks_lang')
      expect(objNames).not.toContain('doc_meta')
      const cols = reopened
        .raw()
        .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('doc_chunks')`)
        .all()
        .map((c) => c.name)
      expect(cols).not.toContain('lang')
      expect(cols).not.toContain('embedding')

      // The stale future row was dropped with the table; search WORKS (no
      // "no such table") and the cache repopulates from source.
      await reopened.indexFile(fileInput('p', 'docs/new.md', '# New\n\nfresh cog content'))
      const hits = await reopened.search({ query: 'cog' })
      expect(hits.map((h) => h.path)).toEqual(['docs/new.md'])
      reopened.close()
    })

    test('a bare user_version=2 DB (no tables) opens AND searches cleanly (self-heal)', async () => {
      // The exact repro: a DB with ONLY a future stamp and NO tables. Opening
      // as-is would register a runtime whose search() throws
      // "no such table: doc_fts". Rebuild-on-mismatch must recreate the schema
      // so open() + search() both succeed.
      const bare = new Database(dbPath)
      bare.exec(`PRAGMA user_version = 2;`)
      bare.close()

      const reopened = DocSearchIndex.open(dbPath)
      expect(reopened.raw().query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(1)
      // search() must NOT throw "no such table: doc_fts".
      expect(await reopened.search({ query: 'anything' })).toEqual([])
      await reopened.indexFile(fileInput('p', 'docs/a.md', '# A\n\nwidget body'))
      expect((await reopened.search({ query: 'widget' })).map((h) => h.path)).toEqual(['docs/a.md'])
      reopened.close()
    })

    test('a corrupt cache stamped at the current version but missing doc_fts self-heals', async () => {
      // A half-written cache stamped at SCHEMA_VERSION but missing a table. The
      // schema fingerprint (missing object → mismatch) catches it and rebuilds
      // so search() never throws.
      const partial = new Database(dbPath)
      partial.exec(`
        CREATE TABLE doc_chunks (id INTEGER PRIMARY KEY, body TEXT);
        PRAGMA user_version = 1;
      `)
      partial.close()

      const reopened = DocSearchIndex.open(dbPath)
      const objNames = reopened
        .raw()
        .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all()
        .map((o) => o.name)
      expect(objNames).toContain('doc_fts')
      await reopened.indexFile(fileInput('p', 'docs/a.md', '# A\n\nwidget body'))
      expect((await reopened.search({ query: 'widget' })).map((h) => h.path)).toEqual(['docs/a.md'])
      reopened.close()
    })

    test('a SAME-version DB with a MALFORMED doc_chunks (wrong columns) self-heals via fingerprint', async () => {
      // The whack-a-mole gap that existence-checking missed: user_version=1 AND
      // both tables present by NAME, but doc_chunks has the WRONG columns
      // (missing `project` etc.). Existence-only checks accept it → indexFile()
      // later throws "no such column: project". The schema FINGERPRINT catches
      // the structural drift and rebuilds to the correct schema.
      const malformed = new Database(dbPath)
      malformed.exec(`
        CREATE TABLE doc_chunks (id INTEGER PRIMARY KEY, body TEXT);
        CREATE VIRTUAL TABLE doc_fts USING fts5(
          title, heading, body, content='doc_chunks', content_rowid='id',
          tokenize='unicode61 remove_diacritics 2'
        );
        PRAGMA user_version = 1;
      `)
      malformed.close()

      const reopened = DocSearchIndex.open(dbPath)
      // Rebuilt to the correct schema: doc_chunks now has the real columns.
      const cols = reopened
        .raw()
        .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('doc_chunks')`)
        .all()
        .map((c) => c.name)
      expect(cols).toContain('project')
      expect(cols).toContain('relpath')
      expect(cols).toContain('heading')
      // indexFile()/search() work — no "no such column".
      await reopened.indexFile(fileInput('p', 'docs/a.md', '# A\n\nwidget body'))
      expect((await reopened.search({ query: 'widget' })).map((h) => h.path)).toEqual(['docs/a.md'])
      reopened.close()
    })

    test('a CORRECT current-schema DB does NOT rebuild on reopen (fingerprint stable)', async () => {
      // Build a correct v1 DB via open(), index a row, then reopen. A stable
      // fingerprint must NOT trigger a rebuild — the row must survive across
      // reopens (a spurious rebuild would drop it, and any FTS shadow-table
      // quirk would surface as a rebuild-every-open here).
      const first = DocSearchIndex.open(dbPath)
      await first.indexFile(fileInput('p', 'docs/keep.md', '# Keep\n\nstable anchovy content'))
      first.close()

      // Reopen repeatedly; each must be a no-op (row survives every time).
      for (let i = 0; i < 3; i++) {
        const again = DocSearchIndex.open(dbPath)
        expect((await again.search({ query: 'anchovy' })).map((h) => h.path)).toEqual(['docs/keep.md'])
        again.close()
      }
    })

    test('a v1 DB missing an FTS-sync TRIGGER self-heals — search works after reopen', async () => {
      // The scope bug this closes: a dropped `doc_chunks_ai` trigger left the
      // fingerprint MATCHING (triggers were filtered out), so no rebuild — then
      // indexFile() inserts stopped populating FTS and search() silently
      // returned nothing. The fingerprint must now cover triggers → mismatch →
      // rebuild → FTS repopulates.
      const first = DocSearchIndex.open(dbPath)
      first.close()
      // Corrupt: drop the AFTER INSERT FTS-sync trigger on an otherwise-valid v1 DB.
      const tamper = new Database(dbPath)
      tamper.exec(`DROP TRIGGER doc_chunks_ai`)
      expect(
        tamper.query<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name='doc_chunks_ai'`,
        ).get()?.n,
      ).toBe(0)
      tamper.close()

      const reopened = DocSearchIndex.open(dbPath)
      // Rebuilt: the trigger is back…
      expect(
        reopened
          .raw()
          .query<{ n: number }, []>(
            `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name='doc_chunks_ai'`,
          )
          .get()?.n,
      ).toBe(1)
      // …and search WORKS after indexing (FTS is repopulated by the restored trigger).
      await reopened.indexFile(fileInput('p', 'docs/a.md', '# A\n\nwidget body'))
      expect((await reopened.search({ query: 'widget' })).map((h) => h.path)).toEqual(['docs/a.md'])
      reopened.close()
    })

    test('a v1 DB missing an INDEX self-heals — index present again after reopen', async () => {
      const first = DocSearchIndex.open(dbPath)
      first.close()
      const tamper = new Database(dbPath)
      tamper.exec(`DROP INDEX idx_doc_chunks_project`)
      tamper.close()

      const reopened = DocSearchIndex.open(dbPath)
      const idxNames = reopened
        .raw()
        .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type='index'`)
        .all()
        .map((r) => r.name)
      expect(idxNames).toContain('idx_doc_chunks_project')
      expect(idxNames).toContain('idx_doc_chunks_file')
      await reopened.indexFile(fileInput('p', 'docs/a.md', '# A\n\nwidget body'))
      expect((await reopened.search({ query: 'widget' })).map((h) => h.path)).toEqual(['docs/a.md'])
      reopened.close()
    })

    test('a v1 DB with an EXTRA rogue TRIGGER self-heals — rogue gone, search works', async () => {
      // The full-owned-set gap this closes: a name-scoped fingerprint DISCARDED
      // an unexpected object (a NEW name not in the reference set) before
      // comparing, so an EXTRA rogue trigger left the fingerprint MATCHING → no
      // rebuild. A rogue `AFTER INSERT` trigger that deletes the just-inserted
      // row makes every indexFile() a no-op and search() silently return
      // nothing. The full-owned-set fingerprint sees the extra object → rebuild.
      const first = DocSearchIndex.open(dbPath)
      first.close()
      const tamper = new Database(dbPath)
      // A rogue trigger (extra object) + a rogue standalone table (extra object).
      tamper.exec(`
        CREATE TRIGGER rogue_sabotage AFTER INSERT ON doc_chunks BEGIN
          DELETE FROM doc_chunks WHERE id = new.id;
        END;
        CREATE TABLE rogue_table (x TEXT);
      `)
      tamper.close()

      const reopened = DocSearchIndex.open(dbPath)
      // Rebuilt: BOTH rogue objects are gone (dedicated cache = exactly the schema).
      const objNames = reopened
        .raw()
        .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`)
        .all()
        .map((o) => o.name)
      expect(objNames).not.toContain('rogue_sabotage')
      expect(objNames).not.toContain('rogue_table')
      // …and search WORKS — the rogue trigger no longer deletes freshly indexed rows.
      await reopened.indexFile(fileInput('p', 'docs/a.md', '# A\n\nwidget body'))
      expect((await reopened.search({ query: 'widget' })).map((h) => h.path)).toEqual(['docs/a.md'])
      reopened.close()

      // Idempotent: the rogue objects were REMOVED by the rebuild, so a second
      // reopen fingerprint-matches and does NOT rebuild (the row survives).
      const again = DocSearchIndex.open(dbPath)
      expect((await again.search({ query: 'widget' })).map((h) => h.path)).toEqual(['docs/a.md'])
      again.close()
    })

    test('an EXTRA rogue VIEW self-heals ONCE — no perpetual rebuild, row survives', async () => {
      // The data-loss bug this closes: the fingerprint covers ALL owned objects
      // (views included), but if the rebuild fails to DROP views, a rogue view
      // SURVIVES every rebuild → the fingerprint NEVER matches → EVERY reopen
      // drops+recreates doc_chunks and loses all indexed rows. The drop-set must
      // equal the fingerprint-set, so views are dropped too → rebuild is
      // idempotent by construction.
      const first = DocSearchIndex.open(dbPath)
      first.close()
      const tamper = new Database(dbPath)
      tamper.exec(`CREATE VIEW rogue_view AS SELECT * FROM doc_chunks`)
      tamper.close()

      // First reopen: rebuilt, the rogue view is GONE.
      const reopened = DocSearchIndex.open(dbPath)
      const objNamesAfter1 = reopened
        .raw()
        .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`)
        .all()
        .map((o) => o.name)
      expect(objNamesAfter1).not.toContain('rogue_view')
      // Insert a row AFTER the heal, so we can prove the SECOND reopen preserves it.
      await reopened.indexFile(fileInput('p', 'docs/keep.md', '# Keep\n\ndurable pomelo content'))
      reopened.close()

      // Second reopen: the view was removed, so the fingerprint now MATCHES →
      // NO rebuild → the row inserted above SURVIVES (a perpetual rebuild would
      // have dropped doc_chunks and lost it).
      const second = DocSearchIndex.open(dbPath)
      expect((await second.search({ query: 'pomelo' })).map((h) => h.path)).toEqual(['docs/keep.md'])
      second.close()

      // Third reopen for good measure — still stable, still no rebuild.
      const third = DocSearchIndex.open(dbPath)
      expect((await third.search({ query: 'pomelo' })).map((h) => h.path)).toEqual(['docs/keep.md'])
      third.close()
    })

    test('a mid-rebuild failure ROLLS BACK — DB left intact, not half-dropped', async () => {
      // The rebuild's teardown + recreate + stamp must be ATOMIC: if a step
      // fails partway (crash, DDL error, lock), the transaction rolls back so the
      // DB is left in its PRIOR state — never half-dropped (which would lose all
      // indexed rows). We inject a failure at the recreate step (CREATE VIRTUAL
      // TABLE) AFTER the destructive drops have run inside the transaction.

      // Warm the reference-fingerprint cache BEFORE patching exec, so building
      // the reference schema (which also runs CREATE VIRTUAL TABLE) isn't caught
      // by the injected failure. A fresh open stamps v1 (no fingerprint eval);
      // the reopen evaluates the fingerprint → builds + caches the reference.
      const warmPath = join(dir, 'warm.db')
      DocSearchIndex.open(warmPath).close()
      DocSearchIndex.open(warmPath).close()

      // Seed a valid v1 DB with a row + a rogue view (forces a rebuild on reopen).
      const seed = DocSearchIndex.open(dbPath)
      await seed.indexFile(fileInput('p', 'docs/precious.md', '# Precious\n\nirreplaceable manatee content'))
      seed.close()
      const tamper = new Database(dbPath)
      tamper.exec(`CREATE VIEW rogue_view AS SELECT * FROM doc_chunks`)
      tamper.close()

      // Inject a failure during the recreate (CREATE VIRTUAL TABLE), after the
      // drops have executed inside the BEGIN IMMEDIATE transaction.
      const origExec = Database.prototype.exec
      Database.prototype.exec = function (this: Database, sql: string, ...rest: unknown[]): unknown {
        if (typeof sql === 'string' && /CREATE\s+VIRTUAL\s+TABLE/i.test(sql)) {
          throw new Error('injected mid-rebuild failure')
        }
        // eslint-disable-next-line prefer-rest-params
        return (origExec as (...a: unknown[]) => unknown).apply(this, [sql, ...rest])
      } as typeof origExec

      let openError: unknown = null
      try {
        DocSearchIndex.open(dbPath)
      } catch (e) {
        openError = e
      } finally {
        Database.prototype.exec = origExec
      }
      // open() surfaced the failure as a caught error (composer degrades on it).
      expect(openError).not.toBeNull()

      // ROLLED BACK: the DB is in its PRIOR state — the row and the rogue view
      // are BOTH still present (the DROPs were undone, NOT a half-dropped schema).
      const check = new Database(dbPath)
      const n = check.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM doc_chunks`).get()?.n
      expect(n).toBeGreaterThan(0)
      const views = check
        .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type='view'`)
        .all()
        .map((r) => r.name)
      expect(views).toContain('rogue_view')
      check.close()

      // A CLEAN reopen (no injected failure) now self-heals normally: rebuild
      // succeeds atomically, the rogue view is gone, and search works.
      const healed = DocSearchIndex.open(dbPath)
      expect(
        healed.raw().query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type='view'`).all(),
      ).toEqual([])
      await healed.indexFile(fileInput('p', 'docs/a.md', '# A\n\nwidget body'))
      expect((await healed.search({ query: 'widget' })).map((h) => h.path)).toEqual(['docs/a.md'])
      healed.close()
    })

    test('a second opener of a just-rebuilt DB does NOT rebuild (lock-then-check) — data survives', async () => {
      // The check-then-act race this closes: two processes open a legacy v0 DB;
      // both would DECIDE "rebuild" if the decision were made outside the lock.
      // With lock-then-check, opener A rebuilds under the write lock and indexes
      // a row; opener B then takes the lock, RE-CHECKS, finds the DB already
      // current, and does NOT rebuild → A's row survives. Ordering is
      // deterministic here (A fully completes before B), which is exactly the
      // interleaving that erased data before: B must re-decide under the lock.

      // Seed a LEGACY v0 DB (forces a rebuild decision) with an old-schema row.
      const legacy = new Database(dbPath)
      legacy.exec(`
        CREATE TABLE doc_chunks (
          id INTEGER PRIMARY KEY, project TEXT NOT NULL, relpath TEXT NOT NULL,
          abs_path TEXT NOT NULL, title TEXT NOT NULL, heading TEXT NOT NULL,
          ordinal INTEGER NOT NULL, body TEXT NOT NULL, mtime_ms INTEGER NOT NULL,
          indexed_at INTEGER NOT NULL, embedding TEXT
        );
        PRAGMA user_version = 0;
      `)
      legacy.close()

      // Opener A: rebuilds the stale cache (v0 → current) and indexes a row.
      const a = DocSearchIndex.open(dbPath)
      expect(a.raw().query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(1)
      await a.indexFile(fileInput('p', 'docs/shared.md', '# Shared\n\ncollaborative tapir content'))
      expect((await a.search({ query: 'tapir' })).map((h) => h.path)).toEqual(['docs/shared.md'])

      // Opener B: same path. Under lock-then-check it re-reads version(=1) +
      // fingerprint(match) → already current → NO rebuild. A's row must survive.
      const b = DocSearchIndex.open(dbPath)
      expect((await b.search({ query: 'tapir' })).map((h) => h.path)).toEqual(['docs/shared.md'])
      b.close()

      // A's own view of the DB is likewise intact.
      expect((await a.search({ query: 'tapir' })).map((h) => h.path)).toEqual(['docs/shared.md'])
      a.close()
    })
  })
})
