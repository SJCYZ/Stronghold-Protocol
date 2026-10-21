// Emotes (交流, research 09 §4): the 36 official in-match emotes of 盟约 — 6 themes × 6 (shared/constants.js
// EMOTE_THEMES / EMOTES, generated reference data/emotes.json). Official emotes are pictures only: nothing here ever
// renders an emote's text (our labels are aria-labels only).
//
//   EmoteArt    the emote picture: the local-client art (data/local-assets.json → emoticon/<dir>/<picId>) first, else
//               the copy setup downloads from the public mirror (data/assets.json → ui['emoticon/<dir>/<picId>'];
//               GitHub issue #42), each tried in turn when one fails to load; a neutral glyph when neither is there.
//               An empty box only while a manifest is still in flight; a timeout or a failed manifest (GitHub #99)
//               uses that glyph, and a later success replaces it.
//   EmoteBubble the pop bubble beside the sender's avatar in the team panel (official emoji_bubble_bkg: a dark rounded
//               square with a tail pointing left + the icon only); pop-in, 3 s, fade. The parent keys it by the emote's
//               seq so a newer emote replaces the old one and pops again, and passes the arrival time (`at`) so a
//               bubble mounted late resumes its timeline instead of restarting it.
//   EmoteWheel  bottom-left 交流 button (official emoji_btn / emoji_btn_disable) + panel (emoji_bkg): one page per theme
//               with 3×2 cells (emoji_cell_bkg), pager dots, arrow keys and buttons to change the page. The panel
//               reopens on the theme of the last emote sent (localStorage). Sending closes the panel and greys
//               the button for the 1 s cooldown (chatCD), counted from the send so a remount keeps it.
// Official UI sprites come from the local ui/battle extraction when present; CSS draws look-alikes otherwise.
// Styles: public/css/emotes.css (injected on first use when the page does not link it).

import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { EMOTE_THEMES, EMOTE_COOLDOWN_MS, EMOTE_BUBBLE_MS, emoteInfo, emoteArtGroup } from '../../../shared/constants.js';
import { html } from './components.js';
import { GIcon } from './gameComponents.js';
import { data, useData, localAsset, artUrls, nextArtUrl } from '../data.js';
import { loadPref, savePref } from '../store.js';
import { t } from '../../../shared/i18n.js';
import { CHAT_MAX_LENGTH, chatLength, truncateChat, validChatText } from '../../../shared/chat.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

export const EMOTE_CSS_HREF = '/css/emotes.css';
const PREF_THEME = 'emoteTheme';

// Time of the last send, shared by every wheel on the page: the 1 s cooldown survives a remount of the wheel (the
// server enforces chatCD too and silently drops an emote sent early).
let lastSentAt = -Infinity;

/** Link public/css/emotes.css once when the host page does not (dev harnesses); no-op outside a browser. */
export function ensureEmoteCss(doc = globalThis.document) {
  if (!doc?.head || typeof doc.querySelector !== 'function') return false;
  if (doc.querySelector(`link[rel="stylesheet"][href$="${EMOTE_CSS_HREF}"]`)) return false;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = EMOTE_CSS_HREF;
  doc.head.appendChild(link);
  return true;
}

/**
 * URLs of an emote's official art, best first: the local-client picture, then the mirror copy (data.js artUrls). Empty
 * when the id is unknown or neither manifest lists the picture (a path that is not listed is never requested).
 * @param {string} id official emoji id
 * @returns {string[]}
 */
export function emoteArtUrls(id) {
  const e = emoteInfo(id);
  return e ? artUrls(emoteArtGroup(id), e.picId) : [];
}

/**
 * URL of an emote's official art (the first of emoteArtUrls), or null.
 * @param {string} id official emoji id
 */
export function emoteArtUrl(id) {
  return emoteArtUrls(id)[0] || null;
}

/** True while local or assets is still in flight (idle or loading). A timeout or a failure is `missing`: the glyph. */
const artManifestsPending = () => ['local', 'assets'].some((n) => { const st = data.status(n); return st === 'loading' || st === 'idle'; });

/** Official emote UI sprite (ui/battle: emoji_bubble_bkg, emoji_bkg, emoji_cell_bkg, emoji_btn, emoji_btn_disable). */
export const emoteUiSprite = (name) => localAsset('ui/battle', name);

/** Index of a theme in the wheel (0 when unknown). */
export function themeIndex(themeId) {
  const i = EMOTE_THEMES.findIndex((t) => t.themeId === themeId);
  return i < 0 ? 0 : i;
}

/** Wheel page to open on: the theme of the last emote sent (remembered in localStorage), else the first. */
export function lastThemeIndex() {
  const v = loadPref(PREF_THEME, null);
  return typeof v === 'string' ? themeIndex(v) : 0;
}

/** Remember the theme of a sent emote. */
export function rememberTheme(themeId) {
  if (EMOTE_THEMES.some((t) => t.themeId === themeId)) savePref(PREF_THEME, themeId);
}

/** Clamp a page index into the wheel. */
export const clampPage = (i) => Math.max(0, Math.min(EMOTE_THEMES.length - 1, Math.trunc(Number(i)) || 0));

/**
 * Cooldown left (ms) of the 交流 button after a send at `sentAt` (chatCD).
 * @param {number} sentAt
 * @param {number} now
 * @param {number} [cooldownMs]
 */
export function cooldownLeft(sentAt, now, cooldownMs = EMOTE_COOLDOWN_MS) {
  const left = sentAt + cooldownMs - now;
  return left > 0 && left <= cooldownMs ? left : 0; // a clock that went backwards never locks the button
}

/**
 * Age (ms) of a bubble received at `at` — so a bubble mounted late (the team panel re-rendered from scratch) resumes
 * its animation instead of popping in again for a full chatTime. 0 when unknown.
 * @param {number|undefined} at receipt time (Date.now() clock)
 * @param {number} now
 * @param {number} ttl
 */
export function bubbleAge(at, now, ttl = EMOTE_BUBBLE_MS) {
  const age = Number.isFinite(at) && Number.isFinite(now) ? now - at : 0;
  return age > 0 ? Math.min(age, Math.max(0, ttl)) : 0;
}

/** Neutral stand-in for a missing emote picture (a glyph, never text). */
function EmoteGlyph({ class: cls }) {
  return html`<span class=${cx('eart', 'eart--glyph', cls)} aria-hidden="true"><${GIcon} name="emote" /></span>`;
}

/**
 * Official emote picture (the local-client art, else the mirror copy; the next one when a picture fails to load);
 * neutral glyph when unavailable.
 * @param {{ id: string, class?: string }} props
 */
export function EmoteArt({ id, class: cls }) {
  useData('local', 'assets');
  const [bad, setBad] = useState(() => new Set()); // URLs that failed to load
  const src = nextArtUrl(emoteArtUrls(id), bad);
  if (src) {
    return html`<img key=${src} class=${cx('eart', cls)} src=${src} alt="" draggable=${false} decoding="async"
      onError=${() => setBad((s) => new Set(s).add(src))} />`;
  }
  if (emoteInfo(id) && artManifestsPending()) return html`<span class=${cx('eart', 'eart--pending', cls)} aria-hidden="true"></span>`;
  return html`<${EmoteGlyph} class=${cls} />`;
}

/**
 * Pop bubble (official picture, or plain chat text) beside the sender's avatar. Unknown ids show the neutral glyph. Key it by the emote's seq
 * (a newer emote replaces the bubble and pops again).
 * @param {{ id?: string, text?: string, class?: string, ttl?: number, at?: number }} props ttl = display time in ms (fade-out at the
 *   end); at = when the emote arrived (Date.now() clock): a bubble mounted after that resumes its pop / fade timeline
 *   instead of restarting it.
 */
export function EmoteBubble({ id, text, class: cls, ttl = EMOTE_BUBBLE_MS, at }) {
  useData('local');
  useEffect(() => { ensureEmoteCss(); }, []);
  const life = Math.max(300, Number(ttl) || EMOTE_BUBBLE_MS);
  const [age] = useState(() => bubbleAge(at, Date.now(), life)); // fixed at mount: the CSS animation runs from there
  const bg = emoteUiSprite('emoji_bubble_bkg');
  const e = emoteInfo(id);
  const style = [`--ebubble-ttl:${life}ms`, age && `--ebubble-age:${Math.round(age)}ms`, bg && `--ebubble-bg:url("${bg}")`].filter(Boolean).join(';');
  if (validChatText(text)) return html`<div class=${cx('ebubble', 'ebubble--chat', cls)} style=${style} role="status">
    ${text}
  </div>`;
  return html`<div class=${cx('ebubble', bg && 'has-sprite', cls)} style=${style} role="img"
    aria-label=${e ? t(e.label) : t('表情')} data-emote=${e ? e.id : ''}>
    <span class="ebubble__icon"><${EmoteArt} id=${id} /></span>
  </div>`;
}

/**
 * 交流 button + emote panel.
 * @param {{ onSend: (id:string)=>void, open: boolean, onToggle: (open:boolean)=>void, disabled?: boolean,
 *   cooldownMs?: number, onChat?: (text:string)=>Promise<boolean>, history?: any[], myId?: string }} props
 */
export function EmoteWheel({ onSend, onChat, history = [], myId, open, onToggle, disabled = false, cooldownMs = EMOTE_COOLDOWN_MS }) {
  useData('local');
  useEffect(() => { ensureEmoteCss(); }, []);
  const [page, setPage] = useState(lastThemeIndex);
  const [dir, setDir] = useState(0);          // direction of the last page change (slide-in animation)
  const [cooling, setCooling] = useState(() => cooldownLeft(lastSentAt, Date.now(), cooldownMs) > 0);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [chatView, setChatView] = useState('emotes');
  const composing = useRef(false);
  const pendingChat = useRef(false);
  const chatInput = useRef(null);
  const live = useRef({});
  live.current = { page, onToggle, chatView };

  const go = (to) => {
    const next = clampPage(to);
    if (next === live.current.page) return;
    setDir(next > live.current.page ? 1 : -1);
    setPage(next);
    live.current.page = next; // several key presses before the next render still step one page each
  };

  // reopen on the last used theme
  useEffect(() => {
    if (open) { setPage(lastThemeIndex()); setDir(0); setChatView('emotes'); }
  }, [open]);

  // cooldown: the button is greyed for chatCD after a send (from the send time, so a remounted wheel keeps it)
  useEffect(() => {
    if (!cooling) return undefined;
    const t = setTimeout(() => setCooling(false), cooldownLeft(lastSentAt, Date.now(), cooldownMs));
    return () => clearTimeout(t);
  }, [cooling]);

  // outside press closes; ← / → change the page
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!(e.target instanceof Element) || !e.target.closest('.ewheel')) live.current.onToggle(false); };
    const onKey = (e) => {
      if (live.current.chatView === 'history') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t instanceof Element && t.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        go(live.current.page + (e.key === 'ArrowRight' ? 1 : -1));
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const send = (id) => {
    const e = emoteInfo(id);
    const now = Date.now();
    if (!e || cooling || disabled || pendingChat.current || cooldownLeft(lastSentAt, now, cooldownMs) > 0) return;
    lastSentAt = now;
    rememberTheme(e.themeId);
    setCooling(true);
    onSend(id);
    onToggle(false);
  };

  const sendChat = async (event) => {
    event.preventDefault();
    // Keep the keyboard/input active even while the send itself is rate-limited.
    if (!disabled && !composing.current) chatInput.current?.focus({ preventScroll: true });
    const now = Date.now();
    if (!onChat || composing.current || pendingChat.current || cooling || disabled
      || cooldownLeft(lastSentAt, now, cooldownMs) > 0 || !validChatText(draft)) return;
    pendingChat.current = true;
    setSending(true);
    lastSentAt = now;
    setCooling(true);
    const submittedDraft = draft;
    try {
      if (await onChat(submittedDraft.trim())) {
        // Typing may continue while the request is in flight; never erase the next message.
        setDraft((current) => current === submittedDraft ? '' : current);
      }
    } finally {
      pendingChat.current = false;
      setSending(false);
    }
  };

  const theme = EMOTE_THEMES[clampPage(page)];
  const btnSprite = emoteUiSprite(disabled || cooling ? 'emoji_btn_disable' : 'emoji_btn');
  const panelBg = emoteUiSprite('emoji_bkg');
  const cellBg = emoteUiSprite('emoji_cell_bkg');
  const panelStyle = [panelBg && `--ewheel-bg:url("${panelBg}")`, cellBg && `--ewheel-cell:url("${cellBg}")`].filter(Boolean).join(';');
  return html`<div class="ewheel">
    <button type="button" class=${cx('ewheel__btn', btnSprite && 'has-sprite', open && 'is-on', cooling && 'is-cooling')}
      style=${btnSprite ? `--ewheel-btn:url("${btnSprite}")` : ''} onClick=${() => onToggle(!open)}
      aria-expanded=${open ? 'true' : 'false'} aria-haspopup="dialog" disabled=${disabled || (!onChat && cooling)}>
      ${btnSprite ? null : html`<${GIcon} name="emote" />`}<span class="ewheel__label">${t('交流')}</span>
    </button>
    ${open ? html`<div class=${cx('ewheel__dialog', onChat && 'has-chat')} role="dialog" aria-label=${t('交流')}>
    ${onChat ? html`<nav class="echat__tabs" aria-label=${t('交流内容')}>
      <button type="button" class=${cx('echat__tab', chatView === 'emotes' && 'is-on')}
        aria-label=${t('表情')} title=${t('表情')}
        aria-pressed=${chatView === 'emotes' ? 'true' : 'false'} onClick=${() => setChatView('emotes')}>
        <${GIcon} name="emote" />
      </button>
      <button type="button" class=${cx('echat__tab', chatView === 'history' && 'is-on')}
        aria-label=${t('聊天历史')} title=${t('聊天历史')}
        aria-pressed=${chatView === 'history' ? 'true' : 'false'} onClick=${() => setChatView('history')}>
        <${GIcon} name="history" /><span class="echat__tab-count">${history.length}</span>
      </button>
    </nav>` : null}
    <div class="ewheel__compose">
    <div class=${cx('ewheel__panel', panelBg && 'has-sprite', cellBg && 'has-cell')} style=${panelStyle}
      hidden=${!!onChat && chatView !== 'emotes'}>
      <div class="ewheel__viewport">
        <div key=${theme.themeId} class=${cx('ewheel__page', dir > 0 && 'is-from-right', dir < 0 && 'is-from-left')}
          role="group" aria-label=${t(theme.name)} data-theme=${theme.themeId}>
          ${theme.emotes.map((e) => html`<button key=${e.id} type="button" class="ewheel__item" data-emote=${e.id} aria-label=${t(e.label)}
              disabled=${cooling || disabled || sending} onClick=${() => send(e.id)}>
            <${EmoteArt} id=${e.id} />
          </button>`)}
        </div>
      </div>
      <div class="ewheel__pager">
      <button type="button" class="ewheel__nav is-prev" aria-label=${t('上一组表情')} disabled=${page <= 0} onClick=${() => go(page - 1)}><${GIcon} name="chevronLeft" /></button>
      <div class="ewheel__dots" role="tablist" aria-label=${t('表情主题')}>
        ${EMOTE_THEMES.map((th, i) => html`<button key=${th.themeId} type="button" role="tab" class=${cx('ewheel__dot', i === page && 'is-on')}
          aria-selected=${i === page ? 'true' : 'false'} aria-label=${`${t(th.name)} ${i + 1}/${EMOTE_THEMES.length}`} onClick=${() => go(i)}></button>`)}
      </div>
      <button type="button" class="ewheel__nav is-next" aria-label=${t('下一组表情')} disabled=${page >= EMOTE_THEMES.length - 1} onClick=${() => go(page + 1)}><${GIcon} name="chevronRight" /></button>
      </div>
    </div>
    ${onChat && chatView === 'history' ? html`<section class="echat__history-pane" aria-label=${t('聊天历史')}>
      <${ChatHistory} history=${history} myId=${myId} />
    </section>` : null}
    </div>
    ${onChat ? html`<div class="echat">
      <form class="echat__form" onSubmit=${sendChat}>
        <input type="text" class="echat__input" ref=${chatInput} value=${draft} placeholder=${t('最多20字')}
          aria-label=${t('局内聊天，最多20字')} disabled=${disabled}
          onCompositionStart=${() => { composing.current = true; }}
          onCompositionEnd=${(e) => {
            composing.current = false;
            e.currentTarget.value = truncateChat(e.currentTarget.value);
            setDraft(e.currentTarget.value);
          }}
          onInput=${(e) => {
            if (!composing.current) e.currentTarget.value = truncateChat(e.currentTarget.value);
            setDraft(e.currentTarget.value);
          }}
          onKeyDown=${(e) => {
            if (e.key === 'Enter' && (e.isComposing || composing.current || e.keyCode === 229)) e.preventDefault();
            e.stopPropagation();
          }} />
        <span class="echat__count">${chatLength(draft)}/${CHAT_MAX_LENGTH}</span>
        <button type="submit" class="echat__send" disabled=${disabled}
          aria-disabled=${cooling || sending || !validChatText(draft) ? 'true' : 'false'}
          onPointerDown=${(e) => {
            // A pointer press must not blur the input (or dismiss the mobile keyboard).
            if (!disabled) e.preventDefault();
          }}>${t('发送')}</button>
      </form>
    </div>` : null}
    </div>` : null}
  </div>`;
}

/** Page-local text messages. Only move to the newest row on open, or if already following the bottom. */
function ChatHistory({ history, myId }) {
  const list = useRef(null);
  const follow = useRef(true);
  useEffect(() => {
    if (follow.current && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [history]);
  return html`<div class="echat__history" ref=${list} role="log" aria-label=${t('聊天历史')} aria-live="polite"
    onScroll=${(e) => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
    ${history.length ? history.map((entry) => html`<div key=${entry.seq} class=${cx('echat__entry', entry.playerId === myId && 'is-self')}>
      <div class="echat__meta"><span>${entry.name}${entry.playerId === myId ? ` (${t('你')})` : ''}</span>
        <time>${new Date(entry.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></div>
      <div class="echat__text">${entry.text}</div>
    </div>`) : html`<div class="echat__empty">${t('暂无聊天记录')}</div>`}
  </div>`;
}
