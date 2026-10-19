import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PHASE } from '../../shared/constants.js';
import { drawUniteHelpers, planUnite, serializeUnitePlan, uniteBattleOpts } from '../../server/match/unite.js';
import { canSnapshot, restoreMatch, snapshotMatch } from '../../server/match/snapshot.js';
import { createRngFromState } from '../../server/sim/rng.js';
import { DATA, makeMatch } from './harness.js';
import { FakeBattle } from './fakeBattle.js';

function makePlan(humans, seed, leaks) {
  const h = makeMatch({ mode: 'coop', humans, seed, fake: true }).start();
  const m = h.m;
  const enemyKey = Object.keys(DATA.enemies).find((id) => m.gd.enemy(id));
  const results = new Map();
  for (const ps of m.alivePlayers()) {
    const count = leaks[ps.playerId] || 0;
    results.set(ps.playerId, {
      leaked: Array.from({ length: count }, (_, i) => ({ enemyKey, counted: true, tag: `source-${ps.playerId}-${i}` })),
      perfect: count === 0,
    });
  }
  return { h, m, results, plan: planUnite(m, results) };
}

test('5 人多人变体把各来源计数漏怪合并，并从全房间完美候选中随机选至多两名', () => {
  const { h, m, results, plan } = makePlan(5, 108, { p_0: 2, p_1: 1 });
  try {
    assert.equal(m.variant, true);
    assert.equal(plan.leaked.length, 3);
    assert.deepEqual(plan.leaked.reduce((counts, leak) => {
      counts[leak.sourcePlayerId] = (counts[leak.sourcePlayerId] || 0) + 1;
      return counts;
    }, {}), { p_0: 2, p_1: 1 });

    const candidates = new Set([...results].filter(([, r]) => r.perfect).map(([id]) => id));
    assert.equal(plan.helpers.length, 2);
    assert.equal(new Set(plan.helpers.map((p) => p.playerId)).size, plan.helpers.length);
    assert.ok(plan.helpers.every((p) => candidates.has(p.playerId)));
    assert.deepEqual(new Set(plan.candidateIds), candidates);
    assert.equal(plan.round, 1);

    const repeats = new Set();
    for (let seed = 1; seed <= 100; seed++) {
      m.rngMeta.setState(seed);
      const first = drawUniteHelpers(m, [...candidates].map((id) => m.players.get(id)));
      const second = drawUniteHelpers(m, [...candidates].map((id) => m.players.get(id)));
      if (second.some((p) => first.some((q) => q.playerId === p.playerId))) repeats.add(seed);
    }
    assert.ok(repeats.size > 0, 'a later round may select a helper used in round one');

    const samples = new Set();
    for (let seed = 1; seed <= 12; seed++) {
      m.rngMeta.setState(seed);
      samples.add(planUnite(m, results).helpers.map((p) => p.playerId).sort().join(','));
    }
    assert.ok(samples.size > 1, `per-round helper selection must use randomness, got ${[...samples]}`);
  } finally {
    m.dispose();
  }
});

function reachUnite({ survivorsFirst = { p_0: 1, p_1: 1 }, survivorsSecond = {}, seed = 810, instant = true } = {}) {
  let uniteCount = 0;
  const h = makeMatch({ mode: 'coop', humans: 5, seed, fake: true, instant, script: (battle) => {
    if (battle.kind !== 'unite') return { leaks: { p_0: 2, p_1: 1 } };
    uniteCount++;
    return { duration: 1, survivors: uniteCount === 1 ? survivorsFirst : survivorsSecond };
  } }).start();
  h.toPrep(1);
  h.setStage('act1autochess_m01');
  h.drive(() => h.m.phase === PHASE.UNITE);
  return h;
}

test('多人联防第二轮只接收第一轮残敌并保留原来源，空场时跳过第二轮', () => {
  const h = reachUnite();
  const m = h.m;
  try {
    const first = FakeBattle.instances.find((b) => b.kind === 'unite');
    assert.equal(first.opts.stageId, 'act1autochess_m01');
    const firstHelpers = m.unitePlan.helpers.map((p) => p.playerId);
    for (const leak of m.unitePlan.leaked) {
      leak.routeIndex = 17;
      leak.mods = { ...(leak.mods || {}), task8Marker: leak.sourcePlayerId };
      leak.bounty = { coins: 9, ownerPlayerId: leak.sourcePlayerId };
    }
    const sourceQueues = new Map();
    for (const spawn of first.spawns) {
      const queue = sourceQueues.get(spawn.sourcePlayerId) || [];
      queue.push(spawn);
      sourceQueues.set(spawn.sourcePlayerId, queue);
    }
    for (const leak of m.unitePlan.leaked) {
      const spawn = sourceQueues.get(leak.sourcePlayerId)?.shift();
      if (spawn) {
        spawn.mods = { ...leak.mods };
        spawn.tag = leak.tag;
        spawn.enemyKey = leak.enemyKey;
      }
    }
    m.uniteState = serializeUnitePlan(m.unitePlan);
    const restored = h.drive(() => FakeBattle.instances.filter((b) => b.kind === 'unite').length >= 2 || m.phase === PHASE.SETTLE);
    assert.ok(restored);
    const unites = FakeBattle.instances.filter((b) => b.kind === 'unite');
    assert.equal(unites.length, 2, 'exactly two rounds start while survivors remain');
    assert.ok(unites.every((b) => b.opts.stageId === first.opts.stageId), 'both rounds preserve the round stage');
    assert.equal(m.unitePlan.round, 2);
    assert.ok(m.unitePlan.helpers.some((p) => firstHelpers.includes(p.playerId)), 'round two may reuse a first-round helper');
    assert.ok(m.unitePlan.helpers.every((p) => m.unitePlan.candidateIds.includes(p.playerId)));
    assert.deepEqual(unites[1].spawns.map((s) => s.sourcePlayerId).sort(), ['p_0', 'p_1']);
    assert.ok(unites[1].spawns.every((s) => ['p_0', 'p_1'].includes(s.sourcePlayerId)));
    assert.ok(m.unitePlan.leaked.every((leak) => leak.routeIndex === 17 && leak.bounty?.coins === 9 && leak.mods?.task8Marker === leak.sourcePlayerId));
    assert.ok(unites[1].spawns.every((spawn) => spawn.bounty?.coins === 9 && spawn.mods?.task8Marker === spawn.sourcePlayerId));
    h.drive(() => m.phase === PHASE.SETTLE);
    assert.equal(m.uniteResultView.through, 0);
    assert.equal(m.uniteResultView.losses.p_0, 0, 'first-round survivors killed in round two are not billed again');
    assert.equal(m.uniteResultView.losses.p_1, 0, 'first-round survivors killed in round two are not billed again');
  } finally {
    m.dispose();
  }

  const empty = reachUnite({ survivorsFirst: {} });
  try {
    empty.drive(() => empty.m.phase === PHASE.SETTLE);
    assert.equal(FakeBattle.instances.filter((b) => b.kind === 'unite').length, 1);
  } finally {
    empty.m.dispose();
  }
});

test('第二轮联防构造失败时只按首轮残敌扣 LP，不重复扣原始漏怪', () => {
  let uniteCount = 0;
  const h = makeMatch({ mode: 'coop', humans: 5, seed: 813, fake: true, script: (battle) => {
    if (battle.kind !== 'unite') return { leaks: { p_0: 2, p_1: 1 } };
    uniteCount++;
    return uniteCount === 1 ? { duration: 1, survivors: { p_0: 1 } } : { throwInCtor: true };
  } }).start();
  const m = h.m;
  try {
    h.toPrep(1);
    const before = h.ps('p_0').lp;
    h.drive(() => m.phase === PHASE.SETTLE);
    assert.ok(m.errorCount > 0, 'the second-round constructor failure remains diagnosed');
    assert.equal(before - h.ps('p_0').lp, 1, 'only the first-round survivor is charged');
    assert.equal(m.uniteResultView.through, 1);
    assert.equal(m.uniteResultView.losses.p_0, 1);
  } finally {
    m.dispose();
  }
});

test('残敌按 source、enemy、tag 与 mods 精确关联，避免不同悬赏记录错配', () => {
  const h = reachUnite({ survivorsFirst: { p_0: 1 } });
  const m = h.m;
  try {
    const first = FakeBattle.instances.find((b) => b.kind === 'unite');
    const leaks = m.unitePlan.leaked.filter((leak) => leak.sourcePlayerId === 'p_0');
    assert.equal(leaks.length, 2);
    leaks[1].enemyKey = leaks[0].enemyKey;
    assert.equal(leaks[0].tag, leaks[1].tag);
    leaks[0].mods = { ...(leaks[0].mods || {}), bountyId: 'bounty-a' };
    leaks[0].bounty = { coins: 4, ownerPlayerId: 'p_0' };
    leaks[1].mods = { ...(leaks[1].mods || {}), bountyId: 'bounty-b' };
    leaks[1].bounty = { coins: 9, ownerPlayerId: 'p_0' };
    const p0Spawns = first.spawns.filter((spawn) => spawn.sourcePlayerId === 'p_0');
    assert.equal(p0Spawns.length, 2);
    p0Spawns[0].mods = { ...(p0Spawns[0].mods || {}), bountyId: 'bounty-a' };
    p0Spawns[1].mods = { ...(p0Spawns[1].mods || {}), bountyId: 'bounty-b' };
    p0Spawns[0].enemyKey = p0Spawns[1].enemyKey = leaks[0].enemyKey;
    first.spawns = [...p0Spawns.reverse(), ...first.spawns.filter((spawn) => spawn.sourcePlayerId !== 'p_0')];
    first.plan.survivors = { p_0: 1 };
    h.drive(() => m.unitePlan?.round === 2);
    const survivor = m.unitePlan.leaked.find((leak) => leak.sourcePlayerId === 'p_0');
    assert.equal(survivor.mods.bountyId, 'bounty-b');
    assert.ok(survivor.bounty?.coins === 9, JSON.stringify({ original: leaks, survivor }));
  } finally {
    m.dispose();
  }
});

test('未生成漏怪按首轮 wave 时间回映，保留原 mods、bounty 与 route 数据', () => {
  const { h, m, plan } = makePlan(5, 814, { p_0: 2, p_1: 1 });
  try {
    const p0Leaks = plan.leaked.filter((leak) => leak.sourcePlayerId === 'p_0');
    assert.equal(p0Leaks.length, 2);
    for (const [index, leak] of p0Leaks.entries()) {
      leak.tag = 'bounty';
      leak.mods = { bountyId: `unspawned-${index}` };
      leak.bounty = { coins: 20 + index, ownerPlayerId: 'p_0' };
      leak.routeIndex = 4 + index;
    }
    m.startUnite(plan);
    const first = FakeBattle.instances.filter((battle) => battle.kind === 'unite').at(-1);
    const spawnA = first.spawns.find((spawn) => spawn.sourcePlayerId === 'p_0' && spawn.mods?.bountyId === 'unspawned-0');
    const spawnB = first.spawns.find((spawn) => spawn.sourcePlayerId === 'p_0' && spawn.mods?.bountyId === 'unspawned-1');
    assert.ok(spawnA && spawnB);
    const indexA = plan.waveLeakSources.indexOf(p0Leaks[0]);
    const indexB = plan.waveLeakSources.indexOf(p0Leaks[1]);
    const tiedTime = Math.min(spawnA.time, spawnB.time);
    plan.waveSpawns[indexA].time = tiedTime;
    plan.waveSpawns[indexB].time = tiedTime;

    m._completeUniteRound(plan, {
      perPlayer: { p_0: { leaked: [{ enemyKey: spawnA.enemyKey, mods: spawnA.mods, sourcePlayerId: 'p_0', tag: spawnA.tag, counted: true }] } },
      unspawned: [{ enemyKey: spawnB.enemyKey, sourcePlayerId: 'p_0', tag: spawnB.tag, time: tiedTime }],
    });

    const secondLeaks = m.unitePlan.leaked.filter((leak) => leak.sourcePlayerId === 'p_0');
    assert.deepEqual(secondLeaks.map((leak) => [leak.mods.bountyId, leak.bounty.coins, leak.routeIndex]).sort(), [
      ['unspawned-0', 20, 4], ['unspawned-1', 21, 5],
    ]);
    const second = FakeBattle.instances.filter((battle) => battle.kind === 'unite').at(-1);
    assert.deepEqual(second.spawns.filter((spawn) => spawn.sourcePlayerId === 'p_0').map((spawn) => spawn.mods.bountyId).sort(), ['unspawned-0', 'unspawned-1']);
  } finally {
    m.dispose();
  }
});

test('多人联防 checkpoint 保存当前轮次与已抽援助者，恢复不再抽样', () => {
  const h = reachUnite({ instant: false });
  const m = h.m;
  let restoredMatch;
  try {
    assert.equal(canSnapshot(m), true);
    const doc = snapshotMatch(m);
    assert.ok(doc);
    assert.equal(doc.phase, PHASE.UNITE);
    assert.equal(doc.uniteState.round, 1);
    const helpers = doc.uniteState.helperIds.slice();
    const rng = { ...doc.rng };
    doc.deadlineRemainingMs = 1000;
    const opts = { mode: 'coop', humans: 5, seed: 810, fake: true, instant: false };
    restoredMatch = makeMatch(opts);
    assert.equal(restoreMatch(restoredMatch.m, doc, { createRngFromState, log: { warn() {}, info() {}, error() {}, debug() {} } }), true);
    assert.equal(restoredMatch.m.phase, PHASE.UNITE);
    assert.deepEqual(restoredMatch.m.unitePlan.helpers.map((p) => p.playerId), helpers);
    assert.equal(restoredMatch.m.unitePlan.round, 1);
    assert.equal(FakeBattle.instances.filter((b) => b.kind === 'unite').length, 1, 'restore reopens only the checkpointed round without drawing helpers');
    const restoredLimit = Math.min(150, restoredMatch.m.gd.combatTimeLimitReal(restoredMatch.m.round));
    assert.equal(restoredMatch.m.deadline - restoredMatch.m.sched.now(), Math.round((restoredLimit * restoredMatch.m.gd.combatTimeScale / restoredMatch.m.gameSpeed) * 1000), 'the rebuilt field gets its full capped deadline instead of the old field’s remaining time');
    assert.equal(restoredMatch.m.rngMeta.state(), rng.rngMeta, 'restore does not consume the saved meta RNG state');
  } finally {
    m.dispose();
    restoredMatch?.m.dispose();
  }
});

test('多人联防第二轮 checkpoint 保留已完成第一轮而不重复结算', () => {
  const h = reachUnite();
  let restoredMatch;
  try {
    h.drive(() => h.m.phase === PHASE.UNITE && h.m.unitePlan?.round === 2);
    assert.equal(h.m.uniteState.roundResults.length, 1);
    const doc = snapshotMatch(h.m);
    const helpers = doc.uniteState.helperIds.slice();
    const rng = doc.rng.rngMeta;
    restoredMatch = makeMatch({ mode: 'coop', humans: 5, seed: 810, fake: true });
    assert.equal(restoreMatch(restoredMatch.m, doc, { createRngFromState, log: { warn() {}, info() {}, error() {}, debug() {} } }), true);
    assert.equal(restoredMatch.m.unitePlan.round, 2);
    assert.equal(restoredMatch.m.unitePlan.roundResults.length, 1);
    assert.deepEqual(restoredMatch.m.unitePlan.helpers.map((p) => p.playerId), helpers);
    assert.equal(restoredMatch.m.rngMeta.state(), rng);
  } finally {
    h.m.dispose();
    restoredMatch?.m.dispose();
  }
});

test('重复援助者的第二轮继承首轮结束时的 HP、SP 与退场状态', () => {
  const h = makeMatch({ mode: 'coop', humans: 5, seed: 812, fake: true }).start();
  try {
    const m = h.m;
    const ps = m.players.get('p_2');
    const op = ps.newPiece('chess', 'chess_char_6_11_a');
    ps.board.set('10,3', op);
    m.lastResults.set(ps.playerId, { unitsEnd: [{ uid: op.uid, hpPct: 0.8, sp: 4, alive: true }] });
    const plan = { round: 2, helpers: [ps], leaked: [], roundResults: [{ perPlayer: {
      [ps.playerId]: { unitsEnd: [{ uid: op.uid, hpPct: 0.35, sp: 12, alive: true }] },
    } }] };
    const { players } = uniteBattleOpts(m, plan, 60);
    assert.deepEqual(players[0].units.find((u) => u.uid === op.uid).carryState, { hpPct: 0.35, sp: 12 });
  } finally {
    h.m.dispose();
  }
});

test('多人联防在首轮 field 已结束、切换回调未执行时 checkpoint 不会重打首轮', () => {
  const h = reachUnite();
  let restoredMatch;
  try {
    h.drive(() => h.m.fields[0]?.live === false);
    const doc = snapshotMatch(h.m);
    assert.ok(doc?.uniteState.pendingResult);
    assert.equal(doc.uniteState.roundResults.length, 0);
    restoredMatch = makeMatch({ mode: 'coop', humans: 5, seed: 810, fake: true });
    assert.equal(restoreMatch(restoredMatch.m, doc, { createRngFromState, log: { warn() {}, info() {}, error() {}, debug() {} } }), true);
    assert.equal(restoredMatch.m.unitePlan.round, 2);
    assert.equal(restoredMatch.m.unitePlan.roundResults.length, 1);
    assert.equal(FakeBattle.instances.filter((b) => b.kind === 'unite').length, 1, 'restore starts round two without replaying the completed first field');
  } finally {
    h.m.dispose();
    restoredMatch?.m.dispose();
  }
});

test('pendingResult checkpoint 恢复时重建首轮 wave 映射并保留未生成漏怪元数据', () => {
  const { h, m, plan } = makePlan(5, 815, { p_0: 2, p_1: 1 });
  let restoredMatch;
  try {
    const p0Leaks = plan.leaked.filter((leak) => leak.sourcePlayerId === 'p_0');
    for (const [index, leak] of p0Leaks.entries()) {
      leak.tag = 'bounty';
      leak.mods = { bountyId: `pending-${index}` };
      leak.bounty = { coins: 30 + index, ownerPlayerId: 'p_0' };
      leak.routeIndex = 6 + index;
    }
    m.startUnite(plan);
    const first = FakeBattle.instances.filter((battle) => battle.kind === 'unite').at(-1);
    const spawnA = first.spawns.find((spawn) => spawn.sourcePlayerId === 'p_0' && spawn.mods?.bountyId === 'pending-0');
    const spawnB = first.spawns.find((spawn) => spawn.sourcePlayerId === 'p_0' && spawn.mods?.bountyId === 'pending-1');
    const pendingResult = {
      perPlayer: { p_0: { leaked: [{ enemyKey: spawnA.enemyKey, mods: spawnA.mods, sourcePlayerId: 'p_0', tag: spawnA.tag, counted: true }] } },
      unspawned: [{ enemyKey: spawnB.enemyKey, sourcePlayerId: 'p_0', tag: spawnB.tag, time: spawnB.time }],
    };
    plan.pendingResult = pendingResult;
    m.uniteState = serializeUnitePlan(plan);
    m.fields[0].live = false;
    m.fields[0].result = pendingResult;
    const doc = snapshotMatch(m);
    assert.ok(doc?.uniteState.pendingResult);

    restoredMatch = makeMatch({ mode: 'coop', humans: 5, seed: 815, fake: true });
    assert.equal(restoreMatch(restoredMatch.m, doc, { createRngFromState, log: { warn() {}, info() {}, error() {}, debug() {} } }), true);
    const secondLeaks = restoredMatch.m.unitePlan.leaked.filter((leak) => leak.sourcePlayerId === 'p_0');
    assert.deepEqual(secondLeaks.map((leak) => [leak.mods.bountyId, leak.bounty.coins, leak.routeIndex]).sort(), [
      ['pending-0', 30, 6], ['pending-1', 31, 7],
    ]);
    const second = FakeBattle.instances.filter((battle) => battle.kind === 'unite').at(-1);
    assert.deepEqual(second.spawns.filter((spawn) => spawn.sourcePlayerId === 'p_0').map((spawn) => [spawn.mods.bountyId, spawn.bounty.coins]).sort(), [
      ['pending-0', 30], ['pending-1', 31],
    ]);
    assert.equal(restoredMatch.m.unitePlan.round, 2);
  } finally {
    h.m.dispose();
    restoredMatch?.m.dispose();
  }
});

test('20 人多人变体从全房间候选中无放回抽两人，候选不足时全部选择', () => {
  const { m, results, plan } = makePlan(20, 209, { p_0: 2, p_1: 1 });
  try {
    assert.equal(plan.leaked.length, 3);
    assert.deepEqual(plan.leaked.reduce((counts, leak) => {
      counts[leak.sourcePlayerId] = (counts[leak.sourcePlayerId] || 0) + 1;
      return counts;
    }, {}), { p_0: 2, p_1: 1 });
    const candidates = new Set([...results].filter(([, r]) => r.perfect).map(([id]) => id));
    assert.equal(plan.helpers.length, 2);
    assert.equal(new Set(plan.helpers.map((p) => p.playerId)).size, 2);
    assert.ok(plan.helpers.every((p) => candidates.has(p.playerId)));

    const onePerfect = new Map([...results].map(([id, r]) => [id, id === 'p_2' ? r : { leaked: [{ enemyKey: Object.keys(DATA.enemies)[0], counted: true }], perfect: false }]));
    const onlyOneCandidate = planUnite(m, onePerfect);
    assert.deepEqual(onlyOneCandidate.helpers.map((p) => p.playerId), ['p_2']);
  } finally {
    m.dispose();
  }
});

test('多人联防倒计时使用真实回合上限并封顶 150 秒，模拟时限沿用战速', () => {
  const h = makeMatch({ mode: 'coop', humans: 5, seed: 411, fake: true, instant: false }).start();
  const m = h.m;
  try {
    const enemyKey = Object.keys(DATA.enemies).find((id) => m.gd.enemy(id));
    const results = new Map(m.alivePlayers().map((p) => [p.playerId, {
      perfect: p.playerId !== 'p_0', leaked: p.playerId === 'p_0' ? [{ enemyKey, counted: true }] : [],
    }]));
    const plan = planUnite(m, results);
    const original = m.gd.combatTimeLimitReal.bind(m.gd);
    m.gd.combatTimeLimitReal = (round) => round * 100;
    m.round = 1;
    m.startUnite(plan);
    const first = FakeBattle.instances.filter((b) => b.kind === 'unite').at(-1);
    assert.equal(first.opts.timeLimit, 200);
    assert.equal(m.deadline - m.sched.now(), Math.round((100 * m.gd.combatTimeScale / m.gameSpeed) * 1000));
    m.round = 2;
    m.startUnite(plan);
    const capped = FakeBattle.instances.filter((b) => b.kind === 'unite').at(-1);
    assert.equal(capped.opts.timeLimit, 300);
    assert.equal(m.deadline - m.sched.now(), Math.round((150 * m.gd.combatTimeScale / m.gameSpeed) * 1000));
    m.gd.combatTimeLimitReal = original;
  } finally {
    m.dispose();
  }
});

test('多人变体没有完美候选时跳过联防', () => {
  const { h, m } = makePlan(5, 310, Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`p_${i}`, 1])));
  try {
    const leaks = new Map(m.alivePlayers().map((p) => [p.playerId, {
      perfect: false,
      leaked: [{ enemyKey: Object.keys(DATA.enemies)[0], counted: true }],
    }]));
    assert.equal(planUnite(m, leaks), null);
  } finally {
    m.dispose();
  }
});
