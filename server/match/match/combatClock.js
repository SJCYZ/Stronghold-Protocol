// Match 阶段逻辑时钟；插件回调不接触墙钟或单场战斗计时器。

import { PHASE } from '../../../shared/constants.js';
import { GAME_SPEED } from '../fields.js';

const ACTIVE_PHASES = new Set([PHASE.COMBAT, PHASE.UNITE, PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE]);
const DEFAULT_PLUGIN_BUDGET = 8000;

export class MatchCombatClock {
  constructor(match) {
    this.match = match;
    this.phase = null;
    this.phaseInstance = 0;
    this.elapsedBase = 0;
    this.anchorAt = match.sched.now();
    this.speed = match.defaultGameSpeed || GAME_SPEED;
    this.paused = false;
    this.pausedAt = 0;
    this.frozen = false;
    this.plugin = null;
    this.tasks = [];
    this.nextId = 1;
    this.timer = null;
    this.executions = 0;
    this.budget = DEFAULT_PLUGIN_BUDGET;
    this.dispatching = false;
    this.disabled = false;
  }

  start(phase, provider) {
    this.stop();
    if (!ACTIVE_PHASES.has(phase)) return 0;
    this.match._combatDeadlineGt = null;
    this.match._bossOvertimeGt = null;
    const now = this.match.sched.now();
    this.phase = phase;
    this.phaseInstance = ++this.match._combatPhaseSeq;
    this.nextId = 1;
    this.elapsedBase = 0;
    this.anchorAt = now;
    this.speed = this.match.defaultGameSpeed || GAME_SPEED;
    this.match.gameSpeed = this.speed;
    this.paused = false;
    this.pausedAt = 0;
    this.frozen = false;
    this.plugin = provider?.plugin || null;
    this.budget = Number.isInteger(this.plugin?.budget) && this.plugin.budget > 0 ? this.plugin.budget : DEFAULT_PLUGIN_BUDGET;
    this.executions = 0;
    this.disabled = false;
    if (typeof provider?.onPhase === 'function') {
      const ctx = Object.freeze({
        phase,
        elapsed: () => this.elapsed(),
        after: (seconds, callback) => this.after(seconds, callback),
        every: (seconds, callback) => this.every(seconds, callback),
        setSpeed: (value) => this.setSpeed(value),
      });
      this._invoke(provider.onPhase, ctx);
      this._runDue();
    }
    this._arm();
    return this.phaseInstance;
  }

  elapsed(now = this.match.sched.now()) {
    if (!this.phase) return 0;
    const at = this.paused ? this.pausedAt : this.frozen ? this.anchorAt : now;
    return this.elapsedBase + Math.max(0, at - this.anchorAt) * this.speed / 1000;
  }

  after(seconds, callback) {
    const at = seconds;
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0 || typeof callback !== 'function') throw new TypeError('clock.after 需要非负秒数和回调函数');
    return this._add(at, 0, callback);
  }

  every(seconds, callback) {
    const interval = seconds;
    if (typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0 || typeof callback !== 'function') throw new TypeError('clock.every 需要正秒数和回调函数');
    return this._add(this.elapsed() + interval, interval, callback);
  }

  _add(at, interval, callback) {
    if (!this.phase || this.disabled) return null;
    const task = { id: this.nextId++, at, interval, callback };
    this.tasks.push(task);
    this._arm();
    return Object.freeze({ cancel: () => { this.tasks = this.tasks.filter((x) => x !== task); this._arm(); } });
  }

  setSpeed(value) {
    const speed = value;
    const step = typeof speed === 'number' ? Math.round(speed * 10) : NaN;
    if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.1 || speed > 3 || Math.abs(speed * 10 - step) > 1e-8) {
      this.match.reportError(`plugin clock:${this.plugin?.id || 'unknown'}`, new RangeError('战斗速度必须为 0.1–3.0 且按 0.1 递增'));
      return false;
    }
    if (!this.phase || this.paused || this.frozen || speed === this.speed) return !!this.phase && !this.paused && !this.frozen;
    const now = this.match.sched.now();
    if (!this.match.sched.instant) {
      this.match.runner?.flush?.(now, this.speed);
      this.match.pacer?.flush?.(now, this.speed);
      if (!this.phase || this.paused || this.frozen) return false;
    }
    const elapsed = this.elapsed(now);
    this.elapsedBase = elapsed;
    this.anchorAt = now;
    this.speed = speed;
    this.match.gameSpeed = speed;
    this.match._combatSpeedChanged({ phase: this.phase, phaseInstance: this.phaseInstance, elapsed, speed, serverNow: now });
    this._arm();
    return true;
  }

  setPaused(on, at = this.match.sched.now()) {
    if (!this.phase || this.frozen || this.paused === !!on) return;
    this.elapsedBase = this.elapsed(at);
    this.anchorAt = at;
    this.paused = !!on;
    this.pausedAt = this.paused ? at : 0;
    this._arm();
  }

  freeze() {
    if (!this.phase || this.frozen) return;
    const now = this.match.sched.now();
    this.elapsedBase = this.elapsed(now);
    this.anchorAt = now;
    this.frozen = true;
    this.tasks = [];
    this._clearTimer();
  }

  stop() {
    this._clearTimer();
    this.phase = null;
    this.elapsedBase = 0;
    this.anchorAt = this.match.sched.now();
    this.speed = this.match.defaultGameSpeed || GAME_SPEED;
    this.match.gameSpeed = this.speed;
    this.paused = false;
    this.pausedAt = 0;
    this.frozen = false;
    this.plugin = null;
    this.tasks = [];
    this.executions = 0;
    this.dispatching = false;
    this.disabled = false;
  }

  _invoke(callback, ...args) {
    if (this.disabled) return;
    if (++this.executions > this.budget) {
      this._fail(new Error(`战斗时钟回调超过 ${this.budget} 次预算`));
      return;
    }
    try { callback(...args); }
    catch (e) { this._fail(e); }
  }

  _fail(error) {
    if (this.disabled) return;
    this.disabled = true;
    this.tasks = [];
    this._clearTimer();
    this.match.reportError(`plugin clock:${this.plugin?.id || 'unknown'}`, error);
  }

  _runDue() {
    if (!this.phase || this.paused || this.disabled || this.dispatching) return;
    this.dispatching = true;
    try {
      while (this.tasks.length && !this.disabled) {
        this.tasks.sort((a, b) => a.at - b.at || a.id - b.id);
        const task = this.tasks[0];
        if (task.at > this.elapsed() + 1e-9) break;
        if (task.interval > 0) task.at += task.interval;
        else this.tasks.shift();
        this._invoke(task.callback);
      }
    } finally {
      this.dispatching = false;
    }
  }

  _clearTimer() {
    if (!this.timer) return;
    this.match.cancel(this.timer);
    this.timer = null;
  }

  _arm() {
    this._clearTimer();
    if (!this.phase || this.paused || this.frozen || this.disabled || this.dispatching || this.match.sched.instant || !this.tasks.length) return;
    this.tasks.sort((a, b) => a.at - b.at || a.id - b.id);
    const delay = Math.max(0, (this.tasks[0].at - this.elapsed()) * 1000 / this.speed);
    this.timer = this.match.later(delay, () => {
      this.timer = null;
      this._runDue();
      this._arm();
    });
  }
}

export class MatchCombatClockMethods {
  _beginCombatClock(phase) {
    this._combatClock.start(phase, this._combatClockController);
    return this._combatClock.phaseInstance;
  }

  _endCombatClock() {
    this._combatClock.stop();
    this._combatDeadlineGt = null;
    this._bossOvertimeGt = null;
  }

  _combatElapsed() {
    return this._combatClock.elapsed();
  }

  _combatWallAt(gameSeconds) {
    if (!gameSeconds || this.sched.instant) return 0;
    return this.sched.now() + Math.max(0, gameSeconds - this._combatElapsed()) * 1000 / this.gameSpeed;
  }

  _refreshCombatDeadlines() {
    if (this._combatDeadlineGt != null) this.deadline = this._combatWallAt(this._combatDeadlineGt);
    if (this._bossOvertimeGt != null) this.overtimeAt = this._combatWallAt(this._bossOvertimeGt);
  }

  _combatSpeedChanged(event) {
    const now = event.serverNow;
    this.runner?.rebase?.(now);
    this.pacer?.rebase?.(now);
    this._refreshCombatDeadlines();
    for (const f of this.fields) {
      if (!f?.cc || f.done) continue;
      if (f.mode === 'client' && f.kind !== 'boss' && f.kind !== 'hidden') this._armDeadline(f);
      else if (f.mode === 'server' && f.result) this._armRelease(f);
    }
    if (this.fields.some((f) => f?.cc && !f.done)) this.broadcast({ t: 'b.speed', ...event });
    this.markPublic();
  }
}
