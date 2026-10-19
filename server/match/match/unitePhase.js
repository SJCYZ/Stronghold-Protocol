// server/match/match/unitePhase.js — Match methods: 联防 glue (the rules: server/match/unite.js) — the UNITE phase in
// both modes (the 联防 field from the helpers' carried state and the leakers' enemies), its end, and the leakers' live
// counts (_uniteLeft, user playtest #6 item 7; _uniteTick in the server-run mode).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, GEO } from '../../../shared/constants.js';
import { deriveSeed } from '../../sim/rng.js';
import { drawUniteHelpers, serializeUnitePlan, uniteBattleOpts, uniteSurvivors, uniteStageId } from '../unite.js';
import { FieldRunner, timelineAt, uniteBillBounds } from '../fields.js';
import { uniteLeft } from '../../sim/spec.js';
import { FLOW_TICKER_PRIORITY, DELAYS } from './common.js';
import { msg } from '../../../shared/i18n.js';
import { onStartUnite } from '../botEmotes.js';

/** The second round receives only enemies still alive or not yet spawned, keeping their original source records. */
function nextUniteLeaks(plan, result) {
  const available = new Map();
  for (const leak of plan.leaked) {
    const key = uniteLeakKey(leak);
    const queue = available.get(key) || [];
    queue.push(leak);
    available.set(key, queue);
  }
  const scheduled = new Map();
  for (let i = 0; i < Math.min(plan.waveSpawns?.length || 0, plan.waveLeakSources?.length || 0); i++) {
    const spawn = plan.waveSpawns[i];
    const key = uniteUnspawnedKey(spawn);
    const queue = scheduled.get(key) || [];
    queue.push(plan.waveLeakSources[i]);
    scheduled.set(key, queue);
  }
  const used = new Set();
  const next = [];
  const take = (leak) => {
    if (!leak || leak.counted === false || typeof leak.enemyKey !== 'string' || !leak.sourcePlayerId) return;
    const queue = available.get(uniteLeakKey(leak));
    const source = queue?.length ? queue.shift() : leak;
    used.add(source);
    next.push(copyUniteLeak(source));
  };
  for (const pp of Object.values(result.perPlayer || {})) for (const leak of pp?.leaked || []) take(leak);
  for (const leak of result.unspawned || []) {
    if (!leak || typeof leak.enemyKey !== 'string' || !leak.sourcePlayerId) continue;
    const queue = scheduled.get(uniteUnspawnedKey(leak));
    let source;
    while (queue?.length && !source) {
      const candidate = queue.shift();
      if (!used.has(candidate)) source = candidate;
    }
    if (source && source.counted !== false) {
      used.add(source);
      next.push(copyUniteLeak(source));
    }
  }
  return next;
}

function uniteUnspawnedKey(leak) {
  return `${leak.sourcePlayerId || ''}\0${leak.enemyKey || ''}\0${leak.tag || ''}\0${Number(leak.time) || 0}`;
}

function copyUniteLeak(leak) {
  return { ...leak, mods: leak.mods ? { ...leak.mods } : null, bounty: leak.bounty ? { ...leak.bounty } : leak.bounty };
}

function uniteLeakKey(leak) {
  const mods = stableLeakValue(leak.mods || {});
  return `${leak.sourcePlayerId || ''}\0${leak.enemyKey || ''}\0${leak.tag || ''}\0${mods}`;
}

function stableLeakValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableLeakValue).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableLeakValue(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function combineUniteResults(results) {
  const last = results[results.length - 1] || {};
  const perPlayer = {};
  for (const result of results) for (const [id, pp] of Object.entries(result?.perPlayer || {})) {
    const out = perPlayer[id] ||= {};
    for (const key of ['killed', 'total', 'coins', 'damageDealt', 'healingDone', 'creditedKills']) {
      if (Number.isFinite(pp[key])) out[key] = (out[key] || 0) + pp[key];
    }
    if (pp.layerGains) {
      out.layerGains ||= {};
      for (const [bondId, value] of Object.entries(pp.layerGains)) out.layerGains[bondId] = (out.layerGains[bondId] || 0) + (Number(value) || 0);
    }
    if (Array.isArray(pp.unitsEnd)) out.unitsEnd = pp.unitsEnd;
  }
  for (const [id, pp] of Object.entries(last.perPlayer || {})) perPlayer[id] ||= {};
  for (const [id, pp] of Object.entries(perPlayer)) pp.leaked = last.perPlayer?.[id]?.leaked || [];
  const billingResult = last.synthetic ? results.slice(0, -1).reverse().find((result) => result && !result.synthetic) : null;
  return {
    ...last, perPlayer, unspawned: last.unspawned || [], errors: results.reduce((n, result) => n + (Number(result?.errors) || 0), 0),
    ...(billingResult ? { billingResult } : {}),
  };
}

export class MatchUnite {
  startUnite(plan) {
    if (this.clientCombat) { this._startUniteClient(plan); return; }
    this.phase = PHASE.UNITE;
    this.unitePlan = plan;
    const limit = plan.variant
      ? Math.min(150, this.gd.combatTimeLimitReal(this.round)) * this.gd.combatTimeScale
      : this.wave ? this.wave.timeLimit : 60;
    if (plan.variant) this.uniteState = serializeUnitePlan(plan);
    const battle = this.newBattle(this._uniteOpts(plan, limit));
    this.fields = [{ fieldId: 'u', kind: 'unite', players: plan.helpers.map((p) => p.playerId), battle, live: true }];
    this.deadline = this.sched.instant ? 0 : this.sched.now() + Math.round((limit / this.gameSpeed) * 1000);
    this._defaultWatch();
    this.markPublic();
    this.tickerText(msg('联防阶段：{names} 迎战突破防线的敌人', { names: plan.helpers.map((p) => p.name) }), FLOW_TICKER_PRIORITY);
    onStartUnite(this, plan); // an AI helper says "合作愉快" once on the open of a 联防 (enabled by default; SP_BOT_EMOTES=0 silences it)
    this._uniteLeftKey = null;
    this.runner = new FieldRunner(this, this.fields, {
      onTick: (runner) => this._uniteTick(runner),
      onDone: (runner) => {
        if (this.phase !== PHASE.UNITE) return;
        const res = runner.resultOf(this.fields[0]);
        this._collectSimErrors(this.fields[0], res);
        this.fields[0].live = false;
        this.deadline = 0;
        this.markPublic();
        if (plan.variant) {
          plan.pendingResult = res;
          this.uniteState = serializeUnitePlan(plan);
        }
        this.later(this.scaled(DELAYS.COMBAT_END), () => this._completeUniteRound(plan, res));
      },
    });
    this.runner.start();
  }

  /**
   * The helpers keep their battlefield's terrain and devices. Escape templates still supply the re-entry wave and
   * routes; field metadata and client specs use the same round stage as the server simulation (#282).
   * The template map remains a fallback when the round's battlefield data is unavailable.
   */
  _uniteOpts(plan, limit) {
    const { wave, players } = uniteBattleOpts(this, plan, limit);
    return {
      seed: deriveSeed(this.seed, `u:${this.round}`),
      kind: 'unite',
      modeId: this.modeId,
      round: this.round,
      stageId: uniteStageId(this.gd, plan.helpers.length, this.stageId) ?? this.stageId,
      rect: { ...GEO.UNITE_RECT },
      timeLimit: limit,
      players,
      spawns: this._sanitizeSpawns(wave.spawns),
      routes: wave.routes,
      sharedBoss: null,
      flags: { layerGainsEnabled: false, ...this.gd.dp },
      fieldId: 'u',
      // leaked enemies re-enter with the stats they had: the round template's stat overrides apply again
      enemyOverrides: this.wave && this.wave.overrides ? this.wave.overrides : {},
      waveId: wave.templateId,
    };
  }

  _startUniteClient(plan) {
    this.phase = PHASE.UNITE;
    this.unitePlan = plan;
    const limit = plan.variant
      ? Math.min(150, this.gd.combatTimeLimitReal(this.round)) * this.gd.combatTimeScale
      : this.wave ? this.wave.timeLimit : 60;
    if (plan.variant) this.uniteState = serializeUnitePlan(plan);
    const f = this._ccField({ fieldId: 'u', kind: 'unite', players: plan.helpers.map((p) => p.playerId), opts: this._uniteOpts(plan, limit) });
    this.deadline = this.sched.instant ? 0 : this.sched.now() + Math.round((limit / this.gameSpeed) * 1000);
    this.watchers.clear();
    this._launch([f]);
    // helpers and everyone else (as observers, spectator seats included) simulate the same 联防 spec locally
    for (const ps of this._viewers()) {
      this.watchers.set(ps.playerId, 'u');
      this._sendStart(ps.playerId, f, { watch: !f.players.includes(ps.playerId) });
    }
    this.markPublic();
    this.tickerText(msg('联防阶段：{names} 迎战突破防线的敌人', { names: plan.helpers.map((p) => p.name) }), FLOW_TICKER_PRIORITY);
  }

  _finishUniteClient() {
    if (this.phase !== PHASE.UNITE) return;
    const f = this.fields[0];
    const res = f.result;
    this._collectSimErrors(f, res);
    this._stopClientCombat();
    f.live = false;
    this.deadline = 0;
    this.markPublic();
    const plan = this.unitePlan;
    if (plan.variant) {
      plan.pendingResult = res;
      this.uniteState = serializeUnitePlan(plan);
    }
    this.later(this.scaled(DELAYS.COMBAT_END), () => this._completeUniteRound(plan, res));
  }

  _completeUniteRound(plan, result) {
    if (!plan.variant) { this.settle(plan, result); return; }
    result = plan.pendingResult || result;
    plan.pendingResult = null;
    plan.roundResults.push(result);
    if (!result.synthetic && plan.round === 1) {
      const leaked = nextUniteLeaks(plan, result);
      if (leaked.length) {
        const usedHelpers = new Set(plan.helpers.map((p) => p.playerId));
        const candidates = plan.candidateIds.filter((id) => !usedHelpers.has(id))
          .map((id) => this.players.get(id)).filter((p) => p && p.alive);
        const helpers = drawUniteHelpers(this, candidates);
        if (helpers.length) {
          plan.round = 2;
          plan.leaked = leaked;
          plan.helpers = helpers;
          this.uniteState = serializeUnitePlan(plan);
          this.startUnite(plan);
          return;
        }
      }
    }
    const finalResult = combineUniteResults(plan.roundResults);
    this.uniteState = null;
    this.settle(plan, finalResult);
  }

  /**
   * 联防 (user playtest #6 item 7; PRTS 卫戍协议/帮助 "防卫失败的玩家可通过上方信息栏确认自身所属敌人的剩余数量"): how many of
   * a leaker's enemies are still standing on the 联防 field — not spawned yet, alive, or through the objective again —
   * plus its leaks that could not re-enter: what settle() charges it (before the per-round cap) if the 联防 ended now.
   * It falls as the helpers strike them down and rises when one splits or summons (the children carry the leaker).
   * Live from the field (client run: the authority's b.progress `left`; server run: the headless timeline on the field
   * clock, or the streamed battle itself), clamped to what settlement can bill that leaker (fields.js uniteBillBounds:
   * sent in + the offspring bound, validateClientResult's budget); exact once the field has its result (unite.js
   * uniteSurvivors; a synthetic result charges the own leaks, as settle()). null for anyone but a leaker of the running
   * 联防.
   * @returns {number|null}
   */
  _uniteLeft(ps) {
    const plan = this.unitePlan;
    if (this.phase !== PHASE.UNITE || !plan || !ps || !plan.leakers.includes(ps)) return null;
    const pid = ps.playerId;
    const f = this.fields.find((x) => x && x.kind === 'unite') || null;
    let res = null;
    if (f && f.cc) res = f.done ? f.result : null;
    else if (f && f.battle && f.battle.finished) { try { res = f.battle.result(); } catch { res = null; } }
    if (res && res.synthetic) {
      const own = this.lastResults.get(pid);
      return own && Array.isArray(own.leaked) ? own.leaked.filter((l) => l && l.counted !== false).length : 0;
    }
    if (res) return uniteSurvivors(plan, res).get(pid) || 0;
    const sent = plan.leaked.filter((l) => l.sourcePlayerId === pid).length;
    let live = null;
    if (f && f.cc) {
      if (f.mode === 'server' && f.timeline) {
        // the sample is [gt, killed, total, resolved(, left)]: a 联防 sample's `left` is its 5th element
        const sample = timelineAt(f.timeline, this._fieldElapsed(f));
        live = sample && sample[4] && typeof sample[4] === 'object' ? sample[4] : null;
      } else live = f.progress && f.progress.left && typeof f.progress.left === 'object' ? f.progress.left : null;
    } else if (f && f.battle) {
      try { live = uniteLeft(f.battle); } catch { live = null; }
    }
    if (!this._uniteBounds || this._uniteBounds.plan !== plan) this._uniteBounds = { plan, bounds: uniteBillBounds(plan.leaked, this.gd) };
    const bound = this._uniteBounds.bounds.get(pid) ?? sent;
    const standing = live ? Math.min(bound, Math.max(0, Math.trunc(Number(live[pid]) || 0))) : sent;
    return standing + (plan.notReentered.get(pid) || 0);
  }

  /** Server-run 联防 (streaming mode): refresh m.public about once a game second when a leaker's count moved. */
  _uniteTick(runner) {
    const f = runner && runner.fields ? runner.fields[0] : null;
    if (!f || !f.battle || runner.ticks % 30 !== 0) return;
    let key = '';
    try { key = JSON.stringify(uniteLeft(f.battle)); } catch { key = ''; }
    if (key === this._uniteLeftKey) return;
    this._uniteLeftKey = key;
    this.markPublic();
  }
}
