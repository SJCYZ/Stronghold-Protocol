import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html } from './components.js';
import { net } from '../net.js';
import { t } from '../../../shared/i18n.js';

const REFRESH_MS = 30000;

export function LobbyDiscoveryView({ rooms = [], leaderboards = { cups: [], leaks: [] }, request = net.request }) {
  const board = (title, rows, suffix) => html`<section class="lobby-discovery__board">
    <h2>${title}</h2>
    ${rows.length ? html`<ol>${rows.slice(0, 10).map((row, i) => html`<li key=${`${title}-${i}`}><span>${i + 1}. ${row.name}</span><b>${row.value}${suffix}</b></li>`)}</ol>`
      : html`<p class="lobby-discovery__empty">${t('暂无记录')}</p>`}
  </section>`;
  return html`<section class="lobby-discovery" aria-label=${t('排行榜与合作房间')}>
    <div class="lobby-discovery__boards">
      ${board('！？强强？！', leaderboards.cups || [], t('杯'))}
      ${board('！？区区？！', leaderboards.leaks || [], t('漏怪'))}
    </div>
    <section class="lobby-discovery__rooms">
      <h2>${t('在线合作房间')}</h2>
      ${rooms.length ? html`<ul>${rooms.map((room) => html`<li key=${room.code}>
        <div class="lobby-discovery__room-main"><b class="num">${room.code}</b><span>${room.host || t('等待房主')}</span>
          <small>${room.occupied}/${room.capacity} · ${room.difficultyName}${room.inMatch ? ` · ${room.phase} ${room.round}` : ''}</small></div>
        <div class="lobby-discovery__actions">
          ${room.joinable ? html`<button type="button" data-action="join" onClick=${() => request('room.join', { code: room.code })}>${t('参与')}</button>` : null}
          ${room.watchable ? html`<button type="button" data-action="spectate" onClick=${() => request('room.spectate', { code: room.code })}>${t('观战')}</button>` : null}
        </div>
      </li>`)}</ul>` : html`<p class="lobby-discovery__empty">${t('当前没有开放的合作房间')}</p>`}
    </section>
  </section>`;
}

export function LobbyDiscovery({ request = net.request }) {
  const [rooms, setRooms] = useState([]);
  const [leaderboards, setLeaderboards] = useState({ cups: [], leaks: [] });
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const [roomResult, boardResult] = await Promise.allSettled([
        fetch('/api/rooms', { cache: 'no-store' }).then((res) => res.ok ? res.json() : null),
        fetch('/api/leaderboards', { cache: 'no-store' }).then((res) => res.ok ? res.json() : null),
      ]);
      if (!active) return;
      if (roomResult.status === 'fulfilled' && Array.isArray(roomResult.value?.rooms)) setRooms(roomResult.value.rooms);
      if (boardResult.status === 'fulfilled' && Array.isArray(boardResult.value?.cups) && Array.isArray(boardResult.value?.leaks)) {
        setLeaderboards({ cups: boardResult.value.cups, leaks: boardResult.value.leaks });
      }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, REFRESH_MS);
    return () => { active = false; clearInterval(timer); };
  }, []);
  return LobbyDiscoveryView({ rooms, leaderboards, request });
}
