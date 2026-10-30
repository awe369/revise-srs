// Mirror ClozeForge cards into Anki through the AnkiConnect add-on (desktop Anki, http://127.0.0.1:8765).
//
// One-way: ClozeForge is the source of truth. A card made or edited here is added/updated in Anki,
// a deleted card is deleted there. Each Anki note remembers its ClozeForge id in the CFId field.
// Anki keeps its own review schedule (optionally the same ladder — see applyLadder).

import { escapeHtml } from './cloze.js';
import { withDefaults, intervalForStep } from './srs.js';

export const ANKI_URL = 'http://127.0.0.1:8765';
export const MODEL = 'ClozeForge';
export const MODEL_VERSION = 1; // bump when the templates/CSS below change, so existing note types get updated
export const FIELDS = ['Text', 'Extra', 'Context', 'SourceTitle', 'SourceLink', 'OpenUrl', 'CFId'];

export class AnkiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export async function anki(action, params = {}) {
  let res;
  try {
    res = await fetch(ANKI_URL, { method: 'POST', body: JSON.stringify({ action, version: 6, params }) });
  } catch {
    throw new AnkiError('offline', 'Anki is not open (or the AnkiConnect add-on is not installed).');
  }
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (body.error) throw new AnkiError('api', `Anki: ${body.error}`);
  return body.result;
}

// ------------------------------------------------------------------ note type
// Same look as the review site: serif card text, a blue "[…]" pill for the hidden part,
// the source chip, the "From the page" quote, and a dark mode that follows Anki's night mode.

const FRONT = `<div class="cf front">
{{#SourceTitle}}<div class="cf-top"><span class="src-chip"><span class="fav">↗</span>{{SourceTitle}}</span></div>{{/SourceTitle}}
<div class="card-text">{{cloze:Text}}</div>
</div>`;

const BACK = `<div class="cf back">
{{#SourceTitle}}<div class="cf-top"><a class="src-chip" href="{{SourceLink}}"><span class="fav">↗</span>{{SourceTitle}}</a></div>{{/SourceTitle}}
<div class="card-text">{{cloze:Text}}</div>
{{#Extra}}<div class="card-extra">{{Extra}}</div>{{/Extra}}
{{#Context}}<div class="context-label">From the page</div><div class="context">{{Context}}</div>{{/Context}}
{{#SourceLink}}<div class="card-actions">
  {{#OpenUrl}}<a class="btn" id="cf-quiz" href="{{OpenUrl}}">Quiz on the page ↗</a>{{/OpenUrl}}
  <a class="btn ghost" href="{{SourceLink}}">Open source</a>
</div>{{/SourceLink}}
</div>
<script>
/* Tell the quiz link which cloze this card tests (Anki marks it with data-ordinal). */
(function () {
  var a = document.getElementById('cf-quiz'), c = document.querySelector('.cf .cloze[data-ordinal]');
  if (a && c && !/[?&]n=\d/.test(a.href)) a.href = a.href + c.getAttribute('data-ordinal');
})();
</script>`;

const CSS = `@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap");
.card {
  --bg: #f6f4ef; --surface: #ffffff; --surface-2: #fbfaf7; --line: #e4e0d8; --line-2: #d6d0c4;
  --text: #1d1b18; --muted: #6b665d; --dim: #9a948a;
  --accent: #2f6fde; --accent-soft: #e2ebfb; --accent-soft-ink: #1d4ea8;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 15px; line-height: 1.55; text-align: left; color: var(--text); background: var(--bg);
  margin: 0; padding: 0;
}
.card.nightMode, .card.night_mode, .nightMode .card, .night_mode .card {
  --bg: #161513; --surface: #201f1d; --surface-2: #1b1a18; --line: #34312d; --line-2: #45413b;
  --text: #f0ede6; --muted: #a39d92; --dim: #7a746a;
  --accent: #6b9cff; --accent-soft: #1f2a44; --accent-soft-ink: #a9c4ff;
}
.cf {
  max-width: 760px; margin: 16px auto; padding: 26px 30px 24px; background: var(--surface);
  border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 1px 2px rgba(20,16,10,.05), 0 8px 28px rgba(20,16,10,.07);
}
.cf-top { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; flex-wrap: wrap; }
.src-chip {
  display: inline-flex; align-items: center; gap: 7px; max-width: 100%; padding: 4px 12px 4px 6px;
  border: 1px solid var(--line); border-radius: 99px; color: var(--muted); font-size: 12.5px;
  text-decoration: none; background: var(--surface-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
a.src-chip:hover { color: var(--text); border-color: var(--line-2); }
.fav { width: 16px; height: 16px; border-radius: 4px; display: inline-grid; place-items: center; background: var(--line); color: var(--muted); font-size: 10px; flex: none; }
.card-text { font: 23px/1.6 "Source Serif 4", Charter, "Iowan Old Style", Georgia, serif; letter-spacing: -.003em; overflow-wrap: anywhere; }
.front .cloze {
  display: inline-block; min-width: 3ch; padding: 0 .35em; border-radius: 6px; background: var(--accent-soft);
  color: var(--accent-soft-ink); font: 700 .82em Inter, ui-sans-serif, system-ui, sans-serif; letter-spacing: .02em; vertical-align: .08em;
}
.back .cloze { color: var(--accent); font-weight: 600; background: linear-gradient(transparent 62%, var(--accent-soft) 62%); }
.card-extra { margin-top: 20px; padding-top: 16px; border-top: 1px dashed var(--line-2); color: var(--muted); font-size: 15px; }
.context-label { font: 600 11px Inter, ui-sans-serif, system-ui, sans-serif; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); margin: 18px 0 6px; }
.context {
  font: 15.5px/1.6 "Source Serif 4", Charter, Georgia, serif; color: var(--muted); background: var(--surface-2);
  border-left: 3px solid var(--line-2); padding: 10px 14px; border-radius: 0 10px 10px 0; max-height: 220px; overflow: auto;
}
.context mark { background: var(--accent-soft); color: var(--accent-soft-ink); border-radius: 3px; padding: 0 2px; }
.card-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 22px; }
.btn {
  display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); background: var(--surface);
  color: var(--text); padding: 5px 11px; border-radius: 8px; font-weight: 600; font-size: 13px; text-decoration: none;
}
.btn.ghost { border-color: transparent; color: var(--muted); }
@media (max-width: 640px) {
  .cf { margin: 0; padding: 20px 18px; border-radius: 0; border: 0; box-shadow: none; }
  .card-text { font-size: 20px; }
}`;

export const MODEL_DEF = {
  modelName: MODEL,
  inOrderFields: FIELDS,
  css: CSS,
  isCloze: true,
  cardTemplates: [{ Name: 'Cloze', Front: FRONT, Back: BACK }],
};

// ------------------------------------------------------------------ card → note fields

const html = (s) => escapeHtml(s || '').replace(/\n/g, '<br>');

function contextHtml(src) {
  if (!src?.context) return '';
  const ctx = src.context, q = src.quote || '';
  const i = q ? ctx.indexOf(q) : -1;
  return i < 0 ? html(ctx) : `${html(ctx.slice(0, i))}<mark>${html(q)}</mark>${html(ctx.slice(i + q.length))}`;
}

const httpOnly = (u) => (/^https?:\/\//i.test(u || '') ? u : '');

/** siteUrl: the review site, for the "Quiz on the page" link (answer hidden on the source page). */
export function noteFields(card, siteUrl = '') {
  const src = card.source || {};
  const link = httpOnly(src.link) || httpOnly(src.url);
  const open = link && siteUrl ? `${siteUrl}#/open/${encodeURIComponent(card.id)}?u=${encodeURIComponent(link)}&n=` : '';
  return {
    Text: html(card.text), // cloze markup {{c1::…}} survives HTML escaping untouched
    Extra: html(card.extra),
    Context: contextHtml(src),
    SourceTitle: link ? html(src.title || src.domain || new URL(link).hostname) : '',
    SourceLink: escapeHtml(link),
    OpenUrl: escapeHtml(open),
    CFId: card.id,
  };
}

export const noteTags = (card) => [...new Set(['clozeforge', ...(card.tags || [])
  .map((t) => String(t).replace(/\s+/g, '_')).filter(Boolean)])];

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

// ------------------------------------------------------------------ sync

/** Ask Anki for access (AnkiConnect shows an "Allow?" dialog the first time). */
export async function connect() {
  const p = await anki('requestPermission');
  if (p?.permission !== 'granted') throw new AnkiError('denied', 'Anki refused the connection — click "Yes" in the AnkiConnect pop-up in Anki.');
  return p;
}

export async function ensureModel(state = {}) {
  const names = await anki('modelNames');
  if (!names.includes(MODEL)) {
    await anki('createModel', MODEL_DEF);
  } else if (state.modelVersion !== MODEL_VERSION) {
    // Add any field this version introduced, then refresh the look.
    const have = await anki('modelFieldNames', { modelName: MODEL });
    for (const [i, f] of FIELDS.entries()) if (!have.includes(f)) await anki('modelFieldAdd', { modelName: MODEL, fieldName: f, index: i });
    await anki('updateModelTemplates', { model: { name: MODEL, templates: { Cloze: { Front: FRONT, Back: BACK } } } });
    await anki('updateModelStyling', { model: { name: MODEL, css: CSS } });
  }
  return MODEL_VERSION;
}

/**
 * Bring Anki in line with `deck` (a ClozeForge deck). `state` is what the last run remembered:
 * { modelVersion, notes: { [cardId]: { id: noteId, h: hash } } }. Returns the new state and counts.
 */
export async function syncToAnki(deck, { deckName = 'ClozeForge', siteUrl = '', state = {} } = {}) {
  await connect();
  const next = { modelVersion: await ensureModel(state), notes: { ...(state.notes || {}) } };
  await anki('createDeck', { deck: deckName });
  const counts = { added: 0, updated: 0, deleted: 0 };

  for (const card of Object.values(deck.cards || {})) {
    const known = next.notes[card.id];
    if (card.deleted) {
      if (known) {
        await anki('deleteNotes', { notes: [known.id] }).catch(() => {});
        delete next.notes[card.id];
        counts.deleted++;
      }
      continue;
    }
    const fields = noteFields(card, siteUrl);
    const tags = noteTags(card);
    const h = hash(JSON.stringify([fields, tags]));
    if (known?.h === h) continue;

    // Find the note: remembered id, else search by CFId (state was lost, e.g. extension reinstalled).
    let noteId = known?.id;
    if (noteId && !(await anki('notesInfo', { notes: [noteId] }))?.[0]?.noteId) noteId = null;
    if (!noteId) [noteId] = await anki('findNotes', { query: `"note:${MODEL}" "CFId:${card.id}"` });

    if (noteId) {
      await anki('updateNote', { note: { id: noteId, fields, tags } });
      counts.updated++;
    } else {
      noteId = await anki('addNote', {
        note: { deckName, modelName: MODEL, fields, tags, options: { allowDuplicate: true } },
      });
      counts.added++;
    }
    next.notes[card.id] = { id: noteId, h };
  }
  return { state: next, counts };
}

/**
 * Optional: make Anki use the same ladder (1 → 3 → 7 → 15 → 30 … days) for this deck, as learning steps
 * in a separate options preset "ClozeForge ladder". Again → 10 minutes, like the site.
 */
export async function applyLadder(deckName, settings) {
  await connect();
  const cfg = withDefaults(settings);
  let conf = await anki('getDeckConfig', { deck: deckName });
  if (conf.name !== 'ClozeForge ladder') {
    const id = await anki('cloneDeckConfigId', { name: 'ClozeForge ladder', cloneFrom: conf.id });
    await anki('setDeckConfigId', { decks: [deckName], configId: id });
    conf = await anki('getDeckConfig', { deck: deckName });
  }
  const steps = cfg.ladder.map((d) => d * 1440); // minutes
  const graduate = intervalForStep(cfg.ladder.length, cfg);
  conf.new.delays = steps;
  conf.new.ints = [graduate, graduate, conf.new.ints?.[2] ?? 0];
  conf.new.perDay = cfg.newPerDay;
  conf.lapse.delays = [cfg.relearnMinutes];
  await anki('saveDeckConfig', { config: conf });
  return { steps: cfg.ladder, graduate };
}
