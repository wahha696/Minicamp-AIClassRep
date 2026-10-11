import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { findRoot } from './paths.js';

let fixture: string;
beforeEach(() => { fixture = mkdtempSync(join(tmpdir(), 'classrep-root-boundary-')); });
afterEach(() => {
  expect(resolve(fixture).startsWith(resolve(tmpdir()) + sep)).toBe(true);
  rmSync(fixture, { recursive: true, force: true });
});
function layout(root: string, packaged = false, marker = true) {
  const start = join(root, packaged ? 'app' : 'apps', 'server', 'dist');
  mkdirSync(start, { recursive: true });
  if (marker) writeFileSync(join(root, '启动.bat'), '@echo off');
  return start;
}

it.each([false, true])('incomplete nested source/package refuses a valid ancestor root (packaged=%s)', packaged => {
  layout(fixture);
  const inner = join(fixture, 'nested');
  const start = layout(inner, packaged, false);
  expect(() => findRoot(start)).toThrow(/安装不完整.*拒绝使用上级目录的数据/);
  expect(existsSync(join(fixture, 'data'))).toBe(false);
  expect(existsSync(join(inner, 'data'))).toBe(false);
});

it.each(['package', 'workspace'])('explicit %s boundary with no marker refuses an ancestor', kind => {
  layout(fixture);
  const inner = join(fixture, 'nested');
  const start = join(inner, 'standalone'); mkdirSync(start, { recursive: true });
  writeFileSync(join(inner, kind === 'package' ? 'package.json' : 'pnpm-workspace.yaml'),
    kind === 'package' ? JSON.stringify({ name: 'classrep' }) : 'packages: []');
  expect(() => findRoot(start)).toThrow(/安装不完整/);
});

it('complete nested source owns its root despite server package.json and an ancestor install', () => {
  layout(fixture);
  const inner = join(fixture, 'nested');
  const start = layout(inner);
  writeFileSync(join(inner, 'package.json'), JSON.stringify({ name: 'classrep' }));
  writeFileSync(join(inner, 'apps', 'server', 'package.json'), JSON.stringify({ name: 'server' }));
  expect(findRoot(start)).toBe(inner);
});

it('complete packaged layout needs no package.json and never uses the enclosing source install', () => {
  layout(fixture);
  const packed = join(fixture, 'release', 'ClassRep');
  const start = layout(packed, true);
  writeFileSync(join(packed, 'app', 'version.json'), JSON.stringify({ version: 'synthetic' }));
  expect(findRoot(start)).toBe(packed);
});

it('malformed root manifest cannot hide the missing marker when application layout remains', () => {
  layout(fixture);
  const inner = join(fixture, 'nested');
  const start = layout(inner, false, false);
  writeFileSync(join(inner, 'package.json'), '{');
  expect(() => findRoot(start)).toThrow(/安装不完整/);
});
