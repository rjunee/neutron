export const documentDirectory = 'file:///harness/documents/';
export const cacheDirectory = 'file:///harness/cache/';
export async function getInfoAsync(): Promise<{ exists: boolean }> { return { exists: false }; }
export async function readAsStringAsync(): Promise<string> { return ''; }
export async function writeAsStringAsync(): Promise<void> {}
export async function deleteAsync(): Promise<void> {}
export async function makeDirectoryAsync(): Promise<void> {}
export async function copyAsync(): Promise<void> {}
export async function uploadAsync(): Promise<{ status: number; body: string }> {
  return { status: 200, body: '{}' };
}
export const EncodingType = { UTF8: 'utf8', Base64: 'base64' } as const;
export const FileSystemUploadType = { BINARY_CONTENT: 0, MULTIPART: 1 } as const;
