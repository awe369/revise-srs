// Cloze syntax (Anki compatible):  {{c1::answer}}  or  {{c1::answer::hint}}
// Shared by the extension (content script, popup) and the review website.

export const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Split text into plain / cloze segments, keeping source offsets. */
export function parseCloze(text) {
  const out = [];
  let last = 0;
  for (const m of String(text).matchAll(CLOZE_RE)) {
    if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index), start: last, end: m.index });
    out.push({
      type: 'cloze', n: Number(m[1]), answer: m[2], hint: m[3] ?? '',
      start: m.index, end: m.index + m[0].length,
    });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last), start: last, end: text.length });
  return out;
}

/** Sorted unique cloze numbers in a text. Each number is one review item. */
export function clozeNumbers(text) {
  const set = new Set();
  for (const m of String(text ?? '').matchAll(CLOZE_RE)) set.add(Number(m[1]));
  return [...set].sort((a, b) => a - b);
}

export const nextClozeNumber = (text) => Math.max(0, ...clozeNumbers(text)) + 1;

/** Plain text with all cloze markup removed. */
export const stripCloze = (text) => String(text ?? '').replace(CLOZE_RE, '$2');

/** Wrap text[start, end) in a cloze, preserving surrounding whitespace outside the braces. */
export function wrapCloze(text, start, end, n = nextClozeNumber(text)) {
  let s = start, e = end;
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  if (s === e) return { text, caret: end };
  const inner = stripCloze(text.slice(s, e));
  const wrapped = `{{c${n}::${inner}}}`;
  return { text: text.slice(0, s) + wrapped + text.slice(e), caret: s + wrapped.length };
}

/** Remove the cloze that spans offset `at` (an offset into the raw text). */
export function unwrapClozeAt(text, at) {
  for (const seg of parseCloze(text)) {
    if (seg.type === 'cloze' && at >= seg.start && at < seg.end) {
      return text.slice(0, seg.start) + seg.answer + text.slice(seg.end);
    }
  }
  return text;
}

/**
 * Render a cloze card to HTML.
 *  active  – the cloze number being tested (others are shown as plain text, like Anki)
 *  reveal  – show the answer
 */
export function renderCloze(text, active, reveal = false) {
  return parseCloze(text).map((seg) => {
    if (seg.type === 'text') return escapeHtml(seg.value).replace(/\n/g, '<br>');
    if (seg.n !== active) return `<span class="cz-other">${escapeHtml(seg.answer)}</span>`;
    if (reveal) return `<span class="cz-answer">${escapeHtml(seg.answer)}</span>`;
    return `<span class="cz-blank">[${seg.hint ? escapeHtml(seg.hint) : '&hellip;'}]</span>`;
  }).join('');
}

/** Render with every cloze highlighted (for lists / previews). */
export function renderAll(text) {
  return parseCloze(text).map((seg) => seg.type === 'text'
    ? escapeHtml(seg.value).replace(/\n/g, '<br>')
    : `<span class="cz-mark" data-n="${seg.n}">${escapeHtml(seg.answer)}</span>`).join('');
}
