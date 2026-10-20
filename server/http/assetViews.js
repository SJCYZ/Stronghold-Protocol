// server/http/assetViews.js — merge optional Forge operator art into the served data/assets.json view.

import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { noopLog } from './config.js';
import { mergeLocalChars } from '../plugins/artReferences.js';
export { mergeLocalChars } from '../plugins/artReferences.js';

const VIEW_MANIFESTS = new Set(['assets.json', 'local-assets.json', 'local-fx.json']);
const hash16 = (body) => createHash('sha256').update(body).digest('hex').slice(0, 16);
const identity = (s) => `${s.size}|${s.mtimeMs}|${s.ctimeMs}|${s.ino}`;

/** A merged served manifest view. Ordinary art URLs stay plain; only plugin files use content-hash URLs. */
export function createManifestViews({ dataDir, log = noopLog }) {
  const dir = path.resolve(dataDir);
  const cache = new Map();
  const pending = new Map();
  const warned = new Set();

  async function build(name) {
    if (name !== 'assets.json') return null;
    const file = path.join(dir, name);
    const localFile = path.join(dir, 'local-assets.json');
    const [st, localStat] = await Promise.all([
      fsp.stat(file).catch(() => null),
      fsp.stat(localFile).catch(() => null),
    ]);
    if (!st?.isFile() || !localStat?.isFile()) return null;
    const key = `${identity(st)}|${identity(localStat)}`;
    const hit = cache.get(name);
    if (hit?.key === key) return hit.view;

    let doc;
    let local;
    try {
      [doc, local] = await Promise.all([
        fsp.readFile(file, 'utf8').then(JSON.parse),
        fsp.readFile(localFile, 'utf8').then(JSON.parse),
      ]);
    } catch (e) {
      if (!warned.has(name)) { warned.add(name); log.warn?.(`[assets] data/${name} or data/local-assets.json unreadable (${e?.message || e}); served as it is`); }
      cache.set(name, { key, view: null });
      return null;
    }

    const merged = mergeLocalChars(doc, local);
    if (merged === doc) {
      cache.set(name, { key, view: null });
      return null;
    }
    const body = Buffer.from(JSON.stringify(merged));
    const view = { body, hash: hash16(body) };
    cache.set(name, { key, view });
    return view;
  }

  function get(name) {
    if (!VIEW_MANIFESTS.has(name)) return Promise.resolve(null);
    const running = pending.get(name);
    if (running) return running;
    const task = build(name).catch((e) => {
      log.error?.('[assets] manifest view failed', e);
      return null;
    }).finally(() => pending.delete(name));
    pending.set(name, task);
    return task;
  }

  return { get };
}
