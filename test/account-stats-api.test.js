import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createAccountStatsRoutes } from '../server/http/accountStats.js';

function harness({ session, introspect = true, accountStats } = {}) {
  let writes = 0;
  const routes = createAccountStatsRoutes({
    sessions: { byToken: () => session || null },
    sso: { async introspect() { return introspect; } },
    accountStats: accountStats || { async mergeRecords() { writes++; return { publicId: 'SP-AB12', records: [] }; }, async updateRound() { writes++; } },
  });
  return { routes, writes: () => writes };
}

async function post(routes, pathname, body, token = 'token') {
  const payload = JSON.stringify(body);
  const req = new Readable({ read() { this.push(payload); this.push(null); } });
  req.method = 'POST';
  req.url = pathname;
  req.headers = { authorization: token ? `Bearer ${token}` : '', 'content-type': 'application/json' };
  const headers = {};
  const res = {
    setHeader(key, value) { headers[key.toLowerCase()] = value; },
    writeHead(status, more = {}) { this.status = status; Object.assign(headers, Object.fromEntries(Object.entries(more).map(([k, v]) => [k.toLowerCase(), v]))); },
    end(data) { this.body = data ? String(data) : ''; },
  };
  const handled = await routes(req, res, pathname);
  return { handled, status: res.status, headers, body: JSON.parse(res.body || '{}') };
}

const account = { token: '0123456789abcdef0123456789abcdef', authType: 'account', wgsSubject: 'subject', wgsSessionRef: 'ref', wgsAuthVersion: 1, authExpiresAt: Date.now() + 60_000 };

test('guest and expired SSO cannot sync', async () => {
  const guest = harness({ session: { ...account, authType: 'guest' } });
  assert.equal((await post(guest.routes, '/api/player-stats', { v: 2, records: [] })).status, 401);
  assert.equal(guest.writes(), 0);
  const expired = harness({ session: account, introspect: false });
  assert.equal((await post(expired.routes, '/api/player-stats', { v: 2, records: [] })).status, 401);
  assert.equal(expired.writes(), 0);
});

test('current SSO account session can sync archive history', async () => {
  const calls = [];
  const app = harness({ session: account, accountStats: {
    async mergeRecords(subject, records) { calls.push(['merge', subject, records]); return { publicId: 'SP-AB12', records }; },
    async updateRound(subject, progress) { calls.push(['round', subject, progress]); },
  } });
  const records = [{ id: 'record-1', players: [{ name: '本人', lineup: [{ id: 'char_1' }] }] }];
  const sync = await post(app.routes, '/api/player-stats', { v: 2, records }, account.token);
  assert.equal(sync.handled, true);
  assert.equal(sync.status, 200);
  assert.deepEqual(sync.body, { publicId: 'SP-AB12', v: 2, records });
  assert.equal(calls[0][1], 'subject');
  assert.equal(calls.some(([type]) => type === 'round'), false);
});

test('round progress is not client-writeable through HTTP', async () => {
  const app = harness({ session: account });
  const response = await post(app.routes, '/api/player-stats/round', { matchId: 'ABCD:1', round: 2, leaks: 9, name: '本人' }, account.token);
  assert.equal(response.handled, false);
  assert.equal(app.writes(), 0);
});

test('Redis unavailable is not reported as saved', async () => {
  const app = harness({ session: account, accountStats: {
    async mergeRecords() { const error = new Error('unavailable'); error.code = 'STORE_UNAVAILABLE'; throw error; },
    async updateRound() { const error = new Error('unavailable'); error.code = 'STORE_UNAVAILABLE'; throw error; },
  } });
  const response = await post(app.routes, '/api/player-stats', { v: 2, records: [] }, account.token);
  assert.equal(response.status, 503);
  assert.equal(response.body.error, 'STATS_UNAVAILABLE');
});
