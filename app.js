'use strict';

/* ---------- PDF.js setup ---------- */
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

/* ---------- IndexedDB layer ---------- */
const DB_NAME = 'ronbun-app';
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('folders')) {
        db.createObjectStore('folders', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('papers')) {
        db.createObjectStore('papers', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files', { keyPath: 'paperId' });
      }
      if (!db.objectStoreNames.contains('pageTexts')) {
        db.createObjectStore('pageTexts', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('translations')) {
        db.createObjectStore('translations', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeNames, mode) {
  return openDB().then((db) => db.transaction(storeNames, mode));
}

function idbPut(storeName, value) {
  return tx([storeName], 'readwrite').then((t) => new Promise((resolve, reject) => {
    const r = t.objectStore(storeName).put(value);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

function idbGet(storeName, key) {
  return tx([storeName], 'readonly').then((t) => new Promise((resolve, reject) => {
    const r = t.objectStore(storeName).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

function idbGetAll(storeName) {
  return tx([storeName], 'readonly').then((t) => new Promise((resolve, reject) => {
    const r = t.objectStore(storeName).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  }));
}

function idbDelete(storeName, key) {
  return tx([storeName], 'readwrite').then((t) => new Promise((resolve, reject) => {
    const r = t.objectStore(storeName).delete(key);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  }));
}

function idbClear(storeName) {
  return tx([storeName], 'readwrite').then((t) => new Promise((resolve, reject) => {
    const r = t.objectStore(storeName).clear();
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  }));
}

function uid() {
  return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

/* ---------- Toast ---------- */
let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

/* ---------- Generic confirm modal ---------- */
let confirmOkHandler = null;
function showConfirm(title, body, onOk) {
  const overlay = document.getElementById('modal-confirm');
  document.getElementById('modal-confirm-title').textContent = title;
  document.getElementById('modal-confirm-body').textContent = body;
  overlay.hidden = false;
  const okBtn = document.getElementById('modal-confirm-ok');
  if (confirmOkHandler) okBtn.removeEventListener('click', confirmOkHandler);
  confirmOkHandler = () => {
    overlay.hidden = true;
    okBtn.removeEventListener('click', confirmOkHandler);
    confirmOkHandler = null;
    onOk();
  };
  okBtn.addEventListener('click', confirmOkHandler);
}

document.querySelectorAll('[data-close]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = btn.getAttribute('data-close');
    document.getElementById(id).hidden = true;
    if (id === 'modal-confirm' && confirmOkHandler) {
      document.getElementById('modal-confirm-ok').removeEventListener('click', confirmOkHandler);
      confirmOkHandler = null;
    }
  });
});

/* ---------- View switching ---------- */
const views = ['shelf', 'reader', 'settings'];
let lastMainView = 'shelf';
function updateSettingsBtns(name) {
  document.querySelectorAll('.header-settings-btn').forEach((b) => {
    b.setAttribute('aria-pressed', name === 'settings' ? 'true' : 'false');
  });
}
function showView(name) {
  if (name !== 'settings') lastMainView = name;
  views.forEach((v) => {
    document.getElementById('view-' + v).hidden = (v !== name);
  });
  document.querySelectorAll('.navbtn').forEach((b) => {
    const t = b.getAttribute('data-view');
    b.classList.toggle('active', name === 'settings' ? t === lastMainView : t === name);
  });
  updateSettingsBtns(name);
  if (name === 'settings') refreshSettingsView();
}
document.querySelectorAll('.navbtn').forEach((b) => {
  b.addEventListener('click', () => showView(b.getAttribute('data-view')));
});
document.querySelectorAll('.header-settings-btn').forEach((b) => {
  b.addEventListener('click', () => {
    const settingsOpen = !document.getElementById('view-settings').hidden;
    if (settingsOpen) showView(lastMainView || 'shelf');
    else showView('settings');
  });
});
document.getElementById('btn-settings-back').addEventListener('click', () => {
  showView(lastMainView || 'shelf');
});

/* =========================================================
   本棚 (Shelf)
   ========================================================= */
let currentFolderFilter = 'all'; // 'all' | 'none' | folderId
let searchQuery = '';

function thumbPlaceholderSVG() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 6 C 10 4.5 6.5 4 4 4.6 L4 18 C 6.5 17.4 10 17.9 12 19.4 C 14 17.9 17.5 17.4 20 18 L20 4.6 C 17.5 4 14 4.5 12 6 Z"/><path d="M12 6 L12 19.4"/></svg>';
}

async function refreshFolderChips() {
  const folders = await idbGetAll('folders');
  folders.sort((a, b) => a.order - b.order);
  const row = document.getElementById('folder-chips');
  row.innerHTML = '';
  const defs = [{ id: 'all', name: 'すべて' }, { id: 'none', name: '未分類' }];
  defs.concat(folders).forEach((f) => {
    const chip = document.createElement('button');
    chip.className = 'chip' + (currentFolderFilter === f.id ? ' active' : '');
    chip.textContent = f.name;
    chip.addEventListener('click', () => {
      if (f.id !== 'all' && f.id !== 'none' && currentFolderFilter === f.id) {
        openFolderManage(f);
        return;
      }
      currentFolderFilter = f.id;
      refreshFolderChips();
      refreshShelfGrid();
    });
    row.appendChild(chip);
  });
}

function openFolderManage(folder) {
  const overlay = document.getElementById('modal-folder-manage');
  const input = document.getElementById('modal-folder-manage-input');
  input.value = folder.name;
  overlay.hidden = false;
  const saveBtn = document.getElementById('modal-folder-rename-save');
  const delBtn = document.getElementById('modal-folder-delete');
  const saveHandler = async () => {
    const name = input.value.trim();
    if (!name) { toast('フォルダ名を入力してください'); return; }
    folder.name = name;
    await idbPut('folders', folder);
    overlay.hidden = true;
    cleanup();
    refreshFolderChips();
    refreshShelfGrid();
    toast('フォルダ名を変更しました');
  };
  const delHandler = () => {
    overlay.hidden = true;
    cleanup();
    showConfirm('フォルダを削除', 'フォルダ「' + folder.name + '」を削除します。中の論文は未分類になります。', async () => {
      const papers = await idbGetAll('papers');
      for (const p of papers) {
        if (p.folderId === folder.id) {
          p.folderId = null;
          await idbPut('papers', p);
        }
      }
      await idbDelete('folders', folder.id);
      if (currentFolderFilter === folder.id) currentFolderFilter = 'all';
      refreshFolderChips();
      refreshShelfGrid();
      toast('フォルダを削除しました');
    });
  };
  function cleanup() {
    saveBtn.onclick = null;
    delBtn.onclick = null;
  }
  saveBtn.onclick = saveHandler;
  delBtn.onclick = delHandler;
}

async function refreshShelfGrid() {
  const grid = document.getElementById('shelf-grid');
  let papers = await idbGetAll('papers');
  papers.sort((a, b) => b.addedAt - a.addedAt);

  if (currentFolderFilter === 'none') {
    papers = papers.filter((p) => !p.folderId);
  } else if (currentFolderFilter !== 'all') {
    papers = papers.filter((p) => p.folderId === currentFolderFilter);
  }
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    papers = papers.filter((p) =>
      (p.title || '').toLowerCase().includes(q) || (p.fileName || '').toLowerCase().includes(q));
  }

  if (papers.length === 0) {
    grid.innerHTML = '<div class="empty">' + thumbPlaceholderSVG() + '<p>PDFを追加するとここに並びます</p></div>';
    return;
  }

  const folders = await idbGetAll('folders');
  const folderMap = {};
  folders.forEach((f) => { folderMap[f.id] = f.name; });

  grid.innerHTML = '';
  const gridEl = document.createElement('div');
  gridEl.className = 'grid';
  papers.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'card';
    const dateStr = new Date(p.addedAt).toLocaleDateString('ja-JP');
    const folderName = p.folderId ? (folderMap[p.folderId] || '未分類') : '未分類';
    card.innerHTML =
      '<button class="cardmenu" aria-label="メニュー">' +
        '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>' +
      '</button>' +
      '<div class="thumb">' + (p.cover ? '<img src="' + p.cover + '" alt="">' : thumbPlaceholderSVG()) + '</div>' +
      '<p class="title">' + escapeHtml(p.title) + '</p>' +
      '<p class="meta">' + p.pageCount + 'ページ・' + dateStr + '</p>' +
      '<p class="meta">' + escapeHtml(folderName) + '</p>';
    card.addEventListener('click', (e) => {
      if (e.target.closest('.cardmenu')) return;
      openPaperInReader(p.id);
    });
    card.querySelector('.cardmenu').addEventListener('click', (e) => {
      e.stopPropagation();
      openCardMenu(e.currentTarget, p);
    });
    gridEl.appendChild(card);
  });
  grid.appendChild(gridEl);
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

let activeMenuPaper = null;
function openCardMenu(anchor, paper) {
  activeMenuPaper = paper;
  const menu = document.getElementById('card-menu');
  const rect = anchor.getBoundingClientRect();
  menu.hidden = false;
  const menuWidth = 180;
  let left = rect.right - menuWidth;
  if (left < 8) left = 8;
  if (left + menuWidth > window.innerWidth - 8) left = window.innerWidth - menuWidth - 8;
  menu.style.left = left + 'px';
  menu.style.top = (rect.bottom + 4) + 'px';
}
document.addEventListener('click', (e) => {
  const menu = document.getElementById('card-menu');
  if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('.cardmenu')) {
    menu.hidden = true;
  }
});

document.getElementById('menu-rename').addEventListener('click', () => {
  document.getElementById('card-menu').hidden = true;
  if (!activeMenuPaper) return;
  const overlay = document.getElementById('modal-rename');
  const input = document.getElementById('modal-rename-input');
  input.value = activeMenuPaper.title;
  overlay.hidden = false;
  const saveBtn = document.getElementById('modal-rename-save');
  saveBtn.onclick = async () => {
    const v = input.value.trim();
    if (!v) { toast('タイトルを入力してください'); return; }
    activeMenuPaper.title = v;
    await idbPut('papers', activeMenuPaper);
    overlay.hidden = true;
    saveBtn.onclick = null;
    refreshShelfGrid();
    if (currentPaper && currentPaper.id === activeMenuPaper.id) {
      currentPaper.title = v;
      document.getElementById('reader-title').textContent = v;
    }
    toast('タイトルを変更しました');
  };
});

document.getElementById('menu-move').addEventListener('click', async () => {
  document.getElementById('card-menu').hidden = true;
  if (!activeMenuPaper) return;
  const overlay = document.getElementById('modal-move');
  const list = document.getElementById('modal-move-list');
  const folders = await idbGetAll('folders');
  folders.sort((a, b) => a.order - b.order);
  list.innerHTML = '';
  const options = [{ id: null, name: '未分類' }].concat(folders.map((f) => ({ id: f.id, name: f.name })));
  options.forEach((opt) => {
    const b = document.createElement('button');
    b.textContent = opt.name;
    if ((activeMenuPaper.folderId || null) === opt.id) b.classList.add('active');
    b.addEventListener('click', async () => {
      activeMenuPaper.folderId = opt.id;
      await idbPut('papers', activeMenuPaper);
      overlay.hidden = true;
      refreshShelfGrid();
      toast('フォルダを移動しました');
    });
    list.appendChild(b);
  });
  overlay.hidden = false;
});

document.getElementById('menu-delete').addEventListener('click', () => {
  document.getElementById('card-menu').hidden = true;
  if (!activeMenuPaper) return;
  const paper = activeMenuPaper;
  showConfirm('論文を削除', '「' + paper.title + '」を削除します。この操作は取り消せません。', async () => {
    await idbDelete('papers', paper.id);
    await idbDelete('files', paper.id);
    const pts = await idbGetAll('pageTexts');
    for (const pt of pts) if (pt.paperId === paper.id) await idbDelete('pageTexts', pt.id);
    const trs = await idbGetAll('translations');
    for (const tr of trs) if (tr.paperId === paper.id) await idbDelete('translations', tr.id);
    if (currentPaper && currentPaper.id === paper.id) {
      currentPaper = null;
      renderReaderEmptyState();
    }
    refreshShelfGrid();
    toast('削除しました');
  });
});

document.getElementById('shelf-search').addEventListener('input', (e) => {
  searchQuery = e.target.value;
  refreshShelfGrid();
});

/* フォルダ作成 */
document.getElementById('btn-new-folder').addEventListener('click', () => {
  document.getElementById('modal-folder-title').textContent = 'フォルダを作成';
  document.getElementById('modal-folder-input').value = '';
  document.getElementById('modal-folder').hidden = false;
});
document.getElementById('modal-folder-save').addEventListener('click', async () => {
  const input = document.getElementById('modal-folder-input');
  const name = input.value.trim();
  if (!name) { toast('フォルダ名を入力してください'); return; }
  const folders = await idbGetAll('folders');
  await idbPut('folders', { id: uid(), name, createdAt: Date.now(), order: folders.length });
  document.getElementById('modal-folder').hidden = true;
  refreshFolderChips();
  toast('フォルダを作成しました');
});

/* PDF追加・取り込み */
document.getElementById('file-input').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  if (files.length === 0) return;
  const progress = document.getElementById('import-progress');
  progress.hidden = false;
  let done = 0;
  for (const file of files) {
    progress.textContent = '取り込み中 ' + (done + 1) + ' / ' + files.length;
    try {
      await importPdfFile(file);
    } catch (err) {
      console.error('PDF import failed', err);
      toast('取り込みに失敗しました: ' + file.name);
    }
    done++;
  }
  progress.hidden = true;
  e.target.value = '';
  refreshShelfGrid();
  toast(files.length + '件のPDFを追加しました');
});

async function importPdfFile(file) {
  const buf = await file.arrayBuffer();
  const data = new Uint8Array(buf);
  const loadingTask = pdfjsLib.getDocument({ data: data.slice() });
  const pdf = await loadingTask.promise;
  const meta = await pdf.getMetadata().catch(() => null);
  const title = (meta && meta.info && meta.info.Title && meta.info.Title.trim()) || file.name.replace(/\.pdf$/i, '');
  const pageCount = pdf.numPages;

  let cover = null;
  try {
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const scale = 240 / viewport.width;
    const scaledViewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = scaledViewport.width;
    canvas.height = scaledViewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;
    cover = canvas.toDataURL('image/jpeg', 0.8);
  } catch (err) {
    console.warn('cover render failed', err);
  }

  const paperId = uid();
  const paper = {
    id: paperId,
    title,
    fileName: file.name,
    pageCount,
    folderId: (currentFolderFilter !== 'all' && currentFolderFilter !== 'none') ? currentFolderFilter : null,
    addedAt: Date.now(),
    cover,
  };
  await idbPut('papers', paper);
  await idbPut('files', { paperId, blob: new Blob([data], { type: 'application/pdf' }) });
}

/* =========================================================
   閲覧 (Reader)
   ========================================================= */
let currentPaper = null;
let currentPdfDoc = null;
let currentPage = 1;
let readerMode = 'both';

function renderReaderEmptyState() {
  document.getElementById('reader-empty-wrap').hidden = false;
  document.getElementById('reader-main-wrap').hidden = true;
}

async function openPaperInReader(paperId) {
  const paper = await idbGet('papers', paperId);
  if (!paper) { toast('論文が見つかりません'); return; }
  currentPaper = paper;
  currentPage = 1;
  document.getElementById('reader-empty-wrap').hidden = true;
  document.getElementById('reader-main-wrap').hidden = false;
  document.getElementById('reader-title').textContent = paper.title;
  showView('reader');

  const fileRow = await idbGet('files', paperId);
  if (!fileRow) { toast('PDFファイルが見つかりません'); return; }
  const buf = await fileRow.blob.arrayBuffer();
  try {
    currentPdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  } catch (err) {
    console.error(err);
    toast('PDFの読み込みに失敗しました');
    return;
  }
  await renderCurrentPage();
}

document.getElementById('btn-reader-back').addEventListener('click', () => showView('shelf'));

document.getElementById('btn-page-prev').addEventListener('click', () => {
  if (!currentPdfDoc) return;
  if (currentPage > 1) { currentPage--; renderCurrentPage(); }
});
document.getElementById('btn-page-next').addEventListener('click', () => {
  if (!currentPdfDoc) return;
  if (currentPage < currentPdfDoc.numPages) { currentPage++; renderCurrentPage(); }
});

document.querySelectorAll('.modebar button').forEach((btn) => {
  btn.addEventListener('click', () => {
    readerMode = btn.getAttribute('data-mode');
    document.querySelectorAll('.modebar button').forEach((b) => b.classList.toggle('active', b === btn));
    const body = document.getElementById('reader-body');
    body.className = 'reader-body mode-' + readerMode;
  });
});

async function renderCurrentPage() {
  if (!currentPdfDoc || !currentPaper) return;
  document.getElementById('page-indicator').textContent = currentPage + ' / ' + currentPdfDoc.numPages;

  const page = await currentPdfDoc.getPage(currentPage);
  const canvas = document.getElementById('pdf-canvas');
  const containerWidth = Math.min(canvas.parentElement.clientWidth || 300, 600);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.max(containerWidth / baseViewport.width, 0.1);
  const viewport = page.getViewport({ scale });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;

  await renderTransPane();
}

async function extractPageText(paper, pageNum) {
  const cacheId = paper.id + '_' + pageNum;
  const cached = await idbGet('pageTexts', cacheId);
  if (cached) return cached.text;

  const page = await currentPdfDoc.getPage(pageNum);
  const content = await page.getTextContent();
  const lines = [];
  let lastY = null;
  let lineBuf = [];
  content.items.forEach((item) => {
    const y = Math.round(item.transform[5]);
    const str = item.str || '';
    if (lastY === null || Math.abs(y - lastY) > 3) {
      if (lineBuf.length) lines.push(lineBuf.join('').replace(/[ \t]+/g, ' ').trimEnd());
      lineBuf = [str];
      lastY = y;
    } else if (str) {
      const prev = lineBuf[lineBuf.length - 1] || '';
      if (prev && !/\s$/.test(prev) && !/^\s/.test(str)) lineBuf.push(' ' + str);
      else lineBuf.push(str);
    }
  });
  if (lineBuf.length) lines.push(lineBuf.join('').replace(/[ \t]+/g, ' ').trimEnd());
  const text = lines.join('\n').trim();
  await idbPut('pageTexts', { id: cacheId, paperId: paper.id, page: pageNum, text });
  return text;
}

async function renderTransPane() {
  const pane = document.getElementById('pane-trans');
  const paper = currentPaper;
  const pageNum = currentPage;
  pane.innerHTML = '<p class="small">読み込み中...</p>';

  const sourceText = await extractPageText(paper, pageNum);
  const cacheId = paper.id + '_' + pageNum;
  const cachedTrans = await idbGet('translations', cacheId);
  const hasKey = !!getGeminiKey();

  let html = '';
  html += '<div class="btnrow">';
  html += '<button class="btn primary" id="btn-translate-page">このページを翻訳</button>';
  if (cachedTrans) html += '<button class="btn" id="btn-retranslate-page">再翻訳</button>';
  html += '</div>';

  if (cachedTrans) {
    html += '<div class="trans-text">' + escapeHtml(cachedTrans.text) + '</div>';
    html += '<p class="sourcetext-toggle" id="toggle-source-text">原文抽出テキストを表示</p>';
    html += '<div class="trans-text" id="source-text-block" hidden>' + escapeHtml(sourceText || '(抽出テキストなし)') + '</div>';
  } else {
    if (!hasKey) {
      html += '<p class="hint">翻訳するには、設定でGemini APIキーを保存してください。</p>';
    }
    html += '<div class="trans-text">' + escapeHtml(sourceText || '(このページから抽出できるテキストがありません)') + '</div>';
  }
  pane.innerHTML = html;

  const translateBtn = document.getElementById('btn-translate-page');
  if (translateBtn) translateBtn.addEventListener('click', () => doTranslate(paper, pageNum, sourceText, false));
  const retransBtn = document.getElementById('btn-retranslate-page');
  if (retransBtn) retransBtn.addEventListener('click', () => doTranslate(paper, pageNum, sourceText, true));
  const toggleBtn = document.getElementById('toggle-source-text');
  if (toggleBtn) toggleBtn.addEventListener('click', () => {
    const block = document.getElementById('source-text-block');
    block.hidden = !block.hidden;
    toggleBtn.textContent = block.hidden ? '原文抽出テキストを表示' : '原文抽出テキストを隠す';
  });
}

async function doTranslate(paper, pageNum, sourceText, force) {
  const key = getGeminiKey();
  if (!key) {
    toast('設定でGemini APIキーを保存してください');
    return;
  }
  if (!sourceText || !sourceText.trim()) {
    toast('このページには翻訳できるテキストがありません');
    return;
  }
  const pane = document.getElementById('pane-trans');
  pane.innerHTML = '<p class="small">翻訳中...</p>';
  try {
    const translated = await translateText(sourceText, key);
    const cacheId = paper.id + '_' + pageNum;
    await idbPut('translations', { id: cacheId, paperId: paper.id, page: pageNum, text: translated, updatedAt: Date.now() });
    toast('翻訳しました');
  } catch (err) {
    console.error(err);
    toast(err.message || '翻訳に失敗しました');
  }
  if (currentPaper && currentPaper.id === paper.id && currentPage === pageNum) {
    await renderTransPane();
  }
}

const GEMINI_MODELS = ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-flash-latest'];
const TRANSLATE_PROMPT_HEADER =
  '学術論文の英語を自然な日本語へ翻訳してください。専門用語は適切な日本語にし、初出は英語を併記してもよいです。' +
  '数式・引用・記号は壊さないでください。説明を足さず、本文の翻訳だけを返してください。\n\n';

function splitForTranslation(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const paragraphs = text.split('\n');
  const chunks = [];
  let buf = '';
  for (const p of paragraphs) {
    if ((buf + '\n' + p).length > maxLen && buf) {
      chunks.push(buf);
      buf = p;
    } else {
      buf = buf ? buf + '\n' + p : p;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

async function callGemini(prompt, key) {
  let lastError = null;
  for (const model of GEMINI_MODELS) {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(key);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      });
      if (!res.ok) {
        if (res.status === 400 || res.status === 403) {
          const body = await res.text().catch(() => '');
          if (/API key|API_KEY_INVALID|permission/i.test(body)) {
            throw new Error('APIキーが正しくないようです。設定を確認してください。');
          }
        }
        if (res.status === 404) { lastError = new Error('モデルが利用できませんでした'); continue; }
        if (res.status === 429) throw new Error('リクエストが多すぎます（レート制限）。しばらくしてから再度お試しください。');
        lastError = new Error('翻訳リクエストに失敗しました（' + res.status + '）');
        continue;
      }
      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
      if (!text) { lastError = new Error('翻訳結果が空でした'); continue; }
      return text.trim();
    } catch (err) {
      if (err instanceof TypeError) {
        lastError = new Error('ネットワークエラーが発生しました。接続を確認してください。');
        continue;
      }
      if (err && err.message && (err.message.indexOf('APIキー') !== -1 || err.message.indexOf('レート制限') !== -1)) {
        throw err;
      }
      lastError = err;
    }
  }
  throw lastError || new Error('翻訳に失敗しました');
}

async function translateText(text, key) {
  const chunks = splitForTranslation(text, 4000);
  const results = [];
  for (const chunk of chunks) {
    const result = await callGemini(TRANSLATE_PROMPT_HEADER + chunk, key);
    results.push(result);
  }
  return results.join('\n');
}

/* =========================================================
   設定 (Settings)
   ========================================================= */
const THEME_KEY = 'ronbun_theme';
const GEMINI_KEY_STORAGE = 'ronbun_gemini_key';

function getGeminiKey() {
  try { return localStorage.getItem(GEMINI_KEY_STORAGE) || ''; } catch (e) { return ''; }
}

function applyTheme(mode) {
  if (mode === 'light' || mode === 'dark') {
    document.documentElement.setAttribute('data-theme', mode);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  try { localStorage.setItem(THEME_KEY, mode); } catch (e) {}
  document.querySelectorAll('#theme-segrow button').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-theme') === mode);
  });
}

document.querySelectorAll('#theme-segrow button').forEach((b) => {
  b.addEventListener('click', () => applyTheme(b.getAttribute('data-theme')));
});

document.getElementById('btn-save-key').addEventListener('click', () => {
  const input = document.getElementById('gemini-key-input');
  const v = input.value.trim();
  if (!v) { toast('APIキーを入力してください'); return; }
  try { localStorage.setItem(GEMINI_KEY_STORAGE, v); } catch (e) {}
  input.value = '';
  input.placeholder = 'APIキーを入力';
  refreshSettingsView();
  toast('APIキーを保存しました');
});

document.getElementById('btn-delete-key').addEventListener('click', () => {
  try { localStorage.removeItem(GEMINI_KEY_STORAGE); } catch (e) {}
  document.getElementById('gemini-key-input').value = '';
  refreshSettingsView();
  toast('APIキーを削除しました');
});

async function refreshSettingsView() {
  const key = getGeminiKey();
  const statusTag = document.getElementById('key-status');
  if (key) {
    statusTag.textContent = '設定済み';
    statusTag.classList.remove('off');
  } else {
    statusTag.textContent = '未設定';
    statusTag.classList.add('off');
  }
  const papers = await idbGetAll('papers');
  const folders = await idbGetAll('folders');
  document.getElementById('data-counts').textContent = '論文 ' + papers.length + '件 / フォルダ ' + folders.length + '件';
}

document.getElementById('btn-clear-cache').addEventListener('click', () => {
  showConfirm('翻訳キャッシュ削除', '保存済みの翻訳結果をすべて削除します。', async () => {
    await idbClear('translations');
    toast('翻訳キャッシュを削除しました');
    if (currentPaper) renderTransPane();
  });
});

document.getElementById('btn-clear-all').addEventListener('click', () => {
  showConfirm('全データ消去（1/2）', '論文・フォルダ・翻訳キャッシュなど、すべてのデータを削除します。本当に続けますか？', () => {
    showConfirm('全データ消去（2/2）', 'この操作は取り消せません。本当にすべて削除しますか？', async () => {
      await idbClear('papers');
      await idbClear('folders');
      await idbClear('files');
      await idbClear('pageTexts');
      await idbClear('translations');
      currentPaper = null;
      currentFolderFilter = 'all';
      renderReaderEmptyState();
      refreshFolderChips();
      refreshShelfGrid();
      refreshSettingsView();
      toast('すべてのデータを消去しました');
    });
  });
});

/* ---------- 初期化 ---------- */
(function init() {
  let theme = 'auto';
  try { theme = localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) {}
  applyTheme(theme);
  refreshFolderChips();
  refreshShelfGrid();
  renderReaderEmptyState();
  refreshSettingsView();
  window.addEventListener('resize', () => {
    if (currentPdfDoc) renderCurrentPage();
  });
})();
