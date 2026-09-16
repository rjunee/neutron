/**
 * The enforced wall budget for each project-build role.
 *
 * This record is shared with the test-strategy renderer because a worker must be
 * told the same ceiling that its host request enforces. Keep milliseconds as the
 * source unit: the worker API consumes milliseconds and prose derives minutes.
 */
export const PROJECT_BUILD_WALL_MS = {
  plan: 15 * 60_000,
  review: 15 * 60_000,
  build: 90 * 60_000,
  fix: 90 * 60_000,
} as const

export type ProjectBuildRole = keyof typeof PROJECT_BUILD_WALL_MS
