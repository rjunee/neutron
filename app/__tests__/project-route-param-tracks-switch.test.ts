import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROUTES_ROOT = join(import.meta.dir, '..', 'app');
const ROOT_LAYOUT = readFileSync(join(ROUTES_ROOT, '_layout.tsx'), 'utf8');
const PROJECTS_LAYOUT_PATH = join(ROUTES_ROOT, 'projects', '_layout.tsx');

function projectRouteName(): string {
  return existsSync(PROJECTS_LAYOUT_PATH) ? '[id]' : 'projects/[id]';
}

function dynamicParamName(routeName: string): string | null {
  return /^\[([^\[\]]+?)\]$/.exec(routeName)?.[1] ?? null;
}

describe('mobile project route identity', () => {
  it('gives the project id its own dynamic navigator node', () => {
    expect(ROOT_LAYOUT).toContain('<Stack.Screen name="projects" />');
    expect(ROOT_LAYOUT).not.toContain('<Stack.Screen name="projects/[id]" />');
    expect(readFileSync(PROJECTS_LAYOUT_PATH, 'utf8')).toContain('<Stack.Screen name="[id]" />');
    expect(dynamicParamName(projectRouteName())).toBe('id');
  });

  it('detects the id change on a switch and on the switch back', () => {
    const param = dynamicParamName(projectRouteName());
    if (param !== 'id') throw new Error('project id is not its own dynamic route node');

    const diverges = (from: string, to: string): boolean =>
      ({ id: from })[param] !== ({ id: to })[param];

    expect(diverges('willow', 'harbor')).toBe(true);
    expect(diverges('harbor', 'willow')).toBe(true);
  });
});
