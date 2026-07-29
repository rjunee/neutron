/**
 * @neutronai/app — composer-side constants (P5.1).
 *
 * The client mirrors the server's `MAX_USER_MESSAGE_LEN = 16_384` cap
 * from `channels/adapters/app-ws/envelope.ts`. Duplicating the value
 * here keeps the Expo bundle dependency-free (no `@neutronai/channels`
 * import in pure-JS code). The lock-test in
 * `app/__tests__/composer-constants.test.ts` guards against drift.
 *
 * Re-exports of the theme tokens are colocated for ergonomics — every
 * primitive in `app/components/` reads its style tokens from `theme.ts`
 * via this barrel.
 */

export const MAX_USER_MESSAGE_LEN_CLIENT = 16_384;

export { BREAKPOINTS, DENSITY, MOTION, SPACING, THEME, TYPOGRAPHY } from './theme';
