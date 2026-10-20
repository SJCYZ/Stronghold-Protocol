import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PHASE } from '../../shared/constants.js';
import { validateC2S } from '../../shared/protocol.js';
import { makeMatch } from './harness.js';

const speedMessage = (speed) => ({ t: 'g.speed', speed });

test('g.speed protocol accepts the supported range and rejects invalid steps', () => {
  for (const speed of [0.1, 2.0, 4.0]) assert.equal(validateC2S(speedMessage(speed)), null, `${speed}`);
  for (const speed of [0, 4.1, -0.1, NaN, Infinity, 1.05]) {
    assert.match(validateC2S(speedMessage(speed)), /speed/, `${speed}`);
  }
});

function activeSolo() {
  const h = makeMatch({ mode: 'solo', humans: 1, hostId: 'p_0', fake: true, clientCombat: true, clients: false });
  h.start().toPrep(1);
  h.m.handle('p_0', { t: 'g.ready', ready: true });
  h.run(() => h.m.phase === PHASE.COMBAT);
  assert.equal(h.m.phase, PHASE.COMBAT);
  return h;
}

test('only the current human host can change active combat speed and it broadcasts the applied clock speed', () => {
  const h = activeSolo();
  const host = h.ps('p_0');
  const result = h.m.handle('p_0', speedMessage(2.7));
  assert.deepEqual(result, { ok: true });
  assert.equal(h.m.gameSpeed, 2.7);
  assert.equal(h.m.defaultGameSpeed, 2.7);
  assert.equal(h.lastBc('b.speed')?.speed, 2.7);

  for (const speed of [0, 4.1, NaN, Infinity, 2.75]) {
    const beforeGameSpeed = h.m.gameSpeed;
    const beforeDefault = h.m.defaultGameSpeed;
    assert.ok(h.m.handle('p_0', speedMessage(speed)).error, `reject ${speed}`);
    assert.equal(h.m.gameSpeed, beforeGameSpeed);
    assert.equal(h.m.defaultGameSpeed, beforeDefault);
  }

  host.alive = false;
  assert.deepEqual(h.m.handle('p_0', speedMessage(2.8)), { ok: true }, 'an eliminated but present host remains the host');
  assert.equal(h.m.defaultGameSpeed, 2.8);
  host.left = true;
  assert.equal(h.m.handle('p_0', speedMessage(2.9)).error, 'NOT_IN_ROOM');
  h.m.dispose();
});

test('a former host cannot change speed after host migration', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, hostId: 'p_0', fake: true, clientCombat: true, clients: false });
  h.start().toPrep(1);
  h.m.handle('p_0', { t: 'g.ready', ready: true });
  h.m.handle('p_1', { t: 'g.ready', ready: true });
  h.run(() => h.m.phase === PHASE.COMBAT);
  assert.equal(h.m.phase, PHASE.COMBAT);
  assert.equal(h.m.handle('p_1', speedMessage(3.0)).error, 'NOT_IN_ROOM', 'a present non-host cannot change speed');
  h.m.setHost('p_1');
  h.ps('p_0').left = true;
  const before = h.m.defaultGameSpeed;
  assert.equal(h.m.handle('p_0', speedMessage(3.0)).error, 'NOT_IN_ROOM');
  assert.equal(h.m.defaultGameSpeed, before);
  assert.deepEqual(h.m.handle('p_1', speedMessage(3.0)), { ok: true });
  h.m.dispose();
});

test('speed intent is rejected during preparation and while combat is paused', () => {
  const prep = makeMatch({ mode: 'solo', humans: 1, hostId: 'p_0', fake: true });
  prep.start().toPrep(1);
  assert.equal(prep.m.handle('p_0', speedMessage(2.5)).error, 'WRONG_PHASE');
  assert.equal(prep.m.defaultGameSpeed, 2);
  prep.m.dispose();

  const h = activeSolo();
  assert.deepEqual(h.m.handle('p_0', { t: 'g.pause', on: true }), { ok: true });
  const before = h.m.gameSpeed;
  assert.equal(h.m.handle('p_0', speedMessage(2.5)).error, 'WRONG_PHASE');
  assert.equal(h.m.gameSpeed, before);
  assert.equal(h.m.defaultGameSpeed, before);
  h.m.dispose();
});
