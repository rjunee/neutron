/**
 * P7.0 + P7.1 — DocsClient tests.
 *
 * Verifies the client's wire shape end-to-end against the real
 * `app-docs-surface` running on a fresh tmpdir-backed DocStore. This
 * is the same test harness pattern the gateway surface tests use, just
 * driven through the client instead of `fetch` directly. Confirms:
 *
 *   - tree() returns the canonical folder/file shape
 *   - readFile() / writeFile() round-trip cleanly
 *   - writeFile({ expected_modified_at: stale }) throws
 *     `DocsClientError(code='doc_modified_conflict')`
 *   - moveFile()/deleteFile()/createFolder()/deleteFolder() succeed
 *   - new-file flow (writeFile with empty body) creates an empty .md
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAppWsAuthResolver } from '../../channels/index.ts';
import { composeHttpHandler } from '../http/compose.ts';
import { createAppDocsSurface } from '../http/app-docs-surface.ts';
import { DocStore } from '../http/doc-store.ts';

import { DocsClient, DocsClientError } from '../../app/lib/docs-client';

const PROJECT_ID = 'demo-project';
const PROJECT_SLUG = 'demo';

interface Harness {
  server: import('bun').Server<unknown>;
  client: DocsClient;
  docsRoot: string;
  tmp: string;
  close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-docs-client-'));
  const owner_home = join(tmp, 'home');
  mkdirSync(owner_home, { recursive: true });
  const docsRoot = join(owner_home, 'Projects', PROJECT_ID, 'docs');
  mkdirSync(docsRoot, { recursive: true });

  const store = new DocStore({ owner_home });
  const auth = createAppWsAuthResolver({ project_slug: PROJECT_SLUG, bypass: true });
  const surface = createAppDocsSurface({ store, auth, project_slug: PROJECT_SLUG });
  const composed = composeHttpHandler({
    appDocs: { handler: surface.handler },
    defaultHandler: () => new Response('not found', { status: 404 }),
  });
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composed.fetch(req, srv),
    websocket: composed.websocket,
  });
  const client = new DocsClient({
    base_url: `http://127.0.0.1:${server.port}`,
    token: 'dev:sam',
  });
  return {
    server,
    client,
    docsRoot,
    tmp,
    close: async () => {
      await server.stop(true);
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

describe('DocsClient', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await startHarness();
  });
  afterEach(async () => {
    await harness.close();
  });

  it('tree() returns empty for a fresh project', async () => {
    const { tree, file_count } = await harness.client.tree(PROJECT_ID);
    expect(tree).toEqual([]);
    expect(file_count).toBe(0);
  });

  it('writeFile() creates a new file and readFile() round-trips it', async () => {
    const write = await harness.client.writeFile(PROJECT_ID, {
      path: 'notes/first.md',
      content: '# First\n',
    });
    expect(write.path).toBe('notes/first.md');
    const read = await harness.client.readFile(PROJECT_ID, 'notes/first.md');
    expect(read.content).toBe('# First\n');
    expect(read.modified_at).toBeGreaterThan(0);
  });

  it('writeFile() with stale expected_modified_at throws DocsClientError(doc_modified_conflict)', async () => {
    await harness.client.writeFile(PROJECT_ID, { path: 'a.md', content: '# A' });
    const read = await harness.client.readFile(PROJECT_ID, 'a.md');
    let caught: unknown = null;
    try {
      await harness.client.writeFile(PROJECT_ID, {
        path: 'a.md',
        content: '# stale write',
        expected_modified_at: read.modified_at - 5000,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught instanceof DocsClientError).toBe(true);
    const dce = caught as DocsClientError;
    expect(dce.code).toBe('doc_modified_conflict');
    expect(dce.status).toBe(409);
    expect(dce.current_modified_at).toBe(read.modified_at);
  });

  it('writeFile() with expected_modified_at on a concurrently-deleted file throws DocsClientError with current_modified_at:null (round-5 IMPORTANT #1)', async () => {
    // Round-5 IMPORTANT #1 — when a PUT carries `expected_modified_at`
    // and the file has been concurrently deleted between the caller's
    // read and this write, the gateway must return 409 with
    // `current_modified_at: null` so the client can switch from an
    // Update-in-place flow to a recreate-via-fresh-PUT flow.
    await harness.client.writeFile(PROJECT_ID, { path: 'a.md', content: '# A' });
    const read = await harness.client.readFile(PROJECT_ID, 'a.md');
    // Simulate the concurrent delete via the filesystem directly so
    // the client's view of `modified_at` is stale by the time of PUT.
    unlinkSync(join(harness.docsRoot, 'a.md'));
    let caught: unknown = null;
    try {
      await harness.client.writeFile(PROJECT_ID, {
        path: 'a.md',
        content: '# recreated',
        expected_modified_at: read.modified_at,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught instanceof DocsClientError).toBe(true);
    const dce = caught as DocsClientError;
    expect(dce.code).toBe('doc_modified_conflict');
    expect(dce.status).toBe(409);
    expect(dce.current_modified_at).toBeNull();

    // A subsequent PUT WITHOUT `expected_modified_at` recreates fine —
    // matching the "client acks the deletion and recreates" path.
    const recreated = await harness.client.writeFile(PROJECT_ID, {
      path: 'a.md',
      content: '# recreated',
    });
    expect(recreated.path).toBe('a.md');
  });

  it('writeFile() with matching expected_modified_at updates the file', async () => {
    await harness.client.writeFile(PROJECT_ID, { path: 'a.md', content: '# A' });
    const read = await harness.client.readFile(PROJECT_ID, 'a.md');
    const update = await harness.client.writeFile(PROJECT_ID, {
      path: 'a.md',
      content: '# Updated',
      expected_modified_at: read.modified_at,
    });
    expect(update.modified_at).toBeGreaterThanOrEqual(read.modified_at);
    const reread = await harness.client.readFile(PROJECT_ID, 'a.md');
    expect(reread.content).toBe('# Updated');
  });

  it('moveFile() renames within docs/', async () => {
    await harness.client.writeFile(PROJECT_ID, { path: 'old.md', content: '# Old' });
    await harness.client.moveFile(PROJECT_ID, 'old.md', 'archive/new.md');
    const read = await harness.client.readFile(PROJECT_ID, 'archive/new.md');
    expect(read.content).toBe('# Old');
  });

  it('deleteFile() removes the file', async () => {
    await harness.client.writeFile(PROJECT_ID, { path: 'goner.md', content: '# G' });
    await harness.client.deleteFile(PROJECT_ID, 'goner.md');
    let caught: unknown = null;
    try {
      await harness.client.readFile(PROJECT_ID, 'goner.md');
    } catch (err) {
      caught = err;
    }
    expect(caught instanceof DocsClientError).toBe(true);
    expect((caught as DocsClientError).status).toBe(404);
  });

  it('createFolder() creates nested folders + tree picks them up', async () => {
    await harness.client.createFolder(PROJECT_ID, 'inbox');
    const { tree } = await harness.client.tree(PROJECT_ID);
    expect(tree.find((n) => n.name === 'inbox' && n.kind === 'folder')).toBeDefined();
  });

  it('deleteFolder() removes an empty folder', async () => {
    await harness.client.createFolder(PROJECT_ID, 'temp');
    await harness.client.deleteFolder(PROJECT_ID, 'temp');
    const { tree } = await harness.client.tree(PROJECT_ID);
    expect(tree.find((n) => n.name === 'temp')).toBeUndefined();
  });

  it('new-file flow (writeFile with empty content) creates an empty .md', async () => {
    await harness.client.writeFile(PROJECT_ID, {
      path: 'notes/empty.md',
      content: '',
    });
    const read = await harness.client.readFile(PROJECT_ID, 'notes/empty.md');
    expect(read.content).toBe('');
    expect(read.size_bytes).toBe(0);
  });

  it('a 4xx response surfaces as DocsClientError with the gateway code', async () => {
    let caught: unknown = null;
    try {
      await harness.client.writeFile(PROJECT_ID, {
        path: 'image.png',
        content: 'not markdown',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught instanceof DocsClientError).toBe(true);
    expect((caught as DocsClientError).code).toBe('invalid_extension');
  });
});
