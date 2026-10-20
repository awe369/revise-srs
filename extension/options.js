import { DEFAULT_CONFIG, getConfig, setConfig, siteUrlFor } from './config.js';
import { GitHubStore } from './lib/github.js';
import { googleReady } from './lib/google-config.js';

const $ = (id) => document.getElementById(id);
const fields = ['owner', 'repo', 'branch', 'path', 'token'];
const msg = $('msg');
const say = (text, cls = '') => { msg.className = `msg ${cls}`; msg.textContent = text; };

const cfg = await getConfig();
for (const f of fields) $(f).value = cfg[f] ?? '';
$('siteUrl').value = cfg.siteUrl || '';
$('floatingButton').checked = cfg.floatingButton;

// ---------- storage choice

function showBackend(b) {
  document.querySelector(`input[name="backend"][value="${b}"]`).checked = true;
  $('driveBox').hidden = b !== 'drive';
  $('form').hidden = b !== 'github';
  say('');
}
document.querySelectorAll('input[name="backend"]').forEach((r) => r.addEventListener('change', async () => {
  await chrome.storage.sync.set({ backend: r.value });
  showBackend(r.value);
  if (r.value === 'drive') renderGoogle();
  chrome.runtime.sendMessage({ type: 'sync' });
}));
showBackend(cfg.backend);

// ---------- Google Drive

$('driveNotReady').hidden = googleReady();
$('driveReady').hidden = !googleReady();

async function renderGoogle() {
  const { gsignedIn, gemail } = await chrome.storage.local.get(['gsignedIn', 'gemail']);
  $('signedIn').hidden = !gsignedIn;
  $('gin').hidden = !!gsignedIn;
  $('gemail').textContent = gemail || 'your Google account';
}
renderGoogle();

$('gin').addEventListener('click', async () => {
  say('Opening Google sign-in…');
  const res = await chrome.runtime.sendMessage({ type: 'google-signin' });
  if (res?.ok || res?.user) {
    const n = Object.values((await chrome.storage.local.get('deckCache')).deckCache?.cards || {}).filter((c) => !c.deleted).length;
    say(`Connected to Google Drive — ${n} cards saved in ClozeForge/cloze-cards.json.`, 'ok');
  } else say(res?.error || 'Sign-in did not finish.', 'err');
  renderGoogle();
});

$('gout').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'google-signout' });
  say('Signed out. Cards you make now wait on this computer until you sign in again.');
  renderGoogle();
});

// ---------- GitHub

function read() {
  const out = {};
  for (const f of fields) out[f] = $(f).value.trim();
  // Accept a pasted repo URL: https://github.com/owner/repo
  const m = out.repo.match(/github\.com\/([^/]+)\/([^/#?]+)/) || out.owner.match(/github\.com\/([^/]+)\/([^/#?]+)/);
  if (m) { out.owner = m[1]; out.repo = m[2].replace(/\.git$/, ''); }
  out.branch ||= DEFAULT_CONFIG.branch;
  out.path ||= DEFAULT_CONFIG.path;
  return out;
}

$('form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const next = read();
  await setConfig({ ...next, backend: 'github' });
  for (const f of fields) $(f).value = next[f];
  say('Testing…');
  try {
    const store = new GitHubStore(next);
    const repo = await store.test();
    await store.ensureBranch();
    const { deck } = await store.load();
    say(`Connected to ${repo.full_name} (${repo.private ? 'private' : 'public'}) — ${Object.keys(deck.cards).length} cards on “${next.branch}”.`, 'ok');
    chrome.runtime.sendMessage({ type: 'sync' });
  } catch (e) {
    say(e.status === 401 ? 'Token rejected (401). Check that you copied it fully and it has not expired.'
      : e.status === 404 ? 'Repository not found (404). Check owner/repo, and that the token has access to it.'
      : e.message, 'err');
  }
});

// ---------- general

$('floatingButton').addEventListener('change', () => chrome.storage.sync.set({ floatingButton: $('floatingButton').checked }));
$('siteUrl').addEventListener('change', () => chrome.storage.sync.set({ siteUrl: $('siteUrl').value.trim() }));

$('openSite').addEventListener('click', async () => {
  const url = siteUrlFor({ ...(await getConfig()), siteUrl: $('siteUrl').value.trim() });
  chrome.tabs.create({ url: url || 'https://awe369.github.io/revise-srs/cloze/' });
});
