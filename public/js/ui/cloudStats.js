// Account-only synchronization for complete local match history. Guest sessions stay on this device.
import { STATS_VERSION, mergeStats, saveStats } from './stats.js';
import { identity } from '../net.js';

const isPublicId = (value) => typeof value === 'string' && /^SP-[0-9A-Z]{4}$/.test(value);
const empty = (stats) => stats ?? { v: STATS_VERSION, records: [] };

/** Read the last confirmed account code for the homepage identity chip. */
export function getCachedPublicId(authType, token = identity.getToken()) {
  if (authType !== 'account' || !token || token !== identity.getToken()) return null;
  const value = identity.getPublicId();
  return isPublicId(value) ? value : null;
}

function cachePublicId(value, token) {
  if (!isPublicId(value)) return null;
  return identity.setPublicId(value, token);
}

/** Merge the local archive into the authenticated account, then persist the server's complete merged archive locally. */
export async function syncCloudStats({ authType, token, stats, fetchFn = globalThis.fetch } = {}) {
  const local = empty(stats);
  let publicId = getCachedPublicId(authType, token);
  const isActiveSession = () => authType === 'account' && identity.getAuthType() === 'account' && token === identity.getToken();
  const notSynced = () => {
    if (!isActiveSession()) publicId = null;
    return { synced: false, publicId, stats: local };
  };
  if (!isActiveSession() || typeof fetchFn !== 'function') return notSynced();

  try {
    const identityResponse = await fetchFn('/api/player-stats/id', {
      method: 'GET', headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
    });
    if (identityResponse?.ok) {
      const identityBody = await identityResponse.json();
      publicId = cachePublicId(identityBody?.publicId, token) || publicId;
    }
  } catch { /* try the archive sync below and retain a previously confirmed code */ }

  if (!isActiveSession()) { publicId = null; return notSynced(); }
  if (local.newer) return notSynced();

  try {
    const response = await fetchFn('/api/player-stats', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ v: local.v, records: local.records }),
    });
    if (!response?.ok) return notSynced();
    const body = await response.json();
    if (!isActiveSession()) { publicId = null; return notSynced(); }
    if (isPublicId(body?.publicId)) publicId = cachePublicId(body.publicId, token) || publicId;
    if (!body || !isPublicId(body.publicId) || !Number.isSafeInteger(body.v) || !Array.isArray(body.records)) return notSynced();
    if (body.v > STATS_VERSION) return notSynced();
    const merged = mergeStats(local, { v: body.v, records: body.records });
    if (!saveStats(merged)) return notSynced();
    return { synced: true, publicId, stats: merged };
  } catch {
    return notSynced();
  }
}
