import { clientAddress, limitKeyOf, TokenBucket } from '../net.js';
import { timingSafeEqual } from 'node:crypto';
import { sendJson } from './common.js';

const BODY_LIMIT = 2048;

function cookie(req, name) {
  const raw = req.headers.cookie;
  if (typeof raw !== 'string') return '';
  for (const part of raw.split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return '';
}

function sameSecret(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readJson(req) {
  if (Number(req.headers['content-length']) > BODY_LIMIT) return Promise.resolve({ tooLarge: true });
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onError);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        cleanup();
        req.pause();
        resolve({ tooLarge: true });
      } else chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve({ body: body && typeof body === 'object' && !Array.isArray(body) ? body : null });
      } catch { resolve({ body: null }); }
    };
    const onError = () => { cleanup(); resolve({ body: null }); };
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onError);
  });
}

/** Stronghold login callback and per-match guest ticket redemption. */
export function createGameAuthRoutes({ sso, lobby, trustProxy, now = Date.now }) {
  const buckets = new Map();
  let sweptAt = now();
  return async (req, res, pathname) => {
    if (pathname === '/auth/wgs/start') {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET'); sendJson(req, res, 405, { error: 'METHOD_NOT_ALLOWED' }); return true;
      }
      try {
        const login = sso.beginLogin();
        const secure = /^https:\/\//i.test(sso.callbackUrl || '') ? '; Secure' : '';
        res.writeHead(302, { Location: login.url, 'Cache-Control': 'no-store',
          'Set-Cookie': `sp_sso_state=${login.state}; Path=/auth/wgs/callback; HttpOnly; SameSite=Lax; Max-Age=300${secure}` }); res.end();
      } catch {
        sendJson(req, res, 503, { error: 'AUTH_UNAVAILABLE' });
      }
      return true;
    }
    if (pathname === '/auth/wgs/callback') {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET'); sendJson(req, res, 405, { error: 'METHOD_NOT_ALLOWED' }); return true;
      }
      const params = new URL(req.url || '/', 'http://localhost').searchParams;
      if ([...params.keys()].some((key) => !['code', 'state'].includes(key))
        || params.getAll('code').length !== 1 || params.getAll('state').length !== 1) {
        sendJson(req, res, 400, { error: 'INVALID_SSO_RESPONSE' }); return true;
      }
      const state = params.get('state');
      const clearStateCookie = 'sp_sso_state=; Path=/auth/wgs/callback; HttpOnly; SameSite=Lax; Max-Age=0'
        + (/^https:\/\//i.test(sso.callbackUrl || '') ? '; Secure' : '');
      if (!state || !sameSecret(cookie(req, 'sp_sso_state'), state)) {
        res.setHeader('Set-Cookie', clearStateCookie);
        sendJson(req, res, 400, { error: 'INVALID_SSO_RESPONSE' }); return true;
      }
      try {
        const ticket = await sso.finishLogin(state, params.get('code'));
        res.writeHead(303, { Location: `/#authTicket=${encodeURIComponent(ticket)}`, 'Cache-Control': 'no-store', 'Set-Cookie': clearStateCookie, 'Referrer-Policy': 'no-referrer' }); res.end();
      } catch {
        res.setHeader('Set-Cookie', clearStateCookie);
        sendJson(req, res, 401, { error: 'SSO_FAILED' });
      }
      return true;
    }
    if (pathname !== '/auth/guest/redeem') return false;
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST'); sendJson(req, res, 405, { error: 'METHOD_NOT_ALLOWED' }); return true;
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
      sendJson(req, res, 415, { error: 'JSON_REQUIRED' }); return true;
    }
    const { ip } = clientAddress(req, trustProxy);
    const key = limitKeyOf(ip);
    const at = now();
    if (at - sweptAt >= 60_000) {
      for (const [entry, bucket] of buckets) if (at - bucket.at >= 60_000) buckets.delete(entry);
      sweptAt = at;
    }
    let bucket = buckets.get(key);
    if (!bucket) { bucket = new TokenBucket(1, 8, at); buckets.set(key, bucket); }
    if (!bucket.take(at)) {
      res.setHeader('Retry-After', '1'); sendJson(req, res, 429, { error: 'RATE_LIMITED' }); return true;
    }
    const result = await readJson(req);
    if (result.tooLarge) {
      res.shouldKeepAlive = false;
      res.setHeader('Connection', 'close');
      sendJson(req, res, 413, { error: 'BODY_TOO_LARGE' });
      return true;
    }
    const body = result.body;
    if (!body || typeof body.shareCode !== 'string' || body.shareCode.length < 16 || body.shareCode.length > 256) {
      sendJson(req, res, 400, { error: 'INVALID_SHARE_CODE' }); return true;
    }
    try {
      const invite = await lobby.redeemShareCode?.(body.shareCode);
      if (!invite || invite.matchStarted || !invite.inviteId || !invite.roomId || !Number.isSafeInteger(invite.generation)) {
        sendJson(req, res, 403, { error: 'SHARE_CODE_UNAVAILABLE' }); return true;
      }
      const authTicket = sso.issueGuestTicket(invite);
      sendJson(req, res, 200, { authTicket });
    } catch {
      sendJson(req, res, 503, { error: 'AUTH_UNAVAILABLE' });
    }
    return true;
  };
}
