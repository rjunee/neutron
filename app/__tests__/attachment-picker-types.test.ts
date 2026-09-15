import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, '..', 'components', 'InputComposer.tsx'), 'utf8');

describe('InputComposer web attachment picker', () => {
  it('offers common diagnostic files to the parent upload flow', () => {
    const accept = source.match(/accept: file_accept \?\? '([^']+)'/)?.[1];
    expect(accept).toBeDefined();
    for (const suffix of ['.gz', '.json', '.log', '.csv']) {
      expect(accept!.split(',')).toContain(suffix);
    }
  });
});
