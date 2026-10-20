// Google Drive "database": the same one-JSON-file deck as GitHubStore, kept in the user's own Drive
// at ClozeForge/cloze-cards.json. Same interface as GitHubStore: ready, test(), load(), sync().
//
// Drive has no compare-and-swap on writes, so a write re-checks the file's `version` right before
// uploading and starts over (re-read, re-merge) if someone else wrote in between.

import { emptyDeck, mergeDecks, compact } from './deck.js';
import { DRIVE_FILE, DRIVE_FOLDER } from './google-config.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export class DriveError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class DriveStore {
  /** getToken(): Promise<string> — throws a DriveError(401) when the user has to sign in. */
  constructor({ getToken, onAuthError }) {
    this.getToken = getToken;
    this.onAuthError = onAuthError; // called once on a 401, e.g. to drop a stale token
    this.fileId = null;
  }

  get ready() { return true; }

  async req(url, opts = {}, retried = false) {
    const token = await this.getToken();
    const res = await fetch(url, {
      ...opts,
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, ...opts.headers },
    });
    if (res.status === 401 && !retried && this.onAuthError) {
      await this.onAuthError();
      return this.req(url, opts, true);
    }
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).error?.message || msg; } catch {}
      throw new DriveError(res.status, res.status === 401 ? 'Google sign-in expired — sign in again.' : `Google Drive ${res.status}: ${msg}`);
    }
    return opts.raw ? res.text() : res.json();
  }

  async find(q) {
    const url = `${API}/files?${new URLSearchParams({ q, spaces: 'drive', orderBy: 'createdTime', fields: 'files(id,version)', pageSize: '10' })}`;
    return (await this.req(url)).files || [];
  }

  async meta() {
    if (!this.fileId) {
      const [f] = await this.find(`name = '${DRIVE_FILE}' and trashed = false`);
      if (!f) return null;
      this.fileId = f.id;
    }
    try {
      return await this.req(`${API}/files/${this.fileId}?fields=id,version`);
    } catch (e) {
      if (e.status !== 404) throw e;
      this.fileId = null; // deleted in Drive → look it up / create it again
      return this.meta();
    }
  }

  /** Signed-in Google account, e.g. for "Signed in as …". */
  async test() {
    const about = await this.req(`${API}/about?fields=user(displayName,emailAddress)`);
    return about.user || {};
  }

  /** Returns { deck, version }. version is null when the file does not exist yet. */
  async load() {
    const m = await this.meta();
    if (!m) return { deck: emptyDeck(), version: null };
    const text = await this.req(`${API}/files/${m.id}?alt=media`, { raw: true });
    return { deck: { ...emptyDeck(), ...(text.trim() ? JSON.parse(text) : {}) }, version: m.version };
  }

  async folderId() {
    const [f] = await this.find(`name = '${DRIVE_FOLDER}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
    if (f) return f.id;
    const made = await this.req(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: DRIVE_FOLDER, mimeType: 'application/vnd.google-apps.folder' }),
    });
    return made.id;
  }

  async create(content) {
    const boundary = 'cf' + Math.random().toString(36).slice(2);
    const meta = { name: DRIVE_FILE, mimeType: 'application/json', parents: [await this.folderId()] };
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`
      + `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
    const f = await this.req(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    this.fileId = f.id;
  }

  /** Merge `local` into the copy in Drive and write it back. Returns the merged deck. */
  async sync(local) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const remote = await this.load();
      const merged = compact(mergeDecks(remote.deck, local));
      const content = JSON.stringify(merged, null, 1);
      if (remote.version && content === JSON.stringify(remote.deck, null, 1)) return merged; // nothing new
      if (!remote.version) {
        if (!Object.keys(merged.cards).length && !merged.settings?.updatedAt) return merged; // don't create an empty file
        await this.create(content);
        return merged;
      }
      const now = await this.meta();
      if (now?.version !== remote.version) { await new Promise((r) => setTimeout(r, 250 * 2 ** attempt)); continue; }
      await this.req(`${UPLOAD}/files/${this.fileId}?uploadType=media&fields=id`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: content,
      });
      return merged;
    }
    throw new DriveError(409, 'Could not save after several retries (the file keeps changing). Try again.');
  }
}
