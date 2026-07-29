/**
 * @neutronai/onboarding/profile-pic — public barrel.
 *
 * Per docs/plans/P2-onboarding.md § 2.7.
 */

export {
  ProfilePicPipeline,
  ProfilePicError,
  archetypeHintToFallbackSlug,
  type ProfilePicErrorCode,
  type ProfilePicJob,
  type ProfilePicJobStatus,
  type ProfilePicPipelineDeps,
  type StartProfilePicInput,
  type StartProfilePicResult,
} from './pipeline.ts'

export {
  GeminiImagenClient,
  GeminiImagenError,
  type GeminiImagenClientDeps,
  type GeminiImagenErrorCode,
  type GeminiImagenFn,
  type GeminiImagenInput,
  type GeminiImagenOutput,
  type GeminiImageCandidate,
} from './gemini-imagegen.ts'

export {
  FallbackGallery,
  FallbackGalleryError,
  FALLBACK_ARCHETYPE_SLUGS,
  FALLBACK_DEFAULT_SLUG,
  normalizeArchetype,
  type FallbackArchetypeSlug,
  type FallbackGalleryDeps,
  type FallbackGalleryErrorCode,
  type FallbackPortrait,
} from './fallback-gallery.ts'

export {
  buildPortraitWaitPrompt,
  buildPortraitPickPrompt,
  PORTRAIT_PICK_PROMPT_BODY,
  PORTRAIT_WAIT_PROMPT_BODY,
  type BuildPortraitPickPromptInput,
  type BuildPortraitWaitPromptInput,
} from './selection.ts'

export {
  CANDIDATE_ROUTE_PATH_PREFIX,
  CANONICAL_AVATAR_FILENAME,
  ProfilePicStorageError,
  buildAvatarRouteHandler,
  buildCandidateRouteHandler,
  buildProfilePicEngineHook,
  persistChosenAvatar,
  type AvatarRouteOptions,
  type BuildProfilePicEngineHookInput,
  type PersistChosenAvatarInput,
  type PersistChosenAvatarResult,
  type ProfilePicStorageDeps,
  type ProfilePicStorageErrorCode,
} from './storage.ts'

export {
  ProfilePicPendingStore,
  type ProfilePicPendingRow,
  type ProfilePicPendingStatus,
  type ProfilePicPendingStoreDeps,
  type RecordPendingInput,
  type RecordPendingResult,
} from './pending-call-store.ts'

export {
  DEFAULT_PENDING_FRESH_WINDOW_MS,
  DEFAULT_PENDING_HARD_FAIL_WINDOW_MS,
  resumeProfilePicOnBoot,
  type ResumeOnBootDeps,
  type ResumeOnBootResult,
} from './restart-resume.ts'
