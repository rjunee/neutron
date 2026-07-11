/**
 * @neutronai/app — `useDocTree`: the file-tree cluster of the docs tab
 * (D7 refactor). Owns `tree` + `loadingTree`, the tree-fetch gate, and
 * `fetchTree`. Refetches on every project switch.
 *
 * Ordering invariant (P7.1 round-7 BLOCKING #2): the tree is cleared
 * to `[]` BEFORE `fetchTree()` runs, so a project A → B switch can
 * never leave A's tree rendered under B's `project_id` (tapping a row
 * would otherwise read/write B with A's relative paths). The gate is
 * invalidated on a committed switch by `useProjectScopedAsync`, so its reset
 * also precedes the refetch's `acquire()`.
 */

import { useCallback, useEffect, useState } from 'react';

import { DocsClient, type DocTreeNode } from '../../lib/docs-client';
import { useProjectScopedAsync } from './use-project-scoped-async';
import { formatError } from './docs-shared';

export interface UseDocTree {
  tree: DocTreeNode[];
  setTree: React.Dispatch<React.SetStateAction<DocTreeNode[]>>;
  loadingTree: boolean;
  fetchTree: () => Promise<void>;
}

export function useDocTree(params: {
  client: DocsClient | null;
  project_id: string;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
}): UseDocTree {
  const { client, project_id, setError } = params;
  const treeGate = useProjectScopedAsync(project_id);

  const [tree, setTree] = useState<DocTreeNode[]>([]);
  const [loadingTree, setLoadingTree] = useState(true);

  const fetchTree = useCallback(async () => {
    if (client === null || project_id.length === 0) return;
    const token = treeGate.acquire();
    setLoadingTree(true);
    try {
      const { tree: nextTree } = await client.tree(project_id);
      if (!treeGate.isLatest(token)) return;
      setTree(nextTree);
    } catch (err) {
      if (!treeGate.isLatest(token)) return;
      // Clear the tree on error so the user can't tap a row that maps
      // to a previous project's tree. Without this, an A → B project
      // switch where B's tree load errors leaves A's tree rendered
      // under B; tapping a row reads/writes B with A's relative paths.
      // Round-7 BLOCKING #2.
      setTree([]);
      setError(formatError(err));
    } finally {
      // Only clear the loading flag for the latest fetch — a superseded
      // call must not stomp the spinner the newer fetch just set.
      if (treeGate.isLatest(token)) setLoadingTree(false);
    }
  }, [client, project_id, treeGate, setError]);

  // Project change (and mount): clear the stale tree, then refetch.
  // Tree MUST reset before fetchTree() — see the ordering invariant in
  // the module header. `fetchTree` is `f(client, project_id)`, so this
  // fires exactly on a project/client switch, matching the pre-D7
  // single project-change effect.
  useEffect(() => {
    setTree([]);
    void fetchTree();
  }, [fetchTree]);

  return { tree, setTree, loadingTree, fetchTree };
}
