// @neutronai/app — Metro config for the Neutron monorepo (mobile Phase 2).
//
// The Expo app consumes `@neutronai/chat-core`, a workspace package whose source
// lives at the repo root (`../chat-core`) and is symlinked into
// `app/node_modules/@neutronai/chat-core`. Out of the box Metro only watches the
// app folder and would fail to resolve the package's real files. This config
// adds the standard Expo-monorepo wiring:
//   - watch the repo root so changes to chat-core are picked up + bundled;
//   - resolve modules from BOTH the app's and the root's node_modules.
//
// Reference: https://docs.expo.dev/guides/monorepos/

const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

// 1. Watch the workspace root so chat-core (../chat-core) is in Metro's graph.
config.watchFolders = [workspaceRoot];

// 2. Resolve from the app first, then the workspace root.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;
