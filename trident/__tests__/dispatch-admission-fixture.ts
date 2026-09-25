/**
 * trident/__tests__/dispatch-admission-fixture.ts — a REAL project admission for
 * dispatch suites whose subject is not admission itself (#1237).
 *
 * `BoardBoundBuildDeps.projectAdmission` is REQUIRED and there is deliberately no
 * permissive stub in source. This backs the gateway's real `ProjectAdmission`
 * with the suite's own migrated `ProjectDb` (migration 0158 is the shipped
 * schema), so every dispatch in these suites takes and releases a durable lease
 * exactly as production does. The default scope is General (null), which always
 * registers and is never fenced unless a test fences it.
 *
 * It lives under `__tests__/` so the layering rules treat its gateway import as
 * the test edge it is; trident SOURCE still never imports gateway.
 */
import type { ProjectDb } from '@neutronai/persistence/index.ts'
import { ProjectAdmission } from '@neutronai/gateway/project-admission.ts'
import type { DispatchAdmission } from '../dispatch-admission.ts'

/** The fixture's owner boundary — one per suite database is enough. */
export const FIXTURE_ADMISSION_OWNER = 'dispatch-fixture-owner'

/** A real admission service over `db`. */
export function fixtureProjectAdmission(db: ProjectDb): ProjectAdmission {
  return new ProjectAdmission({ db, ownerHandle: FIXTURE_ADMISSION_OWNER, bootId: 'dispatch-fixture-boot' })
}

/** The chokepoint's admission for one scope (General by default) over `db`. */
export function fixtureDispatchAdmission(
  db: ProjectDb,
  projectId: string | null = null,
  producer: 'work-board' | 'hold-drain' = 'work-board',
): DispatchAdmission {
  return fixtureProjectAdmission(db).forDispatch(projectId, producer)
}

/** Every durable `build` lease the fixture owner holds in `db`. */
export function fixtureBuildLeases(db: ProjectDb): ReturnType<ProjectAdmission['listLeases']> {
  return fixtureProjectAdmission(db).listLeases('build')
}
