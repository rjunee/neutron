/**
 * gateway/composition/input/composition-input.ts — the composed
 * `CompositionInput` interface.
 *
 * After R5 (audit P2-5) the ~900-LOC body was split into per-concern
 * interfaces in this directory and re-composed here via `extends`. The
 * public shape is structurally identical — every field keeps its name,
 * type, optionality, and JSDoc. `composition.ts` re-exports this type so
 * external importers see the same `CompositionInput`.
 *
 * Defined in this leaf (rather than in `composition.ts`) so the extracted
 * sub-builders can import it without importing `composition.ts` back — that
 * would re-introduce a composition.ts ↔ composition/* import cycle.
 */
import type { ChannelsCompositionInput } from './channels-input.ts'
import type { NotifierCompositionInput } from './notifier-input.ts'
import type { HttpSurfacesCompositionInput } from './http-surfaces-input.ts'
import type { AppSurfacesCompositionInput } from './app-surfaces-input.ts'
import type { ConnectCompositionInput } from './connect-input.ts'
import type { CoresCompositionInput } from './cores-input.ts'
import type { OnboardingCompositionInput } from './onboarding-input.ts'
import type { AuthCompositionInput } from './auth-input.ts'
import type { TasksCompositionInput } from './tasks-input.ts'
import type { PlatformCompositionInput } from './platform-input.ts'
import type { MiscCompositionInput } from './misc-input.ts'

/**
 * Production composition input. See the per-concern interfaces in this
 * directory for the field groupings.
 */
export interface CompositionInput
  extends MiscCompositionInput,
    ChannelsCompositionInput,
    NotifierCompositionInput,
    HttpSurfacesCompositionInput,
    AppSurfacesCompositionInput,
    ConnectCompositionInput,
    OnboardingCompositionInput,
    PlatformCompositionInput,
    CoresCompositionInput,
    AuthCompositionInput,
    TasksCompositionInput {}
