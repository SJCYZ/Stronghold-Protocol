import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from './harness.js';
import { DATA } from './harness.js';
import { MatchWorkerPool } from '../../server/workers/matchPool.js';
import { Lobby } from '../../server/lobby.js';
import { SessionRegistry } from '../../server/net.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

test('round settlement reports cumulative leaks after accounting for this round', () => {
  const events = [];
  const h = makeMatch({ mode: 'solo', onRoundEnd: (event) => events.push(event) });
  const ps = h.ps('p_0');
  h.m.round = 1;
  h.m.lastResults.set(ps.playerId, { leaked: [{ counted: true }, { counted: false }], perfect: false });
  h.m.settle(null, null);
  assert.deepEqual(events, [{ matchId: 'TEST:1', round: 1, players: [{ playerId: 'p_0', leaks: 1 }] }]);
  h.m.finish({ victory: false, reason: 'test-result' });
  assert.equal(h.ended.matchId, events[0].matchId);
  h.m.dispose();
});

test('server result carries the stable room and match number key', () => {
  const h = makeMatch({ mode: 'solo', matchNo: 7 });
  h.m.finish({ victory: false, reason: 'test-result' });
  assert.equal(h.ended.matchId, 'TEST:7');
  h.m.dispose();
});

test('match worker forwards authoritative roundEnd events in order', async (t) => {
  const pool = new MatchWorkerPool({ data: DATA, lanes: 1, log: quiet });
  t.after(() => pool.close());
  const events = [];
  const match = await pool.create('ROUND', {
    roomCode: 'ROUND', mode: 'solo', difficulty: 'NORMAL', seed: 7, matchNo: 3,
    seats: [{ seat: 0, playerId: 'p_0', name: 'P', isBot: false, connected: true }],
  }, { send() {}, broadcast() {}, roundEnd: (event) => events.push(event) });
  await match.invoke('startRound', 1);
  await match.invoke('settle', null, null);
  await match.invoke('startRound', 2);
  await match.invoke('settle', null, null);
  assert.deepEqual(events.map((event) => [event.matchId, event.round]), [['ROUND:3', 1], ['ROUND:3', 2]]);
  await match.dispose();
});

test('lobby updates only captured SSO participants from authoritative events', async (t) => {
  const registry = new SessionRegistry();
  const updates = [];
  const accountStats = {
    async updateRound(subject, progress) { updates.push(['round', subject, progress]); },
    async completeMatch(subject, result) { updates.push(['match', subject, result]); },
  };
  const lobby = new Lobby({ registry, accountStats, log: quiet });
  t.after(() => lobby.shutdown());
  const account = registry.create('可信昵称', { type: 'account', subject: 'subject-a' });
  const guest = registry.create('访客', { type: 'guest', subject: 'subject-guest' });
  const players = [
    { playerId: account.playerId, name: '匹配昵称', isBot: false },
    { playerId: guest.playerId, name: '访客', isBot: false },
  ];
  const ctx = { accountStatsContext: lobby.accountStatsContext(players, 'ABCD:2', 'coop', true) };
  lobby.onMatchRoundEnd(ctx, { matchId: 'ABCD:2', round: 3, players: [
    { playerId: account.playerId, leaks: 4 }, { playerId: guest.playerId, leaks: 9 },
  ] });
  lobby.completeAccountMatch(ctx, { matchId: 'ABCD:2', players: [
    { playerId: account.playerId, trophies: 8, stats: { leaks: 4 } },
    { playerId: guest.playerId, trophies: 99, stats: { leaks: 99 } },
  ] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(updates, [
    ['round', 'subject-a', { matchId: 'ABCD:2', round: 3, leaks: 4, name: '可信昵称' }],
    ['match', 'subject-a', { matchId: 'ABCD:2', roomMode: 'coop', cups: 8, leaks: 4, name: '可信昵称' }],
  ]);
  updates.length = 0;
  lobby.completeAccountMatch({ accountStatsContext: lobby.accountStatsContext(players, 'ABCD:2', 'coop', false) }, {
    matchId: 'ABCD:2', players: [{ playerId: account.playerId, trophies: 8, stats: { leaks: 4 } }],
  });
  assert.deepEqual(updates, []);
});
