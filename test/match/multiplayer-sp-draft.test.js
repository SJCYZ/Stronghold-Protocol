import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PHASE } from '../../shared/constants.js';
import { snapshotMatch, restoreMatch } from '../../server/match/snapshot.js';
import { createRngFromState } from '../../server/sim/rng.js';
import { DATA, makeMatch } from './harness.js';

const DEPS = { createRngFromState, log: { warn() {}, info() {}, error() {}, debug() {} } };

function startDraft(options = {}) {
  const seats = Array.from({ length: 8 }, (_, seat) => ({
    seat, playerId: `p_${seat}`, name: `P${seat}`, isBot: false, connected: true,
  }));
  const h = makeMatch({ mode: 'coop', seats, seed: 23, fake: true, ...options }).start();
  h.drive(() => h.m.phase === PHASE.SP_DRAFT, { ready: false, maxSteps: 10000 });
  assert.equal(h.m.phase, PHASE.SP_DRAFT, 'reached the special draft');
  return h;
}

test('多人机变逐小队隔离卡池、公共状态与选卡请求', () => {
  const h = startDraft();
  const { m } = h;
  try {
    assert.equal(m.sp.mode, 'squad');
    assert.equal(m.sp.squads.length, 2);
    assert.ok(m.sp.squads.every((s) => s.cards.length === 6));

    const pub = m.publicView().sp;
    assert.equal(pub.mode, 'squad');
    assert.deepEqual(Object.keys(pub.squads[0]).sort(), ['order', 'picks', 'progress', 'squadId', 'turn', 'turnDeadline', 'untimed']);
    assert.equal(JSON.stringify(pub).includes('cards'), false);
    assert.equal(JSON.stringify(pub).includes(m.sp.squads[0].cards[0].id), false);

    const own = m.players.get('p_0').privateView().sp;
    assert.equal(own.cards.length, 6);
    assert.deepEqual(own.cards, m.players.get('p_3').privateView().sp.cards);
    assert.deepEqual(m.players.get('p_0').privateView().sp.cards, m.players.get('p_0').privateView().sp.cards);
    assert.notDeepEqual(own.cards, m.players.get('p_4').privateView().sp.cards);

    const [a, b] = m.sp.squads;
    const pidA = a.order[a.idx];
    const pidB = b.order[b.idx];
    const sameCard = { ...a.cards[0], idx: 0 };
    a.cards[0] = sameCard;
    b.cards[0] = { ...sameCard };
    assert.deepEqual(m.handle(pidA, { t: 'g.choice', idx: 0 }), { ok: true });
    assert.deepEqual(m.handle(pidB, { t: 'g.choice', idx: 0 }), { ok: true });
    assert.equal(a.taken[0], pidA);
    assert.equal(b.taken[0], pidB, 'the same card can be taken once in each squad');

    const teammate = pidA === 'p_0' ? 'p_1' : 'p_0';
    const current = m.sp.squads[0].order[m.sp.squads[0].idx];
    const before = m.players.get(current).privateView().sp.picks;
    m.handle(current, { t: 'g.choice', idx: 1 });
    assert.notDeepEqual(m.players.get('p_0').privateView().sp.picks, before, 'same-squad private progress updates');
    assert.deepEqual(m.players.get(teammate).privateView().sp.picks, m.players.get(current).privateView().sp.picks);
  } finally {
    m.dispose();
  }
});

test('多人机变团队卡只影响本小队存活成员', async () => {
  const h = startDraft();
  const { m } = h;
  try {
    const { applyCard } = await import('../../server/match/choices.js');
    const card = { kind: 'tactic', id: 'allybuff_select_3', name: DATA.effects.allybuff_select_3.name,
      desc: '', team: true, family: 'tactic', idx: 0 };
    const before = m.players.get('p_4').funds;
    const beforeSameSquad = m.players.get('p_1').funds;
    applyCard(m, m.players.get('p_0'), card);
    assert.equal(m.players.get('p_1').funds, beforeSameSquad + 1);
    assert.equal(m.players.get('p_4').funds, before, 'other squad is unaffected');
  } finally {
    m.dispose();
  }
});

test('多人机变检查点保留每队卡池与进度且恢复不重放效果', () => {
  const a = startDraft();
  const b = startDraft();
  try {
    const m = a.m;
    const squad = m.sp.squads[0];
    const picker = squad.order[squad.idx];
    const beforeFunds = m.players.get(picker).funds;
    m.handle(picker, { t: 'g.choice', idx: 0 });
    const fundsAfterPick = m.players.get(picker).funds;
    const doc = snapshotMatch(m);
    assert.ok(doc);
    assert.deepEqual(restoreMatch(b.m, doc, DEPS), true);
    assert.deepEqual(b.m.sp.squads, m.sp.squads);
    assert.equal(b.m.players.get(picker).funds, fundsAfterPick, 'already picked choice effects are not replayed');
    assert.ok(b.m.sp.squads.filter((s) => s.order.length && s.idx < s.order.length)
      .every((s) => s.turnDeadline > b.m.sched.now()), 'each active squad gets a fresh turn clock');
    assert.ok(fundsAfterPick >= beforeFunds);
  } finally {
    a.m.dispose();
    b.m.dispose();
  }
});

test('多人机变小队时限独立，单真人房间仍不限时', () => {
  const timed = startDraft();
  try {
    const [a, b] = timed.m.sp.squads;
    const otherDeadline = b.turnDeadline;
    const picker = a.order[a.idx];
    assert.ok(a.turnDeadline > timed.m.sched.now());
    assert.ok(otherDeadline > timed.m.sched.now());
    assert.deepEqual(timed.m.handle(picker, { t: 'g.choice', idx: 0 }), { ok: true });
    assert.equal(b.turnDeadline, otherDeadline, 'one squad pick leaves the other squad clock untouched');
    assert.ok(a.turnDeadline > timed.m.sched.now(), 'the picking squad starts its next clock');
    timed.sched.advance(timed.m.gd.timer('spTurn') * 1000 + 1);
    assert.equal(Object.keys(a.picks).length, 2, 'the timed-out squad auto-picks its own next card');
    assert.equal(Object.keys(b.picks).length, 0, 'the other squad remains on its own initial turn');
  } finally {
    timed.m.dispose();
  }

  const seats = Array.from({ length: 8 }, (_, seat) => ({ seat, playerId: `p_${seat}`, name: `P${seat}`, isBot: seat !== 0, connected: true }));
  const lone = makeMatch({ mode: 'coop', seats, seed: 31, fake: true });
  try {
    lone.m.start();
    lone.m.round = 3;
    lone.m.enterSpDraft();
    assert.equal(lone.m.phase, PHASE.SP_DRAFT);
    assert.ok(lone.m.sp.squads.every((s) => s.untimed && s.turnDeadline === 0));
    lone.sched.advance(901);
    assert.ok(lone.m.sp.squads.some((s) => Object.keys(s.picks).some((id) => lone.m.players.get(id).isBot)), 'AI picks continue without a human timer');
  } finally {
    lone.m.dispose();
  }
});

test('aiPicksLast orders humans before AI within each squad', () => {
  const seats = Array.from({ length: 8 }, (_, seat) => ({
    seat, playerId: `p_${seat}`, name: `P${seat}`, isBot: seat !== 0 && seat !== 4, connected: true,
  }));
  const h = startDraft({ seats, aiPicksLast: true });
  try {
    for (const s of h.m.sp.squads) {
      let sawBot = false;
      for (const id of s.order) {
        if (h.m.players.get(id).isBot) sawBot = true;
        else assert.equal(sawBot, false, `human ${id} precedes AI seats in ${s.squadId}`);
      }
    }
  } finally {
    h.m.dispose();
  }
});
test('所有存活小队完成后进入 PREP 并清理逐队计时器', () => {
  const h = startDraft();
  const { m } = h;
  try {
    for (const squad of m.sp.squads) {
      while (squad.idx < squad.order.length) {
        const playerId = squad.order[squad.idx];
        const idx = squad.cards.find((card) => squad.taken[card.idx] == null)?.idx;
        assert.notEqual(idx, undefined);
        assert.deepEqual(m.handle(playerId, { t: 'g.choice', idx }), { ok: true });
      }
    }
    h.sched.advance(1);
    assert.equal(m.phase, PHASE.PREP);
    assert.equal(m._spTimers.size, 0);
    assert.equal(m._spTimerTokens.size, 0);
  } finally {
    m.dispose();
    assert.equal(m._spTimers.size, 0);
  }
});