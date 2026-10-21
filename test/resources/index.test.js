import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CACHE_NAME, MANIFEST_URL, SW_URL, cacheName } from '../../public/js/resources/common.js';
import { ResourceStore } from '../../public/js/resources/store.js';
import { exportResourceZip } from '../../public/js/resources/archive.js';

class MemoryCache {
  entries = new Map();
  async put(request, response) { this.entries.set(typeof request === 'string' ? request : request.url, response.clone()); }
  async match(request) { return this.entries.get(typeof request === 'string' ? request : request.url)?.clone(); }
  async keys() { return [...this.entries.keys()].map((url) => new Request(url)); }
  async delete(request) { return this.entries.delete(typeof request === 'string' ? request : request.url); }
}
class MemoryCaches {
  entries = new Map();
  async open(name) { if (!this.entries.has(name)) this.entries.set(name, new MemoryCache()); return this.entries.get(name); }
  async keys() { return [...this.entries.keys()]; }
  async delete(name) { return this.entries.delete(name); }
}

const ORIGIN = 'https://game.example';
const FILES = [
  { url: '/assets/local/map/act1/scene.bin', tier: 1, size: 6 },
  { url: '/assets/char/operator/portrait.png', tier: 1, size: 4 },
  { url: '/assets/audio/voice/jp/op/line.mp3', tier: 2, size: 5 },
  { url: '/assets/local/fx/index.json', tier: 2, size: 7 },
].map((file) => ({ ...file, hash: createHash('sha1').update('b'.repeat(file.size)).digest('hex').slice(0, 12) }));
const MANIFEST = { format: 1, version: 'testversion', count: FILES.length, tier1: 2, sized: FILES.length,
  totalBytes: 22, files: FILES };

function stubEnv({ manifest = MANIFEST, failCount = 0, secure = true } = {}) {
  const calls = { fetch: [], registered: [] };
  const saved = Object.fromEntries(['fetch', 'caches', 'navigator', 'isSecureContext', 'location']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const restore = () => {
    for (const key of Object.keys(saved)) {
      if (saved[key]) Object.defineProperty(globalThis, key, saved[key]);
      else delete globalThis[key];
    }
  };
  const caches = new MemoryCaches();
  Object.defineProperty(globalThis, 'isSecureContext', { value: secure, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'location', { value: { origin: ORIGIN }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'caches', { value: caches, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'navigator', { value: {
    serviceWorker: { async register(url, opts) { calls.registered.push([url, opts]); return { scope: '/' }; } },
  }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'fetch', { value: async (url) => {
    calls.fetch.push(url);
    if (url === MANIFEST_URL) {
      if (failCount-- > 0) return new Response('unavailable', { status: 503 });
      return Response.json(manifest);
    }
    return new Response('unexpected request: ' + url, { status: 404 });
  }, configurable: true, writable: true });
  return { calls, caches, restore };
}

test('resource check fetches the manifest only and never fills missing files or transport packs', async (t) => {
  const manifest = { ...MANIFEST, packs: [{ url: '/resource-packs/full.zip' }] };
  const env = stubEnv({ manifest }); t.after(env.restore);
  const mod = await import('../../public/js/resources/index.js?manifest-only-check');

  await mod.syncResources(true);
  await mod.startResources();
  assert.deepEqual(env.calls.fetch, [MANIFEST_URL]);
  assert.equal(mod.resourceState().phase, 'incomplete');
  assert.equal(mod.resourceState().done, 0);
  assert.match(mod.resourceState().message, /导入资源包/);
  await mod.syncResources(false);
});

test('a failed manifest request is retried by the next explicit check', async (t) => {
  const env = stubEnv({ failCount: 1 }); t.after(env.restore);
  const mod = await import('../../public/js/resources/index.js?retry-manifest');
  await mod.syncResources(true);
  assert.equal(mod.resourceState().phase, 'error');
  assert.deepEqual(env.calls.fetch, [MANIFEST_URL]);
  await mod.startResources();
  assert.equal(mod.resourceState().phase, 'incomplete');
  assert.deepEqual(env.calls.fetch, [MANIFEST_URL, MANIFEST_URL]);
  await mod.syncResources(false);
});

test('partial ZIP import validates and stores matching files without enabling checks or filling gaps', async (t) => {
  const source = new ResourceStore({ ...MANIFEST, files: FILES.slice(0, 1) }, {
    caches: new MemoryCaches(), origin: ORIGIN, fetcher: async () => new Response('b'.repeat(FILES[0].size)),
  });
  await source.download();
  const { blob } = await exportResourceZip(source);
  const env = stubEnv(); t.after(env.restore);
  const mod = await import('../../public/js/resources/index.js?manual-import-only');
  let settingChanged = false;

  const result = await mod.importResources(blob, { onImported: () => { settingChanged = true; } });

  assert.equal(result.imported, 1);
  assert.equal(settingChanged, false);
  assert.equal(mod.resourceState().enabled, false);
  assert.equal(mod.resourceState().done, 1);
  assert.equal(mod.resourceState().phase, 'incomplete');
  assert.match(mod.resourceState().message, /继续导入/);
  assert.deepEqual(env.calls.fetch, [MANIFEST_URL], 'import reads the manifest but requests no resource URLs');
});

test('complete ZIP import marks every current manifest resource verified', async (t) => {
  const source = new ResourceStore(MANIFEST, {
    caches: new MemoryCaches(), origin: ORIGIN, fetcher: async (url) => {
      const file = FILES.find((entry) => url.endsWith(entry.url));
      return new Response('b'.repeat(file.size));
    },
  });
  await source.download();
  const { blob } = await exportResourceZip(source);
  const env = stubEnv(); t.after(env.restore);
  const mod = await import('../../public/js/resources/index.js?complete-import');

  const outcome = await mod.importResources(blob);
  assert.equal(outcome.imported, FILES.length);
  assert.equal(mod.resourceState().complete, true);
  assert.equal(mod.resourceState().phase, 'ready');
  assert.deepEqual(env.calls.fetch, [MANIFEST_URL]);
});

test('opening the manager checks cache state while disabled without fetching asset files', async (t) => {
  const env = stubEnv(); t.after(env.restore);
  const mod = await import('../../public/js/resources/index.js?inspect-manifest');
  await mod.inspectResources();
  assert.equal(mod.resourceState().phase, 'incomplete');
  assert.equal(mod.resourceState().selectedMissing, FILES.length);
  assert.deepEqual(env.calls.fetch, [MANIFEST_URL]);
});

test('the worker entry intercepts only runtime resource requests', async (t) => {
  const saved = ['self', 'caches'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const handlers = {};
  const caches = new MemoryCaches();
  const asset = ORIGIN + '/assets/e2e/a.png';
  await (await caches.open(cacheName('sw'))).put(asset, new Response('cached-bytes'));
  Object.defineProperty(globalThis, 'self', { value: { addEventListener: (name, fn) => { handlers[name] = fn; } }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'caches', { value: caches, configurable: true, writable: true });
  t.after(() => { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  await import('../../public/resource-sw.js?manifest-only');
  assert.deepEqual(Object.keys(handlers).sort(), ['activate', 'fetch', 'install']);

  const answered = [];
  const fire = (url, method = 'GET') => {
    let promise = null;
    handlers.fetch({ request: new Request(url, { method }), respondWith: (value) => { promise = value; answered.push(url); } });
    return promise;
  };
  assert.equal(await fire(asset).then((response) => response.text()), 'cached-bytes');
  assert.equal(fire(ORIGIN + '/js/main.js'), null, 'code passes through');
  assert.equal(fire(ORIGIN + '/data/assets.json'), null, 'game data passes through');
  assert.equal(fire(ORIGIN + '/assets/e2e/a.png', 'POST'), null, 'only GET is handled');
  assert.deepEqual(answered, [asset]);
});

test('the worker caches successful visual loads on demand and uses network-first audio', async () => {
  const saved = ['self', 'caches', 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const handlers = {};
  const caches = new MemoryCaches();
  const calls = [];
  Object.defineProperty(globalThis, 'self', { value: { addEventListener: (name, fn) => { handlers[name] = fn; } }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'caches', { value: caches, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'fetch', { value: async (request) => {
    calls.push(request.url);
    return new Response(request.url.endsWith('.mp3') ? 'network-audio' : 'network-image', {
      status: 200, headers: { 'Content-Type': request.url.endsWith('.mp3') ? 'audio/mpeg' : 'image/png' },
    });
  }, configurable: true, writable: true });
  try {
    await import('../../public/resource-sw.js?runtime-cache');
    const fire = (url) => {
      let promise;
      const waits = [];
      handlers.fetch({ request: new Request(url), respondWith: (value) => { promise = value; }, waitUntil: (value) => waits.push(value) });
      return Promise.all([promise, ...waits]).then(([response]) => response);
    };
    const image = ORIGIN + '/assets/runtime/image.png';
    assert.equal(await (await fire(image)).text(), 'network-image');
    assert.equal(await (await (await caches.open(CACHE_NAME)).match(image)).text(), 'network-image');
    calls.length = 0;
    assert.equal(await (await fire(image)).text(), 'network-image');
    assert.deepEqual(calls, []);
    const audio = ORIGIN + '/assets/audio/runtime.mp3';
    assert.equal(await (await fire(audio)).text(), 'network-audio');
    assert.equal(calls.at(-1), audio);
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});
