// All gameplay portraits follow the operator's owner and the viewer's skin switch.
import { html } from './components.js';
import { Img } from './gameComponents.js';
import { chessPortraitUrl } from './assetUrls.js';
import { useStore } from '../store.js';
import { SKINS_KEY, skinsStore } from './skins.js';
import { settingsStore } from './settings.js';
import { visibleOperatorSkin, visibleSkin } from '../../../shared/skins.js';

export function portraitSkin(chess, { state, entries, settings, ownerId, skin } = {}) {
  if (!chess || chess.isDiy || chess.isHidden || chess.standInFor) return null;
  const myId = state?.me?.playerId;
  const owner = ownerId === undefined ? myId : ownerId;
  if (skin !== undefined) return visibleOperatorSkin(skin, settings, owner, myId);
  const id = chess.baseId || chess.chessId;
  const player = state?.match?.public?.players?.find((p) => p.playerId === owner);
  if (player?.isBot) return null;
  // An explicit foreign owner must never inherit this browser's selection.
  const localOwner = ownerId === undefined || (owner != null && owner === myId);
  const plugin = player ? player.operatorSkins?.[chess.charId] : localOwner ? entries?.[chess.charId] : null;
  const shownPlugin = visibleOperatorSkin(plugin, settings, owner, myId);
  if (shownPlugin) return shownPlugin;
  const official = player ? player.skins?.[id] : localOwner ? entries?.[id] : null;
  return visibleSkin(official, settings);
}

export function OperatorPortrait({ m, chess, ownerId, skin, fallback = null, ...props }) {
  const id = chess?.baseId || chess?.chessId;
  const enabled = useStore((s) => s.skinsEnabled, undefined, settingsStore);
  const otherSkins = useStore((s) => s.otherSkins !== false, undefined, settingsStore);
  const entries = useStore((s) => s[SKINS_KEY] || {}, undefined, skinsStore);
  // Subscribe to this portrait's resolved choice, so unrelated snapshots do not redraw every roster image.
  const selected = useStore((state) => portraitSkin(chess, {
    state, entries, settings: { skinsEnabled: enabled, otherSkins }, ownerId, skin,
  }));
  const base = chessPortraitUrl(m, chess);
  const src = chessPortraitUrl(m, chess, { skin: selected });
  return html`<${Img} ...${props} src=${src} fallback=${src !== base
    ? html`<${Img} ...${props} src=${base} fallback=${fallback} />` : fallback} />`;
}
