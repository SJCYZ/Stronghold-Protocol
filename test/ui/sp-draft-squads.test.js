import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSp, phaseTotalSeconds } from '../../public/js/ui/gameLogic.js';
import { ChoiceView, spMarks } from '../../public/js/ui/choiceOverlay.js';

const players = [
  { playerId: 'p0', seat: 0, squadId: 'squad_0', name: 'A' },
  { playerId: 'p1', seat: 1, squadId: 'squad_0', name: 'B' },
  { playerId: 'p2', seat: 2, squadId: 'squad_0', name: 'C' },
  { playerId: 'p3', seat: 3, squadId: 'squad_0', name: 'D' },
  { playerId: 'p4', seat: 4, squadId: 'squad_1', name: 'E' },
  { playerId: 'p5', seat: 5, squadId: 'squad_1', name: 'F' },
  { playerId: 'p6', seat: 6, squadId: 'squad_1', name: 'G' },
  { playerId: 'p7', seat: 7, squadId: 'squad_1', name: 'H' },
];

const publicSp = {
  mode: 'squad',
  squads: [
    { squadId: 'squad_0', order: ['p0', 'p1', 'p2', 'p3'], turn: 'p1', picks: { p0: 2 }, untimed: false, turnDeadline: 111000, progress: { picked: 1, total: 4, complete: false } },
    { squadId: 'squad_1', order: ['p4', 'p5', 'p6', 'p7'], turn: 'p5', picks: { p4: 1, p6: 3 }, untimed: false, turnDeadline: 222000, progress: { picked: 2, total: 4, complete: false } },
  ],
  progress: { complete: 0, total: 2 },
};

const privateSpA = {
  mode: 'squad', squadId: 'squad_0', family: 'tactic', name: 'A draft', desc: 'A desc',
  cards: [{ id: 'secret-a-0', idx: 0 }, { id: 'secret-a-1', idx: 1 }, { id: 'secret-a-2', idx: 2 }, { id: 'secret-a-3', idx: 3 }],
};
const privateSpB = {
  mode: 'squad', squadId: 'squad_1', family: 'bounty', name: 'B draft', desc: 'B desc',
  cards: [{ id: 'secret-b-0', idx: 0 }, { id: 'secret-b-1', idx: 1 }, { id: 'secret-b-2', idx: 2 }, { id: 'secret-b-3', idx: 3 }],
};

test('多人机变只合并接收者小队私有卡面和对应公共进度', () => {
  const a = normalizeSp(publicSp, players, privateSpA);
  const b = normalizeSp(publicSp, players, privateSpB);

  assert.equal(a.mode, 'squad');
  assert.equal(a.squadId, 'squad_0');
  assert.deepEqual(a.cards.map((card) => card.id), privateSpA.cards.map((card) => card.id));
  assert.deepEqual(a.order, ['p0', 'p1', 'p2', 'p3']);
  assert.equal(a.turnPid, 'p1');
  assert.equal(a.turnDeadline, 111000);
  assert.deepEqual(a.progress, { picked: 1, total: 4, complete: false });
  assert.equal(a.pickOf.get('p0'), 2);
  assert.equal(a.cards[2].takenBy, 'p0');

  assert.equal(b.squadId, 'squad_1');
  assert.deepEqual(b.cards.map((card) => card.id), privateSpB.cards.map((card) => card.id));
  assert.equal(b.turnPid, 'p5');
  assert.equal(b.turnDeadline, 222000);
  assert.equal(b.pickOf.get('p6'), 3);
  assert.deepEqual([...spMarks(a, { solo: false })], [['p0', 'done'], ['p1', 'turn']]);
  assert.deepEqual([...spMarks(b, { solo: false })], [['p4', 'done'], ['p5', 'turn'], ['p6', 'done']]);

  const publicFrame = JSON.stringify(publicSp);
  for (const card of [...privateSpA.cards, ...privateSpB.cards]) assert.equal(publicFrame.includes(card.id), false);
  assert.equal(normalizeSp(publicSp, players), null, 'spectators without private cards do not render a deck');
  assert.equal(normalizeSp(publicSp, players, { ...privateSpA, squadId: 'unknown' }), null, 'private state without a matching public squad does not render');
});

function* walk(v) {
  if (Array.isArray(v)) { for (const x of v) yield* walk(x); return; }
  if (!v || typeof v !== 'object') return;
  yield v;
  yield* walk(v.props?.children);
}

test('小队机变弹层显示本队选择进度', () => {
  const sp = normalizeSp(publicSp, players, privateSpA);
  const nodes = [...walk(ChoiceView({ pub: { players, deadline: 0 }, sp, myId: 'p0', solo: false }))];
  const progress = nodes.find((node) => node.props?.['data-testid'] === 'sp-squad-progress');
  assert.ok(progress, 'the local squad progress is visible in the overlay');
  assert.equal(progress.props.children, '1/4');
});
test('多人机变计时长度依据本队已选进度，倒计时截止时间只取本队', async () => {
  const a = normalizeSp(publicSp, players, privateSpA);
  const b = normalizeSp(publicSp, players, privateSpB);
  const config = { timers: { spFirst: 31, spTurn: 17 } };
  const pub = { phase: 'SP_DRAFT', sp: publicSp, players };

  assert.equal(phaseTotalSeconds(pub, config, 'p0', privateSpA), 17);
  assert.equal(phaseTotalSeconds(pub, config, 'p4', privateSpB), 17);
  const firstPick = { ...publicSp, squads: [publicSp.squads[0], { ...publicSp.squads[1], picks: {} }] };
  assert.equal(phaseTotalSeconds({ ...pub, sp: firstPick }, config, 'p4', privateSpB), 31);
  const { spDeadline } = await import('../../public/js/ui/choiceOverlay.js');
  assert.equal(typeof spDeadline, 'function', 'overlay exposes its deadline selection for the local squad');
  assert.equal(spDeadline(a, { deadline: 999000 }), 111000);
  assert.equal(spDeadline(b, { deadline: 999000 }), 222000);
});

test('legacy 机变归一保持二参数卡面、顺序和选择状态', () => {
  const legacy = { family: 'tactic', cards: ['public-card-0', 'public-card-1'], order: ['p0', 'p1'], turn: 'p1', picks: { p0: 0 }, untimed: false };
  const sp = normalizeSp(legacy, players);
  assert.deepEqual(sp.cards.map((card) => card.id), legacy.cards);
  assert.deepEqual(sp.order, legacy.order);
  assert.equal(sp.turnPid, 'p1');
  assert.equal(sp.pickOf.get('p0'), 0);
  assert.equal(sp.cards[0].takenBy, 'p0');
  assert.equal(sp.mode, undefined);
  assert.equal(sp.squadId, undefined);
});
