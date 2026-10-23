import { createHash } from 'node:crypto';

const MAX_RECORDS = 1000;
const MAX_CHARS = 800_000;
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const accountKey = (subject) => createHash('sha256').update(subject).digest('hex');
const publicIdOf = (key) => `SP-${key.slice(0, 4).toUpperCase()}`;

function storeError() {
  const error = new Error('Account statistics storage is unavailable');
  error.code = 'STORE_UNAVAILABLE';
  return error;
}

function recordOrder(a, b) { return (Number(b.t) || 0) - (Number(a.t) || 0) || String(a.id).localeCompare(String(b.id)); }

function mergeRecords(existing, incoming) {
  const byId = new Map();
  for (const record of [...existing, ...incoming]) {
    if (!isObject(record) || typeof record.id !== 'string' || !record.id) continue;
    const old = byId.get(record.id);
    if (!old || (old.compact === true && record.compact !== true)
      || (old.compact === record.compact && (Number(record.t) || 0) >= (Number(old.t) || 0))) {
      byId.set(record.id, record);
    }
  }
  const records = [...byId.values()].sort(recordOrder).slice(0, MAX_RECORDS);
  while (records.length > 1 && JSON.stringify(records).length > MAX_CHARS) records.pop();
  return records;
}

function selfRow(record) {
  const players = Array.isArray(record.players) ? record.players : [];
  return players.find((player) => player?.playerId && player.playerId === record.selfId)
    || players.find((player) => !player?.isBot) || players[0] || null;
}

function roomMode(record) {
  if (record.roomMode === 'solo' || record.roomMode === 'coop') return record.roomMode;
  if (typeof record.modeId !== 'string') return null;
  if (record.modeId.includes('_single_')) return 'solo';
  if (record.modeId.includes('_multi_')) return 'coop';
  return null;
}

function officialRecord(record) {
  return isObject(record) && record.end !== 'quit' && record.test !== true && !record.content
    && record.difficulty !== 'TRAINING' && record.modeId !== 'mode_training_1';
}

function ranking(scores, limit) {
  return scores.filter((entry) => entry.name && entry.value > 0)
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
    .slice(0, limit).map(({ name, value }) => ({ name, value }));
}

/** Persistent account history and ranking aggregation, keyed only by a one-way hash of the SSO subject. */
export function createAccountStats({ store, now = Date.now } = {}) {
  const serialized = new Map();

  async function mutate(subject, fn) {
    if (typeof subject !== 'string' || !subject || !store?.readAccountStats || !store?.writeAccountStats) throw storeError();
    const key = accountKey(subject);
    const prior = serialized.get(key) || Promise.resolve();
    let release;
    const lock = new Promise((resolve) => { release = resolve; });
    const tail = prior.then(() => lock);
    serialized.set(key, tail);
    await prior;
    try {
      const loaded = await store.readAccountStats(key);
      if (!loaded?.available) throw storeError();
      const old = isObject(loaded.value) ? loaded.value : {};
      const doc = {
        publicId: typeof old.publicId === 'string' ? old.publicId : publicIdOf(key),
        records: Array.isArray(old.records) ? old.records : [],
        rounds: isObject(old.rounds) ? old.rounds : {},
      };
      const result = await fn(doc);
      if (await store.writeAccountStats(key, doc) !== true) throw storeError();
      return result;
    } finally {
      release();
      if (serialized.get(key) === tail) serialized.delete(key);
    }
  }

  async function getDoc(subject) {
    if (typeof subject !== 'string' || !subject || !store?.readAccountStats) throw storeError();
    const key = accountKey(subject);
    const loaded = await store.readAccountStats(key);
    if (!loaded?.available) throw storeError();
    const old = isObject(loaded.value) ? loaded.value : {};
    return {
      publicId: typeof old.publicId === 'string' ? old.publicId : publicIdOf(key),
      records: Array.isArray(old.records) ? old.records : [],
      rounds: isObject(old.rounds) ? old.rounds : {},
    };
  }

  async function merge(subject, records) {
    return mutate(subject, (doc) => {
      doc.records = mergeRecords(doc.records, Array.isArray(records) ? records : []);
      for (const record of doc.records) {
        if (typeof record.matchId === 'string' && record.matchId && record.end !== 'quit') delete doc.rounds[record.matchId];
      }
      return { publicId: doc.publicId, records: doc.records };
    });
  }

  async function updateRound(subject, { matchId, round, leaks, name }) {
    if (typeof matchId !== 'string' || !matchId || !Number.isInteger(round) || round < 0
      || !Number.isSafeInteger(leaks) || leaks < 0) throw new TypeError('Invalid round statistics');
    return mutate(subject, (doc) => {
      const current = doc.rounds[matchId];
      if (!current || round > current.round) {
        doc.rounds[matchId] = { round, leaks, name: typeof name === 'string' ? name.slice(0, 24) : '' , at: now() };
      }
    });
  }

  async function leaderboards(limit = 10) {
    if (!store?.readAllAccountStats) throw storeError();
    const loaded = await store.readAllAccountStats();
    if (!loaded?.available) throw storeError();
    const cups = [], leaks = [];
    for (const doc of loaded.value) {
      if (!isObject(doc)) continue;
      let name = '';
      let accountCups = 0, accountLeaks = 0, newest = -Infinity;
      for (const record of Array.isArray(doc.records) ? doc.records : []) {
        if (!officialRecord(record)) continue;
        const self = selfRow(record);
        if (!self) continue;
        if (Number.isFinite(record.t) && record.t >= newest && typeof self.name === 'string') {
          newest = record.t; name = self.name.slice(0, 24);
        }
        const mode = roomMode(record);
        if (mode === 'coop' && Number.isFinite(self.trophies)) accountCups += Math.max(0, self.trophies);
        if ((mode === 'solo' || mode === 'coop') && Number.isFinite(self.stats?.leaks)) {
          accountLeaks += Math.max(0, self.stats.leaks);
        }
      }
      for (const progress of Object.values(isObject(doc.rounds) ? doc.rounds : {})) {
        if (!isObject(progress) || !Number.isFinite(progress.leaks)) continue;
        accountLeaks += Math.max(0, progress.leaks);
        if (typeof progress.name === 'string' && progress.name) name = progress.name.slice(0, 24);
      }
      if (name) {
        cups.push({ name, value: accountCups });
        leaks.push({ name, value: accountLeaks });
      }
    }
    const count = Number.isInteger(limit) ? Math.max(0, Math.min(100, limit)) : 10;
    return { cups: ranking(cups, count), leaks: ranking(leaks, count) };
  }

  return {
    mergeRecords: merge,
    updateRound,
    leaderboards,
    async getPublicId(subject) { return (await getDoc(subject)).publicId; },
  };
}
