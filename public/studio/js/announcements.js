import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Button } from '../../js/ui/components.js';
import { t } from '../../../shared/i18n.js';
import { get, put } from './api.js';

const newId = () => `scroll-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}`;
const localInput = (value) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};
const isoTime = (value) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
};
const fromServer = (row) => {
  const { endAt, ...rest } = row;
  const start = typeof row.startAt === 'number' ? row.startAt : Date.parse(row.startAt);
  const end = typeof endAt === 'number' ? endAt : Date.parse(endAt);
  return { ...rest, type: 'scroll', startAt: new Date(start).toISOString(),
    durationSeconds: row.durationSeconds ?? Math.round((end - start) / 1000) };
};

export function AnnouncementsPage() {
  const [rows, setRows] = useState(null);
  const [revision, setRevision] = useState(null);
  const [selected, setSelected] = useState(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await get('announcements');
      setRows((result.announcements || []).filter((row) => (row.type || 'scroll') === 'scroll').map(fromServer));
      setRevision(result.revision);
      setSelected(null);
      setStatus('');
    } catch (e) { setError(e?.status === 409 ? t('公告版本冲突，请重新读取。') : `${t('读取公告失败')}: ${e?.detail || e?.code || e}`); }
    finally { setBusy(false); }
  };
  useEffect(() => { load(); }, []);

  const update = (id, patch) => {
    setRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
    setStatus('');
  };
  const create = () => {
    if (!rows || rows.length >= 100) return;
    const id = newId();
    const row = { id, text: '', startAt: new Date().toISOString(), durationSeconds: 3600, level: 'info', enabled: true };
    setRows((current) => [...current, row]);
    setSelected(id);
    setStatus('');
    setError('');
  };
  const save = async () => {
    if (busy || !rows) return;
    setBusy(true); setError(''); setStatus('');
    const announcements = rows.map((row) => ({ ...row, type: 'scroll', startAt: isoTime(row.startAt) }));
    if (announcements.some((row) => !row.startAt)) {
      setError(t('请填写有效的开始时间。')); setBusy(false); return;
    }
    try {
      const result = await put('announcements', { announcements, revision });
      setRows((result.announcements || []).filter((row) => (row.type || 'scroll') === 'scroll').map(fromServer));
      setRevision(result.revision);
      setSelected(null);
      setStatus(t('公告已保存。'));
    } catch (e) {
      setError(e?.status === 409 || /CONFLICT|STALE/i.test(e?.code || '')
        ? t('公告版本冲突，请重新读取后再编辑。')
        : `${t('保存公告失败')}: ${e?.detail || e?.code || e}`);
    } finally { setBusy(false); }
  };

  if (!rows) return html`<section class="st-announcements"><h2>${t('网站公告')}</h2>${error ? html`<p class="st-error" role="alert">${error}</p><${Button} onClick=${load} disabled=${busy}>${t('重新读取')}<//>` : html`<p class="st-note">${t('正在读取…')}</p>`}</section>`;
  const editing = rows.find((row) => row.id === selected);
  return html`<section class="st-announcements" data-testid="announcements-page">
    <header class="st-announcements__head"><div><h2>${t('网站公告')}</h2><p class="st-note">${t('最多 100 条；正文最多 500 字，持续时间为 1 至 86400 秒。更改仅在保存后发布。')}</p></div>
      <div class="st-announcements__actions"><${Button} onClick=${load} disabled=${busy}>${t('重新读取')}<//><${Button} onClick=${create} disabled=${busy || rows.length >= 100}>${t('新建公告')}<//><${Button} variant="primary" onClick=${save} disabled=${busy} loading=${busy}>${t('保存公告')}<//></div></header>
    ${error ? html`<div class="st-banner is-bad" role="alert">${error}</div>` : null}
    ${status ? html`<div class="st-banner is-ok" role="status">${status}</div>` : null}
    <div class="st-announcements__layout">
      <div class="st-announcements__list" aria-label=${t('公告列表')}>
        ${rows.map((row) => html`<article key=${row.id} class=${`st-announcement-row ${selected === row.id ? 'is-on' : ''}`}>
          <div class="st-announcement-row__text"><strong>${row.text || t('未填写正文')}</strong><small>${row.id} · ${row.enabled ? t('已启用') : t('已停用')} · ${t(row.level === 'urgent' ? '紧急' : row.level === 'warning' ? '提醒' : '通知')} · ${row.startAt ? new Date(row.startAt).toLocaleString() : '—'}</small></div>
          <div class="st-announcement-row__actions"><button type="button" class="st-link-btn" disabled=${busy} onClick=${() => update(row.id, { enabled: !row.enabled })}>${row.enabled ? t('停用') : t('启用')}</button><button type="button" class="st-link-btn" disabled=${busy} onClick=${() => { setSelected(row.id); setError(''); setStatus(''); }}>${t('编辑')}</button><button type="button" class="st-link-btn is-danger" disabled=${busy} onClick=${() => { setRows((current) => current.filter((item) => item.id !== row.id)); if (selected === row.id) setSelected(null); setStatus(''); }}>${t('删除')}</button></div>
        </article>`)}
        ${!rows.length ? html`<p class="st-none">${t('暂无公告。')}</p>` : null}
      </div>
      ${editing ? html`<form class="st-announcement-editor" onSubmit=${(e) => e.preventDefault()}>
        <h3>${t('编辑公告')}</h3><p class="st-announcement-editor__id"><code>${editing.id}</code></p>
        <label class="st-field-row"><span>${t('公告正文')}</span><textarea class="st-input st-announcement-editor__body" maxlength="500" disabled=${busy} value=${editing.text} onInput=${(e) => update(editing.id, { text: e.currentTarget.value })}></textarea><small>${[...editing.text].length} / 500</small></label>
        <label class="st-field-row"><span>${t('开始时间（本地时区）')}</span><input class="st-input" type="datetime-local" step="1" disabled=${busy} value=${localInput(editing.startAt)} onInput=${(e) => update(editing.id, { startAt: e.currentTarget.value })} /></label>
        <label class="st-field-row"><span>${t('持续秒数')}</span><input class="st-input" type="number" min="1" max="86400" step="1" disabled=${busy} value=${editing.durationSeconds} onInput=${(e) => update(editing.id, { durationSeconds: Number(e.currentTarget.value) })} /></label>
        <label class="st-field-row"><span>${t('级别')}</span><select class="st-input" disabled=${busy} value=${editing.level} onChange=${(e) => update(editing.id, { level: e.currentTarget.value })}><option value="info">${t('通知')}</option><option value="warning">${t('提醒')}</option><option value="urgent">${t('紧急')}</option></select></label>
        <label class="st-check"><input type="checkbox" disabled=${busy} checked=${editing.enabled} onChange=${(e) => update(editing.id, { enabled: e.currentTarget.checked })} />${t('启用公告')}</label>
        <div class="st-announcement-preview"><strong>${t('预览')}</strong><div class=${`st-announcement-preview__bar is-${editing.level}`}>${editing.text || t('公告正文将在这里显示')}</div></div>
        <${Button} disabled=${busy} onClick=${() => setSelected(null)}>${t('完成编辑')}<//>
      </form>` : html`<div class="st-announcement-editor st-none">${t('选择一条公告进行编辑，或新建公告。')}</div>`}
    </div>
  </section>`;
}
