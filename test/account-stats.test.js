import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAccountStats } from '../server/accountStats.js';
import { StateStore } from '../server/redis.js';

function memoryStore(initial = {}) {
  const docs = new Map(Object.entries(initial));
  const ids = new Map();
  const publicIds = new Map();
  return {
    docs,
    ids,
    publicIds,
    async readAccountStats(key) { return { available: true, value: docs.get(key) || null }; },
    async writeAccountStats(key, value) { docs.set(key, structuredClone(value)); return true; },
    async readAllAccountStats() { return { available: true, value: [...docs.values()] }; },
    async claimAccountPublicId(key, code) {
      if (publicIds.has(key)) return publicIds.get(key);
      const owner = ids.get(code);
      if (owner) return false;
      ids.set(code, key);
      publicIds.set(key, code);
      return code;
    },
  };
}

const row = (id, extra = {}) => ({ id, v: 2, t: 1, end: 'settled', roomMode: 'coop', selfId: 'p1', players: [
  { playerId: 'p1', name: '本人', trophies: 5, stats: { leaks: 2 }, ...extra.self },
  { playerId: 'p2', name: '队友甲', lineup: [{ id: 'char_1' }], ...extra.peer },
], ...extra.record });

test('mergeRecords deduplicates ids and preserves full rows', async () => {
  const store = memoryStore();
  const service = createAccountStats({ store });
  const first = await service.mergeRecords('wgs-subject', [row('r1'), row('r2')]);
  const merged = await service.mergeRecords('wgs-subject', [
    { ...row('r1', { self: { name: '新昵称' } }), compact: true, players: [{ playerId: 'p1', name: '新昵称', trophies: 5, stats: { leaks: 2 } }] },
    row('r3'),
  ]);
  assert.equal(first.publicId, merged.publicId);
  assert.match(merged.publicId, /^SP-[0-9A-Z]{4}$/);
  assert.deepEqual(merged.records.map((record) => record.id).sort(), ['r1', 'r2', 'r3']);
  const full = merged.records.find((record) => record.id === 'r1');
  assert.equal(full.players.length, 2);
  assert.deepEqual(full.players[1].lineup, [{ id: 'char_1' }]);
  assert.equal(full.players[0].name, '本人');
  const [internalKey] = store.docs.keys();
  assert.match(internalKey, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(store.docs.get(internalKey)).includes('wgs-subject'), false);
});

test('updateRound ignores stale rounds', async () => {
  const service = createAccountStats({ store: memoryStore() });
  await service.updateRound('subject-a', { matchId: 'ABCD:1', round: 5, leaks: 7, name: '甲' });
  await service.updateRound('subject-a', { matchId: 'ABCD:1', round: 4, leaks: 9, name: '甲' });
  assert.deepEqual(await service.leaderboards(), { cups: [], leaks: [{ name: '甲', value: 7 }] });
});

test('client archive history cannot clear authoritative round progress', async () => {
  const service = createAccountStats({ store: memoryStore() });
  await service.mergeRecords('subject-a', []);
  await service.updateRound('subject-a', { matchId: 'ABCD:2', round: 3, leaks: 4, name: '甲' });
  await service.mergeRecords('subject-a', [row('r-final', { record: { matchId: 'ABCD:2' }, self: { stats: { leaks: 4 } } })]);
  assert.deepEqual((await service.leaderboards()).leaks, [{ name: '甲', value: 4 }]);
});

test('leaderboards count only the account own settled official rows', async () => {
  const service = createAccountStats({ store: memoryStore() });
  const settled = row('eligible', { self: { trophies: 5, stats: { leaks: 2 } }, peer: { trophies: 900, stats: { leaks: 900 } } });
  const solo = row('solo', { record: { roomMode: 'solo' }, self: { trophies: 900, stats: { leaks: 3 } } });
  const quit = row('quit', { record: { end: 'quit' }, self: { trophies: 100, stats: { leaks: 100 } } });
  const modded = row('modded', { record: { content: { cs: 'x' } }, self: { trophies: 100, stats: { leaks: 100 } } });
  const training = row('training', { record: { difficulty: 'TRAINING' }, self: { trophies: 100, stats: { leaks: 100 } } });
  const tested = row('tested', { record: { test: true }, self: { trophies: 100, stats: { leaks: 100 } } });
  await service.mergeRecords('subject-rank', [settled, solo, quit, modded, training, tested]);
  assert.deepEqual(await service.leaderboards(), {
    cups: [{ name: '本人', value: 5 }],
    leaks: [{ name: '本人', value: 5 }],
  });
});

test('archive edits after first binding cannot change leaderboard scores', async () => {
  const service = createAccountStats({ store: memoryStore() });
  const original = row('archive-1', { self: { trophies: 5, stats: { leaks: 2 } } });
  await service.mergeRecords('subject-frozen', [original]);
  await service.mergeRecords('subject-frozen', [
    row('archive-1', { record: { t: 2 }, self: { trophies: 500, stats: { leaks: 500 } } }),
    row('archive-forged', { record: { t: 3 }, self: { trophies: 700, stats: { leaks: 700 } } }),
  ]);
  assert.deepEqual(await service.leaderboards(), { cups: [{ name: '本人', value: 5 }], leaks: [{ name: '本人', value: 2 }] });
});

test('authoritative match completion replaces its round contribution exactly once', async () => {
  const service = createAccountStats({ store: memoryStore() });
  await service.mergeRecords('subject-authoritative', [row('legacy', { self: { trophies: 5, stats: { leaks: 2 } } })]);
  await service.updateRound('subject-authoritative', { matchId: 'ABCD:2', round: 4, leaks: 4, name: '本人' });
  await service.completeMatch('subject-authoritative', { matchId: 'ABCD:2', roomMode: 'coop', cups: 8, leaks: 4, name: '本人' });
  await service.updateRound('subject-authoritative', { matchId: 'ABCD:2', round: 5, leaks: 8, name: '本人' });
  await service.completeMatch('subject-authoritative', { matchId: 'ABCD:2', roomMode: 'coop', cups: 8, leaks: 4, name: '本人' });
  assert.deepEqual(await service.leaderboards(), { cups: [{ name: '本人', value: 13 }], leaks: [{ name: '本人', value: 6 }] });
});

test('legacy backfill excludes a match later registered authoritatively', async () => {
  const service = createAccountStats({ store: memoryStore() });
  await service.completeMatch('subject-prebind', { matchId: 'ABCD:pre', roomMode: 'coop', cups: 8, leaks: 4, name: '本人' });
  await service.mergeRecords('subject-prebind', [row('old-copy', {
    record: { matchId: 'ABCD:pre' }, self: { trophies: 5, stats: { leaks: 2 } },
  })]);
  assert.deepEqual(await service.leaderboards(), { cups: [{ name: '本人', value: 8 }], leaks: [{ name: '本人', value: 4 }] });
});

test('history compaction keeps old rows and their leaderboard totals', async () => {
  const service = createAccountStats({ store: memoryStore() });
  const records = Array.from({ length: 31 }, (_, i) => row(`bulk-${i}`, {
    record: { t: i + 1, padding: 'x'.repeat(26_000) }, self: { trophies: 1, stats: { leaks: 1 } },
  }));
  const merged = await service.mergeRecords('subject-compaction', records);
  assert.equal(merged.records.length, 31);
  assert.equal(merged.records.find((record) => record.id === 'bulk-0').compact, true);
  assert.deepEqual(await service.leaderboards(), { cups: [{ name: '本人', value: 31 }], leaks: [{ name: '本人', value: 31 }] });
});

test('a public ID collision gets a different stable unique code', async () => {
  const store = memoryStore();
  const service = createAccountStats({ store });
  const first = await service.getPublicId('subject-code-a');
  const keyA = createHash('sha256').update('subject-code-a').digest('hex');
  const keyB = createHash('sha256').update('subject-code-b').digest('hex');
  const claim = store.claimAccountPublicId.bind(store);
  let forced = false;
  store.claimAccountPublicId = async (key, code) => {
    if (key === keyB && !forced) { forced = true; store.ids.set(code, keyA); return false; }
    return claim(key, code);
  };
  const second = await service.getPublicId('subject-code-b');
  assert.notEqual(second, first);
  assert.equal(await service.getPublicId('subject-code-b'), second);
  assert.equal(store.ids.get(first.slice(3)), keyA);
  assert.equal(store.ids.get(second.slice(3)), keyB);
});

test('account documents use a separate Redis hash without expiry', async () => {
  const calls = [];
  const store = new StateStore({ url: 'redis://unused', prefix: 'test:', commandTimeoutMs: 0 });
  store.client = {
    isReady: true,
    async hGet(key, field) { calls.push(['get', key, field]); return null; },
    async hSet(...args) { calls.push(['set', ...args]); },
    async eval(script, options) { calls.push(['claim', script, options]); return options.arguments[1]; },
    async hGetAll(key) { calls.push(['all', key]); return {}; },
  };
  assert.deepEqual(await store.readAccountStats('subject-hash'), { available: true, value: null });
  assert.equal(await store.writeAccountStats('subject-hash', { records: [] }), true);
  assert.equal(await store.claimAccountPublicId('subject-hash', 'AB12'), 'AB12');
  assert.deepEqual(calls[0], ['get', 'test:account-stats', 'subject-hash']);
  assert.deepEqual(calls[1], ['set', 'test:account-stats', 'subject-hash', '{"records":[]}']);
  assert.equal(calls[2][0], 'claim');
  assert.deepEqual(calls[2][2], { keys: ['test:account-stats-ids', 'test:account-stats-subject-ids'], arguments: ['subject-hash', 'AB12'] });
  assert.match(calls[2][1], /HSET/);
  await store.close();
});
