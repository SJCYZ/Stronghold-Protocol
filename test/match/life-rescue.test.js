import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from './harness.js';
import { PHASE } from '../../shared/constants.js';
import { matchState } from '../../server/match/snapshot.js';

test('pending eliminations are excluded from the live match roster', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, fake: true }).start();
  const [rescuer, target] = h.m.order;
  target.pendingElimination = true;
  assert.deepEqual(h.m.alivePlayers(), [rescuer]);
  h.m.dispose();
});

test('life-rescue flags default false and survive a safe snapshot', () => {
  const h = makeMatch({ mode: 'coop', humans: 1, fake: true }).start();
  const ps = h.ps('p_0');
  assert.equal(ps.pendingElimination, false);
  assert.equal(ps.lifeRescueUsed, false);
  ps.lifeRescueUsed = true;
  assert.equal(matchState(h.m).players[ps.playerId].lifeRescueUsed, true);
  h.m.dispose();
});

test('SETTLE waits for offered rescue window and rejects insufficient life atomically', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, fake: true }).start();
  const [rescuer, target] = h.m.order;
  h.m.phase = PHASE.SETTLE;
  h.m.lifeRescueCost = 2;
  h.m.lifeRescueDeadline = h.sched.now() + 20_000;
  rescuer.lp = 2;
  target.pendingElimination = true;
  const before = rescuer.lp;
  const result = h.m.handle(rescuer.playerId, { t: 'g.rescue', targetId: target.playerId });
  assert.ok(result?.error);
  assert.equal(rescuer.lp, before);
  h.m.dispose();
});

test('a confirmed rescue pays once, restores one LP and preserves the settled player state', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, fake: true }).start();
  const [rescuer, target] = h.m.order;
  h.m.phase = PHASE.SETTLE;
  h.m.rescueDeadline = h.sched.now() + 20_000;
  h.m.rescueOffers = new Map([[target.playerId, {
    pluginId: 'life-rescue', cost: 2,
    callback: ({ rescuerId, targetId }) => {
      const changeLife = (id, delta) => {
        if (id !== rescuerId || delta !== -2) return false;
        rescuer.lp += delta;
        rescuer.stats.lpLost += -delta;
        h.m._rescueResolution.paid = true;
        return true;
      };
      const revive = (id, lp) => {
        if (id !== targetId || lp !== 1) return false;
        target.pendingElimination = false;
        target.lifeRescueUsed = true;
        target.alive = true;
        target.lp = lp;
        return true;
      };
      assert.equal(changeLife(rescuerId, -2), true);
      assert.equal(revive(targetId, 1), true);
    },
  }]]);
  rescuer.lp = 3;
  target.lp = 0;
  target.pendingElimination = true;
  target.funds = 7;
  target.pendingFunds = 4;
  const board = target.board;
  assert.deepEqual(h.m.rescue(rescuer, target.playerId), { ok: true });
  assert.equal(rescuer.lp, 1);
  assert.equal(rescuer.stats.lpLost, 2);
  assert.equal(target.lp, 1);
  assert.equal(target.pendingElimination, false);
  assert.equal(target.lifeRescueUsed, true);
  assert.equal(target.board, board);
  assert.equal(target.funds, 7);
  assert.equal(target.pendingFunds, 4);
  assert.deepEqual(h.m.rescue(rescuer, target.playerId), { error: 'BAD_TARGET' });
  assert.equal(rescuer.lp, 1);
  h.m.dispose();
});

test('rescue window expiry eliminates pending targets before the normal survivor check', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, fake: true }).start();
  const [rescuer, target] = h.m.order;
  target.pendingElimination = true;
  target.lp = 0;
  let advanced = false;
  h.m.afterSettle = () => { advanced = true; };
  h.m.expireRescueWindow();
  assert.equal(target.alive, false);
  assert.equal(target.pendingElimination, false);
  assert.deepEqual(h.m.alivePlayers(), [rescuer]);
  assert.equal(advanced, true);
  h.m.dispose();
});
