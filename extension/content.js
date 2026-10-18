// ClozeForge content script: selection pill + card editor, rendered in a Shadow DOM
// so neither the page's CSS nor ours can leak across.
(() => {
  if (window.__clozeForge) return;
  window.__clozeForge = true;

  const BLOCK = /^(P|LI|DD|DT|TD|TH|BLOCKQUOTE|PRE|H[1-6]|FIGCAPTION|CAPTION|SECTION|ARTICLE|MAIN|DIV|BODY)$/;
  const SEL_MAX = 4000;
  let lib;                      // lib/cloze.js, loaded on first use
  let host, root, pill, editor; // UI nodes
  let settings = { floatingButton: true };
  let lastCapture = null;

  chrome.storage?.sync.get({ floatingButton: true }, (s) => { settings = s; });
  chrome.storage?.onChanged.addListener((c) => { if (c.floatingButton) settings.floatingButton = c.floatingButton.newValue; });

  const loadLib = () => (lib ??= import(chrome.runtime.getURL('lib/cloze.js')));
  const collapse = (s) => s.replace(/\s+/g, ' ');

  // ---------------------------------------------------------------- selection capture

  function closestBlock(node) {
    let el = node.nodeType === 1 ? node : node.parentElement;
    while (el && el !== document.body) {
      if (BLOCK.test(el.tagName) && collapse(el.textContent).trim().length > 0) {
        const display = getComputedStyle(el).display;
        if (!display.startsWith('inline')) return el;
      }
      el = el.parentElement;
    }
    return el || document.body;
  }

  function wordsOf(s) { return s.trim().split(/\s+/).filter(Boolean); }

  // Grow [s, e) to whole words — text fragments only match on word boundaries.
  function toWordBounds(full, s, e) {
    const w = /[\p{L}\p{N}_']/u;
    while (s > 0 && w.test(full[s - 1]) && w.test(full[s])) s--;
    while (e < full.length && w.test(full[e]) && w.test(full[e - 1])) e++;
    return [s, e];
  }

  // https://wicg.github.io/scroll-to-text-fragment/  →  #:~:text=prefix-,start,end,-suffix
  function textFragment(full, s, e) {
    [s, e] = toWordBounds(full, s, e);
    const enc = (t) => encodeURIComponent(t.trim()).replace(/-/g, '%2D');
    const quote = full.slice(s, e).trim();
    const w = wordsOf(quote);
    let body = quote.length <= 80 || w.length <= 8
      ? enc(quote)
      : `${enc(w.slice(0, 4).join(' '))},${enc(w.slice(-4).join(' '))}`;
    const pre = wordsOf(full.slice(0, s)).slice(-3).join(' ');
    const suf = wordsOf(full.slice(e)).slice(0, 3).join(' ');
    if (pre) body = `${enc(pre)}-,${body}`;
    if (suf) body = `${body},-${enc(suf)}`;
    return body;
  }

  function linkWithFragment(fragment) {
    const href = location.href.replace(/:~:.*$/, '');
    return href.includes('#') ? `${href}:~:text=${fragment}` : `${href}#:~:text=${fragment}`;
  }

  function sentencesAround(full, s, e) {
    if (!Intl.Segmenter) return full.slice(s, e);
    const seg = new Intl.Segmenter(document.documentElement.lang || undefined, { granularity: 'sentence' });
    let from = s, to = e;
    for (const { index, segment } of seg.segment(full)) {
      const end = index + segment.length;
      if (end > s && index < e) { from = Math.min(from, index); to = Math.max(to, end); }
    }
    return [from, to];
  }

  function faviconUrl() {
    const link = document.querySelector('link[rel~="icon"][href], link[rel="apple-touch-icon"][href]');
    try { return new URL(link ? link.getAttribute('href') : '/favicon.ico', location.href).href; } catch { return ''; }
  }

  function capture() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const quote = collapse(sel.toString()).trim();
    if (!quote) return null;
    const range = sel.getRangeAt(0);
    if (host && host.contains(range.commonAncestorContainer)) return null;

    const block = closestBlock(range.commonAncestorContainer);
    const full = collapse(block.textContent);
    const before = document.createRange();
    before.setStart(block, 0);
    before.setEnd(range.startContainer, range.startOffset);
    let s = collapse(before.toString()).length;
    const raw = collapse(range.toString());
    if (full.slice(s, s + raw.length) !== raw) s = Math.max(0, full.indexOf(raw.trim()));
    while (full[s] === ' ') s++;
    const e = Math.min(full.length, s + raw.trim().length);

    const [ss, se] = sentencesAround(full, s, e);
    const rect = range.getBoundingClientRect();
    return {
      quote: quote.slice(0, SEL_MAX),
      paragraph: full.trim().slice(0, SEL_MAX),
      sentence: full.slice(ss, se).trim(),
      // offsets of the quote inside sentence / paragraph, for pre-clozing
      inSentence: [s - ss, e - ss],
      inParagraph: [s - (full.length - full.trimStart().length), e - (full.length - full.trimStart().length)],
      link: linkWithFragment(textFragment(full, s, e)),
      url: location.href.replace(/#:~:.*$/, ''),
      title: document.title || location.hostname,
      favicon: faviconUrl(),
      rect: { x: rect.right, y: rect.bottom, top: rect.top, left: rect.left },
    };
  }

  // ---------------------------------------------------------------- shadow host

  function ensureHost() {
    if (host?.isConnected) return;
    host = document.createElement('clozeforge-ui');
    host.style.cssText = 'all: initial; position: fixed; inset: 0 auto auto 0; z-index: 2147483647;';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style>`;
    // Keep the page's global keyboard shortcuts from reacting while typing in our UI.
    for (const t of ['keydown', 'keyup', 'keypress', 'input']) host.addEventListener(t, (ev) => ev.stopPropagation());
    document.documentElement.appendChild(host);
  }

  // ---------------------------------------------------------------- floating pill

  function showPill(cap) {
    ensureHost();
    if (!pill) {
      pill = document.createElement('button');
      pill.className = 'pill';
      pill.innerHTML = `<span class="br">[…]</span> Cloze`;
      pill.title = 'Make a cloze card (Alt+Shift+C)';
      pill.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
      pill.addEventListener('click', () => { hidePill(); openEditor(lastCapture); });
      root.appendChild(pill);
    }
    const x = Math.min(innerWidth - 90, Math.max(8, cap.rect.x - 40));
    const y = cap.rect.y + 8 > innerHeight - 40 ? cap.rect.top - 40 : cap.rect.y + 8;
    pill.style.transform = `translate(${x}px, ${Math.max(8, y)}px)`;
    pill.hidden = false;
  }
  const hidePill = () => { if (pill) pill.hidden = true; };

  function isEditable(node) {
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    return !!el?.closest('input, textarea, [contenteditable=""], [contenteditable="true"]');
  }

  document.addEventListener('mouseup', (ev) => {
    if (host && ev.composedPath().includes(host)) return;
    setTimeout(() => {
      const sel = getSelection();
      if (!settings.floatingButton || editor || !sel || sel.isCollapsed || isEditable(sel.anchorNode)) return hidePill();
      const cap = capture();
      if (cap && cap.quote.length > 1) { lastCapture = cap; showPill(cap); } else hidePill();
    }, 10);
  }, true);
  document.addEventListener('mousedown', (ev) => { if (!host || !ev.composedPath().includes(host)) hidePill(); }, true);
  addEventListener('scroll', hidePill, { passive: true, capture: true });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === 'open-editor') {
      const cap = capture() || lastCapture;
      // Every frame gets the message: the one holding the selection opens the editor,
      // the top frame opens an empty one when no frame has a selection.
      const focusInChild = document.activeElement?.tagName === 'IFRAME' || document.activeElement?.tagName === 'FRAME';
      if (cap || (window === top && !focusInChild)) { hidePill(); openEditor(cap); }
      reply({ ok: true });
    }
  });

  // ---------------------------------------------------------------- editor

  async function openEditor(cap) {
    const { escapeHtml, parseCloze, wrapCloze, unwrapClozeAt, nextClozeNumber, clozeNumbers } = await loadLib();
    ensureHost();
    closeEditor();
    cap ||= {
      quote: '', paragraph: '', sentence: '', inSentence: [0, 0], inParagraph: [0, 0],
      link: location.href, url: location.href, title: document.title, favicon: faviconUrl(),
    };
    const domain = location.hostname.replace(/^www\./, '');
    const shortQuote = cap.quote && cap.quote.split(/\s+/).length <= 8 && cap.sentence.length <= 500;
    let scope = shortQuote ? 'sentence' : 'selection';

    const textFor = (sc) => {
      if (sc === 'selection') return cap.quote;
      const [src, [s, e]] = sc === 'sentence' ? [cap.sentence, cap.inSentence] : [cap.paragraph, cap.inParagraph];
      if (s >= 0 && e <= src.length && e > s && collapse(src.slice(s, e)).trim() === cap.quote) return wrapCloze(src, s, e, 1).text;
      return src || cap.quote;
    };

    editor = document.createElement('div');
    editor.className = 'backdrop';
    editor.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="New cloze card">
        <header>
          <div class="brand"><span class="logo">[…]</span> New cloze card</div>
          <button class="icon x" title="Close (Esc)" aria-label="Close">✕</button>
        </header>
        <div class="seg" role="tablist">
          ${['selection', 'sentence', 'paragraph'].map((s) => `<button data-scope="${s}" ${!cap.quote ? 'disabled' : ''}>${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}
        </div>
        <label class="lbl">Card text <span class="dim">— click words below to hide them, or select in the box and press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd></span></label>
        <textarea class="text" rows="4" spellcheck="true" placeholder="Paste or type text, then cloze parts of it"></textarea>
        <div class="tools">
          <button class="btn sm" data-act="new" title="Ctrl+Shift+C">[…] New cloze</button>
          <button class="btn sm" data-act="same" title="Ctrl+Alt+Shift+C">[…] Same number</button>
          <button class="btn sm ghost" data-act="clear">Remove all</button>
          <span class="count"></span>
        </div>
        <div class="preview" aria-label="Preview — click a word to cloze it"></div>
        <details class="more">
          <summary>Notes &amp; tags</summary>
          <label class="lbl">Back extra <span class="dim">(shown after the answer)</span></label>
          <textarea class="extra" rows="2" placeholder="Explanation, mnemonic, source note…"></textarea>
          <label class="lbl">Tags</label>
          <input class="tags" placeholder="space separated" />
        </details>
        <footer>
          <a class="src" target="_blank" rel="noopener noreferrer" title="${escapeHtml(cap.link)}">
            ${cap.favicon ? `<img src="${escapeHtml(cap.favicon)}" alt="">` : ''}
            <span>${escapeHtml(cap.title || domain)}</span>
          </a>
          <span class="status" role="status"></span>
          <button class="btn primary save">Save card <kbd>Ctrl</kbd>+<kbd>↵</kbd></button>
        </footer>
      </div>`;
    root.appendChild(editor);

    const $ = (s) => editor.querySelector(s);
    const ta = $('.text'), prev = $('.preview'), saveBtn = $('.save'), status = $('.status');
    $('.src').href = cap.link;
    $('.src img')?.addEventListener('error', (e) => e.target.remove());
    $('.tags').value = domain.split('.').slice(-2, -1)[0] || '';

    const setScope = (sc) => {
      scope = sc;
      editor.querySelectorAll('[data-scope]').forEach((b) => b.setAttribute('aria-selected', b.dataset.scope === sc));
      ta.value = textFor(sc);
      render();
    };

    const WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}'’\-_.]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu;
    function render() {
      const text = ta.value;
      let html = '';
      for (const seg of parseCloze(text)) {
        if (seg.type === 'cloze') {
          html += `<span class="cz" data-at="${seg.start}" title="Click to remove">${escapeHtml(seg.answer)}<sup>${seg.n}</sup></span>`;
          continue;
        }
        let last = 0;
        for (const m of seg.value.matchAll(WORD)) {
          html += escapeHtml(seg.value.slice(last, m.index));
          html += `<span class="w" data-s="${seg.start + m.index}" data-e="${seg.start + m.index + m[0].length}">${escapeHtml(m[0])}</span>`;
          last = m.index + m[0].length;
        }
        html += escapeHtml(seg.value.slice(last));
      }
      prev.innerHTML = html.replace(/\n/g, '<br>') || '<span class="dim">Preview appears here</span>';
      const n = clozeNumbers(text).length;
      $('.count').textContent = n ? `${n} card${n > 1 ? 's' : ''} will be created` : 'Hide at least one part to save';
      saveBtn.disabled = n === 0;
      ta.style.height = 'auto';
      ta.style.height = Math.min(220, ta.scrollHeight + 2) + 'px';
    }

    function clozeSelection(sameNumber) {
      const { selectionStart: s, selectionEnd: e, value } = ta;
      if (s === e) { status.textContent = 'Select some text in the box first'; return; }
      const n = sameNumber ? Math.max(1, nextClozeNumber(value) - 1) : nextClozeNumber(value);
      const r = wrapCloze(value, s, e, n);
      ta.value = r.text;
      ta.focus();
      ta.setSelectionRange(r.caret, r.caret);
      render();
    }

    // Click a word to cloze it; shift-click to give it the same number as the previous cloze.
    prev.addEventListener('click', (ev) => {
      const cz = ev.target.closest('.cz');
      if (cz) { ta.value = unwrapClozeAt(ta.value, +cz.dataset.at); return render(); }
      const w = ev.target.closest('.w');
      if (!w) return;
      const s = +w.dataset.s, e = +w.dataset.e;
      const n = ev.shiftKey || ev.altKey ? Math.max(1, nextClozeNumber(ta.value) - 1) : nextClozeNumber(ta.value);
      ta.value = wrapCloze(ta.value, s, e, n).text;
      render();
    });

    const close = () => closeEditor();
    $('.x').addEventListener('click', close);
    editor.addEventListener('mousedown', (ev) => { if (ev.target === editor) close(); });
    editor.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', () => setScope(b.dataset.scope)));
    $('[data-act="new"]').addEventListener('click', () => clozeSelection(false));
    $('[data-act="same"]').addEventListener('click', () => clozeSelection(true));
    $('[data-act="clear"]').addEventListener('click', () => { ta.value = ta.value.replace(/\{\{c\d+::([\s\S]*?)(?:::[\s\S]*?)?\}\}/g, '$1'); render(); });
    ta.addEventListener('input', render);

    editor.addEventListener('keydown', (ev) => {
      const mod = ev.ctrlKey || ev.metaKey;
      if (ev.key === 'Escape') { ev.preventDefault(); close(); }
      else if (mod && ev.key === 'Enter') { ev.preventDefault(); save(); }
      else if (mod && ev.shiftKey && (ev.key === 'C' || ev.key === 'c' || ev.code === 'KeyC') && ev.target === ta) {
        ev.preventDefault(); clozeSelection(ev.altKey);
      }
    });

    async function save() {
      if (saveBtn.disabled) return;
      saveBtn.disabled = true;
      status.className = 'status';
      status.textContent = 'Saving…';
      const card = {
        text: ta.value.trim(),
        extra: $('.extra').value.trim(),
        tags: $('.tags').value.split(/[\s,]+/).filter(Boolean),
        source: {
          url: cap.url, link: cap.link, title: cap.title, favicon: cap.favicon,
          quote: cap.quote, context: cap.paragraph, domain,
        },
      };
      try {
        const res = await chrome.runtime.sendMessage({ type: 'save-card', card });
        if (res?.ok) { toast('Card saved to GitHub ✓'); close(); }
        else if (res?.id) { toast('Saved offline — will sync when connected', true); close(); }
        else throw new Error(res?.error || 'Unknown error');
      } catch (e) {
        status.className = 'status err';
        status.textContent = /context invalidated/i.test(e.message) ? 'Extension was updated — reload this page.' : e.message;
        saveBtn.disabled = false;
      }
    }
    saveBtn.addEventListener('click', save);

    setScope(cap.quote ? scope : 'selection');
    ta.focus();
  }

  function closeEditor() {
    editor?.remove();
    editor = null;
  }

  function toast(msg, warn = false) {
    ensureHost();
    const t = document.createElement('div');
    t.className = 'toast' + (warn ? ' warn' : '');
    t.textContent = msg;
    root.appendChild(t);
    setTimeout(() => t.classList.add('out'), 2200);
    setTimeout(() => t.remove(), 2600);
  }

  // ---------------------------------------------------------------- styles

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  :host {
    --bg: #fbfaf7; --surface: #ffffff; --line: #e4e0d8; --text: #1d1b18; --muted: #6b665d;
    --accent: #d4572a; --accent-ink: #fff; --mark: #fbe3d6; --mark-ink: #9a3412; --hover: #f2efe9;
    --shadow: 0 24px 64px rgba(20, 16, 10, .28), 0 2px 8px rgba(20, 16, 10, .12);
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--text);
  }
  @media (prefers-color-scheme: dark) {
    :host {
      --bg: #1b1a18; --surface: #232220; --line: #3a3733; --text: #f0ede6; --muted: #a39d92;
      --accent: #f07a4a; --accent-ink: #1b1a18; --mark: #4a2a1c; --mark-ink: #ffb894; --hover: #2c2a27;
      --shadow: 0 24px 64px rgba(0, 0, 0, .6);
    }
  }
  button { font: inherit; color: inherit; cursor: pointer; }
  kbd { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; padding: 1px 4px; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 4px; background: var(--bg); color: var(--muted); }
  .dim { color: var(--muted); font-weight: 400; }

  .pill {
    position: fixed; top: 0; left: 0; display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 12px; border: 0; border-radius: 999px; background: #1d1b18; color: #fff;
    font-weight: 600; font-size: 13px; box-shadow: 0 6px 20px rgba(0,0,0,.25); animation: pop .14s ease-out;
  }
  .pill:hover { background: var(--accent); }
  .pill[hidden] { display: none; }
  .pill .br { font-family: ui-monospace, Menlo, monospace; opacity: .8; }
  @keyframes pop { from { transform: scale(.9); opacity: 0; } }

  .backdrop {
    position: fixed; inset: 0; width: 100vw; height: 100vh; background: rgba(15, 12, 8, .38);
    display: grid; place-items: center; padding: 16px; animation: fade .15s ease-out;
  }
  @keyframes fade { from { opacity: 0; } }
  .modal {
    width: min(640px, 100%); max-height: calc(100vh - 32px); overflow: auto; background: var(--surface);
    border: 1px solid var(--line); border-radius: 16px; box-shadow: var(--shadow); padding: 18px 20px 16px;
    animation: rise .18s cubic-bezier(.2, .9, .3, 1.2);
  }
  @keyframes rise { from { transform: translateY(12px) scale(.98); opacity: 0; } }
  header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .brand { font-weight: 700; font-size: 15px; display: flex; align-items: center; gap: 8px; }
  .logo { font-family: ui-monospace, Menlo, monospace; color: var(--accent); }
  .icon { border: 0; background: none; width: 30px; height: 30px; border-radius: 8px; color: var(--muted); }
  .icon:hover { background: var(--hover); color: var(--text); }

  .seg { display: inline-flex; padding: 3px; gap: 2px; background: var(--bg); border: 1px solid var(--line); border-radius: 10px; margin-bottom: 12px; }
  .seg button { border: 0; background: none; padding: 5px 12px; border-radius: 7px; color: var(--muted); font-size: 13px; }
  .seg button[aria-selected="true"] { background: var(--surface); color: var(--text); box-shadow: 0 1px 3px rgba(0,0,0,.12); font-weight: 600; }
  .seg button:disabled { opacity: .4; cursor: default; }

  .lbl { display: block; font-size: 12px; font-weight: 600; margin: 10px 0 6px; }
  textarea, input {
    width: 100%; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; color: var(--text); background: var(--bg);
    border: 1px solid var(--line); border-radius: 10px; padding: 9px 11px; resize: vertical; outline: none;
  }
  textarea.text { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  textarea:focus, input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }

  .tools { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 8px 0; }
  .count { margin-left: auto; font-size: 12px; color: var(--muted); }
  .btn { border: 1px solid var(--line); background: var(--surface); border-radius: 9px; padding: 7px 14px; font-weight: 600; }
  .btn:hover { background: var(--hover); }
  .btn.sm { padding: 4px 10px; font-size: 12.5px; }
  .btn.ghost { border-color: transparent; color: var(--muted); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); display: inline-flex; gap: 6px; align-items: center; }
  .btn.primary kbd { background: transparent; color: inherit; border-color: color-mix(in srgb, var(--accent-ink) 40%, transparent); opacity: .85; }
  .btn.primary:disabled { opacity: .45; cursor: not-allowed; }

  .preview {
    font: 17px/1.65 Charter, "Iowan Old Style", Georgia, serif; padding: 14px 16px; border-radius: 12px;
    background: var(--bg); border: 1px dashed var(--line); max-height: 240px; overflow: auto; user-select: none;
  }
  .preview .w { cursor: pointer; border-radius: 4px; transition: background .1s; }
  .preview .w:hover { background: var(--mark); }
  .preview .cz { cursor: pointer; background: var(--mark); color: var(--mark-ink); padding: 1px 4px; border-radius: 5px; font-weight: 600; }
  .preview .cz sup { font: 600 10px ui-sans-serif, system-ui; margin-left: 2px; opacity: .75; }
  .preview .cz:hover { text-decoration: line-through; }

  details.more { margin-top: 10px; }
  details.more summary { cursor: pointer; font-size: 13px; color: var(--muted); }
  footer { display: flex; align-items: center; gap: 12px; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--line); }
  .src { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1; color: var(--muted); text-decoration: none; font-size: 12.5px; }
  .src span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .src img { width: 16px; height: 16px; border-radius: 3px; }
  .src:hover { color: var(--text); }
  .status { font-size: 12.5px; color: var(--muted); }
  .status.err { color: #c2410c; }

  .toast {
    position: fixed; right: 20px; bottom: 20px; padding: 10px 16px; border-radius: 10px; background: #1d1b18; color: #fff;
    font-weight: 600; box-shadow: var(--shadow); animation: rise .2s ease-out; transition: opacity .3s, transform .3s;
  }
  .toast.warn { background: #92400e; }
  .toast.out { opacity: 0; transform: translateY(8px); }
  `;
})();
