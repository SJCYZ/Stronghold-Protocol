import { Match as BaseMatch } from '../../../server/match/Match.js';

export class Match extends BaseMatch {
  start() {
    super.start();
    this.round = 1;
    this.order.forEach((ps, index) => { ps.lp = index === 2 ? 1 : 5; });
    this.lastResults = new Map(this.order.map((ps, index) => [ps.playerId, {
      leaked: index === 2 ? [{ counted: true }] : [], perfect: index !== 2, coins: 0,
    }]));
    this.settle(null, null);
    this.flush(true);
  }
}
