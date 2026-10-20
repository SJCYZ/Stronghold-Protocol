import { test } from 'node:test';
import assert from 'node:assert/strict';

const run = process.env.SP_PLUGIN_TEST_SET ? {} : { skip: 'run with node tools/plugin.mjs test combat-speed' };

test('the room plugin registers a clock controller without replacing the host-selected speed', run, async () => {
  const { getCombatClockController } = await import('../../../server/sim/content/extensions.js');
  const controller = getCombatClockController();
  assert.equal(controller?.plugin.id, 'combat-speed');
  assert.equal(typeof controller?.onPhase, 'function');
  const changes = [];
  controller.onPhase({ setSpeed: (speed) => changes.push(speed) });
  assert.deepEqual(changes, []);
});
