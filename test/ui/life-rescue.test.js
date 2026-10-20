import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASE } from '../../shared/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const { rescueTargets } = await import('../../public/js/ui/gameLogic/phases.js');

describe('life rescue UI', () => {
  const pub = {
    phase: PHASE.SETTLE, deadline: 12_000, serverNow: 2_000,
    rescue: { cost: 4, targets: [{ playerId: 'target', cost: 4 }] },
  };
  const players = [
    { playerId: 'target', name: 'Target', alive: false, pendingElimination: true, lp: 0 },
    { playerId: 'rescuer', name: 'Rescuer', alive: true, lp: 6 },
  ];

  test('shows only pending targets during a live SETTLE rescue window', () => {
    assert.deepEqual(rescueTargets(pub, players, 'rescuer', 6, 3_000), [
      { playerId: 'target', name: 'Target', cost: 4, rescued: false, eligible: true, remain: 9 },
    ]);
    assert.deepEqual(rescueTargets({ ...pub, phase: PHASE.PREP }, players, 'rescuer', 6, 3_000), []);
    assert.deepEqual(rescueTargets({ ...pub, deadline: 3_000 }, players, 'rescuer', 6, 3_000), []);
    assert.deepEqual(rescueTargets({ ...pub, rescue: undefined }, players, 'rescuer', 6, 3_000), []);
  });

  test('updates rescued state and disables targets when donor eligibility changes', () => {
    const rescued = [{ ...players[0], alive: true, pendingElimination: false, lp: 1 }];
    assert.equal(rescueTargets(pub, rescued, 'rescuer', 6, 3_000)[0].rescued, true);
    assert.equal(rescueTargets(pub, players, 'rescuer', 4, 3_000)[0].eligible, false, 'donor must retain one LP');
    assert.equal(rescueTargets(pub, players, 'target', 10, 3_000)[0].eligible, false, 'target cannot rescue itself');
  });

  test('re-exports rescueTargets through the gameLogic barrel used by GameScreen', async () => {
    const gameLogic = await import('../../public/js/ui/gameLogic.js');
    assert.equal(gameLogic.rescueTargets, rescueTargets);
  });

  test('client rescue intent carries only targetId and failures use existing action errors', () => {
    const source = read('public/js/screens/game.js');
    assert.match(source, /act\('g\.rescue',\s*\{\s*targetId:\s*target\.playerId\s*\}\)/);
    assert.doesNotMatch(source, /g\.rescue['"],\s*\{[^}]*\b(?:cost|rescuerId|playerId)\s*:/s);
    assert.match(source, /await onRescue\(target\)/, 'the existing act() path reports rejection and success has no local confirmation');
    assert.match(source, /class="life-rescue"/);
  });

  test('all public locale packs include the rescue labels', () => {
    for (const lang of ['en', 'ja', 'ko', 'zh-TW']) {
      const pack = JSON.parse(read(`public/i18n/${lang}.json`));
      for (const key of ['救援目标', '剩余 {seconds} 秒', '救援代价：{cost} 点生命值', '已救援', '救援']) {
        assert.ok(pack[key], `${lang} is missing ${key}`);
      }
    }
  });
});
