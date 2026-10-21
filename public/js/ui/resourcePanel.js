// Compact entry points share one global resource manager; checks only read the manifest and local cache.
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, MicroLabel, Modal, ProgressBar } from './components.js';
import { createStore, useStore } from '../store.js';
import { formatBytes } from '../resources/common.js';
import { clearResources, exportResources, importResources, inspectResources, pauseResources,
  resourceState, startResources, subscribeResources } from '../resources/index.js';
import { t } from '../../../shared/i18n.js';

export function byteText(st) {
  if (Number.isFinite(st.selectedWanted)) {
    if (!st.selectedTotalBytes) return '';
    return st.selectedUnknownSize ? formatBytes(st.selectedTotalBytes)
      : `${formatBytes(st.selectedBytes)} / ${formatBytes(st.selectedTotalBytes)}`;
  }
  const total = Number.isFinite(st.totalBytes) && st.totalBytes > 0 ? st.totalBytes : 0;
  if (!total) return '';
  const done = Number.isFinite(st.bytes) ? st.bytes : 0;
  return st.sizedTotal ? `${formatBytes(done)} / ${formatBytes(total)}` : formatBytes(total);
}

export function detailText(st) {
  if (Number.isFinite(st.selectedWanted)) return [t('所选 {done}/{total}', { done: st.selectedDone, total: st.selectedWanted }), byteText(st)].filter(Boolean).join(' · ');
  if (!st.total) return '';
  return [st.tier1Total ? t('必需 {tier1Done}/{tier1Total}', { tier1Done: st.tier1Done, tier1Total: st.tier1Total }) : '', t('全部 {done}/{total}', { done: st.done, total: st.total }), byteText(st)].filter(Boolean).join(' · ');
}

export function percent(st) {
  if (Number.isFinite(st.selectedWanted)) {
    if (!st.selectedWanted) return 0;
    const pct = st.selectedUnknownSize === 0 && st.selectedTotalBytes > 0
      ? st.selectedBytes / st.selectedTotalBytes : st.selectedDone / st.selectedWanted;
    return Math.max(0, Math.min(100, Math.round(pct * 100)));
  }
  if (!st.total) return 0;
  const byBytes = st.totalBytes > 0 && st.sizedTotal === st.total;
  const pct = byBytes ? (st.bytes / st.totalBytes) * 100 : (st.done / Math.max(1, st.wanted || st.total)) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

const resourceUi = createStore({ open: false });
export const openResources = () => resourceUi.set({ open: true });
const closeResources = () => resourceUi.set({ open: false });
const busy = (st) => !!st.archive || st.phase === 'checking';

function useResources() {
  const [state, setState] = useState(resourceState);
  useEffect(() => subscribeResources(setState), []);
  return state;
}

function stateText(st, enabled) {
  if (st.archive) return st.archive === 'import' ? t('正在导入资源包') : t('正在导出资源包');
  if (enabled && st.combatPaused && !st.manualPaused) return t('战斗中暂停');
  if (st.phase === 'foreign') return t('另一标签页正在检查或导入');
  if (st.phase === 'error') return t('清单检查失败');
  if (busy(st)) return t('处理中');
  if (st.complete) return t('清单资源已齐全');
  if (st.total) return t('缺少 {missing} 个资源', { missing: st.selectedMissing ?? Math.max(0, st.total - st.done) });
  return enabled ? t('等待检查') : t('尚未检查');
}

export function ResourceRow({ enabled }) {
  const st = useResources();
  return html`<div class="set-res">
    <div class="set-row">
      <span class="set-row__label">${t('资源清单')}<${MicroLabel}>ASSETS<//></span>
      <${Button} variant="secondary" size="sm" icon="expand" onClick=${openResources}>${t('资源管理')}<//>
    </div>
    <p class="set-hint">${stateText(st, enabled)} ${t('· 检查本机资源，或导入、导出 ZIP 资源包。')}</p>
  </div>`;
}

export function ResourceLauncher({ enabled }) {
  const st = useResources();
  return html`<div class=${`res-pill${enabled ? ' is-on' : ''}`}>
    <button type="button" class="res-pill__head" title=${t('检查资源清单和管理 ZIP 资源包')} onClick=${openResources}>
      <span class="res-pill__label">${t('资源清单')}<${MicroLabel}>ASSETS<//></span>
      <span class="res-pill__state">${stateText(st, enabled)}</span>
    </button>
    <p class="res-pill__hint">${t('清单校验 · ZIP 主动导入与导出')}</p>
  </div>`;
}

function ResourceTier({ st, tier }) {
  const groups = st.groups.filter((g) => g.tier === tier);
  const chosen = groups.filter((g) => g.selected !== false);
  const total = chosen.reduce((n, g) => n + g.wanted, 0);
  const done = chosen.reduce((n, g) => n + g.present, 0);
  const bytes = chosen.reduce((n, g) => n + g.bytes, 0);
  const totalBytes = chosen.reduce((n, g) => n + g.totalBytes, 0);
  const unknown = chosen.some((g) => g.unknownSize);
  return html`<section class="resource-tier">
    <header class="resource-tier__head">
      <div><h3>${tier === 1 ? t('地图与画面资源') : t('语音与特效资源')}</h3>
        <p>${tier === 1 ? t('地图、人物图片、模型与 Spine 动画') : t('全语言角色语音、技能特效、音效、背景音乐与说明图片')}</p></div>
      <${MicroLabel}>${tier === 1 ? 'VISUALS' : 'AUDIO / FX'}<//>
    </header>
    <div class="resource-tier__summary"><span class="num">${t('{done} / {total} 个文件', { done, total })}</span>
      <span class="num">${unknown ? t('部分大小未知') : `${formatBytes(bytes)} / ${formatBytes(totalBytes)}`}</span></div>
    <${ProgressBar} value=${done} max=${Math.max(1, total)} size="sm" tone=${tier === 1 ? 'mint' : 'amber'} />
    <ul class="resource-tier__list">
      ${groups.map((group) => html`<li key=${group.id}
        class=${st.archivePhase === 'import' && st.archiveGroup === group.id ? 'is-importing' : ''}><span>${t(group.name)}
          ${st.archivePhase === 'import' && st.archiveGroup === group.id ? html`<small>${t('正在导入')}</small>` : null}</span>
        <span class="num">${group.present}/${group.wanted}</span>
        <span class="num">${group.unknownSize ? t('大小待确认') : formatBytes(group.totalBytes)}</span></li>`)}
    </ul>
  </section>`;
}

/** Mounted once in main.js, above all screens including the settings modal. */
export function ResourceHost({ enabled, onChange }) {
  const { open } = useStore((s) => s, Object.is, resourceUi);
  const st = useResources();
  const fileInput = useRef(null);
  useEffect(() => { if (open) void inspectResources().catch(() => {}); }, [open]);
  const archiveBusy = !!st.archive;
  const importFile = async (e) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    try { await importResources(file); } catch { /* controller displays the error */ }
  };
  const exportFile = async () => {
    try {
      const { blob, version } = await exportResources();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `stronghold-resources-${version.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)}.zip`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { /* controller displays the error */ }
  };
  return html`<${Modal} open=${open} onClose=${closeResources} title=${t('资源清单与导入')} micro="RESOURCE MANAGER" class="resource-modal" utility=${true}
    actions=${html`
      ${busy(st) ? html`<${Button} variant="secondary" icon="hourglass" onClick=${pauseResources}>${archiveBusy ? t('取消处理') : t('暂停检查')}<//>`
        : html`<${Button} variant="primary" icon="play" disabled=${!st.supported || st.combatPaused}
          onClick=${() => enabled ? startResources() : onChange(true)}>${t('检查资源')}<//>`}
      ${enabled && st.combatPaused && !st.manualPaused && !archiveBusy ? html`<${Button} variant="secondary" icon="hourglass"
        onClick=${pauseResources}>${t('暂停检查')}<//>` : null}
      <${Button} variant="secondary" onClick=${closeResources}>${t('关闭')}<//>`}>
    <div class="resource-manager">
      <p class="resource-manager__intro">${t('网站提供资源校验清单，不提供批量资源下载。玩家可导入完整资源包；游戏使用中的资源仍会按需请求并缓存。自动检查只读取清单与本机缓存。')}</p>
      <div class="resource-manager__tiers">
        <${ResourceTier} st=${st} tier=${1} />
        <${ResourceTier} st=${st} tier=${2} />
      </div>
      <p class=${`resource-manager__status${st.error ? ' is-error' : ''}`} role="status" aria-live="polite">
        ${st.message || (enabled ? t('自动清单检查已开启') : t('可检查资源清单，或直接导入资源包。'))}</p>
      ${st.worker ? html`<p class="resource-manager__warn">${st.worker}</p>` : null}
      ${st.skipped ? html`<p class="resource-manager__warn">${t('{skipped} 个文件超过缓存上限，不包含在本地缓存统计中。', { skipped: st.skipped })}</p>` : null}
      <section class="resource-archive">
        <h3>${t('ZIP 资源包')}</h3>
        <p>${t('网站仅提供校验清单，不托管完整资源包。获取资源 ZIP 后可主动导入；导入会校验文件，只写入当前清单中仍有效的资源。导出会打包本机已缓存的资源。')}</p>
        ${st.archive ? html`<${ProgressBar} value=${st.archivePercent} max=${100} size="sm" tone="mint" />` : null}
        <input ref=${fileInput} type="file" accept=".zip,application/zip,application/x-zip-compressed" hidden onChange=${importFile} />
        <div class="res-actions">
          <${Button} variant="secondary" disabled=${archiveBusy || !st.supported} onClick=${() => fileInput.current?.click()}>${t('导入 ZIP')}<//>
          <${Button} variant="secondary" disabled=${archiveBusy || !st.supported || !st.done} onClick=${exportFile}>${t('导出 ZIP')}<//>
        </div>
      </section>
      <div class="resource-manager__maintenance">
        <button type="button" class="res-link" disabled=${archiveBusy} onClick=${() => { void clearResources(); }}>${t('清理缓存')}</button>
        ${enabled ? html`<button type="button" class="res-link" onClick=${() => onChange(false)}>${t('关闭自动检查')}</button>` : null}
        <span>${t('自动检查不会下载缺失文件；关闭后已缓存资源仍保留。')}</span>
      </div>
    </div>
  <//>`;
}
