/**
 * Ambient types for the device harness's untyped dependencies.
 *
 * `react-native-web` ships no type declarations. Declaring it as the react-native
 * surface is not a convenience — it is the invariant the harness relies on: the
 * app is written against `react-native`, so anything RNW fails to provide is a
 * harness gap, and typing it this way makes that gap a TYPE ERROR here rather
 * than a runtime surprise in a mount.
 */
declare module 'react-native-web' {
  export * from 'react-native';
}
