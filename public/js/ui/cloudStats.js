// Account-only synchronization for complete local match history. Guest sessions stay on this device.
import { STATS_VERSION, mergeStats, saveStats } from './stats.js';

const empty = (stats) => stats ?? { v: STATS_VERSION, records: [] };

/** Merge the local archive into the authenticated account, then persist the server's complete merged archive locally. */
export async function syncCloudStats({ authType, token, stats, fetchFn = globalThis.fetch } = {}) {
  const local = empty(stats);
  const notSynced = (publicId = null) => ({ synced: false, publicId, stats: local });
  if (authType !== 'account' || !token || local.newer || typeof fetchFn !== 'function') return notSynced();

  try {
    const response = await fetchFn('/api/player-stats', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ v: local.v, records: local.records }),
    });
    if (!response?.ok) return notSynced();
    const body = await response.json();
    if (!body || typeof body.publicId !== 'string' || !/^SP-[0-9A-Z]{4}$/.test(body.publicId)
      || !Number.isSafeInteger(body.v) || !Array.isArray(body.records)) return notSynced();
    if (body.v > STATS_VERSION) return notSynced(body.publicId);
    const merged = mergeStats(local, { v: body.v, records: body.records });
    if (!saveStats(merged)) return notSynced(body.publicId);
    return { synced: true, publicId: body.publicId, stats: merged };
  } catch {
    return notSynced();
  }
}
