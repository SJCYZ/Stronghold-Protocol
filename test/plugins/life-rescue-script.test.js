import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSDK } from '../../shared/plugins/sdk.js';
import { resetExtensions, runPostSettlement } from '../../server/sim/content/extensions.js';

const plugin = 'life-rescue';
const manifestPath = new URL('../../plugins/life-rescue/plugin.json', import.meta.url);
const sourcePath = new URL('../../plugins/life-rescue/sim/index.js', import.meta.url);
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
const source = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, 'utf8') : '';

test('life-rescue declares the bounded default life cost and required server-script permissions', () => {
  assert.ok(manifest, 'life-rescue plugin manifest must exist');
  assert.equal(manifest.class, 'script');
  assert.deepEqual(manifest.permissions, ['sim.code', 'match.life']);
  assert.deepEqual(
    (({ type, min, max, default: defaultValue }) => ({ type, min, max, default: defaultValue }))(manifest.settings.lifeCost),
    { type: 'integer', min: 1, max: 100, default: 10 },
  );
});

test('life-rescue opens a fixed rescue window only for a pending target and eligible human donor', async () => {
  assert.ok(source, 'life-rescue script entry must exist');
  resetExtensions();
  const setup = (await import(`data:text/javascript,${encodeURIComponent(source)}`)).default;
  setup(createSDK({ id: plugin, permissions: manifest.permissions }, { settings: { lifeCost: 10 } }));
  const players = [
    { playerId: 'bot', isBot: true, alive: true, lp: 50, pendingElimination: false },
    { playerId: 'poor', isBot: false, alive: true, lp: 10, pendingElimination: false },
    { playerId: 'target', isBot: false, alive: false, lp: 0, pendingElimination: true },
  ];
  const windows = [];
  const offerRescue = (_pluginId, spec, onRescue) => windows.push({ spec, onRescue });
  runPostSettlement({ players, changeLife() {}, revive() {}, offerRescue });
  assert.equal(windows.length, 0);

  players.push({ playerId: 'donor', isBot: false, alive: true, lp: 11, pendingElimination: false });
  runPostSettlement({ players, changeLife() {}, revive() {}, offerRescue });
  assert.equal(windows.length, 1);
  assert.deepEqual(windows[0].spec, { cost: 10, durationMs: 20_000, targetIds: ['target'] });
});

test('life-rescue confirms payment before reviving one target to one LP', async () => {
  assert.ok(source, 'life-rescue script entry must exist');
  resetExtensions();
  const setup = (await import(`data:text/javascript,${encodeURIComponent(source)}`)).default;
  setup(createSDK({ id: plugin, permissions: manifest.permissions }, { settings: { lifeCost: 7 } }));
  let callback;
  runPostSettlement({
    players: [
      { playerId: 'target', isBot: false, alive: false, lp: 0, pendingElimination: true },
      { playerId: 'donor', isBot: false, alive: true, lp: 8, pendingElimination: false },
    ],
    changeLife: (...args) => calls.push(['changeLife', ...args]),
    revive: (...args) => calls.push(['revive', ...args]),
    offerRescue: (_pluginId, _spec, handler) => { callback = handler; },
  });
  const calls = [];
  callback({ rescuerId: 'donor', targetId: 'target', changeLife: (...args) => calls.push(['changeLife', ...args]), revive: (...args) => calls.push(['revive', ...args]) });
  assert.deepEqual(calls, [['changeLife', 'donor', -7], ['revive', 'target', 1]]);
});
