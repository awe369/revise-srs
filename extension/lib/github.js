// Minimal GitHub "database": one JSON file, written through the Contents API.
// Every write is a read-merge-write with the file's blob sha, so concurrent
// writers (extension + website + another device) never lose each other's data.

import { emptyDeck, mergeDecks, compact } from './deck.js';

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export class GitHubStore {
  /** cfg: { owner, repo, branch, path, token } */
  constructor(cfg) {
    this.cfg = { branch: 'main', path: 'data/cloze.json', ...cfg };
  }

  get ready() { return !!(this.cfg.owner && this.cfg.repo && this.cfg.token); }

  async req(path, opts = {}) {
    const res = await fetch(API + path, {
      ...opts,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.cfg.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
      },
    });
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).message || msg; } catch {}
      throw new GitHubError(res.status, `GitHub ${res.status}: ${msg}`);
    }
    return opts.raw ? res.text() : res.json();
  }

  repoPath() {
    const { owner, repo } = this.cfg;
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  fileUrl() {
    const path = this.cfg.path.split('/').map(encodeURIComponent).join('/');
    return `${this.repoPath()}/contents/${path}`;
  }

  /** Check the token can push to the repo. Returns repo info. */
  async test() {
    const repo = await this.req(this.repoPath());
    if (!repo.permissions?.push) throw new GitHubError(403, 'Token can read this repo but cannot write to it. Give it "Contents: Read and write".');
    return repo;
  }

  /** Create the data branch from the default branch if it doesn't exist yet. */
  async ensureBranch() {
    const { branch } = this.cfg;
    try {
      await this.req(`${this.repoPath()}/git/ref/heads/${encodeURIComponent(branch)}`);
      return;
    } catch (e) { if (e.status !== 404) throw e; }
    const repo = await this.req(this.repoPath());
    const base = await this.req(`${this.repoPath()}/git/ref/heads/${encodeURIComponent(repo.default_branch)}`);
    await this.req(`${this.repoPath()}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: base.object.sha }),
    });
  }

  /** Returns { deck, sha }. sha is null when the file does not exist yet. */
  async load() {
    const ref = `?ref=${encodeURIComponent(this.cfg.branch)}`;
    let meta;
    try {
      meta = await this.req(this.fileUrl() + ref);
    } catch (e) {
      if (e.status === 404) return { deck: emptyDeck(), sha: null };
      throw e;
    }
    // Files > 1 MB come back without inline content; fetch the raw blob instead.
    const text = meta.content && meta.encoding === 'base64'
      ? fromBase64(meta.content)
      : await this.req(this.fileUrl() + ref, { raw: true, headers: { Accept: 'application/vnd.github.raw+json' } });
    return { deck: { ...emptyDeck(), ...JSON.parse(text) }, sha: meta.sha };
  }

  /**
   * Merge `local` into whatever is on GitHub and write it back.
   * Retries on sha conflicts (someone else wrote in between). Returns the merged deck.
   */
  async sync(local, message = 'Update cloze cards') {
    let branchChecked = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      let remote;
      try {
        remote = await this.load();
      } catch (e) {
        // A missing branch shows up as 404 on the file (handled) or 422/409 on the ref.
        if (!branchChecked && (e.status === 409 || e.status === 422)) { await this.ensureBranch(); branchChecked = true; continue; }
        throw e;
      }
      const merged = compact(mergeDecks(remote.deck, local));
      if (remote.sha && JSON.stringify(merged) === JSON.stringify(remote.deck)) return merged; // nothing new
      if (!remote.sha && !Object.keys(merged.cards).length && !merged.settings?.updatedAt) return merged; // don't create an empty file

      const body = {
        message,
        content: toBase64(JSON.stringify(merged, null, 1)),
        branch: this.cfg.branch,
        ...(remote.sha ? { sha: remote.sha } : {}),
      };
      try {
        await this.req(this.fileUrl(), { method: 'PUT', body: JSON.stringify(body) });
        return merged;
      } catch (e) {
        // Branch missing → 404/422 on first write: create it and retry.
        if (!branchChecked && (e.status === 404 || e.status === 422)) { await this.ensureBranch(); branchChecked = true; continue; }
        if (e.status === 409 || e.status === 422) { await new Promise((r) => setTimeout(r, 300 * 2 ** attempt)); continue; }
        throw e;
      }
    }
    throw new GitHubError(409, 'Could not save after several retries (the file keeps changing). Try again.');
  }
}

/** Read-only access for public repos without a token (used by the website as a fallback). */
export async function loadPublic({ owner, repo, branch = 'main', path = 'data/cloze.json' }) {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}?t=${Date.now()}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (res.status === 404) return emptyDeck();
  if (!res.ok) throw new GitHubError(res.status, `Could not read ${url}`);
  return { ...emptyDeck(), ...(await res.json()) };
}
