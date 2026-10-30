// Service worker: context menu, keyboard command, offline outbox and sync (Google Drive or GitHub).

import { getConfig, siteUrlFor } from './config.js';
import { GitHubStore } from './lib/github.js';
import { DriveStore } from './lib/drive.js';
import { getGoogleToken, dropGoogleToken, signInGoogle, signOutGoogle } from './google-auth.js';
import { syncToAnki, applyLadder } from './lib/anki.js';
import { createCard, emptyDeck, items, mergeDecks } from './lib/deck.js';

// ---------- menus & commands ----------

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'cloze', title: 'Make cloze card from “%s”', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'review', title: 'Open ClozeForge review', contexts: ['action'] });
  });
  chrome.alarms.create('sync', { periodInMinutes: 5 });
  if (reason === 'install') chrome.runtime.openOptionsPage();
  refresh();
});

chrome.runtime.onStartup.addListener(refresh);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'cloze') openEditor(tab, info.frameId);
  if (info.menuItemId === 'review') openReview();
});

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd === 'create-cloze') openEditor(tab || (await activeTab()));
});

chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'sync') refresh(); });

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function openEditor(tab, frameId) {
  if (!tab?.id) return;
  const target = { tabId: tab.id, ...(frameId ? { frameIds: [frameId] } : {}) };
  const send = () => chrome.tabs.sendMessage(tab.id, { type: 'open-editor' }, frameId ? { frameId } : undefined);
  try {
    await send();
  } catch {
    // Our PDF viewer is an extension page: no content script to message, it listens for a broadcast instead.
    chrome.runtime.sendMessage({ type: 'open-editor-page', tabId: tab.id }).catch(() => {});
    // Tab was open before the extension was installed/updated: inject, then retry.
    try {
      await chrome.scripting.executeScript({ target, files: ['content.js'] });
      await send();
    } catch (e) {
      console.warn('ClozeForge cannot run on this page', e); // chrome:// pages, Web Store, PDF viewer…
    }
  }
}

// ---------- PDFs → ClozeForge PDF viewer
// Chrome's own PDF viewer doesn't let extensions in, so PDFs are opened in ours (pdf/viewer.html).

const VIEWER = chrome.runtime.getURL('pdf/viewer.html');
const viewerUrl = (u) => `${VIEWER}?file=${encodeURIComponent(u)}`;
const pdfBypass = new Map(); // url → until when "open in Chrome's viewer" was asked for
const noHash = (u) => u.split('#')[0];

async function openPdfInViewer(tabId, url) {
  if (!(await getConfig()).pdfViewer) return;
  if ((pdfBypass.get(noHash(url)) || 0) > Date.now()) return;
  // webRequest URLs have no #fragment; the tab's own URL keeps #page=N.
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const full = [tab?.pendingUrl, tab?.url].find((u) => u && noHash(u) === noHash(url)) || url;
  chrome.tabs.update(tabId, { url: viewerUrl(full) });
}

const isPdfPath = (u) => /\.pdf$/i.test(u.split(/[?#]/)[0]);

// Web PDFs: recognised by their Content-Type (works for links that don't end in .pdf too).
// onResponseStarted also fires when the PDF comes from Chrome's cache (onHeadersReceived doesn't).
chrome.webRequest.onResponseStarted.addListener((d) => {
  if (d.tabId < 0 || d.method !== 'GET') return;
  const h = (n) => d.responseHeaders?.find((x) => x.name.toLowerCase() === n)?.value || '';
  const pdf = /application\/(x-)?pdf/i.test(h('content-type')) || (/octet-stream/i.test(h('content-type')) && isPdfPath(d.url));
  if (pdf && !/^\s*attachment/i.test(h('content-disposition')) && (d.statusCode < 300 || d.statusCode === 304)) openPdfInViewer(d.tabId, d.url);
}, { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] }, ['responseHeaders']);

// PDFs on this computer (file:///…/notes.pdf): no network request, so watch the tab's address instead.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url?.startsWith('file:') && isPdfPath(info.url)) openPdfInViewer(tabId, info.url);
});

async function openReview(hash = '') {
  const url = siteUrlFor(await getConfig());
  chrome.tabs.create({ url: url ? url + hash : chrome.runtime.getURL('options.html') });
}

// ---------- outbox + sync ----------

// Cards are written to the outbox first, so nothing is lost when offline or misconfigured.
async function getLocal() {
  const { outbox = [], deckCache = null, lastSync = 0, lastError = '' } = await chrome.storage.local.get(['outbox', 'deckCache', 'lastSync', 'lastError']);
  return { outbox, deckCache, lastSync, lastError };
}

let syncing = null;
function sync() {
  // Anki is mirrored after every sync (also when the cloud sync failed: queued cards still reach Anki).
  syncing ??= doSync().then(async (r) => ({ ...r, anki: await ankiSync() })).finally(() => { syncing = null; });
  return syncing;
}

// ---------- Anki mirror (AnkiConnect)

let ankiRunning = null;
function ankiSync({ force = false } = {}) {
  ankiRunning ??= doAnkiSync(force).finally(() => { ankiRunning = null; });
  return ankiRunning;
}

async function doAnkiSync(force) {
  const cfg = await getConfig();
  if (!cfg.ankiEnabled && !force) return null;
  const { outbox = [], deckCache = null, ankiState = {} } = await chrome.storage.local.get(['outbox', 'deckCache', 'ankiState']);
  const local = emptyDeck();
  for (const card of outbox) local.cards[card.id] = card;
  try {
    const { state, counts } = await syncToAnki(mergeDecks(deckCache, local), {
      deckName: cfg.ankiDeck || 'ClozeForge',
      siteUrl: siteUrlFor(cfg) || 'https://awe369.github.io/revise-srs/cloze/',
      state: force ? { ...ankiState, modelVersion: 0 } : ankiState,
    });
    const ankiStatus = { ok: true, at: Date.now(), counts, total: Object.keys(state.notes).length };
    await chrome.storage.local.set({ ankiState: state, ankiStatus });
    return ankiStatus;
  } catch (e) {
    const ankiStatus = { ok: false, at: Date.now(), error: e.message, code: e.code };
    await chrome.storage.local.set({ ankiStatus });
    return ankiStatus;
  }
}

export function storeFor(cfg) {
  return cfg.backend === 'drive'
    ? new DriveStore({ getToken: () => getGoogleToken(false), onAuthError: dropGoogleToken })
    : new GitHubStore(cfg);
}

async function doSync() {
  const cfg = await getConfig();
  const store = storeFor(cfg);
  const { outbox, deckCache } = await getLocal();
  if (!store.ready) {
    await chrome.storage.local.set({ lastError: 'Not connected — open the extension options to add your GitHub repo and token.' });
    return { ok: false, queued: outbox.length };
  }
  try {
    const local = emptyDeck();
    for (const card of outbox) local.cards[card.id] = card;
    // Pushing the cached deck too means switching storage (GitHub → Drive) carries every card across.
    const merged = outbox.length || (deckCache && cfg.backend !== deckCache.backend)
      ? await store.sync(mergeDecks(deckCache, local), outbox.length === 1 ? `Add card: ${outbox[0].source?.title || outbox[0].id}`.slice(0, 120) : `Add ${outbox.length || 'cached'} cards`)
      : mergeDecks(deckCache, (await store.load()).deck);
    merged.backend = cfg.backend;
    // Only drop what was actually written (more may have been queued meanwhile).
    const sent = new Set(outbox.map((c) => c.id));
    const { outbox: now = [] } = await chrome.storage.local.get('outbox');
    await chrome.storage.local.set({
      outbox: now.filter((c) => !sent.has(c.id)),
      deckCache: merged,
      lastSync: Date.now(),
      lastError: '',
    });
    await updateBadge(merged);
    return { ok: true, queued: 0 };
  } catch (e) {
    await chrome.storage.local.set({ lastError: e.message });
    return { ok: false, error: e.message, queued: outbox.length };
  }
}

async function refresh() {
  await sync();
}

async function updateBadge(deck) {
  const now = Date.now();
  let due = 0;
  for (const { item } of items(deck || emptyDeck())) if (item.reps > 0 && item.due <= now) due++;
  await chrome.action.setBadgeBackgroundColor({ color: '#2f6fde' });
  await chrome.action.setBadgeText({ text: due ? String(due > 999 ? '999+' : due) : '' });
}

// ---------- messages from content script / popup ----------

let quizOpening = Promise.resolve();

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    switch (msg.type) {
      case 'save-card': {
        const card = createCard(msg.card);
        const { outbox = [] } = await chrome.storage.local.get('outbox');
        await chrome.storage.local.set({ outbox: [...outbox, card] });
        const res = await sync();
        return { ...res, id: card.id };
      }
      case 'status': {
        const cfg = await getConfig();
        const local = await getLocal();
        const { gsignedIn = false, gemail = '' } = await chrome.storage.local.get(['gsignedIn', 'gemail']);
        const configured = cfg.backend === 'drive' ? gsignedIn : !!(cfg.owner && cfg.repo && cfg.token);
        const { ankiStatus = null } = await chrome.storage.local.get('ankiStatus');
        return { configured, backend: cfg.backend, gemail, siteUrl: siteUrlFor(cfg), ankiEnabled: cfg.ankiEnabled, ankiStatus, ...local };
      }
      case 'anki-enable': {
        await chrome.storage.sync.set({ ankiEnabled: true, ...(msg.deck ? { ankiDeck: msg.deck } : {}) });
        return ankiSync({ force: true });
      }
      case 'anki-disable':
        await chrome.storage.sync.set({ ankiEnabled: false });
        return { ok: true };
      case 'anki-ladder': {
        const cfg = await getConfig();
        const { deckCache } = await chrome.storage.local.get('deckCache');
        await ankiSync({ force: true }); // makes sure the deck exists first
        return { ok: true, ...(await applyLadder(cfg.ankiDeck || 'ClozeForge', deckCache?.settings)) };
      }
      case 'sync':
        return sync();
      case 'open-review':
        await openReview(msg.hash || '');
        return { ok: true };
      case 'open-editor-active':
        await openEditor(await activeTab());
        return { ok: true };
      case 'open-quiz': {
        // Only the review site may ask for this.
        const cfg = await getConfig();
        const site = siteUrlFor(cfg);
        const from = sender.url || '';
        if (!(site && from.startsWith(site)) && !/^https:\/\/[^/]+\.github\.io\//.test(from) && !/^http:\/\/localhost[:/]/.test(from)) return { ok: false };
        // A fast page can ask for its card before tabs.create() has even resolved, so it waits on this.
        quizOpening = (async () => {
          const tab = await chrome.tabs.create({ url: msg.link, index: sender.tab ? sender.tab.index + 1 : undefined });
          await chrome.storage.session.set({ [`quiz:${tab.id}`]: { text: msg.text, n: msg.n } });
        })();
        await quizOpening;
        return { ok: true };
      }
      case 'quiz-pending': {
        await quizOpening.catch(() => {});
        const key = `quiz:${sender.tab?.id}`;
        const got = await chrome.storage.session.get(key);
        if (got[key]) await chrome.storage.session.remove(key); // one-shot: a reload shows the page normally
        return got[key] || null;
      }
      case 'google-signin': {
        await signInGoogle();
        await chrome.storage.sync.set({ backend: 'drive' });
        const user = await storeFor({ backend: 'drive' }).test().catch(() => ({}));
        if (user.emailAddress) await chrome.storage.local.set({ gemail: user.emailAddress });
        const res = await sync();
        return { ...res, user };
      }
      case 'google-signout':
        await signOutGoogle();
        return { ok: true };
      case 'pdf-bypass':
        pdfBypass.set(noHash(msg.url), Date.now() + 60_000);
        return { ok: true };
      case 'config':
        return getConfig().then(({ token, ...rest }) => rest);
      default:
        return { ok: false, error: 'unknown message' };
    }
  })().then(reply, (e) => reply({ ok: false, error: e.message }));
  return true; // async reply
});
