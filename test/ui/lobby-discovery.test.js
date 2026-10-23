import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LobbyDiscoveryView } from '../../public/js/ui/lobbyDiscovery.js';

function* walk(v) {
  if (Array.isArray(v)) { for (const x of v) yield* walk(x); return; }
  if (!v || typeof v !== 'object') return;
  yield v; yield* walk(v.props?.children);
}

test('leaderboards show exact titles and room buttons send existing join and spectate intents', async () => {
  const sent = [];
  const tree = LobbyDiscoveryView({ rooms: [{ code: 'ABCD', host: '房主', occupied: 2, capacity: 4,
    difficultyName: '险境模拟', inMatch: false, phase: 'LOBBY', round: 0, joinable: true, watchable: true,
    spectators: 0, spectatorCapacity: 2 }], leaderboards: { cups: [{ name: '甲', value: 9 }], leaks: [{ name: '乙', value: 4 }] },
    request: async (type, body) => { sent.push([type, body]); } });
  const nodes = [...walk(tree)];
  assert.ok(nodes.some((node) => node.type === 'h2' && node.props.children === '！？强强？！'));
  assert.ok(nodes.some((node) => node.type === 'h2' && node.props.children === '！？区区？！'));
  const joinButton = nodes.find((node) => node.props?.['data-action'] === 'join');
  const watchButton = nodes.find((node) => node.props?.['data-action'] === 'spectate');
  await joinButton.props.onClick();
  await watchButton.props.onClick();
  assert.deepEqual(sent, [['room.join', { code: 'ABCD' }], ['room.spectate', { code: 'ABCD' }]]);
});

test('full rooms hide actions when their availability flags are false', () => {
  const tree = LobbyDiscoveryView({ rooms: [{ code: 'ABCD', host: '房主', occupied: 4, capacity: 4,
    difficultyName: '标准模拟', inMatch: true, phase: 'COMBAT', round: 3, joinable: false, watchable: false,
    spectators: 2, spectatorCapacity: 2 }], leaderboards: { cups: [], leaks: [] }, request: async () => {} });
  const actions = [...walk(tree)].filter((node) => node.props?.['data-action']).map((node) => node.props['data-action']);
  assert.deepEqual(actions, []);
});
