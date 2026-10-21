import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { createStaticHandler } from '../../server/http/static.js';

test('server provides a verification manifest but does not serve deployment resource packages', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'sp-resource-import-only-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const publicDir = path.join(root, 'public');
  await mkdir(path.join(publicDir, 'assets', 'ui'), { recursive: true });
  await mkdir(path.join(publicDir, 'resource-packs'), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, 'assets.json'), JSON.stringify({ ui: { probe: '/assets/ui/probe.png' } }));
  await writeFile(path.join(dataDir, 'resource-packs.json'), JSON.stringify({
    format: 'stronghold-resource-pack-index', version: 1, maxBytes: 16000000,
    packs: [{ id: 'old', url: '/resource-packs/old.zip', size: 3, sha1: 'a'.repeat(40), tier: 1, files: [] }],
  }));
  await writeFile(path.join(publicDir, 'assets', 'ui', 'probe.png'), 'runtime asset');
  await writeFile(path.join(publicDir, 'resource-packs', 'old.zip'), 'zip');

  const handler = createStaticHandler({ publicDir, dataDir, sharedDir: path.resolve('shared'), clientBuild: false });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    void handler(req, res, url.pathname, url.search.slice(1));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;

  const manifestResponse = await fetch(origin + '/data/resource-manifest.json');
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();
  assert.ok(manifest.files.some((file) => file.url === '/assets/ui/probe.png'));
  assert.equal(Object.hasOwn(manifest, 'packs'), false, 'the checklist does not expose package download URLs');

  for (const endpoint of ['/data/resource-packs.json', '/resource-packs/old.zip']) {
    assert.equal((await fetch(origin + endpoint)).status, 404, endpoint);
  }
  const runtimeAsset = await fetch(origin + '/assets/ui/probe.png');
  assert.equal(runtimeAsset.status, 200, 'normal game asset requests remain available');
  assert.equal(await runtimeAsset.text(), 'runtime asset');
});