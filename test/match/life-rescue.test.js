import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from './harness.js';
import { PHASE } from '../../shared/constants.js';
import { matchState } from '../../server/match/snapshot.js';
import { createSDK } from '../../shared/plugins/sdk.js';
import { resetExtensions } from '../../server/sim/content/extensions.js';

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

test('real settle registers SDK offers, opens a 20 second window and serializes same-target rescue intents', () => {
  resetExtensions();
  const sp = createSDK({ id: 'life-rescue', permissions: ['match.life'] });
  sp.match.life.onPostSettlement(({ players, offerRescue }) => {
    const targets = players.filter((p) => p.pendingElimination).map((p) => p.playerId);
    if (targets.length) offerRescue({ cost: 2, durationMs: 20_000, targetIds: targets }, ({ rescuerId, targetId, changeLife, revive }) => {
      if (changeLife(rescuerId, -2)) revive(targetId, 1);
    });
  });
  const h = makeMatch({ mode: 'coop', humans: 3, fake: true }).start();
  const [first, second, target] = h.m.order;
  first.lp = 5;
  second.lp = 4;
  target.lp = 1;
  h.m.lastResults = new Map(h.m.order.map((ps) => [ps.playerId, {
    leaked: ps === target ? [{ counted: true }] : [], perfect: true, coins: 0,
  }]));
  h.m.settle(null, null);
  assert.equal(h.m.phase, PHASE.SETTLE);
  assert.equal(h.m.deadline - h.sched.now(), 20_000);
  assert.deepEqual(h.m.publicView().rescue.targets, [{ playerId: target.playerId, cost: 2 }]);
  const firstResult = h.m.handle(first.playerId, { t: 'g.rescue', targetId: target.playerId });
  const secondResult = h.m.handle(second.playerId, { t: 'g.rescue', targetId: target.playerId });
  assert.deepEqual(firstResult, { ok: true });
  assert.deepEqual(secondResult, { error: 'BAD_TARGET' });
  assert.equal(first.lp, 3);
  assert.equal(second.lp, 4);
  assert.equal(target.lp, 1);
  assert.equal(target.lifeRescueUsed, true);
  h.m.dispose();
  resetExtensions();
});

test('real settle with no qualifying human rescuer uses the original three second cleanup', () => {
  resetExtensions();
  const sp = createSDK({ id: 'life-rescue', permissions: ['match.life'] });
  sp.match.life.onPostSettlement(({ players, offerRescue }) => {
    const targets = players.filter((p) => p.pendingElimination).map((p) => p.playerId);
    if (targets.length) offerRescue({ cost: 2, durationMs: 20_000, targetIds: targets }, () => {});
  });
  const h = makeMatch({ mode: 'coop', humans: 2, fake: true }).start();
  for (const ps of h.m.order) ps.lp = 1;
  h.m.lastResults = new Map(h.m.order.map((ps) => [ps.playerId, {
    leaked: [{ counted: true }], perfect: false, coins: 0,
  }]));
  h.m.settle(null, null);
  assert.equal(h.m.rescueTargets, undefined);
  assert.equal(h.m.deadline - h.sched.now(), 3_000);
  assert.ok(h.m.order.every((ps) => !ps.alive && !ps.pendingElimination));
  h.m.dispose();
  resetExtensions();
});


test('a plugin cannot shorten the approved 20 second rescue window', () => {
  resetExtensions();
  const sp = createSDK({ id: 'life-rescue', permissions: ['match.life'] });
  sp.match.life.onPostSettlement(({ players, offerRescue }) => {
    const targetIds = players.filter((p) => p.pendingElimination).map((p) => p.playerId);
    if (targetIds.length) offerRescue({ cost: 2, durationMs: 1_000, targetIds }, () => {});
  });
  const h = makeMatch({ mode: 'coop', humans: 2, fake: true }).start();
  h.m.order[0].lp = 5;
  h.m.order[1].lp = 1;
  h.m.lastResults = new Map(h.m.order.map((ps, index) => [ps.playerId, {
    leaked: index === 1 ? [{ counted: true }] : [], perfect: index !== 1, coins: 0,
  }]));
  h.m.settle(null, null);
  assert.equal(h.m.rescueTargets, undefined);
  assert.equal(h.m.deadline - h.sched.now(), 3_000);
  h.m.dispose();
  resetExtensions();
});
