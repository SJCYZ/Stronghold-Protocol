import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, DATA, checkInvariants, chessOfTier } from './harness.js';
import { snapshotMatch, restoreMatch } from '../../server/match/snapshot.js';
import { createRngFromState } from '../../server/sim/rng.js';

const seats = (count) => Array.from({ length: count }, (_, i) => ({
  seat: i, playerId: `p_${i}`, name: `P${i}`, isBot: i > 0, connected: true,
}));

test('多人变体按持有者隔离干员池，购买、售回和淘汰不影响其他玩家', () => {
  const h = makeMatch({ seats: seats(5), fake: true });
  const { m } = h;
  const [a, b] = [h.ps('p_0'), h.ps('p_1')];
  const id = chessOfTier(6)[0];
  const poolA = m.operatorPool(a);
  const poolB = m.operatorPool(b);
  const cap = DATA.config.economy.poolCopiesOverrides[id] ?? 5;
  assert.equal(poolA.cap(id), cap * 2, '容量仍沿用当前同盟规则');
  assert.notEqual(poolA, poolB);
  const beforeB = poolB.left(id);
  m.phase = 'PREP';
  m.round = 1;
  for (const ps of [a, b]) {
    ps.funds = 100;
    ps.shop.slots = [{ kind: 'chess', id, basePrice: 0, sold: false, frozen: false }];
    ps.shop.layout = { chess: 1, item: 0 };
  }
  assert.equal(a.buy(0).ok, true);
  assert.equal(poolA.left(id), cap * 2 - 1);
  assert.equal(poolB.left(id), beforeB);
  assert.equal(b.buy(0).ok, true);
  const piece = a.hand.find((owned) => owned?.kind === 'chess' && owned.id === id);
  const pieceB = b.hand.find((owned) => owned?.kind === 'chess' && owned.id === id);
  assert.ok(piece && pieceB);
  assert.equal(poolB.left(id), beforeB - 1);
  assert.equal(a.sell(piece.uid).ok, true);
  assert.equal(poolA.left(id), cap * 2);
  assert.equal(poolB.left(id), beforeB - 1);
  assert.equal(m.itemPool, h.ps('p_2').m.itemPool);
  h.invariants();
  m.dispose();
});

test('多人变体每位玩家都能独立耗尽相同干员库存且不能继续领取', () => {
  const h = makeMatch({ seats: seats(5), fake: true });
  const { m } = h;
  const [a, b] = [h.ps('p_0'), h.ps('p_1')];
  const id = chessOfTier(6)[0];
  const pa = m.operatorPool(a), pb = m.operatorPool(b);
  const cap = pa.cap(id);
  assert.equal(pa.take(id, cap), cap);
  assert.equal(pa.take(id, 1), 0);
  assert.equal(pb.take(id, cap), cap);
  assert.equal(pa.left(id), 0);
  assert.equal(pb.left(id), 0);
  m.dispose();
});

test('商店刷新只从该玩家的干员池抽取', () => {
  const h = makeMatch({ seats: seats(5), fake: true });
  const { m } = h;
  const [a, b] = [h.ps('p_0'), h.ps('p_1')];
  const pa = m.operatorPool(a), pb = m.operatorPool(b);
  const [idA, idB] = chessOfTier(1);
  for (const pool of [pa, pb]) for (const entry of pool.entries.values()) entry.left = 0;
  pa.entries.get(idA).left = 1;
  pb.entries.get(idB).left = 1;
  a.shop.level = b.shop.level = 1;
  assert.equal(a._rollChessSlot().id, idA);
  assert.equal(b._rollChessSlot().id, idB);
  m.dispose();
});

test('四人及以下继续共用旧干员池', () => {
  const h = makeMatch({ seats: seats(4), fake: true });
  const { m } = h;
  assert.equal(m.variant, false);
  assert.equal(m.operatorPool(h.ps('p_0')), m.pool);
  assert.equal(m.operatorPool(h.ps('p_3')), m.pool);
  m.dispose();
});

test('多人变体检查点按玩家保存和恢复干员池余额', () => {
  const h = makeMatch({ seats: seats(5), fake: true });
  const { m } = h;
  const id = chessOfTier(6)[0];
  const a = h.ps('p_0');
  a.acquireChess(id);
  m.start();
  const doc = snapshotMatch(m);
  assert.equal(doc.operatorPoolLeft.p_0[id], m.operatorPool(a).left(id));
  assert.notEqual(doc.operatorPoolLeft.p_0[id], doc.operatorPoolLeft.p_1[id]);
  const restored = makeMatch({ seats: seats(5), fake: true }).m;
  assert.equal(restoreMatch(restored, doc, { createRngFromState }), true);
  assert.equal(restored.operatorPool(restored.players.get('p_0')).left(id), doc.operatorPoolLeft.p_0[id]);
  assert.equal(restored.operatorPool(restored.players.get('p_1')).left(id), doc.operatorPoolLeft.p_1[id]);
  h.m.dispose();
  restored.dispose();
});

test('旧变体快照按各玩家的 poolCopies 重建库存，不复制全队聚合余额', () => {
  const h = makeMatch({ seats: seats(5), fake: true });
  const { m } = h;
  const id = chessOfTier(6)[0];
  const [a, b] = [h.ps('p_0'), h.ps('p_1')];
  const cap = m.operatorPool(a).cap(id);
  for (let i = 0; i < cap + 2; i++) a.acquireChess(id);
  for (let i = 0; i < 2; i++) b.acquireChess(id);
  const held = (ps) => [...ps.hand, ...ps.temp, ...ps.board.values()]
    .filter((piece) => piece?.kind === 'chess' && m.gd.baseIdOf(piece.id) === id
      && !ps.gd.chess(piece.id)?.isDiy)
    .reduce((n, piece) => n + piece.poolCopies, 0);
  const heldA = held(a), heldB = held(b);
  assert.equal(heldA, cap + 2);
  assert.equal(heldB, 2);

  m.start();
  const doc = snapshotMatch(m);
  delete doc.operatorPoolLeft;
  doc.poolLeft[id] = cap - heldA - heldB;
  assert.equal(doc.poolLeft[id], -4, '旧字段只记录全队聚合余额');
  const restored = makeMatch({ seats: seats(5), fake: true }).m;
  assert.equal(restoreMatch(restored, doc, { createRngFromState }), true);

  const restoredA = restored.operatorPool(restored.players.get('p_0'));
  const restoredB = restored.operatorPool(restored.players.get('p_1'));
  assert.equal(restoredA.entries.get(id).left, cap - heldA, '超领债务随归属玩家保留');
  assert.equal(restoredB.entries.get(id).left, cap - heldB, '其他玩家仍保有自己的余额');
  assert.equal(restoredA.entries.get(id).left + heldA, cap);
  assert.equal(restoredB.entries.get(id).left + heldB, cap);
  h.m.dispose();
  restored.dispose();
});

test('重抽开局配置后仍为每位变体玩家重建独立干员池', () => {
  const h = makeMatch({ seats: seats(5), fake: true });
  const { m } = h;
  m.start();
  const before = m.operatorPools;
  m.completeSetupReroll();
  assert.notEqual(m.operatorPools, before);
  assert.notEqual(m.operatorPool(h.ps('p_0')), m.operatorPool(h.ps('p_1')));
  assert.equal(m.operatorPool(h.ps('p_0')).entries.size, m.operatorPool(h.ps('p_1')).entries.size);
  m.dispose();
});

test('多人干员池隔离不改变全局装备库存与 itemPoolCopies 账本', () => {
  const h = makeMatch({ seats: seats(5), fake: true });
  const { m } = h;
  const id = Object.keys(DATA.items).find((key) => DATA.items[key]?.itemType === 'EQUIP'
    && !DATA.items[key]?.isGolden && !DATA.items[key]?.hideInShop && !DATA.items[key]?.shopExcluded);
  const before = m.itemPool.left(id);
  const a = h.ps('p_0'), b = h.ps('p_1');
  const x = a.acquireItem(id), y = b.acquireItem(id);
  assert.equal(m.itemPool.occupied(x), 1);
  assert.equal(m.itemPool.occupied(y), 1);
  assert.equal(m.itemPool.held(id), 2);
  assert.equal(m.itemPool.left(id), Math.max(0, before - 2));
  h.invariants();
  m.dispose();
});
