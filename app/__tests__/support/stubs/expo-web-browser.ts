export async function openBrowserAsync(): Promise<{ type: 'cancel' }> { return { type: 'cancel' }; }
export async function openAuthSessionAsync(): Promise<{ type: 'cancel' }> { return { type: 'cancel' }; }
export function dismissBrowser(): void {}
