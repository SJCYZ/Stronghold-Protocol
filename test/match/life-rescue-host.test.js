import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { getData } from '../../server/data.js';
import { createContentSets } from '../../server/plugins/contentSets.js';
import { createMatchHosts } from '../../server/match/host/index.js';
import { scriptFixture } from '../helpers/scriptFixtures.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const delay = (ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('hosted SETTLE window did not open')), ms);
  timer.unref?.();
});

test('hosted Match opens a script registered rescue window and processes competing intents serially', { timeout: 60_000 }, async (t) => {
  const fixture = scriptFixture(t, { log: quiet });
  fixture.put('life-rescue', `export default function setup(sp) {
    sp.match.life.onPostSettlement(({ players, offerRescue }) => {
      const targetIds = players.filter(player => player.pendingElimination).map(player => player.playerId);
      if (!targetIds.length) return;
      offerRescue({ cost: 2, durationMs: 20000, targetIds }, ({ rescuerId, targetId, changeLife, revive }) => {
        if (changeLife(rescuerId, -2)) revive(targetId, 1);
      });
    });
  }`, { permissions: ['sim.code', 'match.life'] });
  const contents = createContentSets({ registry: fixture.registry, vanillaData: getData({ log: quiet }), log: quiet });
  const resolved = contents.resolve(['life-rescue']);
  assert.ok(resolved.ok, JSON.stringify(resolved));
  contents.hold(resolved.set.cs);
  const set = resolved.set;
  const broadcasts = [];
  let openWindow;
  const windowOpened = new Promise((resolve) => { openWindow = resolve; });
  const hosts = createMatchHosts({
    contents, log: quiet,
    options: { matchModule: fileURLToPath(new URL('./fixtures/lifeRescueWorkerMatch.js', import.meta.url)) },
  });
  const seats = [0, 1, 2].map((seat) => ({ seat, playerId: `p_${seat}`, name: `P${seat}`, isBot: false, connected: true }));
  const hosted = hosts.create(set.cs, {
    roomCode: 'TEST', mode: 'coop', difficulty: 'NORMAL', modeId: 'mode_multi_normal', seats, spectators: [],
    seed: 19, matchNo: 1, cs: set.cs, requireCs: true,
    send() { return true; },
    broadcast(message) {
      broadcasts.push(message);
      if (message.t === 'm.public' && message.phase === 'SETTLE' && message.rescue) openWindow(message);
    },
    onEnd() {},
  });
  try {
    hosted.start();
    let view;
    try { view = await Promise.race([windowOpened, delay(15_000)]); }
    catch (error) { throw new Error(`${error.message}; diagnostics=${JSON.stringify(await hosted.diag())}; broadcasts=${JSON.stringify(broadcasts.map(x => x.t + ':' + x.phase))}`); }
    assert.ok(view.deadline - view.serverNow <= 20_000 && view.deadline - view.serverNow > 19_000);
    assert.deepEqual(view.rescue.targets, [{ playerId: 'p_2', cost: 2 }]);
    const outcomes = await Promise.all([
      hosted.handle('p_0', { t: 'g.rescue', targetId: 'p_2' }),
      hosted.handle('p_1', { t: 'g.rescue', targetId: 'p_2' }),
    ]);
    assert.equal(outcomes.filter((result) => result.ok).length, 1);
    assert.equal(outcomes.filter((result) => result.error === 'BAD_TARGET').length, 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const latest = [...broadcasts].reverse().find((message) => message.t === 'm.public');
    const rescued = latest.players.find((player) => player.playerId === 'p_2');
    assert.equal(rescued.alive, true);
    assert.equal(rescued.lp, 1);
    assert.ok(latest.players.filter((player) => ['p_0', 'p_1'].includes(player.playerId)).some((player) => player.lp === 3));
    assert.equal((await hosted.diag()).errorCount, 0);
  } finally {
    hosted.dispose();
    hosts.close();
  }
});
