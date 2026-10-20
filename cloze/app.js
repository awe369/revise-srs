// ClozeForge review site. Static, no build step: runs straight from GitHub Pages.
import { renderCloze, renderAll, escapeHtml, stripCloze, clozeNumbers } from '../extension/lib/cloze.js';
import { schedule, preview, withDefaults, intervalForStep, formatDays, startOfDay, DAY, GRADES, DEFAULT_SETTINGS } from '../extension/lib/srs.js';
import { emptyDeck, createCard, editCard, items, mergeDecks, safeUrl, syncItems } from '../extension/lib/deck.js';
import { GitHubStore, loadPublic } from '../extension/lib/github.js';
import { DriveStore, DriveError } from '../extension/lib/drive.js';
import { GOOGLE_CLIENT_ID, DRIVE_SCOPE, googleReady } from '../extension/lib/google-config.js';

const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');

// =============================================================== config & local cache

const LS = { cfg: 'cf.cfg', token: 'cf.token', deck: 'cf.deck', dirty: 'cf.dirty', gtoken: 'cf.gtoken', gemail: 'cf.gemail', gsigned: 'cf.gsigned' };
const ls = {
  get(k, fb = null) { try { const v = localStorage.getItem(k) ?? sessionStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch { return fb; } },
  set(k, v, session = false) {
    try {
      (session ? localStorage : sessionStorage).removeItem(k);
      (session ? sessionStorage : localStorage).setItem(k, JSON.stringify(v));
    } catch { /* storage full or blocked: the in-memory deck still works */ }
  },
  del(k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch {} },
};

function detectRepo() {
  // https://<owner>.github.io/<repo>/cloze/  →  owner, repo
  const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
  if (!m) return { owner: '', repo: '' };
  const seg = location.pathname.split('/').filter(Boolean);
  const repo = seg.length > 1 ? seg[0] : `${m[1]}.github.io`;
  return { owner: m[1], repo };
}

// The Revise app on the same site already holds a token for this repo — reuse it, no second setup.
const reviseCfg = () => ls.get('revise-cfg', null) || {};

function loadCfg() {
  return {
    ...detectRepo(), ...(reviseCfg().owner ? { owner: reviseCfg().owner, repo: reviseCfg().repo } : {}),
    branch: 'main', path: 'data/cloze.json', ...ls.get(LS.cfg, {}),
    token: ls.get(LS.token, '') || reviseCfg().token || '',
    backend: ls.get(LS.cfg, {})?.backend || (googleReady() ? 'drive' : 'github'),
  };
}

let cfg = loadCfg();
let deck = ls.get(LS.deck) || emptyDeck();
let dirty = !!ls.get(LS.dirty, false);
let edits = 0; // bumps on every local change, so a push can tell if more happened meanwhile
const isDrive = () => cfg.backend === 'drive';
const googleToken = () => { const t = ls.get(LS.gtoken); return t && t.exp > Date.now() + 60_000 ? t.token : null; };
/** Can this page save to its storage right now? (else changes wait in this browser) */
const canWrite = () => (isDrive() ? !!googleToken() : !!cfg.token);
const store = () => (isDrive()
  ? new DriveStore({
    getToken: async () => googleToken() || Promise.reject(new DriveError(401, 'Sign in with Google to sync.')),
    onAuthError: () => ls.del(LS.gtoken),
  })
  : new GitHubStore(cfg));
const settings = () => withDefaults(deck.settings);

// =============================================================== sync

const syncBtn = $('#syncBtn');
let syncState = 'idle', syncTimer = null, syncing = null;

function setSync(state, text) {
  syncState = state;
  syncBtn.className = `sync ${state}`;
  $('#syncText').textContent = text;
}

function persist() {
  ls.set(LS.deck, deck);
  ls.set(LS.dirty, dirty);
}

/** Record a local change and schedule a push. */
function changed() {
  edits++;
  dirty = true;
  persist();
  refreshBadge();
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, 2500);
  if (!canWrite()) setSync('', 'Saved on this device');
}

async function sync() {
  if (syncing) return syncing;
  syncing = (async () => {
    clearTimeout(syncTimer);
    try {
      if (isDrive() && !googleToken()) {
        setSync('err', 'Sign in to sync');
        signInBanner();
        return;
      }
      setSync('busy', 'Syncing…');
      if (!isDrive() && !cfg.token) {
        if (!cfg.owner || !cfg.repo) { setSync('err', 'Not connected'); return; }
        const remote = await loadPublic(cfg);
        deck = mergeDecks(remote, deck);
        persist();
        setSync('', dirty ? 'Read-only · add token' : 'Read-only');
        return;
      }
      const before = edits;
      const merged = await store().sync(deck, 'Review cloze cards');
      deck = mergeDecks(merged, deck); // keep anything changed while the request was in flight
      dirty = edits !== before;
      persist();
      setSync('ok', `Synced ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
      if (dirty) syncTimer = setTimeout(sync, 1000);
    } catch (e) {
      setSync('err', navigator.onLine ? 'Sync failed' : 'Offline');
      syncBtn.title = e.message;
      if (isDrive() && e.status === 401) { ls.del(LS.gtoken); signInBanner(true); }
      else if (e.status === 401 || e.status === 403 || e.status === 404) showBanner(`${isDrive() ? 'Google Drive' : 'GitHub'} said: ${escapeHtml(e.message)} — check <a href="#/settings">Settings</a>.`);
    } finally {
      refreshBadge();
      // Re-render with fresh data, but never swap the card under the user's eyes or wipe a form being typed in.
      const typing = document.activeElement?.matches('input, textarea, select') || $('#modal').open;
      if (route() === 'review' ? !session.current : !typing && route() !== 'settings') render();
    }
  })().finally(() => { syncing = null; });
  return syncing;
}

syncBtn.addEventListener('click', sync);
addEventListener('online', sync);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && dirty && canWrite()) sync();
  if (document.visibilityState === 'visible') sync();
});

function showBanner(html) {
  const b = $('#banner');
  b.innerHTML = html;
  b.hidden = !html;
}

// =============================================================== Google sign-in (website)
// Google Identity Services token flow: a popup the first time, then it closes by itself.
// Tokens last an hour; after that one click on "Continue" renews it.

let gisLoading = null;
function loadGis() {
  gisLoading ??= new Promise((resolve, reject) => {
    const sc = Object.assign(document.createElement('script'), { src: 'https://accounts.google.com/gsi/client', async: true });
    sc.onload = resolve;
    sc.onerror = () => { gisLoading = null; reject(new Error('Could not load Google sign-in')); };
    document.head.appendChild(sc);
  });
  return gisLoading;
}

async function googleSignIn() {
  await loadGis();
  return new Promise((resolve) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      login_hint: ls.get(LS.gemail, '') || undefined,
      callback: async (r) => {
        if (r.error || !r.access_token) { toast(`Google sign-in failed: ${r.error || 'no token'}`); return resolve(false); }
        ls.set(LS.gtoken, { token: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 });
        ls.set(LS.gsigned, true);
        try { const u = await store().test(); if (u.emailAddress) ls.set(LS.gemail, u.emailAddress); } catch {}
        showBanner('');
        await sync();
        resolve(true);
      },
      error_callback: (e) => { toast(e?.type === 'popup_closed' ? 'Sign-in window was closed' : 'Google sign-in did not finish'); resolve(false); },
    });
    client.requestAccessToken({ prompt: ls.get(LS.gsigned) ? '' : 'select_account' });
  });
}

function googleSignOut() {
  const t = ls.get(LS.gtoken);
  if (t?.token) window.google?.accounts.oauth2.revoke(t.token, () => {});
  ls.del(LS.gtoken); ls.del(LS.gsigned); ls.del(LS.gemail);
}

function signInBanner(expired = false) {
  if (!googleReady()) return showBanner('Google Drive sign-in is not set up on this site yet. Use GitHub in <a href="#/settings">Settings</a>.');
  showBanner(expired || ls.get(LS.gsigned)
    ? `Your Google session ended — reviews are kept on this device until you <button class="linkbtn" data-gsignin>continue with Google</button>.`
    : `<b>Save your cards in your own Google Drive.</b> <button class="linkbtn" data-gsignin>Sign in with Google</button> — the site only sees the file it creates, never the rest of your Drive.`);
}

$('#banner').addEventListener('click', (e) => { if (e.target.closest('[data-gsignin]')) googleSignIn(); });

// =============================================================== review queue

const session = { current: null, reviewed: 0, total: 0, undo: [], revealed: false };

function introducedToday(now) {
  const t0 = startOfDay(now) / 1000;
  let n = 0;
  for (const { item } of items(deck)) if (item.log?.length && item.log[0][0] >= t0) n++;
  return n;
}

function buildQueue(now = Date.now()) {
  const due = [], fresh = [], learnAhead = [];
  for (const it of items(deck)) {
    if (it.item.reps === 0) fresh.push(it);
    else if (it.item.due <= now) due.push(it);
    else if (it.item.step === -1 && it.item.due - now < 20 * 60_000) learnAhead.push(it);
  }
  due.sort((a, b) => a.item.due - b.item.due);
  fresh.sort((a, b) => a.card.createdAt - b.card.createdAt || a.n - b.n);
  learnAhead.sort((a, b) => a.item.due - b.item.due);
  const newLeft = Math.max(0, settings().newPerDay - introducedToday(now));
  const learning = due.filter((x) => x.item.step === -1);
  const reviews = due.filter((x) => x.item.step !== -1);
  // Interleave new cards between reviews so a session never ends on a wall of new material.
  const queue = [...learning];
  const news = fresh.slice(0, newLeft);
  const every = news.length ? Math.max(1, Math.floor(reviews.length / news.length)) : Infinity;
  reviews.forEach((r, i) => { queue.push(r); if ((i + 1) % every === 0 && news.length) queue.push(news.shift()); });
  queue.push(...news, ...learnAhead);
  return { queue, counts: { new: Math.min(fresh.length, newLeft), learn: learning.length + learnAhead.length, review: reviews.length } };
}

function refreshBadge() {
  const { queue } = buildQueue();
  const b = $('#dueBadge');
  b.textContent = queue.length;
  b.hidden = !queue.length;
  document.title = queue.length ? `(${queue.length}) Cloze — Revise` : 'Cloze — Revise';
}

function grade(g) {
  const cur = session.current;
  if (!cur || !session.revealed) return;
  const card = deck.cards[cur.card.id];
  if (!card || card.deleted || !card.srs[cur.n]) { session.current = null; return renderReview(); } // changed on another device
  const prev = card.srs[cur.n];
  session.undo.push({ id: card.id, n: cur.n, prev });
  card.srs = { ...card.srs, [cur.n]: schedule(prev, g, Date.now(), settings(), `${card.id}:${cur.n}`) };
  session.reviewed++;
  session.current = null;
  changed();
  renderReview();
}

function undo() {
  const u = session.undo.pop();
  if (!u || !deck.cards[u.id]) return;
  const card = deck.cards[u.id];
  card.srs = { ...card.srs, [u.n]: u.prev };
  session.reviewed = Math.max(0, session.reviewed - 1);
  session.current = { card, n: u.n, item: u.prev };
  session.revealed = false;
  changed();
  renderReview(true);
  toast('Undone');
}

// =============================================================== rendering helpers

function favicon(src) {
  const letter = escapeHtml((src?.domain || hostOf(src?.url) || '?')[0].toUpperCase());
  const url = safeUrl(src?.favicon);
  return `<span class="fav">${url ? `<img src="${escapeHtml(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}${url ? '' : letter}</span>`;
}

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }

function srcChip(src) {
  const link = safeUrl(src?.link) || safeUrl(src?.url);
  if (!link) return '';
  const title = src.title || hostOf(link);
  return `<a class="src-chip" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(link)}" data-src>${favicon(src)}<span>${escapeHtml(title)}</span></a>`;
}

function contextHtml(src) {
  if (!src?.context) return '';
  const ctx = src.context, q = src.quote || '';
  const i = q ? ctx.indexOf(q) : -1;
  if (i < 0) return escapeHtml(ctx);
  return `${escapeHtml(ctx.slice(0, i))}<mark>${escapeHtml(q)}</mark>${escapeHtml(ctx.slice(i + q.length))}`;
}

function relDue(t, now = Date.now()) {
  const d = Math.round((startOfDay(t) - startOfDay(now)) / DAY);
  if (t <= now) return 'due now';
  if (d <= 0) return `in ${Math.max(1, Math.round((t - now) / 60_000))} min`;
  if (d === 1) return 'tomorrow';
  return `in ${formatDays(d)}`;
}

// =============================================================== views

function route() { return (location.hash.match(/^#\/(\w+)/) || [, 'review'])[1]; }

function render() {
  const r = route();
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.route === r));
  ({ review: renderReview, cards: renderCards, stats: renderStats, settings: renderSettings }[r] || renderReview)();
}

function renderReview(keepCurrent = false) {
  const now = Date.now();
  const { queue, counts } = buildQueue(now);
  if (!keepCurrent || !session.current) {
    // Avoid showing the exact same item twice in a row if anything else is available.
    session.current = queue.find((q) => !(session.last && q.card.id === session.last.id && q.n === session.last.n)) || queue[0] || null;
    session.revealed = false;
  }
  session.total = session.reviewed + queue.length;
  const cur = session.current;

  if (!cur) {
    closeViewer();
    const total = Object.values(deck.cards).filter((c) => !c.deleted).length;
    let next = Infinity;
    for (const { item } of items(deck)) if (item.reps > 0) next = Math.min(next, item.due);
    view.innerHTML = total ? `
      <div class="panel empty">
        <div class="big">✓</div>
        <h1>All caught up</h1>
        <p class="muted">${session.reviewed ? `You reviewed ${session.reviewed} card${session.reviewed > 1 ? 's' : ''} this session. ` : ''}${isFinite(next) ? `Next review ${relDue(next, now)}.` : ''}</p>
        <a class="btn" href="#/stats">See stats</a><a class="btn ghost" href="#/cards">Browse cards</a>
      </div>` : `
      <div class="panel empty">
        <div class="big"><span class="logo">[…]</span></div>
        <h1>No cards yet</h1>
        <p class="muted">Install the ClozeForge extension, select text on any website and press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>.<br>Cards appear here and come back on a 1 → 3 → 7 → 15 → 30 day schedule.</p>
        <a class="btn primary" href="#/settings">Set up</a><button class="btn" data-new>Add a card manually</button>
      </div>`;
    $('[data-new]', view)?.addEventListener('click', () => openEditor(null));
    return;
  }

  session.last = { id: cur.card.id, n: cur.n };
  const card = cur.card, item = card.srs[cur.n];
  const pv = preview(item, now, settings(), `${card.id}:${cur.n}`);
  const pct = session.total ? Math.round((session.reviewed / session.total) * 100) : 0;
  const stepLabel = item.reps === 0 ? 'new' : item.step < 0 ? 'relearning' : `${formatDays(intervalForStep(item.step, settings()))} rung`;
  const many = clozeNumbers(card.text).length > 1;

  view.innerHTML = `
    <div class="qmeta">
      <span class="counts"><b class="n">${counts.new}</b> new · <b class="l">${counts.learn}</b> learning · <b class="r">${counts.review}</b> review</span>
      <span>${session.reviewed} done</span>
    </div>
    <div class="progress"><i style="width:${pct}%"></i></div>
    <article class="panel card">
      <div class="card-top">
        ${srcChip(card.source)}
        ${(card.tags || []).slice(0, 4).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
        <span class="step-pill" title="${item.reps} reviews · ${item.lapses} lapses">${many ? `c${cur.n} · ` : ''}${stepLabel}</span>
      </div>
      <div class="card-text" id="cardText">${renderCloze(card.text, cur.n, session.revealed)}</div>
      ${session.revealed ? `
        ${card.extra ? `<div class="card-extra">${escapeHtml(card.extra)}</div>` : ''}
        ${card.source?.context ? `<div class="context-label">From the page</div><div class="context">${contextHtml(card.source)}</div>` : ''}
        <div class="card-actions">
          ${safeUrl(card.source?.link || card.source?.url) ? `
            <a class="btn sm" href="${escapeHtml(safeUrl(card.source.link) || safeUrl(card.source.url))}" target="_blank" rel="noopener noreferrer" data-src>Open source ↗ <kbd>O</kbd></a>
            <button class="btn sm" data-act="inline">View here <kbd>V</kbd></button>` : ''}
          <button class="btn sm ghost" data-act="edit">Edit <kbd>E</kbd></button>
          <button class="btn sm ghost" data-act="suspend">Suspend</button>
          ${session.undo.length ? '<button class="btn sm ghost" data-act="undo">Undo <kbd>Z</kbd></button>' : ''}
        </div>` : ''}
    </article>
    <div class="answer-bar">
      ${session.revealed ? `
        <div class="grades">
          ${[['again', 1, 'Again'], ['hard', 2, 'Hard'], ['good', 3, 'Good'], ['easy', 4, 'Easy']].map(([k, g, label]) => `
            <button class="grade ${k}" data-grade="${g}"><b>${label}</b><small>${pv[k].label}</small><kbd>${g}</kbd></button>`).join('')}
        </div>` : `
        <button class="btn primary reveal" data-act="reveal">Show answer <kbd style="background:transparent;color:inherit;border-color:currentColor;opacity:.6">Space</kbd></button>
        ${session.undo.length ? '<p class="hint-keys"><a href="#" data-act="undo">Undo last answer</a> · <kbd>Z</kbd></p>' : ''}`}
      <p class="hint-keys">Press <kbd>?</kbd> for shortcuts</p>
    </div>`;

  view.querySelectorAll('[data-grade]').forEach((b) => b.addEventListener('click', () => grade(+b.dataset.grade)));
  view.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); act(b.dataset.act); }));
  view.querySelectorAll('[data-src]').forEach((a) => a.addEventListener('click', (e) => { if (openSource(cur)) e.preventDefault(); }));
  if ($('#viewer').hidden === false) openViewer(card.source); // keep the side panel in sync with the card
}

function act(a) {
  const cur = session.current;
  switch (a) {
    case 'reveal': session.revealed = true; renderReview(true); break;
    case 'undo': undo(); break;
    case 'inline': if (cur) openViewer(cur.card.source, true); break;
    case 'open': { const u = cur && (safeUrl(cur.card.source?.link) || safeUrl(cur.card.source?.url)); if (u && !openSource(cur)) window.open(u, '_blank', 'noopener'); break; }
    case 'edit': if (cur) openEditor(cur.card); break;
    case 'suspend':
      if (!cur) break;
      deck.cards[cur.card.id] = { ...deck.cards[cur.card.id], suspended: true, editedAt: Date.now() };
      session.current = null; changed(); renderReview();
      toast('Card suspended', 'Undo', () => { deck.cards[cur.card.id] = { ...deck.cards[cur.card.id], suspended: false, editedAt: Date.now() }; changed(); render(); });
      break;
  }
}

// ---------------------------------------------------------------- source page quiz
// With the extension installed, the source page opens with this card's answer hidden there too.
// Returns false when the extension isn't there (the caller then opens a plain link).

function openSource(cur) {
  const link = cur && (safeUrl(cur.card.source?.link) || safeUrl(cur.card.source?.url));
  if (!link || document.documentElement.dataset.clozeforge !== '1') return false;
  window.postMessage({ type: 'clozeforge:open', link, text: cur.card.text, n: cur.n }, location.origin);
  return true;
}

// The extension inside the side viewer says it's ready → send it the card to hide.
addEventListener('message', (ev) => {
  if (ev.data?.type !== 'clozeforge:ready' || ev.source !== $('#viewerFrame').contentWindow || !session.current) return;
  ev.source.postMessage({ type: 'clozeforge:quiz', text: session.current.card.text, n: session.current.n }, '*');
});

// ---------------------------------------------------------------- inline source viewer

function openViewer(src, toggle = false) {
  const v = $('#viewer');
  const url = safeUrl(src?.url);
  if (toggle && !v.hidden && v.dataset.url === url) return closeViewer();
  if (!url) return closeViewer();
  const link = safeUrl(src.link) || url;
  // Never frame our own origin with scripts + same-origin: it could read this page's token.
  if (new URL(url).origin === location.origin) { window.open(link, '_blank', 'noopener'); return; }
  $('#viewerTitle').textContent = src.title || hostOf(url);
  $('#viewerOpen').href = link;
  if (v.dataset.url !== url) { $('#viewerFrame').src = url; v.dataset.url = url; }
  v.hidden = false;
  document.body.classList.add('split');
}

function closeViewer() {
  const v = $('#viewer');
  if (v.hidden) return;
  v.hidden = true;
  v.dataset.url = '';
  $('#viewerFrame').src = 'about:blank';
  document.body.classList.remove('split');
}
$('#viewerClose').addEventListener('click', closeViewer);

// ---------------------------------------------------------------- cards list

const listState = { q: '', filter: 'all', sort: 'recent', limit: 100 };

function renderCards() {
  closeViewer();
  const now = Date.now();
  const all = Object.values(deck.cards).filter((c) => !c.deleted);
  const q = listState.q.toLowerCase();
  const nextDue = (c) => Math.min(...Object.values(c.srs).map((i) => (i.reps ? i.due : now)), Infinity);
  let rows = all.filter((c) => {
    if (q && !`${stripCloze(c.text)} ${c.extra} ${(c.tags || []).join(' ')} ${c.source?.title || ''} ${c.source?.domain || ''}`.toLowerCase().includes(q)) return false;
    const its = Object.values(c.srs);
    if (listState.filter === 'due') return !c.suspended && its.some((i) => i.reps && i.due <= now);
    if (listState.filter === 'new') return !c.suspended && its.some((i) => !i.reps);
    if (listState.filter === 'suspended') return c.suspended;
    return true;
  });
  rows.sort(listState.sort === 'due' ? (a, b) => nextDue(a) - nextDue(b) : (a, b) => b.createdAt - a.createdAt);
  const shown = rows.slice(0, listState.limit);

  view.innerHTML = `
    <div class="toolbar">
      <input type="search" id="q" placeholder="Search ${all.length} cards…" value="${escapeHtml(listState.q)}" aria-label="Search cards">
      <select id="sort" style="width:auto" aria-label="Sort"><option value="recent">Newest</option><option value="due">Next due</option></select>
      <button class="btn primary" data-new>+ New card</button>
    </div>
    <div class="chips" role="tablist">
      ${['all', 'due', 'new', 'suspended'].map((f) => `<button class="chip ${listState.filter === f ? 'on' : ''}" data-f="${f}">${f[0].toUpperCase() + f.slice(1)}</button>`).join('')}
    </div>
    <p class="count-line">${rows.length} card${rows.length === 1 ? '' : 's'}</p>
    <div class="list">
      ${shown.map((c) => {
        const its = Object.values(c.srs);
        const nd = nextDue(c);
        const status = c.suspended ? 'suspended' : its.every((i) => !i.reps) ? 'new' : relDue(nd, now);
        return `<div class="row ${c.suspended ? 'sus' : ''}" data-id="${escapeHtml(c.id)}" tabindex="0">
          <div class="t">${renderAll(c.text)}</div>
          <div class="m">${c.source?.url ? `${favicon(c.source)} ${escapeHtml(c.source.domain || hostOf(c.source.url))}` : '<span>manual</span>'}
            · <span>${status}</span> · <span>${its.length} cloze${its.length > 1 ? 's' : ''}</span>
            ${(c.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
        </div>`;
      }).join('') || '<p class="muted">Nothing here.</p>'}
    </div>
    ${rows.length > shown.length ? `<p style="text-align:center"><button class="btn" data-more>Show more</button></p>` : ''}`;

  $('#sort', view).value = listState.sort;
  const qi = $('#q', view);
  qi.addEventListener('input', () => { listState.q = qi.value; listState.limit = 100; renderCards(); $('#q', view).focus(); const el = $('#q', view); el.setSelectionRange(el.value.length, el.value.length); });
  $('#sort', view).addEventListener('change', (e) => { listState.sort = e.target.value; renderCards(); });
  view.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => { listState.filter = b.dataset.f; renderCards(); }));
  view.querySelectorAll('.row').forEach((r) => {
    const open = () => openEditor(deck.cards[r.dataset.id]);
    r.addEventListener('click', (e) => { if (!e.target.closest('a')) open(); });
    r.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  });
  $('[data-new]', view).addEventListener('click', () => openEditor(null));
  $('[data-more]', view)?.addEventListener('click', () => { listState.limit += 200; renderCards(); });
}

// ---------------------------------------------------------------- editor modal

function openEditor(card) {
  const dlg = $('#modal');
  const isNew = !card;
  const src = card?.source || {};
  dlg.innerHTML = `
    <form method="dialog" id="ed">
      <h1>${isNew ? 'New card' : 'Edit card'}</h1>
      <label class="f" for="edText">Text <span class="muted">— wrap answers like <code>{{c1::answer}}</code> or <code>{{c1::answer::hint}}</code></span></label>
      <textarea id="edText" rows="4" required>${escapeHtml(card?.text || '')}</textarea>
      <div class="tools" style="margin-top:6px"><button type="button" class="btn sm" id="edCloze">[…] Cloze selection <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd></button></div>
      <div class="preview-box" id="edPrev"></div>
      <label class="f" for="edExtra">Back extra</label>
      <textarea id="edExtra" rows="2">${escapeHtml(card?.extra || '')}</textarea>
      <div class="grid2">
        <div><label class="f" for="edTags">Tags</label><input type="text" id="edTags" value="${escapeHtml((card?.tags || []).join(' '))}"></div>
        <div><label class="f" for="edUrl">Source URL</label><input type="url" id="edUrl" value="${escapeHtml(src.url || '')}" placeholder="https://"></div>
      </div>
      ${!isNew ? `<p class="muted" style="font-size:13px;margin:14px 0 0">Created ${new Date(card.createdAt).toLocaleDateString()} · ${Object.values(card.srs).reduce((s, i) => s + i.reps, 0)} reviews</p>` : ''}
      <div class="foot">
        ${!isNew ? `<button type="button" class="btn sm danger" id="edDel">Delete</button>
          <button type="button" class="btn sm ghost" id="edSus">${card.suspended ? 'Unsuspend' : 'Suspend'}</button>
          <button type="button" class="btn sm ghost" id="edReset">Reset progress</button>` : ''}
        <span class="sp"></span>
        <button type="button" class="btn" id="edCancel">Cancel</button>
        <button type="submit" class="btn primary" id="edSave">Save</button>
      </div>
    </form>`;
  const ta = $('#edText', dlg), pv = $('#edPrev', dlg);
  const upd = () => {
    pv.innerHTML = renderAll(ta.value) || '<span class="muted">Preview</span>';
    $('#edSave', dlg).disabled = clozeNumbers(ta.value).length === 0;
  };
  const clozeSel = (same) => {
    const { selectionStart: s, selectionEnd: e, value } = ta;
    if (s === e) return;
    const nums = clozeNumbers(value);
    const n = same && nums.length ? Math.max(...nums) : (nums.length ? Math.max(...nums) : 0) + 1;
    ta.value = `${value.slice(0, s)}{{c${n}::${value.slice(s, e)}}}${value.slice(e)}`;
    upd();
  };
  ta.addEventListener('input', upd);
  ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyC') { e.preventDefault(); clozeSel(e.altKey); } });
  $('#edCloze', dlg).addEventListener('click', () => clozeSel(false));
  $('#edCancel', dlg).addEventListener('click', () => dlg.close());
  upd();

  const finish = (msg) => { dlg.close(); changed(); if (session.current && deck.cards[session.current.card.id]) session.current.card = deck.cards[session.current.card.id]; render(); if (msg) toast(msg); };

  $('#ed', dlg).addEventListener('submit', (e) => {
    e.preventDefault();
    const url = safeUrl($('#edUrl', dlg).value.trim());
    const patch = {
      text: ta.value.trim(),
      extra: $('#edExtra', dlg).value.trim(),
      tags: $('#edTags', dlg).value.split(/[\s,]+/).filter(Boolean),
    };
    if (isNew) {
      const c = createCard({ ...patch, source: url ? { url, link: url, title: hostOf(url), domain: hostOf(url) } : null });
      deck.cards[c.id] = c;
      return finish('Card added');
    }
    const source = url === (src.url || null) || (!url && !src.url) ? card.source : (url ? { ...src, url, link: url, domain: hostOf(url) } : null);
    deck.cards[card.id] = editCard(deck.cards[card.id], { ...patch, source });
    finish('Saved');
  });

  if (!isNew) {
    $('#edDel', dlg).addEventListener('click', () => {
      const before = deck.cards[card.id];
      deck.cards[card.id] = { ...before, deleted: true, editedAt: Date.now() };
      if (session.current?.card.id === card.id) session.current = null;
      finish();
      toast('Card deleted', 'Undo', () => { deck.cards[card.id] = { ...before, editedAt: Date.now() }; changed(); render(); });
    });
    $('#edSus', dlg).addEventListener('click', () => {
      deck.cards[card.id] = { ...deck.cards[card.id], suspended: !card.suspended, editedAt: Date.now() };
      if (session.current?.card.id === card.id) session.current = null;
      finish(card.suspended ? 'Unsuspended' : 'Suspended');
    });
    $('#edReset', dlg).addEventListener('click', () => {
      if (!confirm('Forget all review history for this card?')) return;
      const now = Date.now();
      // Bump `last` so this reset wins the merge against older review states on other devices.
      const srs = {};
      for (const n of Object.keys(card.srs)) srs[n] = { step: -1, due: now, reps: 0, lapses: 0, last: now, log: [] };
      deck.cards[card.id] = syncItems({ ...deck.cards[card.id], srs, editedAt: now }, now);
      finish('Progress reset');
    });
  }
  dlg.showModal();
  ta.focus();
}

// ---------------------------------------------------------------- stats

function renderStats() {
  closeViewer();
  const now = Date.now();
  const today0 = startOfDay(now);
  const cards = Object.values(deck.cards).filter((c) => !c.deleted);
  const its = [...items(deck)];
  const reviewsByDay = new Map();
  let total30 = 0, pass30 = 0;
  for (const { item } of its) {
    for (const [t, g] of item.log || []) {
      const day = startOfDay(t * 1000);
      reviewsByDay.set(day, (reviewsByDay.get(day) || 0) + 1);
      if (t * 1000 > now - 30 * DAY) { total30++; if (g > 1) pass30++; }
    }
  }
  let streak = 0;
  for (let d = reviewsByDay.has(today0) ? today0 : startOfDay(now, -1); reviewsByDay.has(d); d = startOfDay(d, -1)) streak++;
  const { queue } = buildQueue(now);
  const learned = its.filter((x) => x.item.reps > 0).length;
  const mature = its.filter((x) => x.item.step >= 0 && intervalForStep(x.item.step, settings()) >= 30).length;

  // forecast: due per day for the next 30 days (overdue folds into today)
  const fc = Array(30).fill(0);
  for (const { item } of its) {
    if (!item.reps) continue;
    const d = Math.max(0, Math.round((startOfDay(item.due) - today0) / DAY));
    if (d < 30) fc[d]++;
  }
  const fmax = Math.max(1, ...fc);

  // heatmap: last 26 weeks, columns are weeks starting Sunday
  const weeks = 26;
  const start = startOfDay(now, -(weeks * 7 - 1) - new Date(now).getDay());
  const hmax = Math.max(1, ...reviewsByDay.values());
  let heat = '';
  for (let d = start; d <= today0; d = startOfDay(d, 1)) {
    const c = reviewsByDay.get(d) || 0;
    const l = c ? Math.min(4, Math.ceil((c / hmax) * 4)) : 0;
    heat += `<i data-l="${l}" title="${new Date(d).toLocaleDateString()}: ${c} review${c === 1 ? '' : 's'}"></i>`;
  }

  // ladder distribution
  const cfgS = settings();
  const rungs = new Map();
  for (const { item } of its) {
    const key = !item.reps ? 'new' : item.step < 0 ? 'relearn' : formatDays(intervalForStep(item.step, cfgS));
    rungs.set(key, (rungs.get(key) || 0) + 1);
  }
  const order = ['new', 'relearn', ...Array.from({ length: cfgS.ladder.length + 6 }, (_, i) => formatDays(intervalForStep(i, cfgS)))];
  const rmax = Math.max(1, ...rungs.values());

  view.innerHTML = `
    <h1>Stats</h1>
    <div class="tiles" style="margin-top:14px">
      <div class="panel tile"><b>${queue.length}</b><span>due now</span></div>
      <div class="panel tile"><b>${reviewsByDay.get(today0) || 0}</b><span>reviewed today</span></div>
      <div class="panel tile"><b>${streak}</b><span>day streak</span></div>
      <div class="panel tile"><b>${total30 ? Math.round((pass30 / total30) * 100) + '%' : '–'}</b><span>recall, last 30 days</span></div>
      <div class="panel tile"><b>${cards.length}</b><span>cards · ${its.length} clozes</span></div>
      <div class="panel tile"><b>${mature}</b><span>mature (≥ 30 d) of ${learned}</span></div>
    </div>
    <h2>Upcoming reviews · next 30 days</h2>
    <div class="panel chart">
      <div class="bars">${fc.map((v, i) => `<div class="${v ? '' : 'zero'}" style="height:${(v / fmax) * 100}%" title="${i === 0 ? 'Today' : new Date(startOfDay(now, i)).toLocaleDateString()}: ${v}"></div>`).join('')}</div>
      <div class="axis"><span>today</span><span>+1 week</span><span>+2 weeks</span><span>+3 weeks</span><span>+30 d</span></div>
    </div>
    <h2>Review activity · last 6 months</h2>
    <div class="panel chart"><div class="heat">${heat}</div></div>
    <h2>Where your clozes sit on the ladder</h2>
    <div class="panel chart ladder">
      ${order.filter((k, i, a) => rungs.has(k) && a.indexOf(k) === i).map((k) => `
        <div class="lr"><span>${k}</span><span class="bar"><i style="width:${(rungs.get(k) / rmax) * 100}%"></i></span><span class="v">${rungs.get(k)}</span></div>`).join('') || '<p class="muted">No cards yet.</p>'}
    </div>`;
}

// ---------------------------------------------------------------- settings

function renderSettings() {
  closeViewer();
  const s = settings();
  const remembered = (() => { try { return localStorage.getItem(LS.token) != null || !cfg.token; } catch { return false; } })();
  const extUrl = cfg.owner && cfg.repo ? `https://github.com/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/tree/main/extension` : '';
  view.innerHTML = `
    <div class="settings">
      <h1>Settings</h1>
      <div class="panel">
        <h2>Where your cards are saved</h2>
        <div class="choice" role="radiogroup" aria-label="Storage">
          <label class="opt"><input type="radio" name="sBackend" value="drive" ${isDrive() ? 'checked' : ''} ${googleReady() ? '' : 'disabled'}><b>Google Drive</b><span>Your own Drive · sign in with Google</span></label>
          <label class="opt"><input type="radio" name="sBackend" value="github" ${isDrive() ? '' : 'checked'}><b>GitHub</b><span>A repo you own · needs a token</span></label>
        </div>
        ${isDrive() ? `
          <p class="muted">Cards live in <code>ClozeForge/cloze-cards.json</code> in your Google Drive. This site can only see files it created — never the rest of your Drive. Use the same Google account in the extension.</p>
          <div class="actions">
            ${ls.get(LS.gsigned)
              ? `<span>✅ Signed in${ls.get(LS.gemail) ? ` as <b>${escapeHtml(ls.get(LS.gemail))}</b>` : ''}</span>
                 ${googleToken() ? '' : '<button class="btn primary" id="sGin">Continue with Google</button>'}
                 <button class="btn ghost" id="sGout">Sign out</button>`
              : '<button class="btn primary" id="sGin"><span class="g">G</span> Sign in with Google</button>'}
          </div>
          ${cfg.owner && cfg.repo ? `<p class="muted" style="font-size:13px;margin-top:14px">Had cards on GitHub before? <button class="linkbtn" id="sImportGh">Copy them from ${escapeHtml(cfg.owner)}/${escapeHtml(cfg.repo)}</button> into Drive.</p>` : ''}` : ''}
        ${!googleReady() ? '<p class="muted" style="font-size:13px">Google Drive needs a Google client ID in <code>extension/lib/google-config.js</code> (see the README).</p>' : ''}
      </div>
      <div class="panel" ${isDrive() ? 'hidden' : ''}>
        <h2>GitHub storage</h2>
        <p class="muted" style="margin-top:-6px">Cards live in <code>${escapeHtml(cfg.path || 'data/cloze.json')}</code> on the <code>${escapeHtml(cfg.branch || 'main')}</code> branch. ${reviseCfg().token && cfg.token === reviseCfg().token ? 'Using the token from your Revise app.' : 'Use the same values as in the extension.'}</p>
        <div class="grid2">
          <div><label class="f" for="sOwner">User / org</label><input type="text" id="sOwner" value="${escapeHtml(cfg.owner)}"></div>
          <div><label class="f" for="sRepo">Repository</label><input type="text" id="sRepo" value="${escapeHtml(cfg.repo)}"></div>
          <div><label class="f" for="sBranch">Data branch</label><input type="text" id="sBranch" value="${escapeHtml(cfg.branch)}"></div>
          <div><label class="f" for="sPath">File path</label><input type="text" id="sPath" value="${escapeHtml(cfg.path)}"></div>
        </div>
        <label class="f" for="sToken">Personal access token <span class="muted">— needed to save reviews (fine-grained, Contents: read &amp; write)</span></label>
        <input type="password" id="sToken" value="${escapeHtml(cfg.token)}" placeholder="github_pat_…" autocomplete="off">
        <label class="check"><input type="checkbox" id="sRemember" ${remembered ? 'checked' : ''}> <span>Remember on this device <span class="muted">— otherwise it's forgotten when you close the tab. Only use on your own devices.</span></span></label>
        <div class="actions"><button class="btn primary" id="sConnect">Save &amp; connect</button><span class="msg" id="sMsg"></span></div>
      </div>

      <div class="panel">
        <h2>Spaced repetition</h2>
        <label class="f" for="sLadder">Interval ladder in days <span class="muted">— Good moves one rung up, Easy two, Hard stays, Again restarts</span></label>
        <input type="text" id="sLadder" value="${s.ladder.join(', ')}">
        <div class="grid2">
          <div><label class="f" for="sGrowth">After the last rung, multiply by</label><input type="number" id="sGrowth" min="1.1" max="5" step="0.1" value="${s.growth}"></div>
          <div><label class="f" for="sNew">New clozes per day</label><input type="number" id="sNew" min="0" max="9999" value="${s.newPerDay}"></div>
        </div>
        <label class="check"><input type="checkbox" id="sOverdue" ${s.overdueCredit ? 'checked' : ''}> <span>Overdue credit <span class="muted">— if you still remember a card you reviewed late, it climbs past the rungs you already proved.</span></span></label>
        <label class="check"><input type="checkbox" id="sFuzz" ${s.fuzz ? 'checked' : ''}> <span>Spread reviews <span class="muted">— ±5% on intervals of a week or more, so cards made together don't all land on one day.</span></span></label>
        <p class="muted" id="sLadderPreview" style="font-size:13px"></p>
        <div class="actions"><button class="btn primary" id="sSaveSrs">Save schedule</button><button class="btn ghost" id="sResetSrs">Restore defaults</button></div>
      </div>

      <div class="panel">
        <h2>Chrome extension</h2>
        <ol class="steps">
          <li>Download this repository (${extUrl ? `<a href="${escapeHtml(extUrl)}" target="_blank" rel="noopener">extension folder</a>` : 'the <code>extension</code> folder'}) — Code → Download ZIP, then unzip.</li>
          <li>Open <code>chrome://extensions</code>, turn on <b>Developer mode</b>, click <b>Load unpacked</b> and choose the <code>extension</code> folder.</li>
          <li>In the extension's settings, ${isDrive() ? 'choose <b>Google Drive</b> and sign in with the same Google account' : 'enter the same repo and a token'}. Then select text anywhere and press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>.</li>
        </ol>
      </div>

      <div class="panel">
        <h2>Data</h2>
        <div class="actions" style="margin-top:0">
          <button class="btn" id="sExport">Export JSON</button>
          <label class="btn" style="margin:0">Import JSON<input type="file" id="sImport" accept="application/json,.json" hidden></label>
          <select id="sTheme" style="width:auto;margin-left:auto" aria-label="Theme">
            <option value="">Theme: system</option><option value="light">Light</option><option value="dark">Dark</option>
          </select>
        </div>
      </div>
    </div>`;

  const ladderPreview = () => {
    const l = parseLadder($('#sLadder').value);
    const tmp = { ...s, ladder: l.length ? l : s.ladder, growth: +$('#sGrowth').value || 2 };
    $('#sLadderPreview').textContent = 'Schedule: ' + Array.from({ length: tmp.ladder.length + 3 }, (_, i) => formatDays(intervalForStep(i, tmp))).join(' → ') + ' → …';
  };
  $('#sLadder').addEventListener('input', ladderPreview);
  $('#sGrowth').addEventListener('input', ladderPreview);
  ladderPreview();

  view.querySelectorAll('input[name="sBackend"]').forEach((r) => r.addEventListener('change', () => {
    ls.set(LS.cfg, { ...ls.get(LS.cfg, {}), backend: r.value });
    cfg = loadCfg();
    showBanner('');
    renderSettings();
    sync();
  }));
  $('#sGin')?.addEventListener('click', async () => { if (await googleSignIn()) renderSettings(); });
  $('#sGout')?.addEventListener('click', () => { googleSignOut(); setSync('', 'Signed out'); renderSettings(); signInBanner(); });
  $('#sImportGh')?.addEventListener('click', async () => {
    try {
      const gh = cfg.token && !isDrive() ? (await new GitHubStore(cfg).load()).deck : await loadPublic({ owner: cfg.owner, repo: cfg.repo, branch: 'main', path: 'data/cloze.json' });
      const before = Object.values(deck.cards).filter((c) => !c.deleted).length;
      deck = mergeDecks(deck, gh);
      changed();
      toast(`Copied ${Object.values(deck.cards).filter((c) => !c.deleted).length - before} cards from GitHub`);
    } catch (e) { toast(`Could not read GitHub: ${e.message}`); }
  });

  $('#sConnect').addEventListener('click', async () => {
    const msg = $('#sMsg');
    let owner = $('#sOwner').value.trim(), repo = $('#sRepo').value.trim();
    const m = `${owner} ${repo}`.match(/github\.com\/([^/\s]+)\/([^/#?\s]+)/);
    if (m) { owner = m[1]; repo = m[2].replace(/\.git$/, ''); }
    const next = { owner, repo, branch: $('#sBranch').value.trim() || 'main', path: $('#sPath').value.trim() || 'data/cloze.json' };
    const token = $('#sToken').value.trim();
    ls.set(LS.cfg, next);
    if (token) ls.set(LS.token, token, !$('#sRemember').checked); else ls.del(LS.token);
    cfg = { ...next, token };
    msg.className = 'msg'; msg.textContent = 'Connecting…';
    try {
      if (token) { const r = await store().test(); msg.textContent = `Connected to ${r.full_name}.`; }
      await sync();
      msg.className = syncState === 'err' ? 'msg err' : 'msg ok';
      msg.textContent = syncState === 'err' ? `Could not sync: ${syncBtn.title}` : `${msg.textContent} ${Object.values(deck.cards).filter((c) => !c.deleted).length} cards loaded.`;
      if (syncState !== 'err') showBanner('');
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = e.status === 401 ? 'Token rejected — copy it again or create a new one.' : e.message;
    }
  });

  $('#sSaveSrs').addEventListener('click', () => {
    const ladder = parseLadder($('#sLadder').value);
    if (!ladder.length) return toast('Ladder needs at least one number of days');
    deck.settings = {
      ...deck.settings, ladder,
      growth: Math.min(5, Math.max(1.1, +$('#sGrowth').value || 2)),
      newPerDay: Math.max(0, Math.round(+$('#sNew').value || 0)),
      overdueCredit: $('#sOverdue').checked,
      fuzz: $('#sFuzz').checked,
      updatedAt: Date.now(),
    };
    changed();
    toast('Schedule saved — applies to your next answers');
  });
  $('#sResetSrs').addEventListener('click', () => { deck.settings = { ...DEFAULT_SETTINGS, ladder: [...DEFAULT_SETTINGS.ladder], updatedAt: Date.now() }; changed(); renderSettings(); });

  $('#sExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(deck, null, 1)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `clozeforge-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#sImport').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data || typeof data.cards !== 'object') throw new Error('Not a ClozeForge export');
      const before = Object.keys(deck.cards).length;
      deck = mergeDecks(deck, data);
      changed();
      toast(`Imported ${Object.keys(deck.cards).length - before} new cards`);
    } catch (err) { toast(`Import failed: ${err.message}`); }
  });
  const theme = $('#sTheme');
  theme.value = ls.get('cf.theme', '') || '';
  theme.addEventListener('change', () => { ls.set('cf.theme', theme.value); applyTheme(); });
}

const parseLadder = (s) => s.split(/[\s,;→>]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0).map((n) => Math.round(n)).sort((a, b) => a - b);

function applyTheme() {
  const t = ls.get('cf.theme', '') || ls.get('revise-theme', '');
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
}

// ---------------------------------------------------------------- toasts, shortcuts, help

function toast(text, actionLabel, onAction) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${escapeHtml(text)}</span>${actionLabel ? `<button>${escapeHtml(actionLabel)}</button>` : ''}`;
  if (actionLabel) el.querySelector('button').addEventListener('click', () => { onAction(); el.remove(); });
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), actionLabel ? 6000 : 2600);
}

function showHelp() {
  const dlg = $('#modal');
  dlg.innerHTML = `
    <h1>Keyboard shortcuts</h1>
    <div class="keys">
      <span><kbd>Space</kbd> / <kbd>Enter</kbd></span><span>Show answer · then answer Good</span>
      <span><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd></span><span>Again · Hard · Good · Easy</span>
      <span><kbd>O</kbd></span><span>Open the source page at the exact sentence</span>
      <span><kbd>V</kbd></span><span>View the source page beside the card</span>
      <span><kbd>E</kbd></span><span>Edit card</span>
      <span><kbd>Z</kbd></span><span>Undo last answer</span>
      <span><kbd>S</kbd></span><span>Sync now</span>
    </div>
    <h2>How scheduling works</h2>
    <p class="muted" style="margin:0">Each <code>{{cN::…}}</code> is reviewed separately. <b>Good</b> climbs one rung on your ladder (${settings().ladder.join(' → ')} days, then ×${settings().growth}), <b>Easy</b> two, <b>Hard</b> repeats the current interval and <b>Again</b> shows it again in ${settings().relearnMinutes} minutes and restarts the ladder.</p>
    <div class="foot"><span class="sp"></span><button class="btn" onclick="this.closest('dialog').close()">Close</button></div>`;
  dlg.showModal();
}

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || $('#modal').open) return;
  if (e.target.closest('input, textarea, select, [contenteditable]')) return;
  const k = e.key.toLowerCase();
  if (k === '?') { e.preventDefault(); return showHelp(); }
  if (k === 's') { e.preventDefault(); return sync(); }
  if (route() !== 'review' || !session.current) return;
  if ((k === ' ' || k === 'enter') && !e.target.closest('button, a')) {
    e.preventDefault();
    session.revealed ? grade(GRADES.GOOD) : act('reveal');
  } else if (session.revealed && ['1', '2', '3', '4'].includes(k)) { e.preventDefault(); grade(+k); }
  else if (k === 'z') { e.preventDefault(); undo(); }
  else if (session.revealed && k === 'o') { e.preventDefault(); act('open'); }
  else if (session.revealed && k === 'v') { e.preventDefault(); act('inline'); }
  else if (k === 'e') { e.preventDefault(); act('edit'); }
  else if (k === 'escape') closeViewer();
});

// =============================================================== boot

addEventListener('hashchange', () => { render(); view.focus({ preventScroll: true }); });
applyTheme();
render();
refreshBadge();
if (!reviseCfg().token) $('.back')?.setAttribute('hidden', ''); // the "‹ Revise" link is only for the Revise owner
if (isDrive()) { if (!googleToken()) signInBanner(); if (googleReady()) loadGis().catch(() => {}); }
else if (!cfg.owner || !cfg.repo) showBanner('Welcome! Open <a href="#/settings">Settings</a> to connect your GitHub repository.');
else if (!cfg.token) showBanner('Read-only mode: reviews are kept on this device. Add a token in <a href="#/settings">Settings</a> to sync them to GitHub.');
sync();
setInterval(() => { refreshBadge(); if (document.visibilityState === 'visible') sync(); }, 5 * 60_000);
