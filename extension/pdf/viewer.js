// ClozeForge PDF viewer (PDF.js). Chrome's built-in PDF viewer doesn't let extensions run inside it,
// so PDFs open here instead: same rendering quality, plus a selectable text layer for making cards.
//
//   viewer.html?file=<encoded PDF URL, may end in #page=N>

import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';

globalThis.pdfjsLib = pdfjsLib; // pdf_viewer.mjs reads the library from here
const { EventBus, PDFLinkService, PDFViewer, PDFFindController } = await import('../vendor/pdfjs/pdf_viewer.mjs');

pdfjsLib.GlobalWorkerOptions.workerSrc = '../vendor/pdfjs/pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);
const container = $('viewerContainer');
const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus });
const findController = new PDFFindController({ eventBus, linkService });
const viewer = new PDFViewer({ container, viewer: $('viewer'), eventBus, linkService, findController, removePageBorders: true });
linkService.setViewer(viewer);

// ------------------------------------------------------------------ which PDF

const param = new URLSearchParams(location.search).get('file') || '';
const fileUrl = param.split('#')[0];
const startPage = Number((param.match(/[#&]page=(\d+)/) || [])[1]) || 1;

// Read by content.js (the card editor) so cards point at the PDF itself, not at this viewer page.
window.__clozeForgePdf = { url: fileUrl, title: '' };

function fail(html) {
  $('error').innerHTML = html;
  $('error').hidden = false;
  $('title').textContent = 'Could not open PDF';
}

const filename = (u) => { try { return decodeURIComponent(new URL(u).pathname.split('/').pop()) || u; } catch { return u; } };

async function open(source, name) {
  try {
    const doc = await pdfjsLib.getDocument({
      ...source,
      cMapUrl: '../vendor/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '../vendor/pdfjs/standard_fonts/',
      wasmUrl: '../vendor/pdfjs/wasm/',
      isEvalSupported: false,
      withCredentials: true, // PDFs behind a login (college portals etc.) use your cookies
    }).promise;
    viewer.setDocument(doc);
    linkService.setDocument(doc, null);
    const meta = await doc.getMetadata().catch(() => null);
    const title = (meta?.info?.Title || '').trim() || name;
    window.__clozeForgePdf.title = title;
    document.title = `${title} — ClozeForge`;
    $('title').textContent = title;
    $('title').title = fileUrl || name;
    $('pageCount').textContent = `/ ${doc.numPages}`;
    $('pageNum').max = doc.numPages;
  } catch (e) {
    console.error(e);
    fail(`<h2>Could not open this PDF</h2><p>${e?.message ? e.message.replace(/[<>&]/g, '') : 'Unknown error'}</p>
      ${fileUrl ? '<p><a href="#" id="tryNative">Open it in Chrome\'s viewer instead</a></p>' : ''}`);
    $('tryNative')?.addEventListener('click', (ev) => { ev.preventDefault(); openNative(); });
  }
}

async function start() {
  if (!fileUrl) {
    $('title').textContent = 'Open a PDF';
    return fail('<h2>No PDF selected</h2><p>Click <b>Open file</b> above to pick a PDF from this computer, or open any PDF link in Chrome — it opens here automatically.</p>');
  }
  if (fileUrl.startsWith('file:') && !(await chrome.extension.isAllowedFileSchemeAccess())) {
    $('title').textContent = filename(fileUrl);
    return fail(`<h2>Allow ClozeForge to open files on this computer</h2>
      <p>Chrome asks you to allow this once for PDFs saved on your laptop:</p>
      <ol><li>Open <code>chrome://extensions</code> (copy it into the address bar).</li>
      <li>Find <b>ClozeForge</b> → <b>Details</b>.</li>
      <li>Turn on <b>Allow access to file URLs</b>.</li>
      <li>Come back and reload this page.</li></ol>
      <p>Or click <b>Open file</b> above and choose the PDF.</p>`);
  }
  open({ url: fileUrl }, filename(fileUrl));
}

// ------------------------------------------------------------------ toolbar

eventBus.on('pagesinit', () => {
  viewer.currentScaleValue = 'page-width';
  if (startPage > 1) viewer.currentPageNumber = Math.min(startPage, viewer.pagesCount);
});
eventBus.on('pagechanging', ({ pageNumber }) => { $('pageNum').value = pageNumber; });
eventBus.on('scalechanging', ({ presetValue, scale }) => {
  const sel = $('zoom');
  const v = presetValue || String(+scale.toFixed(2));
  if ([...sel.options].some((o) => o.value === v && !o.hidden)) sel.value = v;
  else { sel.options[sel.options.length - 1].textContent = `${Math.round(scale * 100)}%`; sel.value = 'custom'; }
});

$('prev').onclick = () => { viewer.currentPageNumber = Math.max(1, viewer.currentPageNumber - 1); };
$('next').onclick = () => { viewer.currentPageNumber = Math.min(viewer.pagesCount, viewer.currentPageNumber + 1); };
$('pageNum').onchange = (e) => { const n = Math.round(+e.target.value); if (n >= 1 && n <= viewer.pagesCount) viewer.currentPageNumber = n; };
$('zoom').onchange = (e) => { if (e.target.value !== 'custom') viewer.currentScaleValue = e.target.value; };
const zoomBy = (f) => { viewer.currentScale = Math.min(5, Math.max(0.25, viewer.currentScale * f)); };
$('zoomIn').onclick = () => zoomBy(1.15);
$('zoomOut').onclick = () => zoomBy(1 / 1.15);
addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(1.15); }
  if (e.key === '-') { e.preventDefault(); zoomBy(1 / 1.15); }
});

$('pick').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  $('error').hidden = true;
  // A picked file has no address to reopen later; cards from it keep the title only.
  window.__clozeForgePdf = { url: '', title: f.name };
  open({ data: new Uint8Array(await f.arrayBuffer()) }, f.name);
};

async function openNative() {
  await chrome.runtime.sendMessage({ type: 'pdf-bypass', url: fileUrl });
  location.href = fileUrl;
}
$('native').onclick = () => fileUrl && openNative();
$('native').hidden = !fileUrl;

try { if (localStorage.getItem('cf.pdfHint')) $('hint').remove(); } catch {}
$('hintX')?.addEventListener('click', () => { $('hint').remove(); try { localStorage.setItem('cf.pdfHint', '1'); } catch {} });

// ------------------------------------------------------------------ text layer → card editor

// PDF.js ends each line with a <br>, so the text of one line runs into the next ("endof" + "line").
// A space before every <br> keeps words apart when the editor reads the page text.
eventBus.on('textlayerrendered', ({ source }) => {
  const layer = source?.div?.querySelector('.textLayer');
  if (!layer) return;
  for (const br of layer.querySelectorAll('br')) if (br.previousSibling?.nodeType !== 3) br.before(' ');
  document.dispatchEvent(new CustomEvent('clozeforge:textlayer'));
});

start();
