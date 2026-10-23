import { open, realpath, rename, stat, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseAnnouncements, activeAnnouncement, ANNOUNCEMENT_MAX_COUNT } from '../shared/announcements.js';

export const ANNOUNCEMENT_POLL_MS = 2000;
export const ANNOUNCEMENT_MAX_BYTES = 128 * 1024;
const quiet = { info() {}, warn() {}, error() {} };

async function readBoundedBuffer(file) {
  let handle;
  try {
    handle = await open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > ANNOUNCEMENT_MAX_BYTES) throw new Error('announcement file must be at most 128 KiB');
    const buffer = Buffer.alloc(ANNOUNCEMENT_MAX_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const chunk = await handle.read(buffer, bytes, buffer.length - bytes, null);
      if (!chunk.bytesRead) break;
      bytes += chunk.bytesRead;
    }
    if (bytes > ANNOUNCEMENT_MAX_BYTES) throw new Error('announcement file must be at most 128 KiB');
    return buffer.subarray(0, bytes);
  } finally { await handle?.close().catch(() => {}); }
}

async function readBounded(file) {
  return (await readBoundedBuffer(file)).toString('utf8').replace(/^\uFEFF/, '');
}

const MISSING_REVISION = 'missing-v1';
function revisionOf(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function configError(code, status, message) { return Object.assign(new Error(message), { code, status }); }

/** Optional local popup .md/.txt bodies. Never fetch remote content or read outside the config directory. */
async function popupTextFiles(doc, file) {
  if (!Array.isArray(doc?.announcements) || doc.announcements.length > ANNOUNCEMENT_MAX_COUNT) return doc;
  let root;
  let bodyBytes = 0;
  const rows = [];
  for (const row of doc.announcements) {
    if (!row || !Object.hasOwn(row, 'textFile')) { rows.push(row); continue; }
    if (row.type !== 'popup' || Object.hasOwn(row, 'text')) throw new Error('textFile requires popup and must not be combined with text');
    const name = row.textFile;
    if (typeof name !== 'string' || name.length > 256 || !/\.(md|txt)$/i.test(name)
        || /[\\:\u0000-\u001f\u007f]/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('textFile must be a relative .md/.txt path inside the config directory');
    }
    const { textFile, ...options } = row;
    const format = Object.hasOwn(row, 'format') ? row.format : (/\.md$/i.test(textFile) ? 'markdown' : 'plain');
    // Withdrawal must still work when the old body was removed or is being edited. Disabled entries never publish it.
    if (row.enabled === false) {
      rows.push({ ...options, format, text: '[disabled]' });
      continue;
    }
    root ||= await realpath(path.dirname(file));
    const target = await realpath(path.join(root, name));
    if (!target.startsWith(root + path.sep)) throw new Error('textFile must stay inside the config directory');
    const text = await readBounded(target);
    bodyBytes += Buffer.byteLength(text, 'utf8');
    if (bodyBytes > ANNOUNCEMENT_MAX_BYTES) throw new Error('expanded announcement content must be at most 128 KiB');
    rows.push({ ...options, format, text });
  }
  return { ...doc, announcements: rows };
}

/** Read-only config service: content polling also catches atomic replacements inside Docker bind mounts. */
export class Announcements {
  constructor({ file, broadcast = () => {}, now = Date.now, log = quiet, pollMs = ANNOUNCEMENT_POLL_MS } = {}) {
    this.file = file;
    this.broadcast = broadcast;
    this.now = now;
    this.log = log;
    this.pollMs = pollMs;
    this.rows = [];
    this.current = null;
    this.popupCurrent = null;
    this.key = '[null,null]';
    this.raw = null;
    this.loaded = false;
    this.lastError = null;
    this.started = false;
    this.stopped = false;
    this.pollTimer = null;
    this.boundaryTimer = null;
    this.pending = null;
    this.writePending = Promise.resolve();
  }

  async start() {
    if (this.started || this.stopped) return;
    this.started = true;
    await this.reload();
    if (!this.stopped && this.file) {
      this.pollTimer = setInterval(() => { this.reload(); }, this.pollMs);
      this.pollTimer.unref?.();
    }
    this.refresh();
  }

  reload(forceBroadcast = false) {
    if (this.pending) return forceBroadcast ? this.pending.then((ok) => ok ? this.reload(true) : false) : this.pending;
    if (this.stopped || !this.file) return Promise.resolve(false);
    this.pending = this._read(forceBroadcast).finally(() => { this.pending = null; });
    return this.pending;
  }

  /** Read the editable scroll schedule and bind it to the exact bytes currently on disk. */
  async readEditable() {
    if (!this.file) throw configError('ANNOUNCEMENTS_DISABLED', 503, 'announcement storage is disabled');
    let bytes;
    try { bytes = await readBoundedBuffer(this.file); }
    catch (err) {
      if (err.code === 'ENOENT') return { announcements: [], revision: MISSING_REVISION };
      throw err;
    }
    try {
      const input = bytes.toString('utf8').replace(/^\uFEFF/, '');
      const doc = await popupTextFiles(JSON.parse(input), this.file);
      const rows = parseAnnouncements(doc).filter((row) => (row.type || 'scroll') === 'scroll');
      return { announcements: rows, revision: revisionOf(bytes) };
    } catch (err) {
      throw configError('ANNOUNCEMENTS_INVALID', 400, err.message);
    }
  }

  /** Replace only scroll rows, preserving popup source rows and checking the caller's file revision. */
  replaceScrollRows(announcements, expectedRevision) {
    if (!this.file) return Promise.reject(configError('ANNOUNCEMENTS_DISABLED', 503, 'announcement storage is disabled'));
    const operation = this.writePending.then(() => this._replaceScrollRows(announcements, expectedRevision));
    this.writePending = operation.catch(() => {});
    return operation;
  }

  async _replaceScrollRows(announcements, expectedRevision) {
    if (!Array.isArray(announcements) || typeof expectedRevision !== 'string') {
      throw configError('ANNOUNCEMENTS_INVALID', 400, 'announcements and revision are required');
    }
    let currentBytes = null;
    try { currentBytes = await readBoundedBuffer(this.file); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    const currentRevision = currentBytes ? revisionOf(currentBytes) : MISSING_REVISION;
    if (currentRevision !== expectedRevision) throw configError('ANNOUNCEMENTS_STALE', 409, 'announcement config changed; reload before saving');

    let current = { announcements: [] };
    if (currentBytes) {
      try { current = JSON.parse(currentBytes.toString('utf8').replace(/^\uFEFF/, '')); }
      catch (err) { throw configError('ANNOUNCEMENTS_INVALID', 400, err.message); }
    }
    if (!current || typeof current !== 'object' || Array.isArray(current) || !Array.isArray(current.announcements)) {
      throw configError('ANNOUNCEMENTS_INVALID', 400, 'announcement config must contain an announcements array');
    }
    const popupRows = current.announcements.filter((row) => row?.type === 'popup');
    if (announcements.some((row) => !row || typeof row !== 'object' || Array.isArray(row)
        || row.type === 'popup' || Object.hasOwn(row, 'textFile'))) {
      throw configError('ANNOUNCEMENTS_INVALID', 400, 'only scroll announcements may be edited');
    }
    const next = { ...current, announcements: [...announcements, ...popupRows] };
    try {
      const expanded = await popupTextFiles(next, this.file);
      if (Buffer.byteLength(JSON.stringify(expanded), 'utf8') > ANNOUNCEMENT_MAX_BYTES) throw new Error('expanded announcement content must be at most 128 KiB');
      parseAnnouncements(expanded);
    } catch (err) {
      throw configError('ANNOUNCEMENTS_INVALID', 400, err.message);
    }

    const output = Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8');
    if (output.length > ANNOUNCEMENT_MAX_BYTES) throw configError('ANNOUNCEMENTS_INVALID', 400, 'announcement config must be at most 128 KiB');
    const temp = path.join(path.dirname(this.file), `.${path.basename(this.file)}.${randomUUID()}.tmp`);
    let mode = 0o600;
    if (currentBytes) {
      try { mode = (await stat(this.file)).mode & 0o777; } catch { /* use the private default for a newly created config */ }
    }
    let handle;
    try {
      handle = await open(temp, 'wx', mode);
      await handle.writeFile(output);
      await handle.sync();
      await handle.close();
      handle = null;
      // Recheck after writing the temp file so edits made during validation are not overwritten.
      let latest = null;
      try { latest = await readBoundedBuffer(this.file); }
      catch (err) { if (err.code !== 'ENOENT') throw err; }
      if ((latest ? revisionOf(latest) : MISSING_REVISION) !== expectedRevision) {
        throw configError('ANNOUNCEMENTS_STALE', 409, 'announcement config changed; reload before saving');
      }
      await rename(temp, this.file);
    } finally {
      await handle?.close().catch(() => {});
      await unlink(temp).catch(() => {});
    }
    const result = await this.readEditable();
    await this.reload(true);
    return result;
  }

  async _read(forceBroadcast = false) {
    try {
      const input = await readBounded(this.file);
      const doc = await popupTextFiles(JSON.parse(input), this.file);
      const raw = JSON.stringify(doc);
      if (Buffer.byteLength(raw, 'utf8') > ANNOUNCEMENT_MAX_BYTES) throw new Error('expanded announcement content must be at most 128 KiB');
      if (this.stopped) return false;
      if (raw !== this.raw) {
        const rows = parseAnnouncements(doc);
        this.rows = rows;
        this.raw = raw;
        this.loaded = true;
      }
      this.lastError = null;
      this.refresh(forceBroadcast);
      return true;
    } catch (err) {
      if (!this.stopped) {
        const message = err.code || err.message;
        if (message !== this.lastError && !(message === 'ENOENT' && !this.loaded)) {
          this.log.warn(`[announcements] config rejected (${message}); keeping last valid schedule`);
        }
        this.lastError = message;
      }
      return false;
    }
  }

  refresh(forceBroadcast = false) {
    if (this.stopped) return;
    const now = this.now();
    const current = activeAnnouncement(this.rows, now);
    const popupCurrent = activeAnnouncement(this.rows, now, 'popup');
    const key = JSON.stringify([current, popupCurrent]);
    this.current = current;
    this.popupCurrent = popupCurrent;
    if (key !== this.key || forceBroadcast) {
      this.key = key;
      try { this.broadcast(this.message()); } catch (err) { this.log.error('[announcements] broadcast failed', err); }
    }
    clearTimeout(this.boundaryTimer);
    this.boundaryTimer = null;
    let next = Infinity;
    for (const row of this.rows) if (row.enabled) {
      if (row.startAt > now) next = Math.min(next, row.startAt);
      if (Number.isFinite(row.endAt) && row.endAt > now) next = Math.min(next, row.endAt);
    }
    if (Number.isFinite(next)) {
      // Recheck absolute wall time as well as boundaries: clock changes do not leave a long stale timer.
      this.boundaryTimer = setTimeout(() => this.refresh(), Math.max(1, Math.min(30000, next - now)));
      this.boundaryTimer.unref?.();
    }
  }

  message() { return { t: 'site.announcement', serverNow: this.now(), announcement: this.current, popupAnnouncement: this.popupCurrent }; }
  stats() { return { configured: !!this.file, loaded: this.loaded, entries: this.rows.length,
    activeId: this.current?.id || null, popupActiveId: this.popupCurrent?.id || null, configError: this.lastError }; }

  async stop() {
    this.stopped = true;
    clearInterval(this.pollTimer);
    clearTimeout(this.boundaryTimer);
    this.pollTimer = this.boundaryTimer = null;
    await this.pending;
  }
}
