import { test } from 'node:test';
import assert from 'node:assert/strict';

function storage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
const { createIdentity, tokenHash } = await import('../public/js/net.js');

const tokenA = '0123456789abcdefA';
const tokenB = '0123456789abcdefB';
const channel = () => ({ addEventListener() {}, postMessage() {} });

test('public ID cache belongs to the active tab session and clears on identity changes', () => {
  const session = storage();
  const identity = createIdentity({ local: storage(), session, channel: null });
  identity.setAuthType('account');
  identity.saveToken(tokenA);
  identity.setPublicId('SP-AB12');
  assert.equal(identity.getPublicId(), 'SP-AB12');
  assert.equal(session.getItem('sp.accountPublicId'), 'SP-AB12');

  identity.saveToken(tokenB);
  assert.equal(identity.getPublicId(), null, 'a different active reconnect session must not inherit the old code');
  identity.setPublicId('SP-CD34');
  identity.setAuthType('guest');
  assert.equal(identity.getPublicId(), null, 'guest identity cannot read the account code');
  assert.equal(session.getItem('sp.accountPublicId'), null, 'changing auth type clears the tab cache');

  identity.setAuthType('account');
  identity.saveToken(tokenB);
  identity.setPublicId('SP-EF56');
  identity.clearToken();
  assert.equal(identity.getPublicId(), null, 'invalidating the active token clears its code');
});

test('resuming another saved identity clears the previous public ID', async () => {
  const local = storage({
    'sp.tokens': JSON.stringify([tokenA, tokenB]),
    'sp.matches': JSON.stringify({ [tokenHash(tokenB)]: { name: 'Saved', code: 'ROOM2' } }),
  });
  const session = storage({ 'sp.token': tokenA, 'sp.authType': 'account' });
  const identity = createIdentity({ local, session, channel: channel(), setTimeout: (fn) => { fn(); return 0; }, queryMs: 0 });
  await identity.init();
  identity.setPublicId('SP-AB12');
  assert.equal(await identity.resume(tokenHash(tokenB)), true);
  assert.equal(identity.getPublicId(), null);
});
