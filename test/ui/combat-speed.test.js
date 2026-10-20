import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('combat speed HUD is a compact host-only range control with final-value commits', async () => {
  const [hud, game, actions, css] = await Promise.all([
    read('../../public/js/ui/hud.js'), read('../../public/js/screens/game.js'),
    read('../../public/js/ui/gameActions.js'), read('../../public/css/screens/game.css'),
  ]);
  assert.match(hud, /type="range"[^>]*min="0\.1"[^>]*max="4"[^>]*step="0\.1"/);
  assert.match(hud, /canEdit=\$\{isHost\}/);
  assert.match(hud, /disabled=\$\{disabled\}/);
  assert.match(hud, /onPointerUp/);
  assert.match(hud, /onKeyUp/);
  assert.match(hud, /onBlur/);
  assert.match(hud, /useEffect\(\(\) => \{ draftRef\.current = confirmed; committedRef\.current = null; setDraft\(confirmed\); \}, \[confirmed\]\)/, 'a newer server-confirmed speed replaces a local draft');
  assert.match(hud, /accepted === false[\s\S]*confirmedRef\.current/);
  assert.match(game, /onSpeed=\$\{actions\.speed\}/);
  assert.match(actions, /speed: \(speed\) => act\('g\.speed', \{ speed \}, \{ sfx: false \}\)/);
  assert.match(css, /\.combat-speed/);
  const mobile = css.match(/@media \(max-width: 760px\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(mobile, /\.gtop__right \{ max-width: 25vw; \}/);
  assert.match(mobile, /\.combat-speed \{ width: min\(1\.2rem, 25vw\)/);
  assert.match(css, /\.combat-speed \{[^}]*min-width: 0/);
});

test('combat speed control only appears for active combat and stays disabled while paused or for guests', async () => {
  const [hud, game] = await Promise.all([read('../../public/js/ui/hud.js'), read('../../public/js/screens/game.js')]);
  assert.match(hud, /isCombatPhase\(phase\) \? html`<\$\{CombatSpeedControl\}/);
  assert.match(hud, /paused=\$\{speedPaused\}/);
  assert.match(game, /specFacts\.isHost/);
  assert.match(game, /speedPaused=\$\{paused\}/);
  assert.match(game, /field\?\.speed \?\? battleState\?\.speed/);
});

test('all four UI dictionaries contain the localized combat-speed label', async () => {
  const locales = ['en', 'ja', 'ko', 'zh-TW'];
  const entries = await Promise.all(locales.map(async (locale) => [locale, JSON.parse(await read(`../../public/i18n/${locale}.json`))]));
  for (const [locale, dictionary] of entries) {
    assert.ok(Object.hasOwn(dictionary, '战斗速度'), `${locale} dictionary has the translated label`);
    assert.ok(dictionary['战斗速度'].trim());
  }
});
