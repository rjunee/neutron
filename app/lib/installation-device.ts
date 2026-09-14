import { prefixedRandomId } from '@neutronai/chat-core';

export const INSTALLATION_DEVICE_KEY = 'neutron.chat.device-id';

export interface DeviceBacking {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
}

/** Share one pending mint so simultaneous chat and rail requests agree. */
export function installationDeviceReader(backing: DeviceBacking): () => Promise<string> {
  let pending: Promise<string> | undefined;
  return () => pending ??= (async () => {
    const saved = await backing.getItem(INSTALLATION_DEVICE_KEY);
    if (saved) return saved;
    const id = prefixedRandomId('dev');
    await backing.setItem(INSTALLATION_DEVICE_KEY, id);
    return id;
  })().catch((error: unknown) => {
    pending = undefined;
    throw error;
  });
}

let readDevice: (() => Promise<string>) | undefined;
export async function installationDeviceId(): Promise<string> {
  if (!readDevice) {
    const web = (globalThis as { localStorage?: DeviceBacking }).localStorage;
    if (web) readDevice = installationDeviceReader(web);
    else {
      const { default: storage } = await import('@react-native-async-storage/async-storage');
      readDevice ??= installationDeviceReader(storage);
    }
  }
  return readDevice();
}
