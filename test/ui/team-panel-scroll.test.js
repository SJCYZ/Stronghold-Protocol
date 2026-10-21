import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const gameCss = postcss.parse(read('public/css/screens/game.css'));

function declarations(selector) {
  const rule = gameCss.nodes.find((node) => node.type === 'rule' && node.selector === selector);
  assert.ok(rule, `${selector} rule exists`);
  return Object.fromEntries(rule.nodes.filter((node) => node.type === 'decl').map(({ prop, value }) => [prop, value]));
}

test('shared game player list stays scrollable when the viewport cannot fit every player', () => {
  const team = declarations('.team');
  assert.equal(team['overflow-y'], 'auto');
  assert.match(team['max-height'], /^calc\(100% - .+\)$/);
  assert.equal(team['pointer-events'], 'auto', 'the native scrollbar can receive pointer input');
  assert.match(read('public/js/screens/game.js'), /<\$\{TeamPanel\}/, 'game phases use the shared player list');
});
