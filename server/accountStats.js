import { createHash } from 'node:crypto';
import { fitToBudget } from '../public/js/ui/stats.js';

const ID_SPACE = 36 ** 4;
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const accountKey = (subject) => createHash('sha256').update(subject).digest('hex');

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
  return fitToBudget([...byId.values()].sort(recordOrder));
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

function recordScore(record) {
  if (!officialRecord(record)) return null;
  const self = selfRow(record);
  const mode = roomMode(record);
  if (!self || !['solo', 'coop'].includes(mode)) return null;
  return {
    name: typeof self.name === 'string' ? self.name.slice(0, 24) : '',
    cups: mode === 'coop' && Number.isFinite(self.trophies) ? Math.max(0, self.trophies) : 0,
    leaks: Number.isFinite(self.stats?.leaks) ? Math.max(0, self.stats.leaks) : 0,
  };
}

function legacyScore(records) {
  const legacy = { cups: 0, leaks: 0, name: '', matchScores: {} };
  let newest = -Infinity;
  for (const record of records) {
    const score = recordScore(record);
    if (!score) continue;
    legacy.cups += score.cups;
    legacy.leaks += score.leaks;
    if (Number.isFinite(record.t) && record.t >= newest) { legacy.name = score.name; newest = record.t; }
    if (typeof record.matchId === 'string' && record.matchId) {
      const match = legacy.matchScores[record.matchId] ||= { cups: 0, leaks: 0 };
      match.cups += score.cups;
      match.leaks += score.leaks;
    }
  }
  return legacy;
}

function ranking(scores, limit) {
  return scores.filter((entry) => entry.name && entry.value > 0)
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
    .slice(0, limit).map(({ name, value }) => ({ name, value }));
}

function codeFor(key, offset) {
  return ((Number(BigInt(`0x${key}`) % BigInt(ID_SPACE)) + offset) % ID_SPACE).toString(36).toUpperCase().padStart(4, '0');
}

/** Persistent account history with one-time legacy score backfill and server-authoritative live scores. */
export function createAccountStats({ store, now = Date.now } = {}) {
  const serialized = new Map();

  async function publicId(key, preferred = '') {
    if (!store?.claimAccountPublicId) throw storeError();
    if (/^SP-[A-Z0-9]{4}$/.test(preferred)) {
      const reserved = await store.claimAccountPublicId(key, preferred.slice(3));
      if (typeof reserved === 'string') return `SP-${reserved}`;
      if (reserved == null) throw storeError();
    }
    for (let offset = 0; offset < ID_SPACE; offset++) {
      const code = codeFor(key, offset);
      const claimed = await store.claimAccountPublicId(key, code);
      if (typeof claimed === 'string') return `SP-${claimed}`;
      if (claimed == null) throw storeError();
    }
    throw new Error('Account public ID namespace exhausted');
  }

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
        publicId: await publicId(key, old.publicId),
        records: Array.isArray(old.records) ? old.records : [],
        rounds: isObject(old.rounds) ? old.rounds : {},
        matches: isObject(old.matches) ? old.matches : {},
        legacyBound: old.legacyBound === true,
        legacy: isObject(old.legacy) ? old.legacy : { cups: 0, leaks: 0, name: '', matchScores: {} },
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
    return { publicId: await publicId(key, old.publicId) };
  }

  async function merge(subject, records) {
    return mutate(subject, (doc) => {
      doc.records = mergeRecords(doc.records, Array.isArray(records) ? records : []);
      if (!doc.legacyBound) {
        doc.legacy = legacyScore(doc.records);
        doc.legacyBound = true;
      }
      return { publicId: doc.publicId, records: doc.records };
    });
  }

  async function updateRound(subject, { matchId, round, leaks, name }) {
    if (typeof matchId !== 'string' || !matchId || !Number.isInteger(round) || round < 0
      || !Number.isSafeInteger(leaks) || leaks < 0) throw new TypeError('Invalid round statistics');
    return mutate(subject, (doc) => {
      if (doc.matches[matchId]) return;
      const current = doc.rounds[matchId];
      if (!current || round > current.round) {
        doc.rounds[matchId] = { round, leaks, name: typeof name === 'string' ? name.slice(0, 24) : '', at: now() };
      }
    });
  }

  async function completeMatch(subject, { matchId, roomMode: mode, cups, leaks, name }) {
    if (typeof matchId !== 'string' || !matchId || !['solo', 'coop'].includes(mode)
      || !Number.isSafeInteger(cups) || cups < 0 || !Number.isSafeInteger(leaks) || leaks < 0 || typeof name !== 'string') {
      throw new TypeError('Invalid completed match statistics');
    }
    return mutate(subject, (doc) => {
      doc.matches[matchId] = { roomMode: mode, cups: mode === 'coop' ? cups : 0, leaks, name: name.slice(0, 24), at: now() };
      delete doc.rounds[matchId];
    });
  }

  async function leaderboards(limit = 10) {
    if (!store?.readAllAccountStats) throw storeError();
    const loaded = await store.readAllAccountStats();
    if (!loaded?.available) throw storeError();
    const cups = [], leaks = [];
    for (const doc of loaded.value) {
      if (!isObject(doc)) continue;
      const base = isObject(doc.legacy) ? doc.legacy : { cups: 0, leaks: 0, name: '', matchScores: {} };
      let accountCups = Number(base.cups) || 0, accountLeaks = Number(base.leaks) || 0;
      for (const [matchId, score] of Object.entries(isObject(base.matchScores) ? base.matchScores : {})) {
        if (!doc.matches?.[matchId]) continue;
        accountCups -= Number(score?.cups) || 0;
        accountLeaks -= Number(score?.leaks) || 0;
      }
      let name = typeof base.name === 'string' ? base.name : '';
      for (const match of Object.values(isObject(doc.matches) ? doc.matches : {})) {
        if (!isObject(match)) continue;
        accountCups += Number(match.cups) || 0;
        accountLeaks += Number(match.leaks) || 0;
        if (typeof match.name === 'string' && match.name) name = match.name;
      }
      for (const progress of Object.values(isObject(doc.rounds) ? doc.rounds : {})) {
        if (!isObject(progress)) continue;
        accountLeaks += Math.max(0, Number(progress.leaks) || 0);
        if (typeof progress.name === 'string' && progress.name) name = progress.name;
      }
      if (name) {
        cups.push({ name, value: Math.max(0, accountCups) });
        leaks.push({ name, value: Math.max(0, accountLeaks) });
      }
    }
    const count = Number.isInteger(limit) ? Math.max(0, Math.min(100, limit)) : 10;
    return { cups: ranking(cups, count), leaks: ranking(leaks, count) };
  }

  return { mergeRecords: merge, updateRound, completeMatch,
    leaderboards, async getPublicId(subject) { return (await getDoc(subject)).publicId; } };
}
