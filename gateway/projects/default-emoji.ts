/**
 * @neutronai/gateway/projects — default project emoji re-export shim.
 *
 * L3 (2026-07) — the deterministic emoji heuristic moved to the node-free
 * `contracts/default-emoji.ts` leaf so consumers across bands (gateway, open,
 * onboarding) import it from a leaf rather than reaching into gateway. This
 * shim re-exports every symbol so existing gateway import specifiers stay valid
 * (test-policy §2.2 barrel rule). The L5 import-rewrite sweep will repoint the
 * remaining gateway importers and delete this shim.
 */

export {
  GENERAL_EMOJI,
  MAX_EMOJI_LEN,
  defaultProjectEmoji,
  normaliseEmojiInput,
  resolveProjectEmoji,
} from '@neutronai/contracts/default-emoji.ts'
