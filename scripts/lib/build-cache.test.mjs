import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { webBuildFresh } from './build-cache.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'classrep-build-cache-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = (path, seconds) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'fixture');
    utimesSync(target, seconds, seconds);
  };
  file('apps/web/src/main.tsx', 100);
  return { root, file };
}

test('missing output requires a build', (t) => {
  const { root } = fixture(t);
  assert.equal(webBuildFresh(root), false);
});

for (const input of ['apps/web/src/main.tsx', 'shared/timetable.ts', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json']) {
  test(`changes to ${input} invalidate the build`, (t) => {
    const { root, file } = fixture(t);
    file(input, 100);
    file('apps/web/dist/index.html', 200);
    assert.equal(webBuildFresh(root), true);
    file(input, 300);
    assert.equal(webBuildFresh(root), false);
  });
}

test('generated files and dependencies do not invalidate the build', (t) => {
  const { root, file } = fixture(t);
  file('apps/web/dist/index.html', 200);
  for (const path of ['apps/web/dist/assets/main.js', 'apps/web/node_modules/library/index.js', 'apps/web/.vite/cache', 'shared/node_modules/library/index.js']) file(path, 300);
  assert.equal(webBuildFresh(root), true);
});
