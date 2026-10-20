import { createHash, randomBytes } from 'node:crypto';

const TICKET_TTL_MS = 60_000;
const LOGIN_TTL_MS = 5 * 60_000;
const MAX_PENDING_FLOWS = 10_000;
const random = (size = 32) => randomBytes(size).toString('base64url');
const digest = (value) => createHash('sha256').update(value).digest('base64url');

/** Server-side WGS OAuth client and short-lived Stronghold auth tickets. */
export class WgsSso {
  constructor({ config, callbackUrl, fetchImpl = fetch, now = Date.now }) {
    this.config = config;
    this.callbackUrl = callbackUrl;
    this.fetch = fetchImpl;
    this.now = now;
    this.logins = new Map();
    this.tickets = new Map();
  }

  enabled() {
    return !!(this.config.wgsUrl && this.config.wgsClientId && this.config.wgsClientSecret && this.callbackUrl);
  }

  beginLogin() {
    if (!this.enabled()) throw new Error('SSO_NOT_CONFIGURED');
    this.sweep();
    if (this.logins.size >= MAX_PENDING_FLOWS) throw new Error('SSO_BUSY');
    const state = random();
    const verifier = random();
    this.logins.set(digest(state), { verifier, expiresAt: this.now() + LOGIN_TTL_MS });
    const url = new URL('/api/v1/game-sso/authorize', this.config.wgsUrl);
    url.search = new URLSearchParams({
      client_id: this.config.wgsClientId,
      redirect_uri: this.callbackUrl,
      state,
      code_challenge: digest(verifier),
      code_challenge_method: 'S256',
    }).toString();
    return { state, url: url.toString() };
  }

  async finishLogin(state, code) {
    const key = typeof state === 'string' ? digest(state) : '';
    const login = this.logins.get(key);
    this.logins.delete(key);
    if (!login || login.expiresAt <= this.now() || typeof code !== 'string' || !code || code.length > 512) throw new Error('SSO_INVALID_STATE');
    const result = await this.request('/api/v1/game-sso/token', {
      client_id: this.config.wgsClientId,
      client_secret: this.config.wgsClientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.callbackUrl,
      code_verifier: login.verifier,
    });
    if (typeof result.subject !== 'string' || !result.subject || result.subject.length > 128 || !Number.isSafeInteger(result.auth_version)
      || typeof result.session_ref !== 'string' || !result.session_ref || result.session_ref.length > 512
      || !Number.isFinite(result.expires_at) || result.expires_at * 1000 <= this.now()) throw new Error('SSO_INVALID_RESPONSE');
    return this.issueTicket({
      type: 'account', subject: result.subject, authVersion: result.auth_version,
      sessionRef: result.session_ref, expiresAt: result.expires_at * 1000,
    });
  }

  issueGuestTicket(scope) {
    if (!scope || typeof scope.inviteId !== 'string' || typeof scope.roomId !== 'string'
      || !Number.isSafeInteger(scope.generation) || scope.generation < 0) throw new Error('INVALID_GUEST_SCOPE');
    return this.issueTicket({ type: 'guest', inviteId: scope.inviteId, roomId: scope.roomId, generation: scope.generation });
  }

  issueTicket(record) {
    this.sweep();
    if (this.tickets.size >= MAX_PENDING_FLOWS) throw new Error('AUTH_TICKETS_BUSY');
    const ticket = random();
    const identityExpiry = Number.isFinite(record.expiresAt) ? record.expiresAt : Infinity;
    this.tickets.set(digest(ticket), { ...record, expiresAt: Math.min(identityExpiry, this.now() + TICKET_TTL_MS) });
    return ticket;
  }

  consumeTicket(ticket) {
    if (typeof ticket !== 'string' || ticket.length > 256) return null;
    const key = digest(ticket);
    const record = this.tickets.get(key);
    this.tickets.delete(key);
    if (!record || record.expiresAt <= this.now()) return null;
    return record;
  }

  async introspect(sessionRef, subject, authVersion) {
    const result = await this.request('/api/v1/game-sso/introspect', {
      client_id: this.config.wgsClientId,
      client_secret: this.config.wgsClientSecret,
      session_ref: sessionRef,
    });
    return result.active === true && result.subject === subject && result.auth_version === authVersion
      && Number.isFinite(result.expires_at) && result.expires_at * 1000 > this.now();
  }

  async request(path, payload) {
    if (!this.enabled()) throw new Error('SSO_NOT_CONFIGURED');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.wgsTimeoutMs);
    try {
      const response = await this.fetch(new URL(path, this.config.wgsUrl), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: controller.signal,
      });
      if (!response.ok) throw new Error('SSO_REJECTED');
      const result = await response.json();
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('SSO_INVALID_RESPONSE');
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }

  sweep() {
    const now = this.now();
    for (const [key, item] of this.logins) if (item.expiresAt <= now) this.logins.delete(key);
    for (const [key, item] of this.tickets) if (item.expiresAt <= now) this.tickets.delete(key);
  }
}
