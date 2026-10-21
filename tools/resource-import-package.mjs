import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResourceIndex } from '../server/resources.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'artifacts');
const temp = await mkdtemp(path.join(os.tmpdir(), 'stronghold-resource-manifest-'));
try {
  const { manifest } = await createResourceIndex({ dataDir: path.join(root, 'data'), publicDir: path.join(root, 'public') }).get();
  const manifestPath = path.join(temp, 'resource-manifest.json');
  const outputPath = path.join(artifacts, `stronghold-resource-import-${manifest.version}.zip`);
  await mkdir(artifacts, { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest));
  const python = process.env.PYTHON || 'python';
  const result = spawnSync(python, [path.join(root, 'tools', 'resource_packs.py'), '--manifest', manifestPath,
    '--assets-root', path.join(root, 'public'), '--full-output', outputPath], { cwd: root, encoding: 'utf8', stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status || 1;
} finally {
  await rm(temp, { recursive: true, force: true });
}
