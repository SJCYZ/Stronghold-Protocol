import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle } from '../helpers/battleHarness.js';
import { MAX_ALIVE_ENEMIES, fieldEnemyCap } from '../../server/sim/constants.js';
import { buildBattleSpec, compactResult, fitResult, RESULT_FRAME_BUDGET } from '../../server/sim/spec.js';
import { validateClientResult } from '../../server/match/fields.js';

const makePlayers = (count) => Array.from({ length: count }, (_, i) => ({ playerId: `p${i}`, units: [] }));

test('runtime living-enemy cap follows actual battle players, with 600 per field member', () => {
  assert.deepEqual([1, 2, 4, 20].map(fieldEnemyCap), [600, 1200, 2400, 12000]);
  for (const playerCount of [1, 2, 4]) {
    const h = makeBattle({ players: makePlayers(playerCount), content: 'none', autoFinish: false });
    h.step();
    const cap = MAX_ALIVE_ENEMIES * playerCount;
    for (let i = 0; i < cap; i++) assert.ok(h.b.spawnEnemy('enemy_1422_lrsldr', { pos: [10, 8] }));
    assert.equal(h.b.aliveEnemies().length, cap, `${playerCount} players`);
    assert.equal(h.b.spawnEnemy('enemy_1422_lrsldr', { pos: [10, 8] }), null, `${playerCount} player cap rejects next enemy`);
  }
});

test('scheduled spawn counts may fill a shared field cap but remain 600 in a solo field', () => {
  const enemies = [{ key: 'enemy_1422_lrsldr', count: 1200, pos: [10, 8] }];
  const shared = makeBattle({ players: makePlayers(2), enemies, content: 'none', autoFinish: false });
  shared.step();
  assert.equal(shared.b.aliveEnemies().length, 1200);
  const solo = makeBattle({ enemies, content: 'none', autoFinish: false });
  assert.equal(solo.b.total, 600);
});

test('compact battle results preserve all twenty actual players', () => {
  const perPlayer = Object.fromEntries(makePlayers(20).map(({ playerId }) => [playerId, { total: 0, killed: 0 }]));
  const compact = compactResult({ reason: 'cleared', perPlayer });
  assert.deepEqual(Object.keys(compact.perPlayer), Object.keys(perPlayer));
});

test('result validation accepts the 20-player field and rejects more than the protocol maximum', () => {
  const result = (count) => ({
    reason: 'cleared', time: 0,
    perPlayer: Object.fromEntries(makePlayers(count).map(({ playerId }) => [playerId, { killed: 0, total: 0, leaked: [], perfect: true, coins: 0 }])),
  });
  const valid = buildBattleSpec({ players: makePlayers(20), spawns: [] });
  assert.equal(validateClientResult(valid, result(20)).ok, true);
  const tooMany = buildBattleSpec({ players: makePlayers(21), spawns: [] });
  assert.equal(validateClientResult(tooMany, result(21)).reason, 'players');
  assert.equal(fieldEnemyCap(21), MAX_ALIVE_ENEMIES * 20);
});

test('large 20-player results remain bounded by the original frame budget', () => {
  const leaked = Array.from({ length: 401 }, () => ({ enemyKey: 'enemy_w', mods: { hpMul: 1.2 } }));
  const perPlayer = Object.fromEntries(makePlayers(20).map(({ playerId }) => [playerId, { total: 401, killed: 0, leaked, unitStats: Array(160).fill({ uid: 1, dmg: 1 }) }]));
  const compact = compactResult({ reason: 'timeout', perPlayer, unspawned: leaked.map(() => ({ enemyKey: 'enemy_w' })) });
  assert.equal(compact.perPlayer.p0.leaked.length, 400);
  assert.equal(compact.unspawned.length, 400);
  const fitted = fitResult(compact, { bossLike: true, battleId: 'large' });
  assert.ok(fitted && typeof fitted === 'object');
  assert.ok(new TextEncoder().encode(JSON.stringify({ t: 'b.result', battleId: 'large', result: fitted, rid: 2147483647 })).byteLength <= RESULT_FRAME_BUDGET);
});

test('oversized non-boss result with 20 × 400 Unicode leaks is refused instead of sent over budget', () => {
  const leaked = Array.from({ length: 400 }, () => ({ enemyKey: 'enemy_w', tag: '敌军🛡️', sourcePlayerId: 'p0' }));
  const perPlayer = Object.fromEntries(makePlayers(20).map(({ playerId }) => [playerId, {
    total: 400, killed: 0, leaked: leaked.map((item) => ({ ...item, sourcePlayerId: playerId })), perfect: false,
  }]));
  const compact = compactResult({ reason: 'timeout', time: 60, perPlayer });
  const fitted = fitResult(compact, { bossLike: false, battleId: 'field-Unicode-联防' });
  const wireBytes = fitted == null ? 0 : new TextEncoder().encode(JSON.stringify({
    t: 'b.result', battleId: 'field-Unicode-联防', result: fitted, rid: 2147483647,
  })).byteLength;
  assert.ok(fitted === null, `non-boss result must be refused rather than sent (${wireBytes} UTF-8 bytes)`);
  assert.ok(wireBytes === 0 || wireBytes <= RESULT_FRAME_BUDGET);
});
