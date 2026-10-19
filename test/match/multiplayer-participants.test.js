import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from './harness.js';
import { MAX_SEATS } from '../../shared/constants.js';
import { RESULT_LIMITS } from '../../shared/protocol.js';

function seats(count) {
  return Array.from({ length: count }, (_, seat) => ({
    seat,
    playerId: seat === 0 ? 'human' : `ai_${seat}`,
    name: `P${seat}`,
    isBot: seat !== 0,
    connected: true,
  }));
}

test('match variant follows actual participants, not the room capacity', (t) => {
  const four = makeMatch({ seats: seats(4) });
  t.after(() => four.m.dispose());
  const five = makeMatch({ seats: seats(5) });
  t.after(() => five.m.dispose());

  assert.equal(four.m.variant, false);
  assert.equal(five.m.variant, true);
  assert.equal(five.m.publicView().variant, true);
  assert.equal(MAX_SEATS, 4, 'quickmatch seat limit stays four');
});

test('twenty participants have five fixed squads; spectators, recovery and elimination do not change membership', (t) => {
  const h = makeMatch({ seats: seats(20), spectators: ['watcher'] });
  t.after(() => h.m.dispose());
  const m = h.m;
  const expected = Array.from({ length: 5 }, (_, i) => ({
    squadId: `squad_${i + 1}`,
    playerIds: Array.from({ length: 4 }, (_, j) => i * 4 + j).map((seat) => seat === 0 ? 'human' : `ai_${seat}`),
  }));

  assert.equal(m.participants.length, 20);
  assert.deepEqual(m.squads, expected);
  assert.throws(() => { m.squads = []; }, TypeError);
  assert.throws(() => { m.variant = false; }, TypeError);
  assert.equal(m.spectators.has('watcher'), true);
  for (const ps of [m.players.get('human'), ...m.players.values()].slice(0, 5)) {
    ps.alive = false;
    ps.left = true;
  }
  assert.deepEqual(m.squads, expected);
  assert.deepEqual(m.publicView().players.map((p) => p.squadId), m.order.map((p) => m.squadOf(p.playerId)));
  assert.equal(RESULT_LIMITS.players, 20);
});
