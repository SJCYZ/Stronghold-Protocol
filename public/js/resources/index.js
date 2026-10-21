// public/js/resources/index.js — the page side of the optional asset preload (docs/ASSETS.md「Preload」).
//
// Resource management verifies the manifest and local cache; players add bulk resources by importing a ZIP.
// The Service Worker still caches ordinary game requests on demand. 「清理缓存」 deletes that runtime cache too.
//
// The settings panel (public/js/ui/resourcePanel.js) renders `resourceState()`; main.js calls `syncResources()` with the
// persisted setting at boot and on every settings change.

import { CACHE_PREFIX, MANIFEST_URL, SW_URL, checkAbort, isQuotaError, resourceGroup, resourceSelection, validateManifest } from './common.js';
import { ResourceStore } from './store.js';
import { t } from '../../../shared/i18n.js';

/** @type {any} */
const state = {
  enabled: false,
  phase: 'off', // off | checking | incomplete | foreign (another tab) | ready | paused | error
  supported: true,
  reason: '',
  done: 0,
  total: 0,
  wanted: 0,
  tier1Done: 0,
  tier1Total: 0,
  tier2Done: 0,
  tier2Total: 0,
  bytes: 0,
  totalBytes: null,
  sized: 0,
  sizedTotal: 0,
  skipped: 0,
  failed: 0,
  complete: false,
  cacheVerified: false,
  message: '',
  error: false,
  worker: '',
  version: '',
  archive: '', // import | export
  archivePhase: '',
  archivePercent: 0,
  archiveGroup: '',
  selectionComplete: false,
  combatPaused: false,
  manualPaused: false,
  groups: [],
};

const listeners = new Set();
let current = false;
let controller = null;
let contextPromise = null;
let activeRun = null;
let transferPromise = null;
let archiveController = null;
const ALL_VOICE_LANGS = ['cn', 'jp', 'en', 'kr'];
let syncRevision = 0;
let workerPromise = null;
let cancelBackgroundCheck = null;
let combatPaused = false;
let manualPaused = false;
let combatRevision = 0;
let resumeAfterCombat = false;
let cancelOtherTabWatch = null;
let runRevision = 0;

const combatMessage = () => t('战斗中已暂停资源检查，战斗结束后自动继续。');
const manualMessage = () => t('已暂停资源检查，可继续检查或清理缓存。');
const downloadBlocked = () => !current || combatPaused || manualPaused;

/** Subscribe to preload state changes (returns the unsubscribe function). */
export function subscribeResources(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** A copy of the current preload state (safe to hand to Preact). */
export function resourceState() {
  return { ...state };
}

function set(patch) {
  const before = JSON.stringify(state); // the state is small and flat: a cheap "did anything change" test
  Object.assign(state, patch);
  // Async checks must not replace an automatic/manual pause with a late state.
  if (current && !state.archive && (combatPaused || manualPaused)
      && ['checking', 'incomplete', 'foreign', 'ready', 'paused'].includes(state.phase)) {
    state.phase = 'paused';
    state.message = manualPaused ? manualMessage() : combatMessage();
  }
  if (JSON.stringify(state) === before) return;
  for (const fn of [...listeners]) {
    try { fn(resourceState()); } catch (err) { console.error('[resources] listener failed', err); }
  }
}

/**
 * The counters of one store payload (status / progress / result — store.js emits the same fields for all three), in the
 * names the panel renders. One shape for all three is what keeps a progress update from leaving a field undefined.
 */
const counters = (s) => ({
  cacheVerified: s.cacheVerified ?? true,
  done: s.count,
  total: s.total,
  wanted: s.wanted,
  tier1Done: s.tier1Present,
  tier1Total: s.tier1,
  tier2Done: s.tier2Present,
  tier2Total: s.tier2,
  tier1Wanted: s.tier1Wanted ?? s.tier1,
  tier2Wanted: s.tier2Wanted ?? s.tier2,
  bytes: s.bytes,
  totalBytes: s.totalBytes,
  sized: s.sized,
  sizedTotal: s.sizedTotal,
  skipped: s.skipped,
  complete: s.complete,
  adopted: s.adopted ?? 0,
  ...resourceSelection(s, true, ALL_VOICE_LANGS, true),
});

const selectionComplete = (s) => resourceSelection(s, true, ALL_VOICE_LANGS, true).selectionComplete;

/** Why this browser cannot keep the resources (empty ⇒ it can). */
export function unsupportedReason() {
  if (!globalThis.isSecureContext) return t('需要 HTTPS（或 localhost）才能预载资源');
  if (!globalThis.caches) return t('当前浏览器不支持 Cache Storage');
  if (!globalThis.navigator?.serviceWorker) return t('当前浏览器不支持 Service Worker');
  return '';
}

/**
 * The preload context: the manifest plus (when this browser can cache) its store. Cached for the session; a failure is
 * retried the next time the player enables the preload.
 */
export function resourceContext() {
  contextPromise ??= (async () => {
    const reason = unsupportedReason();
    if (reason) return { unsupported: reason }; // no point in asking for a list this browser cannot store
    let res;
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(30000) : undefined;
    try {
      // Revalidate the HTTP cache on every page load. On a wire-level 304 the browser supplies the cached JSON body.
      res = await fetch(MANIFEST_URL, { cache: 'no-cache', signal });
    } catch (err) {
      return { error: t('无法读取资源清单：{0}', { 0: err?.message || err }) };
    }
    if (!res.ok) return { error: t('无法读取资源清单：HTTP {status}', { status: res.status }) };
    let manifest;
    try {
      manifest = validateManifest(await res.json());
    } catch (err) {
      return { error: String(err?.message || err) };
    }
    if (!manifest.files.length) return { manifest, empty: true };
    return { manifest, store: new ResourceStore(manifest) };
  })();
  return contextPromise;
}

/** Register the Service Worker that caches ordinary game requests on demand. */
async function ensureWorker() {
  if (workerPromise) return workerPromise;
  const nav = globalThis.navigator;
  if (!nav?.serviceWorker) throw new Error('不支持 Service Worker');
  workerPromise = nav.serviceWorker.register(SW_URL, { type: 'module', scope: '/', updateViaCache: 'none' })
    .then((reg) => { set({ worker: '' }); return reg; })
    .catch((err) => { workerPromise = null; throw err; });
  return workerPromise;
}

/**
 * Turn the preload on or off (idempotent: the settings store fires on every volume change).
 * @param {boolean} enabled
 */
export async function syncResources(enabled) {
  enabled = !!enabled;
  if (enabled === current) {
    if (!enabled) {
      await ensureWorker().catch((err) => {
        console.warn('[resources] service worker not registered', err);
        set({ worker: t('预载服务未启用（{0}）', { 0: err?.message || err }) });
      });
    }
    set({ enabled });
    return;
  }
  const revision = ++syncRevision;
  cancelBackgroundCheck?.();
  const wasEnabled = current;
  current = enabled;
  if (!enabled || !wasEnabled) manualPaused = false;
  set({ enabled, manualPaused, error: false, message: '' });
  if (!enabled) {
    resumeAfterCombat = false;
    cancelOtherTabWatch?.();
    controller?.abort();
    archiveController?.abort();
    await ensureWorker().catch((err) => {
      console.warn('[resources] service worker not registered', err);
      set({ worker: t('预载服务未启用（{0}）', { 0: err?.message || err }) });
    });
    set({ phase: state.complete ? 'ready' : 'incomplete', message: t('自动检查已关闭；已导入和已缓存的资源仍保留。') });
    return;
  }
  if (activeRun && controller?.signal.aborted) await activeRun;
  if (revision !== syncRevision || !current) return;
  if (manualPaused) { set({ phase: 'paused' }); return; }
  if (combatPaused) {
    resumeAfterCombat = true;
    void ensureWorker().catch(err => console.warn('[resources] service worker not registered', err));
    set({ phase: 'paused' });
    return;
  }
  return start();
}

/** Temporary battle gate: abort bulk lanes, preserve completed writes/indexes, and resume only automatic work. */
export async function syncResourceCombat(active) {
  active = !!active;
  if (active === combatPaused) return;
  const revision = ++combatRevision;
  combatPaused = active;
  set({ combatPaused });
  if (active) {
    resumeAfterCombat = current && !manualPaused && !state.error;
    cancelBackgroundCheck?.();
    cancelOtherTabWatch?.();
    controller?.abort();
    if (current && !state.archive && !state.error) set({ phase: 'paused' });
    return;
  }
  // Cache.put already in flight cannot be cancelled. Await the whole prior run before obtaining a new Web Lock.
  if (activeRun) await activeRun;
  if (revision !== combatRevision || combatPaused) return;
  const resume = resumeAfterCombat;
  resumeAfterCombat = false;
  if (resume && current && !manualPaused && !state.error) return start();
}

/** Continue (or start) an enabled manifest and cache check. */
export async function startResources() {
  if (!current) return;
  manualPaused = false;
  set({ manualPaused });
  if (combatPaused) {
    resumeAfterCombat = true;
    set({ phase: 'paused' });
    return;
  }
  if (transferPromise) await transferPromise.catch(() => {});
  if (activeRun && (controller?.signal.aborted || ['ready', 'error', 'paused'].includes(state.phase))) await activeRun;
  if (downloadBlocked()) return;
  return start({ verifyCache: true });
}

/** Only one tab scans or updates the shared cache index at a time. */
export const DOWNLOAD_LOCK = 'stronghold-resources-preload';

/** Run `job` while holding the resource lock; `{ busy: true }` when another tab has it. Unsupported ⇒ just run it. */
async function withDownloadLock(job) {
  const locks = globalThis.navigator?.locks;
  if (!locks || typeof locks.request !== 'function') return job();
  return locks.request(DOWNLOAD_LOCK, { ifAvailable: true }, async (lock) => (lock ? job() : { busy: true }));
}

/** Another tab owns the cache check or import: show current state and look again when visible. */
function watchOtherTab(store) {
  if (downloadBlocked()) { if (current) set({ phase: 'paused' }); return Promise.resolve(); }
  cancelOtherTabWatch?.();
  if (globalThis.document?.addEventListener) {
    const recheck = () => {
      if (document.visibilityState !== 'visible' || downloadBlocked()) return;
      cancelOtherTabWatch?.();
      void start({ verifyCache: true });
    };
    cancelOtherTabWatch = () => { document.removeEventListener('visibilitychange', recheck); cancelOtherTabWatch = null; };
    document.addEventListener('visibilitychange', recheck);
  }
  return store.status().then((st) => set({
    ...counters(st), phase: 'foreign', error: false,
    message: selectionComplete(st) ? t('所选资源已齐全。') : t('另一个标签页正在预载⋯回到这个标签页时会自动继续。'),
  }));
}

function scheduleBackgroundCheck() {
  cancelBackgroundCheck?.();
  // Browser only: no lingering timers in tools/tests. Recheck every page entry,
  // but do not keep the initial "checking resources" UI waiting for cache.keys.
  const win = globalThis.window;
  if (!win?.setTimeout) return;
  const revision = syncRevision;
  const run = () => {
    cancelBackgroundCheck = null;
    if (downloadBlocked() || revision !== syncRevision || activeRun || transferPromise) return;
    void start({ verifyCache: true, background: true }).catch((err) =>
      console.warn('[resources] background check failed', err));
  };
  const timer = win.setTimeout(run, 5000);
  cancelBackgroundCheck = () => { win.clearTimeout(timer); cancelBackgroundCheck = null; };
}

function start(options = {}) {
  if (downloadBlocked()) {
    if (current && manualPaused) set({ phase: 'paused', message: manualMessage() });
    else if (current && combatPaused) set({ phase: 'paused', message: combatMessage() });
    return Promise.resolve();
  }
  if (transferPromise) return transferPromise.catch(() => {});
  if (activeRun) return activeRun;
  runRevision++;
  cancelBackgroundCheck?.();
  controller = new AbortController();
  const signal = controller.signal;
  activeRun = startDownload(signal, options).catch(err => {
    // A pause can arrive during initial manifest/cache verification, before the inner download catch.
    if (err?.name === 'AbortError') { set({ phase: 'paused', message: current ? manualMessage() : t('已停止预载。') }); return; }
    throw err;
  }).finally(() => { activeRun = null; controller = null; });
  return activeRun;
}

async function startDownload(signal, { verifyCache = false, background = false } = {}) {
  if (!background) set({ phase: 'checking', message: t('正在检查资源清单与本地缓存…'), error: false });
  const checkStart = performance.now();
  const ctx = await resourceContext();
  const manifestReady = performance.now();
  if (downloadBlocked() || signal.aborted) { set({ phase: 'paused' }); return; }
  if (ctx.error || ctx.unsupported || ctx.empty) {
    const message = ctx.error || ctx.unsupported || t('服务器没有可检查的资源');
    contextPromise = null;
    set({ phase: 'error', message, error: true, supported: !ctx.unsupported });
    return;
  }
  const store = ctx.store;
  set({ supported: true, version: store.manifest.version });
  // Register the worker for ordinary game requests; bulk resource requests only come from an imported ZIP.
  ensureWorker().catch((err) => {
    console.warn('[resources] service worker not registered', err);
    set({ worker: t('按需缓存未启用（{0}）', { 0: err?.message || err }) });
  });
  try {
    const outcome = await withDownloadLock(async () => {
      checkAbort(signal);
      const status = await store.status({ verifyCache });
      checkAbort(signal);
      if (verifyCache) {
        await store.reconcileRuntimeIndex(status);
        checkAbort(signal);
        if (status.complete) await store.prune();
      }
      return { busy: false, status };
    });
    if (outcome.busy) { await watchOtherTab(store); return; }
    checkAbort(signal);
    const status = outcome.status;
    const complete = selectionComplete(status);
    const missing = resourceSelection(status, true, ALL_VOICE_LANGS, true).selectedMissing;
    console.info('[resources] verification timings', { manifestMs: manifestReady - checkStart,
      ...status.checkTimings, background, durationMs: performance.now() - checkStart, cached: status.count, files: status.total });
    set({ ...counters(status), phase: complete ? 'ready' : 'incomplete', error: false,
      message: !verifyCache ? t('已读取本机缓存索引，稍后核对缓存。')
        : complete ? t('清单资源已齐全。')
          : t('缺少 {missing} 个资源文件；请导入资源包。', { missing }) });
    if (!verifyCache) scheduleBackgroundCheck();
  } catch (err) {
    if (err?.name === 'AbortError') {
      const now = combatPaused ? null : await store.status().catch(() => null);
      set({ ...(now ? counters(now) : {}), phase: 'paused', message: current ? manualMessage() : t('已停止资源检查。') });
      return;
    }
    const message = isQuotaError(err) || /quota|空间不足/i.test(String(err?.message || ''))
      ? t('浏览器存储空间不足：已保存的文件保留，可清理缓存后重试。')
      : t('资源检查失败：{0}', { 0: err?.message || err });
    const now = await store.status().catch(() => null);
    set({ ...(now ? counters(now) : {}), phase: 'error', message, error: true });
  }
}
/** Stop a pending check or archive operation (keeps what is cached). */
export function pauseResources() {
  manualPaused = true;
  resumeAfterCombat = false;
  set({ manualPaused });
  cancelBackgroundCheck?.();
  cancelOtherTabWatch?.();
  archiveController?.abort();
  if (controller) {
    controller.abort();
    set({ message: t('正在暂停…') });
  }
  else if (current && !state.archive) set({ phase: 'paused', message: manualMessage() });
}

/** ZIP support stays out of the initial module graph. An import can be started before enabling network preloading. */
export async function importResources(file) {
  return transferArchive('import', file);
}

export function exportResources() {
  return transferArchive('export');
}

function transferArchive(kind, file) {
  cancelBackgroundCheck?.();
  if (transferPromise) return Promise.reject(new Error('资源包正在处理中'));
  if (kind === 'import') runRevision++;
  // Stop a pending cache check before taking the shared archive lock.
  controller?.abort();
  archiveController = new AbortController();
  const signal = archiveController.signal;
  set({ archive: kind, archivePhase: '', archivePercent: 0, archiveGroup: '',
    message: kind === 'import' ? t('正在准备导入资源包…') : t('正在准备导出资源包…'), error: false });
  transferPromise = (async () => {
    if (activeRun) await activeRun;
    if (kind === 'import') contextPromise = null;
    const ctx = await resourceContext();
    if (!ctx.store) throw new Error(ctx.error || ctx.unsupported || '服务器没有可预载的资源');
    checkAbort(signal);
    const outcome = await withDownloadLock(async () => {
      set(counters(await ctx.store.status()));
      const archive = await import('./archive.js');
      checkAbort(signal);
      let lastTime = -Infinity;
      let lastPhase = '';
      const onProgress = (p) => {
        const now = performance.now();
        // Keep hashing/cache writes running at full speed. UI and category aggregation run at most twice a second;
        // phase boundaries and completion always publish immediately, without timers that could outlive the job.
        if (p.phase === lastPhase && p.done < p.total && now - lastTime < 500) return;
        lastTime = now;
        lastPhase = p.phase;
        const percent = p.total > 0 ? Math.min(100, Math.floor(p.done * 100 / p.total)) : 100;
        const status = p.getStatus?.();
        set({ ...(status ? counters(status) : {}), archivePhase: p.phase, archivePercent: percent,
          archiveGroup: p.file ? resourceGroup(p.file) : '',
          message: t('{0}资源包：{percent}%', { 0: p.phase === 'export' ? t('正在导出') : p.phase === 'verify' ? t('正在校验') : t('正在导入'), percent }) });
      };
      return kind === 'import'
        ? archive.importResourceZip(ctx.store, file, { signal, onProgress,
          onDiagnostics: (timings) => console.info('[resources] ZIP import timings', timings) })
        : archive.exportResourceZip(ctx.store, { signal, onProgress });
    });
    if (outcome.busy) throw new Error('另一个标签页正在处理资源，请暂停后重试');
    checkAbort(signal);
    const status = await ctx.store.status();
    const missing = resourceSelection(status, true, ALL_VOICE_LANGS, true).selectedMissing;
    const complete = selectionComplete(status);
    set({ ...counters(status), failed: 0, phase: complete ? 'ready' : 'incomplete',
      message: kind === 'export'
        ? t('已导出 {count} 个资源文件。', { count: outcome.count })
        : t('已导入 {imported} 个资源文件，跳过 {skippedPackage} 个不适用的资源；{2}', { imported: outcome.imported, skippedPackage: outcome.skippedPackage, 2: missing === 0 ? t('清单资源已齐全。') : t('仍缺少 {missing} 个文件，请继续导入资源包。', { missing }) }) });
    if (kind === 'import') {
      await ensureWorker().catch((err) => set({ worker: t('预载服务未启用（{0}）', { 0: err?.message || err }) }));
    }
    checkAbort(signal);
    return outcome;
  })().catch(async (err) => {
    const ctx = await resourceContext();
    const status = await ctx.store?.status().catch(() => null);
    const aborted = err?.name === 'AbortError';
    set({ ...(status ? counters(status) : {}), phase: aborted ? 'paused' : 'error', error: !aborted,
      message: aborted ? t('资源包处理已取消，已保存的资源保留。')
        : isQuotaError(err) || /空间不足/i.test(String(err?.message || '')) ? t('浏览器存储空间不足，已保存的资源保留，可清理后重试。')
          : t('资源包{0}失败：{1}', { 0: kind === 'import' ? t('导入') : t('导出'), 1: err?.message || err }) });
    throw err;
  }).finally(() => {
    archiveController = null;
    transferPromise = null;
    set({ archive: '', archivePhase: '', archiveGroup: '' });
  });
  return transferPromise;
}

/**
 * Delete every cached resource (all versions) and stop.
 */
export async function clearResources() {
  manualPaused = true;
  resumeAfterCombat = false;
  set({ manualPaused });
  cancelBackgroundCheck?.();
  cancelOtherTabWatch?.();
  controller?.abort();
  archiveController?.abort();
  if (activeRun) await activeRun;
  if (transferPromise) { try { await transferPromise; } catch { /* cancelled */ } }
  const ctx = await resourceContext();
  // a run that was mid-file finishes (or aborts) before the caches go away, so nothing lands after the clear
  if (ctx.store?.running) { try { await ctx.store.running; } catch { /* aborted — nothing to keep */ } }
  const outcome = await withDownloadLock(async () => {
    if (ctx.store) await ctx.store.clear();
    else if (globalThis.caches) {
      const names = await globalThis.caches.keys();
      await Promise.all(names.filter((n) => n.startsWith(CACHE_PREFIX)).map((n) => globalThis.caches.delete(n)));
    }
    return { busy: false };
  });
  if (outcome.busy) {
    set({ message: t('另一个标签页正在处理资源，请暂停后再清理。') });
    return;
  }
  set({
    done: 0, tier1Done: 0, tier2Done: 0, bytes: 0, failed: 0, complete: false, error: false, cacheVerified: true,
    phase: current ? 'paused' : 'off',
    message: t('已清理预载资源缓存。'),
    selectionComplete: false,
    ...resourceSelection({ groups: state.groups.map((g) => ({ ...g, present: 0, bytes: 0 })) }, true, ALL_VOICE_LANGS, true),
  });
}

/** Opening the manager checks the cache without starting network asset downloads. */
export async function inspectResources() {
  if (combatPaused) { if (current && !state.archive) set({ phase: 'paused' }); return; }
  // An active run already publishes authoritative counters; opening the panel must not enqueue another cache scan.
  if (activeRun || transferPromise) return;
  const revision = runRevision;
  cancelBackgroundCheck?.();
  if (!activeRun && !transferPromise) set({ phase: 'checking', error: false, message: t('正在检查资源清单与本地缓存…') });
  const ctx = await resourceContext();
  if (!ctx.store) {
    set({ phase: 'error', supported: !ctx.unsupported, error: true, message: ctx.error || ctx.unsupported || t('服务器没有可预载的资源') });
    // A later open can retry a temporarily unavailable manifest.
    contextPromise = null;
    return;
  }
  try {
    if (activeRun || transferPromise) return;
    if (combatPaused) { if (current) set({ phase: 'paused' }); return; }
    const outcome = await withDownloadLock(async () => {
      if (combatPaused) return { deferred: true };
      const status = await ctx.store.status();
      if (combatPaused) return { deferred: true };
      await ctx.store.reconcileRuntimeIndex(status);
      if (combatPaused) return { deferred: true };
      if (status.complete) await ctx.store.prune();
      return { status };
    });
    if (outcome.deferred) { if (current) set({ phase: 'paused' }); return; }
    const status = outcome.busy ? await ctx.store.status() : outcome.status;
    // An inspection begun before a newer check/import must not overwrite its status.
    if (revision !== runRevision) return;
    const complete = selectionComplete(status);
    const missing = resourceSelection(status, true, ALL_VOICE_LANGS, true).selectedMissing;
    set({ ...counters(status), version: ctx.manifest.version, supported: true,
      ...(!activeRun && !transferPromise ? { phase: complete ? 'ready' : 'incomplete',
        message: complete ? t('清单资源已齐全。') : t('仍缺少 {missing} 个文件，请导入资源包。', { missing }), error: false } : {}) });
  } catch (err) {
    if (revision !== runRevision) return;
    set({ phase: 'error', error: true, message: t('无法读取本机资源缓存：{0}', { 0: err?.message || err }) });
  }
}
