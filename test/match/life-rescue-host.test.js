import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Match } from '../../server/match/Match.js';
import { getData } from '../../server/data.js';
import { createPluginRegistry } from '../../server/plugins/registry.js';
import { createContentSets } from '../../server/plugins/contentSets.js';
import { createMatchHosts } from '../../server/match/host/index.js';
import { writePlugin } from '../helpers/pluginFixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const dirs = [];

function contentSet() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-life-rescue-host-'));
  dirs.push(tmp);
  const pluginsDir = path.join(tmp, 'plugins');
  writePlugin(path.join(pluginsDir, 'empty'), { manifest: 2, version: '1.0.0', app: '*', api: 1, class: 'content', scope: ['room'], permissions: [] }, {});
  const registry = createPluginRegistry({
    publicDir: path.join(ROOT, 'public'), dataDir: path.join(ROOT, 'data'), packsDir: path.join(tmp, 'packs'), pluginsDir,
  }, { log: quiet });
  registry.refresh(true);
  const contents = createContentSets({ registry, vanillaData: getData({ log: quiet }), log: quiet });
  const result = contents.resolve(['empty']);
  assert.ok(result.ok, JSON.stringify(result));
  contents.hold(result.set.cs);
  return { contents, set: result.set };
}

function opts(cs, frames) {
  const seats = [0, 1].map((seat) => ({ seat, playerId: `p_${seat}`, name: `P${seat}`, isBot: false, connected: true }));
  return {
    roomCode: 'TEST', mode: 'coop', difficulty: 'NORMAL', modeId: 'mode_multi_normal', seats, spectators: [],
    seed: 19, matchNo: 1, cs, requireCs: true,
    send: (id, msg) => { frames.sent.push([id, msg]); return true; },
    broadcast: (msg) => frames.broadcast.push(msg), onEnd() {},
  };
}

after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

test('hosted Match handles rescue intent with the same phase gate as direct Match', { timeout: 60_000 }, async () => {
  const { contents, set } = contentSet();
  const hosts = createMatchHosts({ contents, log: quiet, options: { virtualTime: true } });
  const hostedFrames = { sent: [], broadcast: [] };
  const directFrames = { sent: [], broadcast: [] };
  const hosted = hosts.create(set.cs, opts(set.cs, hostedFrames));
  const direct = new Match({ ...opts(set.cs, directFrames), data: set.data, log: quiet });
  try {
    hosted.start();
    direct.start();
    const hostedResult = await hosted.handle('p_0', { t: 'g.rescue', targetId: 'p_1' });
    const directResult = direct.handle('p_0', { t: 'g.rescue', targetId: 'p_1' });
    assert.deepEqual(hostedResult, directResult);
    assert.deepEqual(hostedResult, { error: 'WRONG_PHASE' });
  } finally {
    hosted.dispose();
    direct.dispose();
    hosts.close();
  }
});
