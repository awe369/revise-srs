// Ladder-based spaced repetition: 1 → 3 → 7 → 15 → 30 → 60 → 120 → 240 days, then ×2.
//
// Each cloze number on a card is an independent review item with this state:
//   { step, due, reps, lapses, last, log }
//   step  – index into the ladder of the current interval (-1 = new / relearning)
//   due   – epoch ms when the item becomes reviewable
//   log   – [[epochSeconds, grade, intervalDays], ...]
//
// Grades: 1 Again · 2 Hard · 3 Good · 4 Easy

export const DAY = 86_400_000;
export const GRADES = { AGAIN: 1, HARD: 2, GOOD: 3, EASY: 4 };

export const DEFAULT_SETTINGS = Object.freeze({
  ladder: [1, 3, 7, 15, 30, 60, 120, 240],
  growth: 2,             // multiplier applied after the last ladder rung
  maxInterval: 3650,     // days
  relearnMinutes: 10,    // "Again" brings the item back in the same session
  newPerDay: 20,
  overdueCredit: true,   // remembered after a long gap → skip ahead on the ladder
  fuzz: false,           // ±5% spread on intervals ≥ 7d to avoid review pile-ups
});

export const withDefaults = (s) => ({ ...DEFAULT_SETTINGS, ...(s || {}) });

export function newItem(now = Date.now()) {
  return { step: -1, due: now, reps: 0, lapses: 0, last: null, log: [] };
}

export const isNew = (item) => !item || item.reps === 0;

/** Interval in days for a ladder step (steps beyond the ladder keep growing). */
export function intervalForStep(step, settings) {
  const { ladder, growth, maxInterval } = withDefaults(settings);
  if (step < 0) return 0;
  if (step < ladder.length) return Math.min(ladder[step], maxInterval);
  const extra = step - ladder.length + 1;
  return Math.min(Math.round(ladder[ladder.length - 1] * growth ** extra), maxInterval);
}

/** Local midnight of the day `days` after `now`. Items become due at the start of their day. */
export function startOfDay(t, days = 0) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

// Deterministic per-item fuzz so the same review always previews the same interval.
function fuzzDays(days, seed) {
  if (days < 7) return days;
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const r = ((h >>> 0) % 1000) / 1000 - 0.5; // [-0.5, 0.5)
  return Math.max(1, Math.round(days * (1 + r * 0.1)));
}

/** Pure scheduling function: returns the next state for `item` after answering with `grade`. */
export function schedule(item, grade, now = Date.now(), settings, seed = '') {
  const cfg = withDefaults(settings);
  const prev = item || newItem(now);
  const next = { ...prev, log: [...(prev.log || [])] };
  const elapsedDays = prev.last ? (now - prev.last) / DAY : 0;
  const maxStep = stepForInterval(cfg.maxInterval, cfg);

  let step;
  switch (grade) {
    case GRADES.AGAIN:
      if (prev.reps > 0 && prev.step >= 0) next.lapses = (prev.lapses || 0) + 1;
      next.step = -1;
      next.due = now + cfg.relearnMinutes * 60_000;
      next.reps = (prev.reps || 0) + 1;
      next.last = now;
      next.log.push([Math.round(now / 1000), grade, 0]);
      return next;
    case GRADES.HARD:
      step = Math.max(prev.step, 0);
      break;
    case GRADES.EASY:
      step = prev.step + 2;
      break;
    case GRADES.GOOD:
    default:
      step = prev.step + 1;
  }

  // Overdue credit: if the item survived a gap longer than the target rung, start from there.
  if (cfg.overdueCredit && grade >= GRADES.GOOD && prev.step >= 0) {
    while (step < maxStep && intervalForStep(step, cfg) <= elapsedDays) step++;
  }
  step = Math.min(step, maxStep);

  let days = intervalForStep(step, cfg);
  if (cfg.fuzz) days = fuzzDays(days, `${seed}:${prev.reps}`);

  next.step = step;
  next.due = startOfDay(now, days);
  next.reps = (prev.reps || 0) + 1;
  next.last = now;
  next.log.push([Math.round(now / 1000), grade, days]);
  return next;
}

function stepForInterval(days, cfg) {
  let s = 0;
  while (intervalForStep(s, cfg) < days && s < 64) s++;
  return s;
}

/** Human label for an interval, e.g. "10m", "3d", "2mo", "1.5y". */
export function formatInterval(ms) {
  const min = ms / 60_000;
  if (min < 60) return `${Math.max(1, Math.round(min))}m`;
  if (min < 60 * 24) return `${Math.round(min / 60)}h`;
  return formatDays(Math.round(ms / DAY));
}

export function formatDays(d) {
  if (d < 30) return `${d}d`;
  if (d < 365) return `${+(d / 30).toFixed(d < 60 ? 1 : 0)}mo`;
  return `${+(d / 365).toFixed(1)}y`;
}

/** What each button would do — shown under the grade buttons. */
export function preview(item, now = Date.now(), settings, seed = '') {
  const out = {};
  for (const [name, g] of Object.entries(GRADES)) {
    const n = schedule(item, g, now, settings, seed);
    const days = n.log[n.log.length - 1][2];
    out[name.toLowerCase()] = { days, label: days ? formatDays(days) : formatInterval(n.due - now), step: n.step };
  }
  return out;
}

export const isDue = (item, now = Date.now()) => !!item && item.due <= now;
