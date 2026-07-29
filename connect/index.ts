export {
  getOrigin,
  isTaggedContent,
  stampOriginInstance,
  type TaggedContent,
} from './api/origin-tag.ts'

export {
  authorizeConnectRequest,
  type AuthFailure,
  type AuthResult,
  type AuthSuccess,
  type ConnectAuthContext,
  type JwtBearerMiddlewareOptions,
} from './api/jwt-bearer-middleware.ts'

export {
  CONNECT_API_PREFIX,
  createConnectApiHandler,
  type ConnectApiHandlers,
  type ConnectApiServerOptions,
  type IncomingMessage,
  type ProjectRef,
} from './api/server.ts'

export {
  ProjectListCache,
  getUnifiedProjects,
  type UnifiedProjectListInput,
  type UnifiedProjectListResult,
  type UnifiedProjectListSource,
} from './unified-project-list.ts'

export {
  SharedProjectMirrorStore,
  type SharedProjectMirrorRow,
  type RecordMirrorInput,
} from './shared-project-mirror-store.ts'

export {
  exportProjectGraphSnapshot,
  importGraphSnapshot,
  importSharedProjectMemoryOnJoin,
  formatMirrorSource,
  mirroredSlug,
  tagPageContent,
  OWNER_AUTHOR_ID,
  InProcessGraphSource,
  type GraphSnapshot,
  type MirrorPage,
  type MirrorEdge,
  type MirrorAuthor,
  type MirrorResult,
  type SharedProjectGraphSource,
  type ImportSharedProjectMemoryInput,
  type ImportSharedProjectMemoryDeps,
} from './shared-project-memory-mirror.ts'
