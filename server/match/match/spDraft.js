// server/match/match/spDraft.js — Match methods: the 机变 draft (SP_DRAFT: turn order, timers, AI picks, the card applied
// by choices.js applyCard), the personal bounty choice of the Art 教鞭 (offerBountyChoice / pickPersonalChoice /
// autoPickPersonalChoice: held by the player inside PREP — no phase, no timer of its own) and the rolls the meta effects
// ask for — bounties (addBounty), item ids (rollItemId) and choices.json pools (rollPool).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, ERR } from '../../../shared/constants.js';
import { generateDraft, applyCard, bountyBattles, isMultiRoundBounty, bountyCard } from '../choices.js';
import { onPickCard } from '../botEmotes.js';
import { weightedPick } from '../waves.js';
import { botPickCard } from '../bot.js';
import { OK, fail, DELAYS } from './common.js';

/** Cards of the personal choice (PRTS 卫戍协议：盟约 下半 §法术 教鞭: "于3个战术特训的悬赏任务中选择一项"). */
const PERSONAL_OFFER_SIZE = 3;

export class MatchSpDraft {
  enterSpDraft() {
    const alive = this.alivePlayers();
    if (!alive.length) { this.beforePrepOffers(); return; }
    this.phase = PHASE.SP_DRAFT;
    const untimed = this.soloUntimed;
    if (this.variant) {
      const squads = this.squads.map((group) => {
        const draft = generateDraft(this.gd, this.rngDraft, this.round, { stageId: this.stageId, bondAvailable: (bondId) => this.bondLive(bondId), itemAvailable: id => this.itemPool.canGain(id) });
        if (!draft) return null;
        let order = group.playerIds.filter((id) => this.players.get(id)?.alive);
        if (!this.isSolo) this.rngDraft.shuffle(order);
        order = this.humansFirst(order);
        return { squadId: group.squadId, ...draft, order, idx: 0, picks: {}, taken: {}, untimed, turnDeadline: 0 };
      }).filter(Boolean);
      if (!squads.length) { this.enterPrep(); return; }
      this.sp = { mode: 'squad', squads };
      this.setDeadline(0);
      this._spTimers = new Map();
      this._spTimerTokens = new Map();
      this.startSpTurn();
      for (const ps of alive) this.markPrivate(ps);
      this.markPublic();
      return;
    }
    const draft = generateDraft(this.gd, this.rngDraft, this.round, { stageId: this.stageId, bondAvailable: (bondId) => this.bondLive(bondId), itemAvailable: id => this.itemPool.canGain(id) });
    if (!draft) { this.enterPrep(); return; }
    let order = alive.map((p) => p.playerId);
    if (!this.isSolo) this.rngDraft.shuffle(order);
    order = this.humansFirst(order);
    this.sp = { ...draft, order, idx: 0, picks: {}, taken: {}, untimed, turnDeadline: 0 };
    this.setDeadline(0);
    this.startSpTurn();
    this.markPublic();
  }

  spTurn(ps = null) {
    if (this.sp?.mode === 'squad') {
      const squadId = ps ? this.squadOf(ps) : null;
      const squads = squadId ? this.sp.squads.filter((s) => s.squadId === squadId) : this.sp.squads;
      for (const s of squads) if (s && s.order[s.idx]) return s.order[s.idx];
      return null;
    }
    const s = this.sp;
    if (!s) return null;
    return s.order[s.idx] ?? null;
  }

  spCardAvailable(card) { return !!card && this.sp?.taken?.[card.idx] == null && (card.kind !== 'item' || this.itemPool.canGain(card.id)); }

  _spSquad(ps) {
    const id = this.squadOf(ps);
    return this.sp?.mode === 'squad' ? this.sp.squads.find((s) => s.squadId === id) || null : this.sp;
  }

  _spSquadDone(s) {
    return !this.squadMembers(s.squadId, { aliveOnly: true }).length || s.idx >= s.order.length;
  }

  startSpTurn(squadId = null) {
    if (this.sp?.mode !== 'squad') {
      const s = this.sp;
      if (!s) return;
      this.cancel(this._turnTimer);
      this._turnTimer = null;
      // loop-cap: walk only this draft's finite player order (bounded by room capacity).
      while (s.idx < s.order.length) {
        const ps = this.players.get(s.order[s.idx]);
        if (ps && ps.alive && s.picks[ps.playerId] == null) break;
        s.idx++;
      }
      const available = s.cards.filter(c => this.spCardAvailable(c)).map(c => c.idx);
      if (s.idx >= s.order.length || !available.length) { this.setDeadline(0); this.later(0, () => this.finishSpDraft()); return; }
      const token = ++this._turnToken;
      if (!s.untimed) {
        const secs = s.idx === 0 ? this.gd.timer('spFirst') : this.gd.timer('spTurn');
        this.setDeadline(secs, () => {
          if (this.phase !== PHASE.SP_DRAFT || token !== this._turnToken) return;
          const ps = this.players.get(this.spTurn());
          if (!ps) return;
          const avail = s.cards.filter(c => this.spCardAvailable(c)).map(c => c.idx);
          if (!avail.length) { this.finishSpDraft(); return; }
          this._applyCard(ps, avail[Math.floor(this.rngDraft() * avail.length)]);
        });
        s.turnDeadline = this.deadline;
      } else this.setDeadline(0);
      const cur = this.players.get(this.spTurn());
      if (cur?.botControlled) this.scheduleSpBot();
      this.markPublic();
      return;
    }
    this._spTimers ||= new Map();
    this._spTimerTokens ||= new Map();
    const squads = squadId ? this.sp.squads.filter((s) => s.squadId === squadId) : this.sp.squads;
    for (const s of squads) this._startSpSquadTurn(s);
    if (this.sp.squads.every((s) => this._spSquadDone(s))) this.later(0, () => this.finishSpDraft());
    this.markPublic();
  }

  _startSpSquadTurn(s) {
    const old = this._spTimers?.get(s.squadId);
    if (old) this.cancel(old);
    this._spTimers?.delete(s.squadId);
    // loop-cap: walk only this squad's finite player order (bounded by room capacity).
    while (s.idx < s.order.length) {
      const ps = this.players.get(s.order[s.idx]);
      if (ps?.alive && s.picks[ps.playerId] == null) break;
      s.idx++;
    }
    const available = s.cards.filter((c) => s.taken[c.idx] == null && (c.kind !== 'item' || this.itemPool.canGain(c.id))).map((c) => c.idx);
    if (s.idx >= s.order.length || this._spSquadDone(s)) { s.turnDeadline = 0; return; }
    if (!available.length) { s.idx = s.order.length; s.turnDeadline = 0; return; }
    const token = (this._spTimerTokens.get(s.squadId) || 0) + 1;
    this._spTimerTokens.set(s.squadId, token);
    if (!s.untimed) {
      const secs = s.idx === 0 ? this.gd.timer('spFirst') : this.gd.timer('spTurn');
      s.turnDeadline = this.sched.now() + this.scaled(secs * 1000);
      const timer = this.later(this.scaled(secs * 1000), () => {
        this._spTimers.delete(s.squadId);
        if (this.phase !== PHASE.SP_DRAFT || this._spTimerTokens.get(s.squadId) !== token) return;
        const ps = this.players.get(s.order[s.idx]);
        const avail = s.cards.filter((c) => s.taken[c.idx] == null && (c.kind !== 'item' || this.itemPool.canGain(c.id))).map((c) => c.idx);
        if (!ps || !avail.length) { this.startSpTurn(s.squadId); return; }
        this._applyCard(ps, avail[Math.floor(this.rngDraft() * avail.length)], s);
      });
      this._spTimers.set(s.squadId, timer);
    } else s.turnDeadline = 0;
    const cur = this.players.get(s.order[s.idx]);
    if (cur?.botControlled) this.scheduleSpBot(s);
  }

  scheduleSpBot(squad = null) {
    if (this.sp?.mode === 'squad') {
      const s = squad || this._spSquad(this.players.get(this.spTurn()));
      if (!s) return;
      const token = this._spTimerTokens.get(s.squadId) || 0;
      this.later(this.scaled(DELAYS.BOT_ACTION), () => {
        if (this.phase !== PHASE.SP_DRAFT || this._spTimerTokens.get(s.squadId) !== token || this._spSquadDone(s)) return;
        const ps = this.players.get(s.order[s.idx]);
        if (!ps?.botControlled) return;
        const avail = s.cards.filter((c) => s.taken[c.idx] == null && (c.kind !== 'item' || this.itemPool.canGain(c.id))).map((c) => c.idx);
        if (avail.length) this._applyCard(ps, botPickCard(this, ps, s.cards, avail), s);
      });
      return;
    }
    const token = this._turnToken;
    this.later(this.scaled(DELAYS.BOT_ACTION), () => {
      if (this.phase !== PHASE.SP_DRAFT || token !== this._turnToken || !this.sp) return;
      const ps = this.players.get(this.spTurn());
      if (!ps || !ps.botControlled) return;
      const avail = this.sp.cards.filter(c => this.spCardAvailable(c)).map(c => c.idx);
      if (avail.length) this._applyCard(ps, botPickCard(this, ps, this.sp.cards, avail));
    });
  }

  pickCard(ps, idx) {
    if (this.phase !== PHASE.SP_DRAFT || !this.sp) return fail(ERR.WRONG_PHASE);
    if (!ps.alive) return fail(ERR.ELIMINATED);
    const s = this._spSquad(ps);
    if (s.picks[ps.playerId] != null) return fail(ERR.ALREADY);
    if (this.spTurn(ps) !== ps.playerId) return fail(ERR.NOT_YOUR_TURN);
    if (!Number.isInteger(idx) || idx < 0 || idx >= s.cards.length) return fail(ERR.BAD_TARGET);
    if (this.sp.mode === 'squad') {
      if (!s.cards[idx] || s.taken[idx] != null || (s.cards[idx].kind === 'item' && !this.itemPool.canGain(s.cards[idx].id))) return fail(ERR.SOLD_OUT);
    } else if (!this.spCardAvailable(s.cards[idx])) return fail(ERR.SOLD_OUT);
    this._applyCard(ps, idx, s);
    return OK;
  }

  _applyCard(ps, idx, squad = null) {
    const s = squad || this._spSquad(ps);
    if (!s || s.picks[ps.playerId] != null) return;
    const card = s.cards[idx];
    if (!card || (this.sp.mode === 'squad' ? s.taken[idx] != null : !this.spCardAvailable(card))) return;
    s.picks[ps.playerId] = idx;
    s.taken[idx] = ps.playerId;
    try { applyCard(this, ps, card); } catch (e) { this.reportError(`applyCard ${card.id}`, e); }
    const members = this.sp.mode === 'squad' ? this.squadMembers(ps, { aliveOnly: false }) : [ps];
    for (const p of members) this.markPrivate(p);
    this.markPublic();
    onPickCard(this, ps, card);
    this.startSpTurn(this.sp.mode === 'squad' ? s.squadId : null);
  }

  finishSpDraft() {
    if (this.phase !== PHASE.SP_DRAFT) return;
    if (this._spTimers) {
      for (const timer of this._spTimers.values()) this.cancel(timer);
      this._spTimers.clear();
    }
    this._spTimerTokens?.clear();
    this.cancel(this._turnTimer);
    this._turnTimer = null;
    this.beforePrepOffers();
  }
  /**
   * 教鞭 (content/items/meta.js, ctx.offerBountyChoice): the Art opens a PERSONAL choice (act2autochess choice event
   * `hunter_band_1`, choiceType PERSONAL_CHOOSE) between up to three of `candidates` — drawn once from the meta rng, kept in
   * `ps.personalChoice` (m.private only) until the owner confirms one with `g.choice { idx, choiceId }`. It lives inside
   * PREP: no phase of its own and no timer — the prep's deadline resolves it (prepDeadline), Ready is refused while it is
   * pending (PlayerPrep.setReady). Refused — before an rng draw or an id is used, so the Art stays in the hand — when it
   * is not the player's PREP, a choice is already open or no card is left to offer.
   * @param {import('../PlayerState.js').PlayerState} ps @param {any[]} candidates cards.bounty entries
   * @param {string} sourceItemId the Art
   */
  offerBountyChoice(ps, candidates, sourceItemId) {
    if (this.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    if (!ps.alive) return fail(ERR.ELIMINATED);
    if (ps.ready) return fail(ERR.WRONG_PHASE, 'ready');
    if (ps.personalChoice) return fail(ERR.BAD_TARGET, '请先完成当前教鞭选择'); // i18n-ignore: developer error detail
    if (!candidates.length) return fail(ERR.BAD_TARGET, '当前没有可用的战术特训'); // i18n-ignore: developer error detail
    const cards = this.rngMeta.shuffle(candidates.slice()).slice(0, PERSONAL_OFFER_SIZE);
    ps.personalChoice = { id: `${this.battlePrefix}.choice.${this.nextUid()}`, round: this.round, sourceItemId, cards };
    ps.dirty();
    return OK;
  }

  /** g.choice { idx, choiceId }: the owner's pick of its open personal choice — the card becomes a bounty on its next battles. */
  pickPersonalChoice(ps, idx, choiceId) {
    if (this.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    if (!ps.alive) return fail(ERR.ELIMINATED);
    if (ps.ready) return fail(ERR.WRONG_PHASE, 'ready');
    const pending = ps.personalChoice;
    if (!pending || pending.id !== choiceId || pending.round !== this.round) return fail(ERR.BAD_TARGET);
    if (!Number.isInteger(idx) || idx < 0 || idx >= pending.cards.length) return fail(ERR.BAD_TARGET);
    if (!this.addBounty(ps, pending.cards[idx])) return fail(ERR.BAD_TARGET);
    ps.personalChoice = null;
    ps.dirty();
    return OK;
  }

  /**
   * The pick made for a player who did not make it. 'bot': an AI seat or a human under AI 托管 — the bounty scorer of the
   * 机变 draft (bot.js botPickCard: the expected pay minus the expected LP lost against the own board, the bots' seeded rng
   * only breaks ties); 'random': the prep's deadline and a seat the engine finishes by other means — one of the cards at
   * random from the meta rng, like a 机变 turn that runs out. Nothing pending: nothing happens, no rng draw.
   */
  autoPickPersonalChoice(ps, mode) {
    const pending = ps.personalChoice;
    if (!pending) return undefined;
    const indices = pending.cards.map((c, i) => i);
    const idx = mode === 'bot'
      ? botPickCard(this, ps, pending.cards.map((c) => bountyCard(this.gd, c)), indices)
      : this.rngMeta.pick(indices);
    return this.pickPersonalChoice(ps, idx, pending.id);
  }

  addBounty(ps, card) {
    if (!ps || !card || !this.gd.enemy(card.enemyKey)) return null;
    // a multi-round card lasts MULTI_ROUND_BOUNTY_BATTLES battles (choices.js; the user's call after playtest #6)
    const rounds = bountyBattles(card);
    const b = {
      id: `bounty:${this.nextUid()}`,
      card: { effectId: card.effectId ?? card.id ?? null, name: card.name ?? '悬赏', desc: card.desc ?? '', tier: card.tier ?? 1, coin: Math.max(0, Math.trunc(Number(card.coin) || 0)), payout: card.payout === 'perfect' ? 'perfect' : 'kill', rounds, multiRound: isMultiRoundBounty(card), enemyKey: card.enemyKey, count: Math.max(1, Math.min(20, Number.isInteger(card.count) ? card.count : 1)) }, // i18n-ignore: a data-less card's fallback name
      roundsLeft: rounds,
    };
    ps.bounties.push(b);
    ps.dirty();
    return b.id;
  }

  /** Random item id: a choices.json server pool ({ pool }), a tier, or ≤ maxTier shop-eligible items.
   * `also` (pool_equip_kathe: 突变细胞) joins the draw even though it is shopExcluded. The shop item slot does not
   * read it. `pick` still drops ids that `canGain` refuses, so an empty shop item stays out and an uncapped `also`
   * id can still be drawn. */
  rollItemId({ pool = null, tier = null, maxTier = 6, shopLevel = 6, exclude = [], ignoreStock = false } = {}) {
    const pools = this.gd.choices.pools && typeof this.gd.choices.pools === 'object' ? this.gd.choices.pools : {};
    const p = typeof pool === 'string' && Object.hasOwn(pools, pool) ? pools[pool] : null;
    const rng = this.rngMeta;
    const pick = (ids, weights = null) => {
      const selected = ids.map((id, i) => ({ id, weight: weights instanceof Map ? weights.get(id) : Array.isArray(weights) ? weights[i] : undefined }))
        .filter(({ id }) => !exclude.includes(id));
      const chosen = selected.map(({ id }) => id);
      const chosenWeights = weights instanceof Map ? new Map(selected.map(({ id, weight }) => [id, weight])) : Array.isArray(weights) ? selected.map(({ weight }) => weight) : weights;
      return this.itemPool.pick(rng, chosen, chosenWeights, { ignoreStock });
    };
    const tierList = (lo, hi) => { const out = []; for (let t = lo; t <= hi; t++) for (const id of this.gd.shopItemsByTier[t] || []) out.push(id); return out; };
    const also = p && Array.isArray(p.also) ? p.also.filter((id) => typeof id === 'string' && this.gd.item(id)) : [];
    const withAlso = (list) => {
      const out = list.slice();
      for (const id of also) if (!out.includes(id)) out.push(id);
      return out;
    };
    if (p && p.kind === 'equip') {
      if (Array.isArray(p.weighted) && p.weighted.length) {
        const pairs = p.weighted.filter((x) => Array.isArray(x) && this.gd.item(x[0]));
        for (const id of also) if (!pairs.some((x) => x[0] === id)) pairs.push([id, 1]);
        return pick(pairs.map(x => x[0]), new Map(pairs));
      }
      if (Array.isArray(p.items) && p.items.length) {
        const items = p.items.filter((id) => this.gd.item(id));
        return pick(withAlso(items));
      }
      let list;
      if (Array.isArray(p.tiers) && p.tiers.length) list = p.tiers.flatMap((t) => this.gd.shopItemsByTier[t] || []);
      else list = tierList(1, p.maxTier === 'shopLevel' ? Math.max(1, Math.min(6, shopLevel)) : 6);
      return pick(withAlso(list));
    }
    const list = Number.isInteger(tier) ? tierList(tier, tier) : tierList(1, Math.max(1, Math.min(6, maxTier)));
    return pick(list);
  }

  /**
   * Roll a choices.json pool (ctx.rollPool). Equip pools → rollItemId. Chess pools: an `items` (uniform) or `weighted`
   * list — only chess with a free pool copy (or outside the pool) qualify — else a copy-weighted draw from the shared
   * pool filtered by `tier` / `minTier` / `maxTier` (number or 'shopLevel') / `bond`; `golden: true` yields the elite id.
   * `extra` (the drawing player's 自选 stock, player/diy.js diyStockEntries) joins that shared-pool draw, `chessOf` reads the
   * bonds (the player's data view: a slotted slot's operator) — 0.2.0 WE2.
   * @returns {{ kind: 'item'|'chess', id: string, golden?: boolean } | null}
   */
  rollPool(poolId, { shopLevel = 6, extra = null, chessOf = null, ignoreItemStock = false, operatorPool = this.pool, exclude = [] } = {}) {
    const pools = this.gd.choices.pools && typeof this.gd.choices.pools === 'object' ? this.gd.choices.pools : {};
    const p = typeof poolId === 'string' && Object.hasOwn(pools, poolId) ? pools[poolId] : null;
    if (!p || typeof p !== 'object') return null;
    const lvl = Math.max(1, Math.min(6, Number.isInteger(shopLevel) ? shopLevel : 6));
    if (p.kind === 'equip') {
      const id = this.rollItemId({ pool: poolId, shopLevel: lvl, exclude, ignoreStock: ignoreItemStock });
      return id ? { kind: 'item', id } : null;
    }
    if (p.kind !== 'chess') return null;
    const rng = this.rngMeta;
    const free = (id) => {
      if (typeof id !== 'string' || !this.gd.chess(id)) return false;
      const base = this.gd.baseIdOf(id);
      return !operatorPool.has(base) || operatorPool.left(base) > 0;
    };
    let id = null;
    if (Array.isArray(p.weighted) && p.weighted.length) {
      const pairs = p.weighted.filter((x) => Array.isArray(x) && free(x[0]));
      id = pairs.length ? weightedPick(rng, pairs) : null;
    } else if (Array.isArray(p.items) && p.items.length) {
      const list = p.items.filter(free);
      id = list.length ? list[Math.floor(rng() * list.length)] : null;
    } else {
      const maxTier = p.maxTier === 'shopLevel' ? lvl : Number.isInteger(p.maxTier) ? p.maxTier : 6;
      const minTier = Number.isInteger(p.minTier) ? p.minTier : 1;
      const bond = typeof p.bond === 'string' ? p.bond : null;
      const recOf = typeof chessOf === 'function' ? chessOf : (cid) => this.gd.chess(cid);
      id = operatorPool.roll(rng, {
        tier: Number.isInteger(p.tier) ? p.tier : null,
        maxTier,
        filter: (cid, e) => e.tier >= minTier && (!bond || (Array.isArray(recOf(cid)?.bonds) && recOf(cid).bonds.includes(bond))),
        extra,
      });
    }
    if (!id) return null;
    const golden = !!p.golden;
    return { kind: 'chess', id: golden ? this.gd.goldenIdOf(id) || id : id, golden };
  }
}
