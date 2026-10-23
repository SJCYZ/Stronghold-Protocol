import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
};

const { STATS_VERSION, loadStats, saveStats } = await import('../../public/js/ui/stats.js');
const { syncCloudStats } = await import('../../public/js/ui/cloudStats.js');

const record = (id, extra = {}) => ({ id, v: 2, t: 100, end: 'settled', modeId: 'mode_multi_hard',
  players: [{ playerId: 'me', name: '博士', lineup: [{ id: 'char_1' }], stats: { kills: 4 } },
    { playerId: 'mate', name: '队友', lineup: [{ id: 'char_2' }], stats: { kills: 2 } }], ...extra });
const setStats = (records, v = STATS_VERSION) => saveStats({ v, records });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, json: async () => body });

describe('cloud match history sync', () => {
  test('guest sync skips fetch', async () => {
    let requests = 0;
    const result = await syncCloudStats({ authType: 'guest', token: 'guest-ticket', stats: { v: STATS_VERSION, records: [] },
      fetchFn: async () => { requests++; } });
    assert.equal(requests, 0);
    assert.equal(result.synced, false);
  });

  test('first SSO sync uploads unbound full local records', async () => {
    memory.clear();
    const local = record('local-1');
    setStats([local]);
    let sent;
    const result = await syncCloudStats({ authType: 'account', token: 'session', stats: loadStats(), fetchFn: async (url, init) => {
      assert.equal(url, '/api/player-stats');
      sent = JSON.parse(init.body);
      return response({ publicId: 'SP-1234', v: STATS_VERSION, records: [local] });
    } });
    assert.equal(sent.records[0].id, 'local-1');
    assert.equal(sent.records[0].players[1].name, '队友');
    assert.equal(result.publicId, 'SP-1234');
    assert.equal(result.synced, true);
  });

  test('sync merges by id, keeping one complete record', async () => {
    memory.clear();
    const local = record('same', { t: 200 });
    const cloud = record('same', { t: 100 });
    setStats([local]);
    const result = await syncCloudStats({ authType: 'account', token: 'session', stats: loadStats(), fetchFn: async () =>
      response({ publicId: 'SP-1234', v: STATS_VERSION, records: [cloud] }) });
    assert.equal(result.stats.records.filter((item) => item.id === 'same').length, 1);
    assert.equal(result.stats.records[0].players[1].name, '队友');
    assert.equal(result.stats.records[0].t, 200);
  });

  test('cleared local history restores from cloud on next sync', async () => {
    memory.clear();
    const cloudRecord = record('cloud-only');
    setStats([]);
    const result = await syncCloudStats({ authType: 'account', token: 'session', stats: loadStats(), fetchFn: async () =>
      response({ publicId: 'SP-1234', v: STATS_VERSION, records: [cloudRecord] }) });
    assert.deepEqual(loadStats().records.map((item) => item.id), ['cloud-only']);
    assert.equal(result.synced, true);
  });

  test('future-version response does not overwrite local envelope', async () => {
    memory.clear();
    const local = record('local');
    setStats([local]);
    const before = localStorage.getItem('sp.pref.stats');
    const result = await syncCloudStats({ authType: 'account', token: 'session', stats: loadStats(), fetchFn: async () =>
      response({ publicId: 'SP-1234', v: STATS_VERSION + 1, records: [record('future')] }) });
    assert.equal(localStorage.getItem('sp.pref.stats'), before);
    assert.equal(result.stats.records[0].id, 'local');
    assert.equal(result.synced, false);
    assert.equal(result.publicId, 'SP-1234');
  });

  test('future-version local envelope skips network and stays intact', async () => {
    memory.clear();
    const future = { v: STATS_VERSION + 1, records: [record('future-local')], custom: 'preserve' };
    localStorage.setItem('sp.pref.stats', JSON.stringify(future));
    let requests = 0;
    const result = await syncCloudStats({ authType: 'account', token: 'session', stats: loadStats(), fetchFn: async () => {
      requests++;
      return response({ publicId: 'SP-1234', v: STATS_VERSION, records: [] });
    } });
    assert.equal(requests, 0);
    assert.deepEqual(JSON.parse(localStorage.getItem('sp.pref.stats')), future);
    assert.equal(result.synced, false);
  });

  test('API failure is reported as not synced', async () => {
    const result = await syncCloudStats({ authType: 'account', token: 'session', stats: { v: STATS_VERSION, records: [] }, fetchFn: async () => response({}, 503) });
    assert.equal(result.synced, false);
  });
});
