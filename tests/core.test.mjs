// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCloze, clozeNumbers, wrapCloze, unwrapClozeAt, renderCloze, stripCloze } from '../extension/lib/cloze.js';
import { schedule, intervalForStep, preview, newItem, startOfDay, DAY, GRADES } from '../extension/lib/srs.js';
import { createCard, editCard, mergeDecks, emptyDeck, safeUrl } from '../extension/lib/deck.js';
import { GitHubStore } from '../extension/lib/github.js';

const T0 = new Date(2026, 0, 10, 15, 0).getTime();

test('cloze parsing and rendering', () => {
  const t = 'The {{c1::mitochondria}} is the powerhouse of the {{c2::cell::organism unit}}.';
  assert.deepEqual(clozeNumbers(t), [1, 2]);
  assert.equal(parseCloze(t).filter((s) => s.type === 'cloze').length, 2);
  assert.equal(stripCloze(t), 'The mitochondria is the powerhouse of the cell.');
  assert.match(renderCloze(t, 1), /\[&hellip;\].*cell/);
  assert.match(renderCloze(t, 2), /mitochondria.*\[organism unit\]/);
  assert.match(renderCloze(t, 1, true), /cz-answer">mitochondria/);
  assert.match(renderCloze('<b>{{c1::x}}</b>', 1), /^&lt;b&gt;/); // escaped
});

test('wrap / unwrap', () => {
  const r = wrapCloze('Paris is the capital of France', 0, 6, 1);
  assert.equal(r.text, '{{c1::Paris}} is the capital of France');
  const r2 = wrapCloze(r.text, r.text.indexOf('France'), r.text.length);
  assert.equal(r2.text, '{{c1::Paris}} is the capital of {{c2::France}}');
  assert.equal(unwrapClozeAt(r2.text, 3), 'Paris is the capital of {{c2::France}}');
});

test('ladder intervals: 1, 3, 7, 15, 30, 60, 120, 240, then x2', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((s) => intervalForStep(s)), [1, 3, 7, 15, 30, 60, 120, 240, 480, 960]);
  assert.equal(intervalForStep(40), 3650); // capped
});

test('Good walks up the ladder when reviewed on time', () => {
  let it = newItem(T0), now = T0;
  const seen = [];
  for (let i = 0; i < 6; i++) {
    it = schedule(it, GRADES.GOOD, now);
    const days = Math.round((it.due - startOfDay(now)) / DAY);
    seen.push(days);
    now = it.due + 10 * 3600_000; // review at 10:00 on the due day
  }
  assert.deepEqual(seen, [1, 3, 7, 15, 30, 60]);
});

test('Again relearns in 10 minutes and restarts the ladder', () => {
  let it = schedule(newItem(T0), GRADES.GOOD, T0);
  it = schedule(it, GRADES.GOOD, it.due + 1);   // now on 3d rung
  const lapse = schedule(it, GRADES.AGAIN, T0 + 5 * DAY);
  assert.equal(lapse.step, -1);
  assert.equal(lapse.lapses, 1);
  assert.equal(lapse.due, T0 + 5 * DAY + 10 * 60_000);
  const back = schedule(lapse, GRADES.GOOD, lapse.due);
  assert.equal(back.step, 0); // 1 day
});

test('Hard repeats, Easy skips a rung', () => {
  const it = schedule(newItem(T0), GRADES.GOOD, T0); // step 0 (1d)
  assert.equal(schedule(it, GRADES.HARD, it.due).step, 0);
  assert.equal(schedule(it, GRADES.EASY, it.due).step, 2); // 7d
  assert.equal(schedule(newItem(T0), GRADES.HARD, T0).step, 0);
});

test('overdue credit: remembering after a long gap skips proven rungs', () => {
  let it = schedule(newItem(T0), GRADES.GOOD, T0);
  it = schedule(it, GRADES.GOOD, it.due); // step 1 (3d)
  const late = schedule(it, GRADES.GOOD, it.last + 20 * DAY);
  assert.equal(intervalForStep(late.step), 30); // survived 20 days → next rung above 20 is 30
  const off = schedule(it, GRADES.GOOD, it.last + 20 * DAY, { overdueCredit: false });
  assert.equal(intervalForStep(off.step), 7);
});

test('preview labels', () => {
  const p = preview(newItem(T0), T0);
  assert.deepEqual([p.again.label, p.hard.label, p.good.label, p.easy.label], ['10m', '1d', '1d', '3d']);
});

test('merge keeps the newest edit and the newest review per cloze', () => {
  const c = createCard({ text: '{{c1::A}} and {{c2::B}}' }, T0);
  const a = { ...emptyDeck(), cards: { [c.id]: c } };
  const b = structuredClone(a);
  // device A reviews c1, device B reviews c2 and edits text
  a.cards[c.id].srs[1] = schedule(c.srs[1], GRADES.GOOD, T0 + 1000);
  b.cards[c.id] = editCard(b.cards[c.id], { extra: 'note' }, T0 + 2000);
  b.cards[c.id].srs[2] = schedule(c.srs[2], GRADES.EASY, T0 + 3000);
  const m = mergeDecks(a, b);
  assert.equal(m.cards[c.id].extra, 'note');
  assert.equal(m.cards[c.id].srs[1].reps, 1);
  assert.equal(m.cards[c.id].srs[2].step, 1);
  assert.deepEqual(mergeDecks(b, a).cards[c.id].srs, m.cards[c.id].srs); // order independent
});

test('safeUrl rejects javascript: links', () => {
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('https://en.wikipedia.org/wiki/Cell#:~:text=cell'), 'https://en.wikipedia.org/wiki/Cell#:~:text=cell');
});

test('GitHubStore.sync creates branch, writes, and retries on conflict', async () => {
  const files = { sha: null, content: null };
  let branch = false, puts = 0, conflictOnce = true;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url), method = opts.method || 'GET';
    calls.push(`${method} ${u.pathname}`);
    const json = (status, body) => new Response(JSON.stringify(body), { status });
    if (u.pathname.endsWith('/git/ref/heads/cloze-data')) return branch ? json(200, {}) : json(404, { message: 'Not Found' });
    if (u.pathname.endsWith('/git/ref/heads/main')) return json(200, { object: { sha: 'abc' } });
    if (u.pathname.endsWith('/git/refs')) { branch = true; return json(201, {}); }
    if (u.pathname === '/repos/me/notes') return json(200, { default_branch: 'main', permissions: { push: true } });
    if (u.pathname.endsWith('/contents/cards.json')) {
      if (method === 'GET') {
        if (!branch || !files.sha) return json(404, { message: 'Not Found' });
        return json(200, { sha: files.sha, encoding: 'base64', content: Buffer.from(files.content).toString('base64') });
      }
      const body = JSON.parse(opts.body);
      if (!branch) return json(404, { message: 'Branch cloze-data not found' });
      if (conflictOnce && files.sha) { conflictOnce = false; files.sha = 'other'; return json(409, { message: 'conflict' }); }
      if ((body.sha || null) !== files.sha) return json(409, { message: 'sha mismatch' });
      puts++;
      files.content = Buffer.from(body.content, 'base64').toString('utf8');
      files.sha = `sha${puts}`;
      return json(200, {});
    }
    return json(500, { message: `unexpected ${url}` });
  };
  const store = new GitHubStore({ owner: 'me', repo: 'notes', token: 't', branch: 'cloze-data', path: 'cards.json' });
  const c1 = createCard({ text: 'Ünïcode {{c1::ok}} ✓' });
  await store.sync({ ...emptyDeck(), cards: { [c1.id]: c1 } });
  assert.ok(branch, 'branch created');
  const c2 = createCard({ text: '{{c1::second}}' });
  const merged = await store.sync({ ...emptyDeck(), cards: { [c2.id]: c2 } });
  assert.equal(Object.keys(merged.cards).length, 2);
  const onDisk = JSON.parse(files.content);
  assert.equal(onDisk.cards[c1.id].text, 'Ünïcode {{c1::ok}} ✓');
  assert.ok(onDisk.cards[c2.id]);
});

test('DriveStore creates folder + file, merges, and re-reads when the file changed meanwhile', async () => {
  const { DriveStore } = await import('../extension/lib/drive.js');
  const files = {}; // id → { name, mimeType, parents, version, content }
  let nextId = 1, sneakyWrite = false, tokenCalls = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url), method = opts.method || 'GET';
    const json = (status, body) => new Response(JSON.stringify(body), { status });
    assert.equal(opts.headers.Authorization, 'Bearer tok');
    if (u.pathname === '/drive/v3/files' && method === 'GET') {
      const q = u.searchParams.get('q');
      const name = q.match(/name = '([^']+)'/)[1], folder = q.includes('folder');
      return json(200, { files: Object.entries(files).filter(([, f]) => f.name === name && (f.mimeType === 'application/vnd.google-apps.folder') === folder).map(([id, f]) => ({ id, version: String(f.version) })) });
    }
    if (u.pathname === '/drive/v3/files' && method === 'POST') { const id = 'f' + nextId++; files[id] = { ...JSON.parse(opts.body), version: 1 }; return json(200, { id }); }
    if (u.pathname === '/upload/drive/v3/files' && method === 'POST') {
      const parts = opts.body.split(/--cf\w+/);
      const meta = JSON.parse(parts[1].split('\r\n\r\n')[1]);
      const content = parts[2].split('\r\n\r\n')[1].replace(/\r\n$/, '');
      const id = 'f' + nextId++; files[id] = { ...meta, version: 1, content }; return json(200, { id });
    }
    const m = u.pathname.match(/\/files\/(\w+)$/);
    if (m && method === 'PATCH') { files[m[1]].content = opts.body; files[m[1]].version++; return json(200, { id: m[1] }); }
    if (m && u.searchParams.get('alt') === 'media') {
      const body = files[m[1]].content;
      if (sneakyWrite) { // another device writes right after we read
        sneakyWrite = false;
        const d = JSON.parse(body); const c = createCard({ text: '{{c1::other device}}' }); d.cards[c.id] = c;
        files[m[1]].content = JSON.stringify(d); files[m[1]].version++;
      }
      return new Response(body, { status: 200 });
    }
    if (m) return json(200, { id: m[1], version: String(files[m[1]].version) });
    if (u.pathname === '/drive/v3/about') return json(200, { user: { emailAddress: 'me@example.com' } });
    return json(500, { error: { message: `unexpected ${method} ${url}` } });
  };
  const store = new DriveStore({ getToken: async () => { tokenCalls++; return 'tok'; } });
  assert.equal((await store.test()).emailAddress, 'me@example.com');
  // empty deck → no file created
  await store.sync(emptyDeck());
  assert.equal(Object.keys(files).length, 0);
  const c1 = createCard({ text: 'हिंदी {{c1::ठीक}} ✓' });
  await store.sync({ ...emptyDeck(), cards: { [c1.id]: c1 } });
  const folder = Object.values(files).find((f) => f.mimeType === 'application/vnd.google-apps.folder');
  const file = Object.values(files).find((f) => f.name === 'cloze-cards.json');
  assert.equal(folder.name, 'ClozeForge');
  assert.deepEqual(file.parents, [Object.keys(files).find((id) => files[id] === folder)]);
  sneakyWrite = true;
  const c2 = createCard({ text: '{{c1::second}}' });
  const merged = await store.sync({ ...emptyDeck(), cards: { [c2.id]: c2 } });
  const onDisk = JSON.parse(file.content);
  assert.equal(Object.keys(onDisk.cards).length, 3, 'own two cards + the other device\'s card');
  assert.equal(Object.keys(merged.cards).length, 3);
  assert.equal(onDisk.cards[c1.id].text, 'हिंदी {{c1::ठीक}} ✓');
  assert.ok(tokenCalls > 0);
});
