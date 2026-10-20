import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { PHASE } from '../../shared/constants.js';
import { isCombatPhase } from '../../public/js/ui/gameLogic.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const CHROME = process.env.CHROME_PATH || (process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const BROWSER_TESTS = process.env.SP_E2E === '1' && existsSync(CHROME);

test('a COMBAT phase without a matching live field is inactive for speed changes', async () => {
  const { isActiveCombatSpeedField } = await import('../../public/js/ui/hud.js');
  assert.equal(typeof isActiveCombatSpeedField, 'function');
  assert.equal(isCombatPhase(PHASE.COMBAT), true);
  assert.equal(isActiveCombatSpeedField(null, null), false);
  assert.equal(isActiveCombatSpeedField({ battleId: 'b1', live: false }, { battleId: 'b1' }), false);
  assert.equal(isActiveCombatSpeedField({ battleId: 'b1', live: true }, { battleId: 'b2' }), false);
  assert.equal(isActiveCombatSpeedField({ battleId: 'b1', live: true }, { battleId: 'b1', loading: true }), false);
  assert.equal(isActiveCombatSpeedField({ battleId: 'b1', live: true }, { battleId: 'b1', done: true }), false);
  assert.equal(isActiveCombatSpeedField({ battleId: 'b1', live: true }, { battleId: 'b1' }), true);
  assert.match(await read('../../public/js/screens/game.js'), /speedActive=\$\{isActiveCombatSpeedField\(field, battleState\)\}/);
});

test('the room-selected combat-speed plugin gates the native HUD slider', async () => {
  const { hasCombatSpeedPlugin } = await import('../../public/js/ui/hud.js');
  assert.equal(hasCombatSpeedPlugin(null), false);
  assert.equal(hasCombatSpeedPlugin({ content: { plugins: [] } }), false);
  assert.equal(hasCombatSpeedPlugin({ content: { plugins: [{ id: 'other-plugin' }] } }), false);
  assert.equal(hasCombatSpeedPlugin({ content: { plugins: [{ id: 'combat-speed', class: 'cosmetic' }] } }), false);
  assert.equal(hasCombatSpeedPlugin({ content: { plugins: [{ id: 'combat-speed', class: 'script' }] } }), true);
  assert.match(await read('../../public/js/screens/game.js'), /speedEnabled=\$\{speedPluginEnabled\}/);
  assert.match(await read('../../public/js/ui/hud.js'), /\$\{speedEnabled && isCombatPhase\(phase\)[\s\S]*?<\$\{CombatSpeedControl\}/);
});

describe('combat speed control mounted in headless Chrome', { skip: !BROWSER_TESTS && 'set SP_E2E=1 and have Chrome to run' }, () => {
  let server;
  let browser;
  let base;

  before(async () => {
    const { startServer } = await import('../../server/index.js');
    const puppeteer = (await import('puppeteer-core')).default;
    server = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    base = `http://127.0.0.1:${server.port}`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--no-proxy-server'] });
  });

  after(async () => { await browser?.close(); await server?.close(); });

  test('host pointer, keyboard and blur commits; guest, paused and inactive states are read-only', async () => {
    const page = await browser.newPage();
    try {
      page.setDefaultTimeout(8000);
      await page.setViewport({ width: 1280, height: 720 });
      await page.goto(`${base}/dev/uikit.html`, { waitUntil: 'domcontentloaded' });
      await page.evaluate(async () => {
        const { render } = await import('/vendor/preact.module.js');
        const { useState } = await import('/vendor/hooks.module.js');
        const { html } = await import('/js/ui/components.js');
        const { CombatSpeedControl } = await import('/js/ui/hud.js');
        function Harness() {
          const [speed, setSpeed] = useState(2);
          const [canEdit, setCanEdit] = useState(true);
          const [active, setActive] = useState(true);
          const [paused, setPaused] = useState(false);
          const [reject, setReject] = useState(false);
          const [sent, setSent] = useState([]);
          const onSpeed = async (value) => {
            setSent((all) => [...all, value]);
            return reject ? false : true;
          };
          window.__combatSpeedHarness = { setSpeed, setCanEdit, setActive, setPaused, setReject, sent: () => sent };
          return html`<div>
            <${CombatSpeedControl} speed=${speed} canEdit=${canEdit} active=${active} paused=${paused} onSpeed=${onSpeed} />
            <button id="outside">outside</button><output id="sent">${sent.join(',')}</output>
          </div>`;
        }
        render(html`<${Harness} />`, document.getElementById('kit'));
      });

      const input = 'input[type="range"][aria-label="战斗速度"]';
      const setDraft = async (value) => page.$eval(input, (el, v) => {
        el.value = String(v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, value);
      const sent = () => page.$eval('#sent', (el) => el.textContent ? el.textContent.split(',').map(Number) : []);
      const value = () => page.$eval(input, (el) => Number(el.value));

      assert.equal(await page.$eval(input, (el) => el.disabled), false, 'active host can edit');
      assert.deepEqual(await page.$eval(input, (el) => [el.min, el.max, el.step]), ['0.1', '4', '0.1']);
      await setDraft(3.2);
      assert.deepEqual(await sent(), [], 'draft stays local until the pointer interaction ends');
      await page.$eval(input, (el) => el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 2 })));
      await page.waitForFunction(() => document.querySelector('#sent')?.textContent === '3.2');
      await page.$eval(input, (el) => el.focus());
      await page.click('#outside');
      assert.deepEqual(await sent(), [3.2], 'blur after pointer release does not submit twice');

      await page.focus(input);
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => document.querySelector('#sent')?.textContent === '3.2,3.3');
      assert.deepEqual(await sent(), [3.2, 3.3], 'keyboard interaction commits on keyup');

      await page.evaluate(() => window.__combatSpeedHarness.setSpeed(1.7));
      await page.waitForFunction(() => document.querySelector('input[type="range"]')?.value === '1.7');
      assert.equal(await value(), 1.7, 'new server-confirmed speed replaces the draft');

      await setDraft(2.0);
      await page.focus(input);
      await page.focus('#outside');
      await page.waitForFunction(() => document.querySelector('#sent')?.textContent === '3.2,3.3,2');
      assert.deepEqual(await sent(), [3.2, 3.3, 2], 'blur commits an unfinished keyboard or pointer draft');

      await page.evaluate(() => window.__combatSpeedHarness.setReject(true));
      await setDraft(2.4);
      await page.$eval(input, (el) => el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 3 })));
      await page.waitForFunction(() => window.__combatSpeedHarness.sent().length === 4 && document.querySelector('input[type="range"]')?.value === '1.7');
      assert.equal(await value(), 1.7, 'rejection restores the latest confirmed speed');

      await page.evaluate(() => window.__combatSpeedHarness.setReject(false));
      for (const [flag, expected, disabledExpected] of [
        ['setCanEdit', false, true], ['setCanEdit', true, false], ['setPaused', true, true],
        ['setPaused', false, false], ['setActive', false, true],
      ]) {
        await page.evaluate(([name, state]) => window.__combatSpeedHarness[name](state), [flag, expected]);
        await page.waitForFunction((disabled) => document.querySelector('input[type="range"]')?.disabled === disabled, {}, disabledExpected);
        const disabled = await page.$eval(input, (el) => el.disabled);
        assert.equal(disabled, disabledExpected, `${flag}=${expected} sets the disabled state`);
      }
      const before = await sent();
      await setDraft(2.8);
      await page.$eval(input, (el) => el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 4 })));
      assert.deepEqual(await sent(), before, 'inactive combat cannot submit a speed intent');
    } finally { await page.close(); }
  });
});

test('all four UI dictionaries contain the localized combat-speed label', async () => {
  const locales = ['en', 'ja', 'ko', 'zh-TW'];
  const entries = await Promise.all(locales.map(async (locale) => [locale, JSON.parse(await read(`../../public/i18n/${locale}.json`))]));
  for (const [locale, dictionary] of entries) {
    assert.ok(Object.hasOwn(dictionary, '战斗速度'), `${locale} dictionary has the translated label`);
    assert.ok(dictionary['战斗速度'].trim());
  }
});

test('the narrow top bar constrains its speed control to the right viewport column', async () => {
  const css = await read('../../public/css/screens/game.css');
  const mobile = css.match(/@media \(max-width: 760px\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(mobile, /\.gtop__right \{ max-width: 25vw; \}/);
  assert.match(mobile, /\.combat-speed \{ width: min\(1\.2rem, 25vw\)/);
  assert.match(css, /\.combat-speed \{[^}]*min-width: 0/);
});

test('combat speed slider track is slightly larger', async () => {
  const css = await read('../../public/css/screens/game.css');
  assert.match(css, /\.combat-speed input \{[^}]*height: \.2rem;/);
});
