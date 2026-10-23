import { sendJson } from './common.js';

const BODY_LIMIT = 1_000_000;

function readJson(req) {
  if (Number(req.headers['content-length']) > BODY_LIMIT) return Promise.resolve({ tooLarge: true });
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onError);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) { cleanup(); req.pause(); resolve({ tooLarge: true }); }
      else chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve({ body: body && typeof body === 'object' && !Array.isArray(body) ? body : null });
      } catch { resolve({ body: null }); }
    };
    const onError = () => { cleanup(); resolve({ body: null }); };
    req.on('data', onData); req.once('end', onEnd); req.once('error', onError); req.once('aborted', onError);
  });
}

/** SSO-only account history endpoints. Session tokens and subjects never enter the stored document or response. */
export function createAccountStatsRoutes({ sessions, sso, accountStats, now = Date.now }) {
  return async (req, res, pathname) => {
    if (pathname !== '/api/player-stats' && pathname !== '/api/player-stats/round') return false;
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST'); sendJson(req, res, 405, { error: 'METHOD_NOT_ALLOWED' }); return true;
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
      sendJson(req, res, 415, { error: 'JSON_REQUIRED' }); return true;
    }
    const match = /^Bearer ([A-Za-z0-9_-]{16,256})$/.exec(req.headers.authorization || '');
    const session = match ? sessions?.byToken(match[1]) : null;
    if (!session || session.authType !== 'account' || !session.wgsSubject || !session.wgsSessionRef
      || !Number.isSafeInteger(session.wgsAuthVersion)
      || Number.isFinite(session.authExpiresAt) && session.authExpiresAt <= now()
      || !await sso?.introspect(session.wgsSessionRef, session.wgsSubject, session.wgsAuthVersion)) {
      sendJson(req, res, 401, { error: 'ACCOUNT_SESSION_REQUIRED' }); return true;
    }
    const parsed = await readJson(req);
    if (parsed.tooLarge) {
      res.setHeader('Connection', 'close'); sendJson(req, res, 413, { error: 'BODY_TOO_LARGE' }); return true;
    }
    const body = parsed.body;
    if (!body) { sendJson(req, res, 400, { error: 'INVALID_JSON' }); return true; }
    try {
      if (pathname === '/api/player-stats') {
        if (!Number.isSafeInteger(body.v) || body.v < 1 || !Array.isArray(body.records)) {
          sendJson(req, res, 400, { error: 'INVALID_STATS' }); return true;
        }
        const result = await accountStats.mergeRecords(session.wgsSubject, body.records);
        sendJson(req, res, 200, { publicId: result.publicId, v: body.v, records: result.records });
      } else {
        if (typeof body.matchId !== 'string' || !body.matchId || body.matchId.length > 128
          || !Number.isSafeInteger(body.round) || body.round < 0
          || !Number.isSafeInteger(body.leaks) || body.leaks < 0 || typeof body.name !== 'string') {
          sendJson(req, res, 400, { error: 'INVALID_ROUND_STATS' }); return true;
        }
        await accountStats.updateRound(session.wgsSubject, body);
        sendJson(req, res, 200, { saved: true });
      }
    } catch (error) {
      if (error?.code === 'STORE_UNAVAILABLE') sendJson(req, res, 503, { error: 'STATS_UNAVAILABLE' });
      else throw error;
    }
    return true;
  };
}
