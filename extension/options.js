import { DEFAULT_CONFIG, getConfig, setConfig, siteUrlFor } from './config.js';
import { GitHubStore } from './lib/github.js';

const $ = (id) => document.getElementById(id);
const fields = ['owner', 'repo', 'branch', 'path', 'token', 'siteUrl'];
const msg = $('msg');

const cfg = await getConfig();
for (const f of fields) $(f).value = cfg[f] ?? '';
$('floatingButton').checked = cfg.floatingButton;

function read() {
  const out = { floatingButton: $('floatingButton').checked };
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
  await setConfig(next);
  for (const f of fields) $(f).value = next[f];
  msg.className = 'msg';
  msg.textContent = 'Testing…';
  try {
    const store = new GitHubStore(next);
    const repo = await store.test();
    await store.ensureBranch();
    const { deck } = await store.load();
    msg.className = 'msg ok';
    msg.textContent = `Connected to ${repo.full_name} (${repo.private ? 'private' : 'public'}) — ${Object.keys(deck.cards).length} cards on “${next.branch}”.`;
    chrome.runtime.sendMessage({ type: 'sync' });
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = e.status === 401 ? 'Token rejected (401). Check that you copied it fully and it has not expired.'
      : e.status === 404 ? 'Repository not found (404). Check owner/repo, and that the token has access to it.'
      : e.message;
  }
});

$('floatingButton').addEventListener('change', () => chrome.storage.sync.set({ floatingButton: $('floatingButton').checked }));

$('openSite').addEventListener('click', () => {
  const url = siteUrlFor(read());
  if (url) chrome.tabs.create({ url });
  else { msg.className = 'msg err'; msg.textContent = 'Enter your user and repository first.'; }
});
