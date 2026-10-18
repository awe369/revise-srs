// Deck data model + conflict-free merge.
//
// The whole collection is one JSON file in your GitHub repo:
// {
//   version: 1,
//   settings: { ...srs settings, updatedAt },
//   cards: { [id]: Card }
// }
// Card = { id, text, extra, tags, source, createdAt, editedAt, deleted?, suspended?, srs: { [clozeNumber]: Item } }
//
// Two devices can edit/review offline and still sync: content merges by `editedAt`,
// each review item merges by its last review time, review logs are unioned.

import { clozeNumbers } from './cloze.js';
import { newItem } from './srs.js';

export const emptyDeck = () => ({ version: 1, settings: {}, cards: {} });

export function makeId(now = Date.now()) {
  const rnd = crypto.getRandomValues(new Uint32Array(2));
  return now.toString(36) + rnd[0].toString(36) + rnd[1].toString(36).slice(0, 4);
}

export function createCard({ text, extra = '', tags = [], source = null }, now = Date.now()) {
  const card = { id: makeId(now), text, extra, tags, source, createdAt: now, editedAt: now, srs: {} };
  return syncItems(card, now);
}

/** Make the review items match the cloze numbers in the text (new numbers start as new items). */
export function syncItems(card, now = Date.now()) {
  const nums = clozeNumbers(card.text);
  const srs = {};
  for (const n of nums) srs[n] = card.srs?.[n] ?? newItem(now);
  return { ...card, srs };
}

export function editCard(card, patch, now = Date.now()) {
  return syncItems({ ...card, ...patch, editedAt: now }, now);
}

/** Iterate live review items: [{ card, n, item }] */
export function* items(deck) {
  for (const card of Object.values(deck.cards || {})) {
    if (card.deleted || card.suspended) continue;
    for (const [n, item] of Object.entries(card.srs || {})) yield { card, n: Number(n), item };
  }
}

const lastOf = (item) => (item?.last ?? -1);

function mergeLogs(a = [], b = []) {
  const seen = new Map();
  for (const e of [...a, ...b]) seen.set(`${e[0]}:${e[1]}`, e);
  return [...seen.values()].sort((x, y) => x[0] - y[0]);
}

function mergeItem(a, b) {
  if (!a) return b;
  if (!b) return a;
  const win = lastOf(b) > lastOf(a) ? b : a;
  return { ...win, log: mergeLogs(a.log, b.log) };
}

export function mergeCard(a, b) {
  if (!a) return b;
  if (!b) return a;
  const base = (b.editedAt ?? 0) >= (a.editedAt ?? 0) ? b : a;
  const srs = {};
  for (const n of Object.keys(base.srs || {})) srs[n] = mergeItem(a.srs?.[n], b.srs?.[n]);
  return { ...base, srs };
}

export function mergeDecks(a, b) {
  a = a || emptyDeck();
  b = b || emptyDeck();
  const cards = {};
  for (const id of new Set([...Object.keys(a.cards || {}), ...Object.keys(b.cards || {})])) {
    cards[id] = mergeCard(a.cards?.[id], b.cards?.[id]);
  }
  const sa = a.settings || {}, sb = b.settings || {};
  const settings = (sb.updatedAt ?? 0) >= (sa.updatedAt ?? 0) ? sb : sa;
  return { version: 1, settings, cards };
}

/** Drop tombstones older than `days` so the file doesn't grow forever. */
export function compact(deck, now = Date.now(), days = 90) {
  const cards = {};
  for (const [id, c] of Object.entries(deck.cards)) {
    if (c.deleted && now - c.editedAt > days * 86_400_000) continue;
    cards[id] = c;
  }
  return { ...deck, cards };
}

/** Only http(s) links are ever rendered as clickable. */
export function safeUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch { return null; }
}
