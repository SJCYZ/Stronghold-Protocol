import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStore } from '../../public/js/store.js';
import { skinsStore, SKINS_KEY, SKINS_SYNC_KEY, setSkin, clearSkin, availableSkins } from '../../public/js/ui/skins.js';
import { installSkinsSync } from '../../public/js/ui/loadoutSync.js';
import { data } from '../../public/js/data.js';
import { sanitizeSettings } from '../../public/js/ui/gameLogic/settings.js';
import { cleanSkins, freezeSkins, visibleOperatorSkin, visibleSkin, SKIN_LIMITS } from '../../shared/skins.js';

const CHESS = 'chess_char_1_01_a', OPERATOR = 'char_498_inside', SKIN = 'char_498_inside@kitchen#2';
const read = (path) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
function syncEnv(enabled = false) {
  const target = createStore({ [SKINS_KEY]: { [CHESS]: SKIN, [OPERATOR]: SKIN }, skinsSync: 'idle' });
  const settings = createStore({ skinsEnabled: enabled });
  const handlers = new Map(), calls = [], timers = new Map();
  let id = 0;
  const net = { status: 'online',
    on(t, fn) { handlers.set(t, fn); return () => handlers.delete(t); },
    async request(t, msg) { calls.push({ t, ...msg }); },
  };
  const sync = installSkinsSync({ net, settings, target, timers: {
    setTimeout(fn) { const n = ++id; timers.set(n, fn); return n; },
    clearTimeout(n) { timers.delete(n); },
  } });
  return { target, settings, handlers, calls, timers, net, sync };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));

test('skins and skin preloading are separate opt-ins; malformed/legacy settings default off', () => {
  for (const raw of [null, {}, { skinsEnabled: 'true', preloadSkins: 1 }]) {
    const s = sanitizeSettings(raw);
    assert.equal(s.skinsEnabled, false); assert.equal(s.preloadSkins, false);
  }
  const s = sanitizeSettings({ skinsEnabled: false, preloadOptional: false, preloadSkins: true });
  assert.equal(s.preloadSkins, true); assert.equal(s.preloadOptional, false); assert.equal(s.skinsEnabled, false);
  assert.equal(visibleSkin(SKIN, { skinsEnabled: true }), SKIN);
  for (const settings of [undefined, {}, { skinsEnabled: false }, { skinsEnabled: 'true' }]) {
    assert.equal(visibleSkin(SKIN, settings), null, 'both own and other players fall back');
  }
  assert.equal(visibleOperatorSkin(SKIN, { skinsEnabled: false }, 'self', 'self'), SKIN);
  assert.equal(visibleOperatorSkin(SKIN, { skinsEnabled: false, otherSkins: false }, 'other', 'self'), null);
  assert.equal(visibleOperatorSkin(SKIN, { skinsEnabled: false, otherSkins: true }, 'other', 'self'), SKIN);
});

test('official opt-out preserves local choices while plugin choices stay published', async (t) => {
  const e = syncEnv(); t.after(e.sync.dispose);
  await e.sync.flush();
  assert.deepEqual(e.calls, [{ t: 'room.skins', skins: { [OPERATOR]: SKIN } }]);
  e.settings.set({ skinsEnabled: true }); await turn();
  assert.deepEqual(e.calls.at(-1).skins, { [CHESS]: SKIN, [OPERATOR]: SKIN });
  e.settings.set({ skinsEnabled: false }); await turn();
  assert.deepEqual(e.calls.at(-1).skins, { [OPERATOR]: SKIN });
  assert.deepEqual(e.target.get()[SKINS_KEY], { [CHESS]: SKIN, [OPERATOR]: SKIN }, 'opt-out does not clear selections');
  e.handlers.get('welcome')(); await e.sync.flush();
  assert.deepEqual(e.calls.at(-1).skins, { [OPERATOR]: SKIN });
  const n = e.calls.length;
  e.settings.set({ voice: 0.5 }); await turn();
  assert.equal(e.calls.length, n, 'unrelated settings do not send skin messages');
});

test('a late opt-in reply cannot overwrite a newer opt-out; rate-limited opt-out retries', async (t) => {
  const e = syncEnv(true); t.after(e.sync.dispose);
  const replies = [];
  e.net.request = (type, body) => { e.calls.push(body); return new Promise((resolve, reject) => replies.push({ resolve, reject })); };
  const old = e.sync.flush();
  e.settings.set({ skinsEnabled: false });
  await turn();
  assert.equal(e.calls.length, 2);
  assert.deepEqual(e.calls[1].skins, { [OPERATOR]: SKIN });
  replies[1].reject({ code: 'RATE' }); await turn();
  assert.equal(e.target.get()[SKINS_SYNC_KEY], 'pending');
  replies[0].resolve(); await old;
  assert.equal(e.target.get()[SKINS_SYNC_KEY], 'pending');
  const retry = e.sync.flush(); await turn(); replies[2].resolve(); await retry;
  assert.deepEqual(e.calls.at(-1).skins, { [OPERATOR]: SKIN });
  assert.equal(e.target.get()[SKINS_SYNC_KEY], 'synced');
});

test('preference sanitising caps wire size, rejects prototype keys and filters non-base chess', () => {
  const big = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`chess_${i}`, SKIN]));
  assert.equal(Object.keys(cleanSkins(big)).length, SKIN_LIMITS.entries);
  assert.deepEqual(cleanSkins(JSON.parse('{"__proto__":"char_x@s#1","constructor":"char_x@s#1","x":"bad/id"}')), {});
  const chess = { good: {}, hidden: { visible: false }, golden: { isGolden: true }, diy: { isDiy: true }, alias: { baseId: 'good' } };
  assert.deepEqual(freezeSkins(Object.fromEntries(Object.keys(chess).map((id) => [id, SKIN])), (id) => chess[id]), { good: SKIN });
});

test('picker offers only deployed models, uses operator ids and clears only one selection', (t) => {
  const old = skinsStore.get()[SKINS_KEY]; t.after(() => skinsStore.set({ [SKINS_KEY]: old }));
  const get = data.get; t.after(() => { data.get = get; });
  data.get = () => ({ chars: { char_498_inside: { skins: { [SKIN]: {
    name: 'Outfit', group: 'Series', avatar: '/skin.png', spine: { front: { skel: '/skin.skel' } },
  } } } } });
  assert.deepEqual(availableSkins('char_498_inside').map(({ id, name, group, playable }) => ({ id, name, group, playable })), [
    { id: '', name: '', group: '', playable: true },
    { id: SKIN, name: 'Outfit', group: 'Series', playable: true },
  ]);
  assert.deepEqual(availableSkins(CHESS), []);
  setSkin(CHESS, SKIN); setSkin('another', SKIN); clearSkin(CHESS);
  assert.equal(skinsStore.get()[SKINS_KEY][CHESS], undefined);
  assert.equal(skinsStore.get()[SKINS_KEY].another, SKIN);
});

test('picker/catalogue are lazy and both renderer paths honour the viewer setting without local-owner leakage', () => {
  const picker = read('public/js/ui/skinPicker.js');
  assert.match(picker, /if \(!settings.skinsEnabled\)/);
  assert.match(picker, /function OfficialSkinSection[\s\S]*useData\('skins', 'assets'\)/);
  assert.doesNotMatch(picker, /setInterval|room\.skin\.install/);
  assert.match(read('public/js/screens/loadout.js'), /<\$\{SkinSection\} chess=\$\{chess\}/);
  const app = read('public/js/render/app.js');
  assert.match(app, /skin: si \|\| dr \? null : piece.skin \|\| null/);
  assert.doesNotMatch(app, /skinFor/);
  assert.match(app, /for \(const v of views.values\(\)\) v.refreshSkin\?\.\(\)/);
  const fallback = read('public/js/ui/fallbackField.js');
  assert.match(fallback, /visibleOperatorSkin\(p.skin, st.settings\)/);
  assert.match(fallback, /unitArt\(m\(\), info, st.settings, st.myPlayerId, st.playerSkins\)/);
});
