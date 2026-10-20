// The settlement flow's local trophy total and card helpers (screens/settle.js), without an account or XP system.
// The pages themselves: test/ui/mock.e2e.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
globalThis.fetch = async (url) => {
  const name = String(url).split('/').pop();
  try {
    const body = readFileSync(path.join(ROOT, 'data', name), 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  } catch {
    return { ok: false, status: 404, json: async () => ({}) };
  }
};

const S = await import('../../public/js/screens/settle.js');
const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).getTime();

test('the result flow marks test matches and keeps its existing local trophy total', () => {
  const src = readFileSync(new URL('../../public/js/screens/settle.js', import.meta.url), 'utf8');
  assert.match(src, /<\$\{SettleTestMark\} res=\$\{res\} \/><\/div>/, 'the personal report');
  assert.match(src, /steam__tags[^\n]*<\$\{SettleTestMark\} res=\$\{res\} \/>/, 'the alliance page');
  assert.match(src, /counted: !isTest && !isModdedRoom/);
  assert.match(src, /function trophyTotal\(records/);
  assert.match(src, /trophies: trophyTotal\(ctx\.records/);
  assert.doesNotMatch(src, /LevelStrip|levelProgress|accountApi|fetch\(|net\.request/);
});

test('the card helpers: elite level by tier, the ace, time and date, a row\'s own outcome', () => {
  assert.deepEqual(S.opLevel(1, false), { phase: 1, level: 55 });
  assert.deepEqual(S.opLevel(2, true), { phase: 2, level: 55 });
  assert.deepEqual(S.opLevel(5, false), { phase: 2, level: 1 });
  assert.deepEqual(S.opLevel(6, true), { phase: 2, level: 60 });
  const lineup = [{ id: 'a', tier: 4 }, { id: 'b', tier: 5 }, { id: 'c', tier: 5, golden: true }, { id: 't', tier: 6, kind: 'token' }];
  assert.equal(S.aceOf(lineup).id, 'c', 'the highest tier, elite first; a token never');
  assert.equal(S.aceOf([]), null);
  assert.equal(S.fmtDuration(52 * 60000), '00时52分00秒');
  assert.equal(S.fmtDuration(3723000), '01时02分03秒');
  assert.equal(S.fmtDuration(null), '—');
  assert.equal(S.fmtDate(at(16, 7, 5)), '2026/10/16 07:05');
  assert.equal(S.fmtDate('nope'), '—');
  assert.equal(S.rowCleared({ victory: false }, { alive: true }, true), false, 'the server\'s per-row outcome first');
  assert.equal(S.rowCleared(null, { alive: true }, true), true);
  assert.equal(S.rowCleared(null, { alive: false }, true), false);
  assert.equal(S.rowCleared(null, { left: true }, true), false);
});

test('the stylesheet keeps to the project\'s rules', () => {
  const css = readFileSync(path.join(ROOT, 'public/css/screens/settle.css'), 'utf8');
  assert.doesNotMatch(css, /!important/);
  assert.doesNotMatch(css, /:has\(/);
  assert.doesNotMatch(css, /--t\s*:/, 'the text size setting (--t) is followed, not reset');
  const js = readFileSync(path.join(ROOT, 'public/js/screens/settle.js'), 'utf8');
  assert.equal(js.match(/data-ui-slot="result\.tab"/g)?.length, 1, 'one 结算 tab plugin slot (the team page); the detail view drops its own');
  assert.match(js, /slot=\$\{false\}/);
});
