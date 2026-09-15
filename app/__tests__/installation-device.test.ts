import { expect, test } from 'bun:test';
import { installationDeviceReader } from '../lib/installation-device';

test('one persisted identity across concurrent requests and reloads', async () => {
  const values = new Map<string, string>();
  let writes = 0;
  const backing = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => { writes++; values.set(key, value); },
  };
  const read = installationDeviceReader(backing);
  const ids = await Promise.all([read(), read(), read()]);
  expect(new Set(ids).size).toBe(1);
  expect(writes).toBe(1);
  expect(await installationDeviceReader(backing)()).toBe(ids[0]!);
  expect(writes).toBe(1);
});

test('failed persistence refuses identity and retries instead of inventing a device', async () => {
  let fail = true;
  const read = installationDeviceReader({
    getItem: () => null,
    setItem: () => { if (fail) throw new Error('storage unavailable'); },
  });
  await expect(read()).rejects.toThrow('storage unavailable');
  fail = false;
  expect(await read()).toMatch(/^dev-/);
});
