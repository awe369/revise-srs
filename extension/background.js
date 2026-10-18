// Service worker: context menu, keyboard command, offline outbox and GitHub sync.

import { getConfig, siteUrlFor } from './config.js';
import { GitHubStore } from './lib/github.js';
import { createCard, emptyDeck, items, mergeDecks } from './lib/deck.js';

// ---------- menus & commands ----------

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'cloze', title: 'Make cloze card from “%s”', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'review', title: 'Open ClozeForge review', contexts: ['action'] });
  });
  chrome.alarms.create('sync', { periodInMinutes: 15 });
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
    // Tab was open before the extension was installed/updated: inject, then retry.
    try {
      await chrome.scripting.executeScript({ target, files: ['content.js'] });
      await send();
    } catch (e) {
      console.warn('ClozeForge cannot run on this page', e); // chrome:// pages, Web Store, PDF viewer…
    }
  }
}

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
  syncing ??= doSync().finally(() => { syncing = null; });
  return syncing;
}

async function doSync() {
  const cfg = await getConfig();
  const store = new GitHubStore(cfg);
  const { outbox, deckCache } = await getLocal();
  if (!store.ready) {
    await chrome.storage.local.set({ lastError: 'Not connected — open the extension options to add your GitHub repo and token.' });
    return { ok: false, queued: outbox.length };
  }
  try {
    const local = emptyDeck();
    for (const card of outbox) local.cards[card.id] = card;
    const merged = outbox.length
      ? await store.sync(local, outbox.length === 1 ? `Add card: ${outbox[0].source?.title || outbox[0].id}`.slice(0, 120) : `Add ${outbox.length} cards`)
      : mergeDecks(deckCache, (await store.load()).deck);
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
  await chrome.action.setBadgeBackgroundColor({ color: '#d4572a' });
  await chrome.action.setBadgeText({ text: due ? String(due > 999 ? '999+' : due) : '' });
}

// ---------- messages from content script / popup ----------

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
        return { configured: !!(cfg.owner && cfg.repo && cfg.token), siteUrl: siteUrlFor(cfg), ...local };
      }
      case 'sync':
        return sync();
      case 'open-review':
        await openReview(msg.hash || '');
        return { ok: true };
      case 'open-editor-active':
        await openEditor(await activeTab());
        return { ok: true };
      case 'config':
        return getConfig().then(({ token, ...rest }) => rest);
      default:
        return { ok: false, error: 'unknown message' };
    }
  })().then(reply, (e) => reply({ ok: false, error: e.message }));
  return true; // async reply
});
