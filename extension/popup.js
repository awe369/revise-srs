import { items } from './lib/deck.js';

const $ = (id) => document.getElementById(id);

function ago(t) {
  if (!t) return 'never synced';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'synced just now';
  if (s < 3600) return `synced ${Math.round(s / 60)} min ago`;
  return `synced ${Math.round(s / 3600)} h ago`;
}

async function render() {
  const st = await chrome.runtime.sendMessage({ type: 'status' });
  const now = Date.now();
  let due = 0, fresh = 0, total = 0;
  if (st.deckCache) {
    total = Object.values(st.deckCache.cards).filter((c) => !c.deleted).length;
    for (const { item } of items(st.deckCache)) {
      if (item.reps === 0) fresh++;
      else if (item.due <= now) due++;
    }
  }
  $('due').textContent = due;
  $('new').textContent = fresh;
  $('total').textContent = total;
  $('sync').textContent = st.outbox.length ? `${st.outbox.length} waiting to sync` : ago(st.lastSync);
  const needGoogle = st.backend === 'drive' && (!st.configured || /sign in/i.test(st.lastError));
  const warn = needGoogle ? 'Sign in with Google to save your cards in your own Google Drive.'
    : !st.configured ? 'Not connected yet — open Settings to choose where to save cards.' : st.lastError;
  $('warn').hidden = !warn;
  $('warn').textContent = warn || '';
  $('google').hidden = !needGoogle;
  $('where').textContent = st.backend === 'drive' ? (st.gemail ? `Google Drive · ${st.gemail}` : 'Google Drive') : 'GitHub';
}

$('review').addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'open-review' }); window.close(); });
$('make').addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'open-editor-active' }); window.close(); });
// The popup closes when Google's sign-in window opens; the background page finishes the sign-in.
$('google').addEventListener('click', () => { chrome.runtime.sendMessage({ type: 'google-signin' }); });
$('syncNow').addEventListener('click', async () => {
  $('sync').textContent = 'syncing…';
  await chrome.runtime.sendMessage({ type: 'sync' });
  render();
});

render();
