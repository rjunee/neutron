/**
 * @neutronai/app — harness stub for `expo-document-picker`.
 *
 * DELIBERATELY OBSERVABLE, like the `expo-audio` stub beside it and for the same
 * reason: "did pressing + actually reach the OS picker?" is a question an inert
 * stub cannot answer, and an attach button that renders and opens nothing is the
 * voice defect wearing a different control. So it counts its calls.
 *
 * The RESULT is unchanged — `{ canceled: true }`, i.e. the owner backed out of
 * the sheet — because nothing in this repo needs a picked file to exist, and a
 * stub that invented one would be a fake with behaviour rather than a seam.
 */

let calls = 0;

/** How many times the picker was opened this test. */
export function harnessDocumentPickerCalls(): number {
  return calls;
}

/** Back to zero. Call in `beforeEach`. */
export function resetHarnessDocumentPicker(): void {
  calls = 0;
}

export async function getDocumentAsync(): Promise<{ canceled: true }> {
  calls += 1;
  return { canceled: true };
}
