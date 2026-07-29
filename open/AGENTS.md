# AGENTS.md — open

`open/` is the single-owner **Open** server: the entrypoint (`open/server.ts` → `@neutronai/open`) that a fresh self-hosted clone runs via `bun start` to get the full onboarding + chat product on one port. It builds the single-owner `GraphComposer` (`open/composer.ts`) and calls the shared `boot()` shell.

It must NOT hold the substrate dispatcher (`runtime/`), the gateway HTTP core (`gateway/`), or Managed-only cross-instance identity minting — an Open install has no signing key and federates into Managed via a relay-issued JWT.

## Naming — the `open` overload (READ THIS)

`open` is overloaded across the codebase. These are DIFFERENT senses on DIFFERENT axes — do not conflate them:

- **Product / repo** — "Neutron Open", the open-source single-owner mirror (this `neutron-open` repo). The user-facing product name.
- **Directory / package** — `open/` (`@neutronai/open`): the single-owner server entrypoint + composer documented here. The *code* sense.
- **Deployment-mode enum value** — `'open'` in `DeploymentMode = 'open' | 'managed' | 'connect'` (`gateway/deployment-mode.ts`): a self-hosted single-owner install (no signing key; the M2.5 default). The *runtime-config* sense. The `open/` directory sense and the `'open'` mode value are NOT the same axis — an `open/` checkout can boot a Managed graph (it defers to `NEUTRON_GRAPH_COMPOSER_MODULE` when set; see `open/server.ts`), so "runs from `open/`" ≠ "deployment mode is `'open'`".
- **Federation sense** — an `'open'`-mode install is a FEDERATED node: it calls a Managed workspace-instance's cross-instance API with a federated JWT from the syndication relay (`gateway/deployment-mode.ts` header). "open" here connotes the federated / self-hosted edge, opposite the "managed" hub.

Cross-refs: `gateway/deployment-mode.ts` (mode enum + federation), `open/server.ts` (entrypoint), `open/composer.ts` (single-owner graph).
