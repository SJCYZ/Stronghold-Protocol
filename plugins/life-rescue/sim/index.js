export default function setup(sp) {
  const lifeCost = sp.settings.lifeCost;
  sp.match.life.onPostSettlement(({ players, offerRescue }) => {
    const targetIds = players
      .filter(player => player.pendingElimination && !player.lifeRescueUsed)
      .map(player => player.playerId);
    const hasDonor = players.some(player =>
      !player.isBot && player.alive && !player.pendingElimination && player.lp >= lifeCost + 1);
    if (!targetIds.length || !hasDonor) return;

    offerRescue({ cost: lifeCost, durationMs: 20_000, targetIds },
      ({ rescuerId, targetId, changeLife, revive }) => {
        changeLife(rescuerId, -lifeCost);
        revive(targetId, 1);
      });
  });
}
