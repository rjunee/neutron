# IMPLEMENTATION_PLAN.md — a hand-edit in the deploy checkout silently blocks every deploy

Card: a deploy of `origin/main` was refused twice because the deploy checkout carried an
uncommitted `migrations/repairs.json` whose content is ALREADY in the target ref; the refusal
reached only the owner's chat, so the dispatching agent saw approvals that silently did nothing.

Context note (planner judgment, recorded because it shapes every task): the precondition that
produced the HTTP 500 executes on the CONTROL PLANE (`/opt/neutron-managed`), which is outside
this repository. The managed host vendors this tree at `vendor/neutron`, so the correct in-repo
fix is a dependency-free, control-plane-importable precondition module that implements the
discriminating check and the remedy-naming refusal text; the agent-visibility and health work
lands on this repo's own `host_deploy_*` surfaces. No competing plan doc — SPEC.md governs.

- [x] **1. Discriminating deploy-precondition module with remedy-naming refusal text**
      (`open/host-deploy-preconditions.ts` + real-git tests). Classify every dirty path in a
      checkout against the TARGET ref: `untracked` (blocks), `divergent` (blocks), `redundant`
      (working-tree content byte-equal to the target ref's blob — does NOT block; discarding
      loses nothing). Render a refusal that names each blocking path and states whether each
      dirty path is redundant with the target, so the reader knows whether discarding is safe
      without diffing by hand. Fail CLOSED when the target ref cannot be resolved. NO force
      flag; NO auto-discard of divergent content. Covers acceptance bullets 1, 2 and 4.
- [ ] **2. The refusal reaches the dispatching agent, not only the owner's chat.** Persist the
      terminal outcome of every host-deploy attempt (accepted / refused / errored / timed-out,
      with the scrubbed control-plane detail, ref, sha, timestamp) at the moment
      `handleOwnerButtonAnswer` learns it in `open/host-deploy.ts`, and expose it through the
      agent-facing surface: extend `host_deploy_status` (`gateway/wiring/host-deploy-tool.ts`)
      with a `last_deploy` block so the session that called `host_deploy_request` can read the
      refusal REASON back instead of inferring from silence. Mind `HOST_DEPLOY_DETAIL_CAP`
      truncation: the blocking-path list must survive into the stored reason. Test: a dispatch
      that returns `ok:false` with a precondition detail is readable via the agent tool with
      its reason; an approval that dispatched nothing never reads as success. Covers
      acceptance bullet 3.
- [ ] **3. Detect the drift before anyone deploys.** A dirty deployed checkout is a standing
      condition, not a deploy-time surprise: extend the `/preview` consumption in
      `open/host-deploy-runtime.ts` (`createHostDeployRemoteGit`) to read an OPTIONAL
      `dirty_paths` field when the control plane reports one, and surface it in
      `host_deploy_status` (and the `status()` result in `open/host-deploy.ts`) as a named
      warning listing the paths — absent/omitted field degrades to today's behavior so an
      older control plane still works. Test: a preview answer carrying `dirty_paths` shows up
      in `host_deploy_status`; one without it changes nothing. Covers work item 4.
