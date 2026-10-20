import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../../server/lobby.js';
import { SessionRegistry } from '../../server/net.js';
import { StubMatch } from '../../server/match/StubMatch.js';
import { wireOptions } from '../../server/match/host/proxy.js';

class RecordingMatch extends StubMatch {
  static options = null;
  constructor(options) { super(options); RecordingMatch.options = options; }
}

function startRoom(pluginIds) {
  const lobby = new Lobby({
    registry: new SessionRegistry(),
    MatchClass: RecordingMatch,
    content: { cs: 'ab'.repeat(32) },
  });
  const host = { playerId: 'p_host', name: 'Host', connected: true, roomCode: null, ws: null };
  assert.deepEqual(lobby.create(host, { mode: 'solo', difficulty: 'NORMAL' }), { ok: true });
  const room = lobby.getRoom(host.roomCode);
  if (pluginIds.length) {
    room.content = Object.freeze({
      cs: 'cd'.repeat(32), vanilla: false,
      plugins: Object.freeze(pluginIds.map((id) => Object.freeze({ id, class: 'script', version: '1.0.0' }))),
      modes: Object.freeze([]),
    });
  }
  const result = lobby.startMatchWithLocal(room, null, null);
  assert.deepEqual(result, { ok: true });
  return { lobby, room };
}

test('lobby derives host speed permission from the selected room plugin and preserves it in plugin-host options', () => {
  const vanilla = startRoom([]);
  assert.equal(RecordingMatch.options.hostSpeedEnabled, false);
  vanilla.lobby.shutdown();

  const selected = startRoom(['other-plugin', 'combat-speed']);
  assert.equal(RecordingMatch.options.hostSpeedEnabled, true);
  assert.equal(wireOptions(RecordingMatch.options).hostSpeedEnabled, true, 'the plugin Host forwards the option to its Match');
  selected.lobby.shutdown();
});
