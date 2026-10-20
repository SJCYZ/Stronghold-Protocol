import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPluginManifest, PERMISSIONS } from '../../shared/plugins/manifest.js';
import { createSDK } from '../../shared/plugins/sdk.js';
import * as extensions from '../../server/sim/content/extensions.js';
const { resetExtensions } = extensions;

const manifest = (permissions, cls = 'script', entry = { sim: 'sim.js' }) => readPluginManifest({
  manifest: 2, id: 'life-rescue', name: 'Life rescue', version: '1.0.0', app: '*', api: 1,
  class: cls, scope: ['room'], permissions: [...new Set([...permissions, 'sim.code'])], entry,
}, { id: 'life-rescue', app: '0.3.0' });

test('match.life is only declared by script and trusted manifests', () => {
  assert.deepEqual(PERMISSIONS['match.life'], ['script', 'trusted']);
  assert.deepEqual(manifest(['match.life']).problems, []);
  assert.deepEqual(manifest(['match.life'], 'trusted').problems, []);
  assert.ok(manifest(['match.life'], 'content').problems.some(x => x.includes('not one a content plugin may have')));
  assert.ok(manifest(['match.life', 'unknown.permission']).problems.some(x => x.includes('unknown permission')));
});

test('clock.speed is a runtime permission for script and trusted entries', () => {
  assert.deepEqual(PERMISSIONS['clock.speed'], ['script', 'trusted']);
  assert.deepEqual(manifest(['clock.speed']).problems, []);
  assert.deepEqual(manifest(['clock.speed']).warnings, []);
  assert.deepEqual(manifest(['clock.speed'], 'trusted').warnings, []);
  assert.ok(manifest(['clock.speed'], 'script', {}).warnings.some(x => x.includes('"clock.speed" is declared but nothing in the manifest uses it')));
});

test('life callback registration requires match.life permission', () => {
  const sp = createSDK({ id: 'life-rescue', permissions: [] });
  assert.throws(() => sp.match.life.onPostSettlement(() => {}), { code: 'PLUGIN_PERMISSION_MISSING' });
});

test('server post-settlement receives immutable player copies and scoped rescue operations', () => {
  resetExtensions();
  const sp = createSDK({ id: 'life-rescue', permissions: ['match.life'] });
  let callbackCalls = 0;
  let rescue;
  const changed = [];
  const revived = [];
  sp.match.life.onPostSettlement(({ players, changeLife, revive, offerRescue }) => {
    callbackCalls++;
    assert.deepEqual(players[0], {
      playerId: 'p1', isBot: false, alive: true, lp: 2,
      pendingElimination: false, lifeRescueUsed: false,
    });
    assert.ok(Object.isFrozen(players) && Object.isFrozen(players[0]));
    assert.equal(players[0].state, undefined);
    assert.throws(() => { players[0].lp = 99; }, TypeError);
    changeLife('p1', -1);
    offerRescue({ cost: 2, durationMs: 1000, targetIds: ['p2'] }, ({ rescuerId, targetId }) => {
      rescue = { rescuerId, targetId }; changeLife(rescuerId, -1); revive(targetId, 1);
    });
    assert.equal(typeof revive, 'function');
  });
  const sourcePlayers = [{ playerId: 'p1', isBot: false, alive: true, lp: 2, pendingElimination: false, lifeRescueUsed: false, state: { secret: true } }];
  extensions.runPostSettlement({
    players: sourcePlayers,
    changeLife: (...args) => changed.push(args),
    revive: (...args) => revived.push(args),
    offerRescue: (_pluginId, spec, handler) => {
      assert.deepEqual(spec, { cost: 2, durationMs: 1000, targetIds: ['p2'] });
      handler({ rescuerId: 'p1', targetId: 'p2' });
    },
  });
  assert.equal(callbackCalls, 1);
  assert.deepEqual(changed, [['p1', -1], ['p1', -1]]);
  assert.deepEqual(revived, [['p2', 1]]);
  assert.deepEqual(rescue, { rescuerId: 'p1', targetId: 'p2' });
  resetExtensions();
});

test('life write closures expire after post-settlement and rescue callbacks return', () => {
  resetExtensions();
  const sp = createSDK({ id: 'life-rescue', permissions: ['match.life'] });
  let lateChangeLife;
  let lateRevive;
  let lateOfferRescue;
  let rescueHandler;
  let retainedRescueOps;
  let registrationCount = 0;
  const changed = [];
  const revived = [];
  sp.match.life.onPostSettlement(({ changeLife, revive, offerRescue }) => {
    lateChangeLife = changeLife;
    lateRevive = revive;
    lateOfferRescue = offerRescue;
    offerRescue({ cost: 2, durationMs: 20_000, targetIds: ['p2'] }, ops => {
      retainedRescueOps = ops;
      assert.equal(ops.changeLife(ops.rescuerId, -2), true);
      assert.equal(ops.revive(ops.targetId, 1), true);
    });
  });

  extensions.runPostSettlement({
    players: [],
    changeLife: (...args) => { changed.push(args); return true; },
    revive: (...args) => { revived.push(args); return true; },
    offerRescue: (_pluginId, _spec, handler) => { registrationCount++; rescueHandler = handler; return true; },
  });
  assert.equal(lateChangeLife('p1', -1), false);
  assert.equal(lateRevive('p2', 1), false);
  assert.equal(lateOfferRescue({ cost: 2, durationMs: 20_000, targetIds: ['p2'] }, () => {}), false);
  assert.equal(registrationCount, 1);
  assert.deepEqual(changed, []);
  assert.deepEqual(revived, []);

  rescueHandler({ rescuerId: 'p1', targetId: 'p2' });
  assert.deepEqual(changed, [['p1', -2]]);
  assert.deepEqual(revived, [['p2', 1]]);
  assert.equal(retainedRescueOps.changeLife('p1', -2), false);
  assert.equal(retainedRescueOps.revive('p2', 1), false);
  assert.deepEqual(changed, [['p1', -2]]);
  assert.deepEqual(revived, [['p2', 1]]);
  resetExtensions();
});

test('client-side SDK registration does not run lifecycle callbacks or provide write context', () => {
  resetExtensions();
  const sp = createSDK({ id: 'client', permissions: ['match.life'] });
  let called = false;
  sp.match.life.onPostSettlement(context => { called = true; assert.ok(context.changeLife); });
  assert.equal(called, false);
  assert.deepEqual(Object.keys(sp.match.life), ['onPostSettlement']);
  resetExtensions();
});

test('one post-settlement plugin error does not block later plugins and is returned with its owner', () => {
  resetExtensions();
  let laterCalled = false;
  const first = createSDK({ id: 'first', permissions: ['match.life'] });
  const second = createSDK({ id: 'second', permissions: ['match.life'] });
  const failure = new Error('plugin failure');
  first.match.life.onPostSettlement(() => { throw failure; });
  second.match.life.onPostSettlement(() => { laterCalled = true; });
  const errors = extensions.runPostSettlement({
    players: [], changeLife() {}, revive() {}, offerRescue() {},
  });
  assert.equal(laterCalled, true);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].pluginId, 'first');
  assert.equal(errors[0].error, failure);
  resetExtensions();
});
