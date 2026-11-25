'use strict';
/* 짱디터 - 렌더러 */

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let ws = null;                 // 워크스페이스
let cfg = { pinned: true, collapsed: false, theme: 'dark', hideDelay: 500, width: 440 };
let busy = false;              // 네이티브 다이얼로그 중
let saveTimer = null;
let hideTimer = null;

/* ================= 모델 ================= */
const ROW_TYPES = ['section', 'cmd', 'table', 'text'];

function normRow(r) {
  r = r || {};
  const t = ROW_TYPES.indexOf(r.type) >= 0 ? r.type : 'item';
  const out = {
    id: r.id || uid(),
    type: t,
    done: !!r.done,
    label: r.label || '',
    key: r.key || '',
    current: r.current || '',
    target: r.target || '',
    cmd: r.cmd || '',
    text: r.text || '',
    filePath: r.filePath || null,
    encoding: r.encoding || null,
    savedText: typeof r.savedText === 'string' ? r.savedText : null,
    fileStamp: typeof r.fileStamp === 'string' ? r.fileStamp : null,
    results: (r.results && Array.isArray(r.results.items)) ? r.results : null,
    height: (typeof r.height === 'number' && r.height > 40) ? Math.min(r.height, 6000) : null,
    fit: !!r.fit,                      // true = 패널 높이에 항상 맞춤
    note: r.note || '',
    showNote: !!r.showNote || !!(r.note && r.note.length),
    hideCurrent: !!r.hideCurrent,
    collapsed: !!r.collapsed
  };
  if (t === 'table') {
    out.cells = normCells(r.cells) || makeCells(3, 3);
    out.header = r.header !== false;
  }
  return out;
}

/* ---- 표 데이터 ---- */
const MAX_TBL_ROWS = 60;
const MAX_TBL_COLS = 20;

function makeCells(rows, cols) {
  rows = Math.max(1, Math.min(MAX_TBL_ROWS, rows | 0));
  cols = Math.max(1, Math.min(MAX_TBL_COLS, cols | 0));
  const out = [];
  for (let i = 0; i < rows; i++) out.push(new Array(cols).fill(''));
  return out;
}

function normCells(cells) {
  if (!Array.isArray(cells) || !cells.length) return null;
  let cols = 1;
  for (const r of cells) if (Array.isArray(r) && r.length > cols) cols = r.length;
  cols = Math.min(cols, MAX_TBL_COLS);
  return cells.slice(0, MAX_TBL_ROWS).map(function (r) {
    const a = Array.isArray(r) ? r.slice(0, cols) : [];
    while (a.length < cols) a.push('');
    return a.map(function (v) { return v == null ? '' : String(v); });
  });
}

function normTab(t) {
  t = t || {};
  let rows = (Array.isArray(t.rows) ? t.rows : []).map(normRow);

  // 예전에 쓰던 '글 전용 탭' 은 일반 탭 안의 글 블록 하나로 바꾼다
  if (t.kind === 'text' && typeof t.text === 'string' && t.text.length) {
    rows = [normRow({ type: 'text', label: t.name || '글', text: t.text, filePath: t.filePath || null })];
  }

  return {
    id: t.id || uid(),
    name: t.name || '새 탭',
    rows: rows,
    createdAt: t.createdAt || new Date().toISOString(),
    updatedAt: t.updatedAt || new Date().toISOString()
  };
}

function defaultUi() {
  // mode: 'work' = 작업 화면(값 채우고 복사), 'edit' = 설정 화면(틀을 고침)
  return { showCurrent: true, showKey: 'auto', filterUndone: false, mode: 'work',
           mono: 'gulim', monoSize: 13, monoLh: 1.45,
           iconbar: null,                    // null = 기본 차례
           // 글 끝에서 멈추지 않고 더 내려갈 수 있게 (울트라에디트와 같은 방식)
           pastEnd: true };
}

function tabFromTemplate(tplId) {
  const tpl = (window.JJ_TEMPLATES || []).find((x) => x.id === tplId) || (window.JJ_TEMPLATES || [])[0];
  return normTab({ name: tpl ? tpl.tabName : '새 탭', rows: tpl ? tpl.rows : [] });
}

function defaultWs() {
  const t = tabFromTemplate('linux-install');
  return { version: WS_VERSION, activeTabId: t.id, ui: defaultUi(), tabs: [t], recent: [] };
}

const WS_VERSION = 2;

function normWs(w) {
  if (!w || !Array.isArray(w.tabs) || !w.tabs.length) return defaultWs();
  const tabs = w.tabs.map(normTab);
  const ui = Object.assign(defaultUi(), w.ui || {});
  // 아이콘 줄 : 모르는 아이디는 걸러 낸다 (예전 설정이나 사라진 기능)
  if (Array.isArray(ui.iconbar)) {
    ui.iconbar = ui.iconbar.filter((id) => id === '|' || icById(id));
    if (!ui.iconbar.length) ui.iconbar = null;
  } else {
    ui.iconbar = null;
  }
  const activeTabId = tabs.some((t) => t.id === w.activeTabId) ? w.activeTabId : tabs[0].id;
  const recent = Array.isArray(w.recent) ? w.recent.slice(0, 12) : [];

  // 1 → 2 : 예전에는 파일을 열 때의 패널 높이를 px 로 굳혀 두었다.
  //         모니터마다 높이가 다르니 '패널 맞춤' 으로 한 번 옮긴다.
  if (w.version !== WS_VERSION) {
    for (const t of tabs) {
      for (const r of t.rows) {
        if (r.filePath && !r.fit && r.height >= 600) { r.fit = true; r.height = null; }
      }
    }
  }

  return { version: WS_VERSION, activeTabId: activeTabId, ui: ui, tabs: tabs, recent: recent };
}

const activeTab = () => ws.tabs.find((t) => t.id === ws.activeTabId) || ws.tabs[0];
const rowById = (id) => { const t = activeTab(); return t ? t.rows.find((r) => r.id === id) : null; };

function groupsOf(tab) {
  const out = [];
  let cur = { section: null, rows: [] };
  for (const r of tab.rows) {
    if (r.type === 'section') { out.push(cur); cur = { section: r, rows: [] }; }
    else cur.rows.push(r);
  }
  out.push(cur);
  return out.filter((g) => g.section || g.rows.length);
}

function countOf(rows) {
  let total = 0, done = 0;
  for (const r of rows) { if (r.type === 'section') continue; total++; if (r.done) done++; }
  return { total: total, done: done };
}

/* ================= 저장 ================= */
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const t = activeTab();
    if (t) t.updatedAt = new Date().toISOString();
    window.jj.save(ws);
  }, 350);
}
function saveNow() { clearTimeout(saveTimer); window.jj.save(ws); }

/* ================= 변수 치환 ================= */
function varsOf(tab) {
  const m = {};
  for (const r of tab.rows) {
    if (r.type === 'item' && r.key) m[r.key] = (r.target !== '' ? r.target : r.current);
  }
  return m;
}
const HAS_VAR = /\{\{\s*[\w.\-]+\s*\}\}/;
function resolve(text, vars) {
  return String(text == null ? '' : text).replace(/\{\{\s*([\w.\-]+)\s*\}\}/g,
    (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) && vars[k] !== '') ? vars[k] : m);
}

/* ================= 표 ================= */
const colName = (i) => (i < 26 ? String.fromCharCode(65 + i)
  : String.fromCharCode(64 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26)));

function buildTable(row, vars) {
  const el = document.createElement('div');
  el.className = 'row tbl' + (row.done ? ' done' : '');
  el.dataset.id = row.id;
  const cells = row.cells;
  const cols = cells[0].length;

  let h = '<div class="rowmain">' +
    '<span class="handle" draggable="true" title="드래그하여 순서 변경">⠿</span>' +
    '<input type="checkbox" class="chk"' + (row.done ? ' checked' : '') + '>' +
    '<input class="label" data-field="label" value="' + esc(row.label) + '" placeholder="표 제목" spellcheck="false">' +
    acts(false) +
    '</div>' +
    '<div class="tblwrap"><div class="grid" style="--cols:' + cols + '">' +
    '<div class="corner" data-act="tbl-copyall" title="표 전체 복사">⧉</div>';

  for (let c = 0; c < cols; c++) {
    h += '<div class="colh" data-act="tbl-copycol" data-c="' + c + '" title="' + colName(c) + '열 복사">' +
      colName(c) + '</div>';
  }
  for (let r = 0; r < cells.length; r++) {
    h += '<div class="rowh" data-act="tbl-copyrow" data-r="' + r + '" title="' + (r + 1) + '행 복사">' + (r + 1) + '</div>';
    for (let c = 0; c < cols; c++) {
      h += '<input class="cell' + (row.header && r === 0 ? ' hd' : '') + '"' +
        ' data-r="' + r + '" data-c="' + c + '" value="' + esc(cells[r][c]) + '" spellcheck="false">';
    }
  }

  h += '</div></div><div class="tblfoot">' +
    '<button data-act="tbl-rowplus" title="맨 아래에 행 추가">행＋</button>' +
    '<button data-act="tbl-rowminus" title="마지막 행 삭제">행－</button>' +
    '<button data-act="tbl-colplus" title="오른쪽에 열 추가">열＋</button>' +
    '<button data-act="tbl-colminus" title="마지막 열 삭제">열－</button>' +
    '<button data-act="tbl-header"' + (row.header ? ' class="on"' : '') + ' title="첫 행을 머리글로">머리글</button>' +
    '<span class="sp"></span>' +
    '<button data-act="tbl-paste" title="클립보드의 표를 통째로 붙여넣기 ' +
      '(탭 구분 · 마크다운 표 · CSV)">붙여넣기</button>' +
    '<button data-act="tbl-copymd" title="마크다운 표로 복사">MD</button>' +
    '<button data-act="tbl-copyall" class="prim" title="엑셀에 붙여넣을 수 있는 형식(탭 구분)">표 복사</button>' +
    '</div>';
  el.innerHTML = h;
  return el;
}

function cellsOut(row, vars) {
  return row.cells.map((r) => r.map((v) => resolve(v, vars)));
}
function tblTsv(row, vars) {
  return cellsOut(row, vars).map((r) => r.join('\t')).join('\n');
}
function tblMarkdown(row, vars) {
  const cells = cellsOut(row, vars).map((r) => r.map((v) => v.replace(/\|/g, '\\|')));
  const cols = cells[0].length;
  const sep = '|' + new Array(cols).fill(' --- ').join('|') + '|';
  const out = [];
  let body = cells;
  if (row.header) {
    out.push('| ' + cells[0].join(' | ') + ' |');
    body = cells.slice(1);
  } else {
    out.push('|' + new Array(cols).fill('   ').join('|') + '|');
  }
  out.push(sep);
  for (const r of body) out.push('| ' + r.join(' | ') + ' |');
  return out.join('\n');
}


/* ================= 표에 붙여넣기 =================
   다른 데서 복사한 표를 그대로 받아 준다.
     · 브라우저·엑셀에서 복사 → 탭으로 나뉜 글
     · 마크다운 표          → | 항목 | 값 |
     · CSV                 → 쉼표로 나뉜 글
   어느 쪽인지 알아서 가린다.                                        */

/** 따옴표를 아는 쉼표 쪼개기 */
function splitCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (q) {
      if (ch === '"') {
        if (line.charAt(i + 1) === '"') { cur += '"'; i++; } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

/** 마크다운 표의 ---|---|--- 줄인가 */
function isMdSepLine(l) {
  return /^[\s|:\-+]+$/.test(l) && (l.match(/-/g) || []).length >= 2 && l.indexOf('|') >= 0;
}

/**
 * 붙여넣은 글을 표(2차원 배열)로 바꾼다.
 * 돌려주는 값 : { grid, kind, md }  /  표로 볼 수 없으면 null
 */
function parseTableText(t) {
  if (t == null) return null;
  const raw = String(t).replace(/\r\n?/g, '\n').replace(/\s*$/, '');
  if (!raw) return null;
  const lines = raw.split('\n');
  const solid = lines.filter((l) => l.trim() !== '');
  if (!solid.length) return null;

  /* 1) 마크다운 표 */
  if (solid.length >= 2 && solid.every((l) => l.indexOf('|') >= 0) && solid.some(isMdSepLine)) {
    const grid = [];
    for (const l of solid) {
      if (isMdSepLine(l)) continue;
      let x = l.trim();
      if (x.charAt(0) === '|') x = x.slice(1);
      if (x.charAt(x.length - 1) === '|') x = x.slice(0, -1);
      grid.push(x.split('|').map((v) => v.replace(/\\\|/g, '|').trim()));
    }
    if (grid.length) return { grid: grid, kind: '마크다운 표', md: true };
  }

  /* 2) 탭으로 나뉜 글 (브라우저·엑셀에서 복사하면 이렇게 온다) */
  if (raw.indexOf('\t') >= 0) {
    return { grid: lines.map((l) => l.split('\t')), kind: '탭 구분', md: false };
  }

  /* 3) 쉼표로 나뉜 글 — 모든 줄의 칸 수가 같을 때만 (글 속 쉼표와 헷갈리지 않게) */
  if (solid.length >= 2 && solid.every((l) => l.indexOf(',') >= 0)) {
    const g = solid.map(splitCsvLine);
    const n = g[0].length;
    if (n >= 2 && g.every((r) => r.length === n)) return { grid: g, kind: 'CSV', md: false };
  }

  /* 4) 그 밖에는 한 줄을 한 칸으로 (세로로 쭉 넣는다) */
  if (lines.length >= 2) {
    return { grid: lines.map((l) => [l]), kind: '줄마다 한 칸', md: false };
  }
  return null;
}

/** 표의 (r0, c0) 자리부터 붙여넣는다. 모자라면 행·열을 늘린다. */
function tablePasteAt(row, r0, c0, grid) {
  let wantC = 0;
  for (const g of grid) if (c0 + g.length > wantC) wantC = c0 + g.length;
  const needC = Math.min(MAX_TBL_COLS, Math.max(row.cells[0].length, wantC));
  const needR = Math.min(MAX_TBL_ROWS, Math.max(row.cells.length, r0 + grid.length));

  row.cells.forEach((rr) => { while (rr.length < needC) rr.push(''); });
  while (row.cells.length < needR) row.cells.push(new Array(needC).fill(''));

  let wrote = 0, cut = false;
  for (let i = 0; i < grid.length; i++) {
    const r = r0 + i;
    if (r >= row.cells.length) { cut = true; break; }
    for (let j = 0; j < grid[i].length; j++) {
      const c = c0 + j;
      if (c >= row.cells[r].length) { cut = true; continue; }
      row.cells[r][c] = grid[i][j];
      wrote++;
    }
  }
  return { wrote: wrote, cut: cut };
}

/** 붙여넣고 나서 알려 주기 */
function tablePasteDone(res, parsed, grid) {
  rerender();
  scheduleSave();
  const cols = grid.reduce((m, g) => Math.max(m, g.length), 0);
  toast(grid.length + '행 × ' + cols + '열을 넣었습니다 (' + parsed.kind + ')' +
        (res.cut ? ' — 표 크기를 넘는 부분은 넣지 못했습니다' : ''));
}

/** 표 전체를 클립보드 내용으로 채운다 (맨 위 왼쪽부터) */
async function tablePasteAll(row) {
  const t = await window.jj.paste();
  const parsed = parseTableText(t);
  if (!parsed) { toast('클립보드에 표로 볼 만한 내용이 없습니다'); return; }
  const g = parsed.grid;
  const res = tablePasteAt(row, 0, 0, g);
  if (parsed.md && g.length > 1) row.header = true;   // 마크다운 표면 첫 줄은 머리글
  tablePasteDone(res, parsed, g);
}

function tableAct(act, row, btn) {
  const vars = varsOf(activeTab());
  const cols = row.cells[0].length;
  if (act === 'tbl-copyall') { copyText(tblTsv(row, vars)); return true; }
  if (act === 'tbl-paste') { tablePasteAll(row); return true; }
  if (act === 'tbl-copymd') { copyText(tblMarkdown(row, vars)); return true; }
  if (act === 'tbl-copyrow') {
    copyText(row.cells[+btn.dataset.r].map((v) => resolve(v, vars)).join('\t'));
    return true;
  }
  if (act === 'tbl-copycol') {
    const c = +btn.dataset.c;
    copyText(row.cells.map((rr) => resolve(rr[c], vars)).join('\n'));
    return true;
  }
  if (act === 'tbl-rowplus') {
    if (row.cells.length >= MAX_TBL_ROWS) { toast('행은 최대 ' + MAX_TBL_ROWS + '개까지'); return true; }
    row.cells.push(new Array(cols).fill(''));
  } else if (act === 'tbl-rowminus') {
    if (row.cells.length <= 1) { toast('행이 하나뿐입니다'); return true; }
    row.cells.pop();
  } else if (act === 'tbl-colplus') {
    if (cols >= MAX_TBL_COLS) { toast('열은 최대 ' + MAX_TBL_COLS + '개까지'); return true; }
    row.cells.forEach((rr) => rr.push(''));
  } else if (act === 'tbl-colminus') {
    if (cols <= 1) { toast('열이 하나뿐입니다'); return true; }
    row.cells.forEach((rr) => rr.pop());
  } else if (act === 'tbl-header') {
    row.header = !row.header;
  } else {
    return false;
  }
  rerender();
  scheduleSave();
  return true;
}

function tableCellMenu(row, r, c, x, y) {
  const vars = varsOf(activeTab());
  const blank = () => new Array(row.cells[0].length).fill('');
  const after = () => { rerender(); scheduleSave(); };
  openPopup([
    { hd: (r + 1) + '행 ' + colName(c) + '열' },
    { icon: '⧉', label: '이 셀 복사', onClick: () => copyText(resolve(row.cells[r][c], vars)) },
    { icon: '⧉', label: '이 행 복사', onClick: () => copyText(row.cells[r].map((v) => resolve(v, vars)).join('\t')) },
    { icon: '⧉', label: '이 열 복사', onClick: () => copyText(row.cells.map((rr) => resolve(rr[c], vars)).join('\n')) },
    { icon: '⧉', label: '표 전체 복사', tag: '탭 구분', onClick: () => copyText(tblTsv(row, vars)) },
    { sep: true },
    {
      icon: '⬇', label: '여기에 붙여넣기', tag: '이 칸부터',
      onClick: async () => {
        const t = await window.jj.paste();
        const parsed = parseTableText(t);
        if (!parsed) { toast('클립보드에 표로 볼 만한 내용이 없습니다'); return; }
        const res = tablePasteAt(row, r, c, parsed.grid);
        tablePasteDone(res, parsed, parsed.grid);
      }
    },
    {
      icon: '⬇', label: '표 전체를 붙여넣기', tag: '맨 위부터',
      onClick: () => tablePasteAll(row)
    },
    { icon: '⧉', label: '마크다운 표로 복사', onClick: () => copyText(tblMarkdown(row, vars)) },
    { sep: true },
    { icon: '↑', label: '위에 행 삽입', onClick: () => { row.cells.splice(r, 0, blank()); after(); } },
    { icon: '↓', label: '아래에 행 삽입', onClick: () => { row.cells.splice(r + 1, 0, blank()); after(); } },
    { icon: '←', label: '왼쪽에 열 삽입', onClick: () => { row.cells.forEach((rr) => rr.splice(c, 0, '')); after(); } },
    { icon: '→', label: '오른쪽에 열 삽입', onClick: () => { row.cells.forEach((rr) => rr.splice(c + 1, 0, '')); after(); } },
    { sep: true },
    {
      icon: '✕', label: (r + 1) + '행 삭제', danger: true,
      onClick: () => { if (row.cells.length > 1) { row.cells.splice(r, 1); after(); } else toast('행이 하나뿐입니다'); }
    },
    {
      icon: '✕', label: colName(c) + '열 삭제', danger: true,
      onClick: () => {
        if (row.cells[0].length > 1) { row.cells.forEach((rr) => rr.splice(c, 1)); after(); }
        else toast('열이 하나뿐입니다');
      }
    }
  ], x, y);
}

/** 표 크기 고르기 - 격자를 훑어서 고르거나 직접 숫자로 입력 */
function openTablePicker(x, y) {
  const MAXR = 8, MAXC = 8;
  const m = $('#menu');
  m.innerHTML = '';
  const hd = document.createElement('div');
  hd.className = 'hd';
  hd.textContent = '표 크기';
  m.appendChild(hd);

  const grid = document.createElement('div');
  grid.className = 'gridpick';
  for (let r = 1; r <= MAXR; r++) {
    for (let c = 1; c <= MAXC; c++) {
      const g = document.createElement('div');
      g.className = 'gp';
      g.dataset.r = r; g.dataset.c = c;
      grid.appendChild(g);
    }
  }
  const lab = document.createElement('div');
  lab.className = 'gplabel';
  lab.textContent = '행 × 열';
  grid.addEventListener('mouseover', (e) => {
    const g = e.target.closest('.gp');
    if (!g) return;
    const R = +g.dataset.r, C = +g.dataset.c;
    lab.textContent = R + '행 × ' + C + '열';
    for (const el of grid.children) el.classList.toggle('on', +el.dataset.r <= R && +el.dataset.c <= C);
  });
  grid.addEventListener('click', (e) => {
    const g = e.target.closest('.gp');
    if (!g) return;
    closePopup();
    addRow('table', null, { cells: makeCells(+g.dataset.r, +g.dataset.c) });
  });
  m.appendChild(grid);
  m.appendChild(lab);

  const man = document.createElement('div');
  man.className = 'gpman';
  man.innerHTML = '<input type="number" min="1" max="' + MAX_TBL_ROWS + '" value="4"> 행 × ' +
    '<input type="number" min="1" max="' + MAX_TBL_COLS + '" value="5"> 열<button>만들기</button>';
  const nums = man.querySelectorAll('input');
  man.querySelector('button').addEventListener('click', () => {
    closePopup();
    addRow('table', null, { cells: makeCells(+nums[0].value || 1, +nums[1].value || 1) });
  });
  m.appendChild(man);

  m.classList.remove('hidden');
  const rect = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 6)) + 'px';
  m.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 6)) + 'px';
  popupOpen = true;
}

/* ================= 글자체 ================= */
/* 열 편집은 '한글 한 글자 = 영문 두 글자' 를 전제로 한다.
   아래 배율이 정확히 2.0 인 글꼴에서만 한글 열이 맞는다. */
const MONO_FONTS = [
  { id: 'gulim',  label: '굴림체',     css: '"굴림체", GulimChe, monospace' },
  { id: 'dotum',  label: '돋움체',     css: '"돋움체", DotumChe, monospace' },
  { id: 'batang', label: '바탕체',     css: '"바탕체", BatangChe, monospace' },
  { id: 'd2',     label: 'D2Coding',  css: '"D2Coding", "나눔고딕코딩", NanumGothicCoding, monospace' },
  { id: 'consolas', label: 'Consolas', css: 'Consolas, monospace' }
];

function monoById(id) {
  return MONO_FONTS.find((f) => f.id === id) || MONO_FONTS[0];
}

/** 그 글꼴에서 한글이 영문의 몇 배 폭인지 (2.0 이어야 열 편집이 맞는다) */
function monoRatio(cssFont) {
  const w = (txt) => {
    const sp = document.createElement('span');
    sp.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:40px ' + cssFont;
    sp.textContent = txt.repeat(50);
    document.body.appendChild(sp);
    const r = sp.getBoundingClientRect().width / 50;
    sp.remove();
    return r;
  };
  const n = w('M');
  return n > 0 ? w('가') / n : 0;
}

function applyFont() {
  const f = monoById(ws.ui.mono);
  const sz = Math.max(10, Math.min(20, ws.ui.monoSize || 13));
  const lh = Math.max(1.0, Math.min(2.2, ws.ui.monoLh || 1.45));
  document.documentElement.style.setProperty('--mono', f.css);
  document.documentElement.style.setProperty('--monosz', sz + 'px');
  document.documentElement.style.setProperty('--monolh', String(lh));
  if (window.JJDoc && window.JJDoc.remeasure) window.JJDoc.remeasure();
}

function fontItems() {
  const items = MONO_FONTS.map((f) => {
    const r = monoRatio(f.css);
    const okCol = Math.abs(r - 2) < 0.01;
    return {
      icon: ws.ui.mono === f.id ? '●' : '○',
      label: f.label,
      tag: okCol ? '열 편집 ○' : '열 편집 ✕',
      onClick: () => {
        ws.ui.mono = f.id;
        applyFont();
  loadMyTemplates(); rerender(); saveNow();
        toast(f.label + (okCol ? '' : ' — 이 글꼴은 한글 열이 맞지 않습니다'));
      }
    };
  });
  items.push({ sep: true });
  items.push({ icon: '', label: '한글 열 편집은 "열 편집 ○" 글꼴에서만 맞습니다' });
  return items;
}

/* 우측 끝에서 패널을 여는 '띠' 가 화면 어디까지 걸쳐 있을지.
 * 위쪽까지 걸쳐 있으면 다른 창의 X 를 누르러 갈 때 패널이 튀어나온다. */
const ZONES = [
  { v: 2, label: '가운데만', tag: '화면 절반 (권장)' },
  { v: 1, label: '가운데 넓게', tag: '화면 70%' },
  { v: 3, label: '가운데 좁게', tag: '화면 30%' },
  { v: 0, label: '화면 전체', tag: 'X 버튼과 겹침' }
];

function zoneLabel(v) {
  const z = ZONES.find((x) => x.v === (v == null ? 2 : v));
  return z ? z.label : '가운데만';
}

function zoneItems() {
  const cur = cfg.triggerZone == null ? 2 : cfg.triggerZone;
  const list = ZONES.map((z) => ({
    icon: cur === z.v ? '●' : '○',
    label: z.label,
    tag: z.tag,
    onClick: () => {
      window.jj.setPrefs({ triggerZone: z.v });
      toast('패널 열리는 자리: ' + z.label);
    }
  }));
  list.push({ sep: true });
  list.push({ icon: '', label: '마우스를 오른쪽 끝 가운데로 가져가면 열립니다' });
  return list;
}

function fontSizeItems() {
  const cur = ws.ui.monoSize || 13;
  return [11, 12, 13, 14, 15, 16].map((n) => ({
    icon: cur === n ? '●' : '○',
    label: n + 'px',
    onClick: () => { ws.ui.monoSize = n; applyFont(); rerender(); saveNow(); }
  }));
}

/* 줄 간격 (글자 크기의 몇 배로 줄을 띄울지) */
const LINE_HEIGHTS = [
  { v: 1.15, label: '아주 좁게' },
  { v: 1.30, label: '좁게' },
  { v: 1.45, label: '보통', tag: '기본' },
  { v: 1.60, label: '넓게' },
  { v: 1.80, label: '아주 넓게' }
];

function lhLabel(v) {
  const z = LINE_HEIGHTS.find((x) => Math.abs(x.v - (v || 1.45)) < 0.01);
  return z ? z.label : String(v);
}

function lineHeightItems() {
  const cur = ws.ui.monoLh || 1.45;
  return LINE_HEIGHTS.map((z) => ({
    icon: Math.abs(cur - z.v) < 0.01 ? '●' : '○',
    label: z.label,
    tag: z.tag || z.v.toFixed(2) + '배',
    onClick: () => {
      ws.ui.monoLh = z.v;
      applyFont();
  loadMyTemplates(); rerender(); saveNow();
      toast('줄 간격: ' + z.label);
    }
  }));
}

/* ================= 렌더 ================= */
function applyMode() {
  const edit = ws.ui.mode === 'edit';
  const tab = activeTab();
  document.body.classList.toggle('empty-tab', !tab || !tab.rows.length);
  document.body.classList.toggle('mode-edit', edit);
  document.body.classList.toggle('pastend', ws.ui.pastEnd !== false);
  document.body.classList.toggle('mode-work', !edit);
  const b = $('#btnMode');
  if (b) {
    b.classList.toggle('on', edit);
    b.textContent = edit ? '✎ 설정 중' : '작업';
    b.title = edit
      ? '설정 화면 — 항목·키·순서를 고칩니다 (클릭하면 작업 화면으로)'
      : '작업 화면 — 값만 채우고 복사합니다 (클릭하면 설정 화면으로)';
  }
}

function render() {
  applyMode();
  renderIconbar();
  renderTabs();
  renderRows();
  renderProgress();
}

/**
 * 저장 아이콘 색 바꾸기.
 * 파일로 열어둔 글이 바뀌었으면 칼라, 아니면 흑백.
 */
function updateSaveIcon() {
  const b = document.querySelector('#iconbar button[data-ic="save"]');
  if (!b) return;
  const tab = activeTab();
  const dirty = tab ? unsavedFileRows(tab).length > 0 : false;
  b.classList.toggle('dirty', dirty);
  b.title = dirty
    ? '파일 저장 — 바뀐 내용이 있습니다 (Ctrl+S)'
    : '파일 저장 (Ctrl+S)';
}

function renderTabs() {
  const host = $('#tabs');
  host.innerHTML = '';
  for (const t of ws.tabs) {
    const c = countOf(t.rows);
    const el = document.createElement('div');
    const shared = tabSharesFile(t);
    el.className = 'tab' + (t.id === ws.activeTabId ? ' active' : '') +
      (c.total > 0 && c.done === c.total ? ' alldone' : '') +
      (unsavedFileRows(t).length ? ' dirty' : '') +
      (shared ? ' shared' : '');
    el.dataset.id = t.id;
    el.draggable = true;
    el.title = t.name + (unsavedFileRows(t).length ? '  (저장 안 된 내용 있음)' : '') +
      (shared ? '\n\u26a0 같은 파일이 다른 탭에도 열려 있습니다' : '');
    el.innerHTML = '<span class="tname">' + esc(t.name) + '</span>' +
      (shared ? '<span class="tshare" title="같은 파일이 다른 탭에도 열려 있습니다">\u26a0</span>' : '') +
      '<span class="tcount">' + c.done + '/' + c.total + '</span>' +
      '<button class="tclose" title="이 탭 닫기 (내용도 함께 지워집니다)">✕</button>';
    host.appendChild(el);
  }
}

function renderProgress() {
  const t = activeTab();
  const c = t ? countOf(t.rows) : { total: 0, done: 0 };
  const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
  $('#progressBar').style.width = pct + '%';
  $('#progressText').textContent = c.done + ' / ' + c.total + (c.total ? '  (' + pct + '%)' : '');
}

function fieldRow(cls, label, field, value, copy, ph) {
  return '<div class="f ' + cls + '">' +
    '<label>' + esc(label) + '</label>' +
    '<input data-field="' + field + '" value="' + esc(value) + '" placeholder="' + esc(ph || '') + '" spellcheck="false">' +
    (copy ? '<button class="cp" data-act="copy" data-src="' + field + '" title="복사">⧉</button>' : '') +
    '</div>';
}

function buildItem(row, vars) {
  const el = document.createElement('div');
  el.className = 'row item' + (row.done ? ' done' : '');
  el.dataset.id = row.id;
  const showKey = ws.ui.showKey === true || (ws.ui.showKey === 'auto' && row.key !== '');
  let h = '<div class="rowmain">' +
    '<span class="handle" draggable="true" title="드래그하여 순서 변경">⠿</span>' +
    '<input type="checkbox" class="chk"' + (row.done ? ' checked' : '') + '>' +
    '<input class="label" data-field="label" value="' + esc(row.label) + '" placeholder="항목명" spellcheck="false">' +
    acts(true) +
    '</div><div class="fields">';
  if (showKey) h += fieldRow('keyf', '키', 'key', row.key, false, '변수명 (예: ip)');
  if (ws.ui.showCurrent && !row.hideCurrent) h += fieldRow('cur', '현재', 'current', row.current, true, '현재 값');
  h += fieldRow('tgt', '설정', 'target', row.target, true, '설정할 값');
  if (row.showNote) {
    h += '<div class="f note"><label>메모</label>' +
      '<textarea data-field="note" rows="1" placeholder="메모" spellcheck="false">' + esc(row.note) + '</textarea></div>';
  }
  h += '</div>';
  el.innerHTML = h;
  return el;
}

function buildCmd(row, vars) {
  const el = document.createElement('div');
  el.className = 'row cmd' + (row.done ? ' done' : '');
  el.dataset.id = row.id;
  const res = HAS_VAR.test(row.cmd) ? resolve(row.cmd, vars) : '';
  el.innerHTML = '<div class="rowmain">' +
    '<span class="handle" draggable="true" title="드래그하여 순서 변경">⠿</span>' +
    '<input type="checkbox" class="chk"' + (row.done ? ' checked' : '') + '>' +
    '<input class="label" data-field="label" value="' + esc(row.label) + '" placeholder="명령 설명" spellcheck="false">' +
    acts(true) +
    '</div>' +
    '<div class="docwrap"><div class="hilite"></div><div class="colsel"></div>' +
    '<textarea class="code" data-field="cmd" rows="1" wrap="off"' + heightAttr(row) +
    ' placeholder="실행할 명령어 ( {{키}} 로 위 항목 값 참조 )" spellcheck="false">' + esc(row.cmd) + '</textarea>' +
    '</div>' +
    '<div class="cmdfoot"><div class="resolved">' + esc(res !== row.cmd ? res : '') + '</div>' +
    '<button class="zoombtn" data-act="find" data-f="cmd" title="이 명령에서 찾기 (Ctrl+F)">🔎 찾기</button>' +
    '<button class="zoombtn" data-act="col" data-f="cmd" title="세로로 블록을 잡아 한꺼번에 고칩니다 (Alt+C)">▥ 열 편집</button>' +
    '<button data-act="fit" class="zoombtn" title="' + (row.fit ? '원래 크기로 되돌리기' : '패널 높이에 맞춰 크게 보기') + '">' + (row.fit ? '\u2921 소형화' : '\u2922 전체화') + '</button>' +
    '<button class="copycmd" data-act="copycmd">복사</button></div>';
  return el;
}

/** 파일 내에서 찾기 결과 — 줄을 누르면 그 파일 그 줄이 열린다 */
function buildResult(row) {
  const R = row.results;
  const el = document.createElement('div');
  el.className = 'row txt res';
  el.dataset.id = row.id;

  let body =
    '<div class="reshead">' +
      '<b>\u201c' + esc(R.query) + '\u201d</b>' +
      '<span class="rcount">' + (R.hits ? ('파일 ' + R.files + '개 \u00b7 ' + R.hits + '곳') : '없음') +
        (R.truncated ? ' (너무 많아 일부만)' : '') + '</span>' +
      '<div class="ressub">' + esc(R.dir || '') + (R.sub ? '  (하위 폴더 포함)' : '') +
        '   \u00b7   ' + esc(R.pattern || '') + (R.cs ? '   대/소문자 구분' : '') + '</div>' +
    '</div>';

  if (!R.items.length) {
    body += '<div class="resnone">찾은 내용이 없습니다. (' + R.scanned + '개 파일을 살펴봤습니다)</div>';
  } else {
    let last = null;
    for (const it of R.items) {
      if (it.file !== last) {
        last = it.file;
        body += '<div class="resfile" data-f="' + esc(it.file) + '" title="이 파일을 엽니다">' +
          '<span class="fn">\ud83d\udcc4 ' + esc(it.file.split(/[\\/]/).pop()) + '</span>' +
          '<span class="fp">' + esc(it.file) + '</span></div>';
      }
      body += '<div class="reshit" data-f="' + esc(it.file) + '" data-l="' + it.line + '"' +
        ' title="클릭하면 이 줄로 이동합니다">' +
        '<span class="ln">' + it.line + '</span>' +
        '<span class="lt">' + esc(it.text) + '</span></div>';
    }
  }

  el.innerHTML = '<div class="rowmain">' +
    '<span class="handle" draggable="true" title="드래그하여 순서 변경">\u283f</span>' +
    '<input class="label" data-field="label" value="' + esc(row.label) + '" spellcheck="false">' +
    acts(false) +
    '</div>' +
    '<div class="resbox"' + heightAttr(row) + '>' + body + '</div>' +
    '<div class="txtfoot"><div class="resolved">줄을 클릭하면 그 파일이 열립니다</div>' +
    '<button data-act="refind" title="같은 조건으로 다시 찾기">\ud83d\udd01 다시 찾기</button>' +
    '<button data-act="fit" title="' + (row.fit ? '원래 크기로 되돌리기' : '패널 높이에 맞춰 크게 보기') + '">' +
      (row.fit ? '\u2921 소형화' : '\u2922 전체화') + '</button>' +
    '<button data-act="copytext" class="prim">복사</button></div>';
  return el;
}

function buildText(row, vars) {
  if (row.results) return buildResult(row);
  const el = document.createElement('div');
  el.className = 'row txt' + (row.done ? ' done' : '');
  el.dataset.id = row.id;
  const res = HAS_VAR.test(row.text) ? resolve(row.text, vars) : '';
  el.innerHTML = '<div class="rowmain">' +
    '<span class="handle" draggable="true" title="드래그하여 순서 변경">⠿</span>' +
    '<input type="checkbox" class="chk"' + (row.done ? ' checked' : '') + '>' +
    '<input class="label" data-field="label" value="' + esc(row.label) + '" placeholder="제목 (예: 시작 문자)" spellcheck="false">' +
    acts(false) +
    '</div>' +
    '<div class="docwrap"><div class="hilite"></div><div class="colsel"></div>' +
    '<textarea class="memo" data-field="text" rows="1" wrap="off"' + heightAttr(row) +
    ' placeholder="내용을 입력하세요" spellcheck="false">' + esc(row.text) + '</textarea>' +
    '</div>' +
    '<div class="txtfoot"><div class="resolved">' + esc(res !== row.text ? res : '') + '</div>' +
    '<button data-act="find" data-f="text" title="이 글에서 찾기 (Ctrl+F)">🔎 찾기</button>' +
    '<button data-act="col" data-f="text" title="세로로 블록을 잡아 한꺼번에 고칩니다 (Alt+C)">▥ 열 편집</button>' +
    '<button data-act="fit" class="" title="' + (row.fit ? '원래 크기로 되돌리기' : '패널 높이에 맞춰 크게 보기') + '">' + (row.fit ? '\u2921 소형화' : '\u2922 전체화') + '</button>' +
    '<button data-act="copytext" class="prim">복사</button></div>';
  return el;
}

function buildSection(row, cnt) {
  const el = document.createElement('div');
  el.className = 'section' + (cnt.total > 0 && cnt.done === cnt.total ? ' done-all' : '');
  el.dataset.id = row.id;
  el.innerHTML = '<button class="caret" data-act="caret">' + (row.collapsed ? '▸' : '▾') + '</button>' +
    '<input class="label" data-field="label" value="' + esc(row.label) + '" placeholder="섹션 이름" spellcheck="false">' +
    '<span class="count">' + cnt.done + '/' + cnt.total + '</span>' +
    acts(false);
  return el;
}

function acts(withNote) {
  return '<span class="acts">' +
    (withNote ? '<button data-act="note" title="메모 표시/숨김">📝</button>' : '') +
    '<button data-act="up" title="위로">▲</button>' +
    '<button data-act="down" title="아래로">▼</button>' +
    '<button data-act="more" title="이 줄 메뉴 (우클릭으로도 열립니다)">⋯</button>' +
    '<button data-act="del" class="del" title="이 줄 삭제">✕</button>' +
    '</span>';
}

function renderRows() {
  const host = $('#rows');
  const tab = activeTab();
  host.innerHTML = '';
  host.classList.toggle('only-undone', !!ws.ui.filterUndone);
  if (!tab) return;

  if (!tab.rows.length) {
    host.innerHTML = '<div class="empty">' +
      '<div class="etitle">아직 항목이 없습니다</div>' +
      '<div class="ebtns">' +
        '<button data-new="item">\u2610 항목</button>' +
        '<button data-new="cmd">\uff1e 명령어</button>' +
        '<button data-new="text">\u270e 글</button>' +
        '<button data-new="table">\u25a6 표</button>' +
        '<button data-new="section">\u00a7 섹션</button>' +
      '</div>' +
      '<div class="ehint">텍스트 파일을 열려면 <b>파일 \u2192 텍스트 파일 열기</b> (Ctrl+O)</div>' +
      '</div>';
    return;
  }

  // '미완료만' 이 켜져 있는데 전부 끝났으면 빈 화면이 된다 -> 알려 준다
  if (ws.ui.filterUndone) {
    const items = tab.rows.filter((r) => r.type !== 'section');
    if (items.length && items.every((r) => r.done)) {
      host.innerHTML = '<div class="empty">' +
        '<div class="etitle">이 탭은 모두 끝났습니다 \u2714</div>' +
        '<div class="ebtns"><button data-showall="1">\ud83d\udc41 전체 보기</button></div>' +
        '<div class="ehint">지금 <b>미완료만</b> 보기가 켜져 있어 완료된 항목이 숨겨졌습니다.</div>' +
        '</div>';
      return;
    }
  }

  const vars = varsOf(tab);
  const groups = groupsOf(tab);
  let nextMarked = false;

  for (const g of groups) {
    let box = host;
    if (g.section) {
      host.appendChild(buildSection(g.section, countOf(g.rows)));
      box = document.createElement('div');
      box.className = 'group' + (g.section.collapsed ? ' collapsed' : '');
      host.appendChild(box);
    } else {
      box = document.createElement('div');
      box.className = 'group';
      host.appendChild(box);
    }
    for (const r of g.rows) {
      const el = r.type === 'cmd' ? buildCmd(r, vars)
        : r.type === 'table' ? buildTable(r, vars)
          : r.type === 'text' ? buildText(r, vars)
            : buildItem(r, vars);
      if (!r.done && !nextMarked) { el.classList.add('next'); nextMarked = true; }
      box.appendChild(el);
    }
  }
  updateSaveIcon();
  applyFit();
  requestAnimationFrame(() => {
    $$('#rows textarea').forEach(autosize);
    applyFit();                        // 창이 늦게 떠도 다시 맞춘다
    watchResize();                     // 끌어서 높이를 바꾸면 알아채도록
    applyPastEnd();
  });
}

/** 사용자가 정한 높이가 있으면 그대로 쓴다 */
function heightAttr(row) {
  if (row.fit) return ' data-fixedh="1" data-fit="1"';
  return row.height ? (' data-fixedh="1" style="height:' + row.height + 'px"') : '';
}

/**
 * '패널에 맞춤' 인 블록들의 높이를 지금 패널 크기에 맞춰 다시 잡는다.
 * 그릴 때마다, 그리고 창 크기가 바뀔 때마다 부른다.
 */

/* ================= 끌어서 높이 조절 =================
   '패널 높이 맞춤' 인 글 칸은 그릴 때마다 높이를 다시 잡는다.
   그래서 사용자가 모서리를 끌어도 곧바로 되돌아가 버렸다.
   끌어서 바꾼 것을 알아채면 '맞춤' 을 풀고 그 높이를 기억한다.         */

let sizeWatcher = null;

/** 우리가 코드로 정해 준 높이를 적어 둔다 (사용자가 끈 것과 가리려고) */
function markAutoHeight(el) {
  el.dataset.autoh = String(Math.round(el.getBoundingClientRect().height));
}

/** 글 칸들의 높이 바뀜을 지켜본다 */
function watchResize() {
  if (typeof ResizeObserver === 'undefined') return;
  if (!sizeWatcher) {
    sizeWatcher = new ResizeObserver((entries) => {
      for (const e of entries) onResized(e.target);
    });
  }
  sizeWatcher.disconnect();
  const list = document.querySelectorAll('#rows textarea.memo, #rows textarea.code');
  for (const el of list) {
    markAutoHeight(el);
    sizeWatcher.observe(el);
  }
}

/** 사람이 끌어서 바꾼 것이면 그 높이를 블록에 적어 둔다 */
function onResized(el) {
  const now = Math.round(el.getBoundingClientRect().height);
  const was = +(el.dataset.autoh || 0);
  if (!now || Math.abs(now - was) < 3) return;      // 우리가 바꾼 것 — 그냥 둔다
  el.dataset.autoh = String(now);

  const holder = el.closest('#rows [data-id]');
  if (!holder) return;
  const row = rowById(holder.dataset.id);
  if (!row) return;

  // 내용에 맞춰 늘어나는 블록은 건드리지 않는다 (타자 칠 때마다 커지므로)
  if (el.dataset.fixedh !== '1') return;

  row.fit = false;                 // 더 이상 패널 높이를 따르지 않는다
  row.height = now;
  el.removeAttribute('data-fit');
  el.style.height = now + 'px';
  applyPastEnd();                  // 줄인 높이에 맞춰 끝 여백도 다시
  updateFitButtons(holder, row);
  scheduleSave();
}

/** 끌어서 바꾸면 [전체화 / 소형화] 단추 글씨도 맞춰 준다 */
function updateFitButtons(holder, row) {
  const txt = row.fit ? '\u2921 소형화' : '\u2922 전체화';
  const tip = row.fit ? '원래 크기로 되돌리기' : '패널 높이에 맞춰 크게 보기';
  holder.querySelectorAll('[data-act="fit"]').forEach((b) => {
    b.textContent = txt;
    b.title = tip;
  });
}


/**
 * '글 끝 뒤로도 스크롤' 여백을 넣는다.
 * 그 칸 높이의 60% 만큼만 준다 — 화면 높이로 주면 글 칸을 그보다
 * 작게 줄일 수 없게 되어(테두리+여백이 최소 높이가 된다) 크기 조절이 막힌다.
 */
let padHold = false;        // 모서리를 끄는 중 (여백을 잠깐 뺀다)

/** 모서리를 끄는 중에는 여백 때문에 더 줄일 수 없으므로 빼 둔다 */
function holdPastEnd(el) {
  padHold = true;
  el.style.paddingBottom = '';
}

/** 손을 떼면 다시 넣는다 */
function releasePastEnd() {
  if (!padHold) return;
  padHold = false;
  applyPastEnd();
}

function applyPastEnd() {
  if (padHold) return;                       // 끄는 중에는 건드리지 않는다
  const on = !!ws && ws.ui.pastEnd !== false;
  const put = (el) => {
    if (!el) return;
    const h = el.clientHeight;                 // 테두리 안쪽 높이 (여백을 넣어도 안 변한다)
    el.style.paddingBottom = on && h > 40 ? Math.round(h * 0.6) + 'px' : '';
  };
  document.querySelectorAll('#rows textarea[data-fixedh="1"]').forEach(put);
  put(document.querySelector('#zoom textarea.doctext'));
}

function applyFit() {
  const list = document.querySelectorAll('#rows [data-fit="1"]');
  for (const el of list) {
    el.style.height = fullHeightFor(el) + 'px';
    markAutoHeight(el);
  }
  applyPastEnd();
}

function autosize(ta) {
  if (ta.dataset.fixedh === '1') return;
  // 'auto' 로 두고 재면 flex 안에서 남는 높이를 돌려주는 경우가 있어 0 으로 줄인 뒤 잰다
  ta.style.height = '0px';
  ta.style.height = Math.min(Math.max(ta.scrollHeight, 24), 420) + 'px';
}

function rerender(keepScroll) {
  const host = $('#rows');
  const st = keepScroll === false ? 0 : host.scrollTop;
  render();
  host.scrollTop = st;
}

/* ================= 토스트 ================= */
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1400);
}

async function copyText(text, label) {
  if (text == null || text === '') { toast('복사할 내용이 없습니다'); return; }
  await window.jj.copy(text);
  const preview = String(text).split('\n')[0].slice(0, 36);
  toast('복사됨: ' + preview + (String(text).length > 36 ? '…' : ''));
}

/* ================= 행 조작 ================= */
function blockOf(rows, i) {
  if (rows[i].type !== 'section') return [i, i];
  let e = i;
  while (e + 1 < rows.length && rows[e + 1].type !== 'section') e++;
  return [i, e];
}

function addRow(type, afterId, extra) {
  const tab = activeTab();
  if (!tab) return;
  const r = normRow(Object.assign({ type: type, label: '' }, extra || {}));
  let at = tab.rows.length;
  if (afterId) {
    const i = tab.rows.findIndex((x) => x.id === afterId);
    if (i >= 0) {
      const b = blockOf(tab.rows, i);
      at = b[1] + 1;
    }
  }
  tab.rows.splice(at, 0, r);
  rerender();
  scheduleSave();
  const el = $('#rows .row[data-id="' + r.id + '"], #rows .section[data-id="' + r.id + '"]');
  if (el) {
    el.scrollIntoView({ block: 'nearest' });
    const inp = el.querySelector('input.label');
    if (inp) inp.focus();
  }
}

function moveUp(tab, id) {
  const rows = tab.rows;
  const i = rows.findIndex((r) => r.id === id);
  if (i <= 0) return;
  if (rows[i].type !== 'section') {
    const r = rows.splice(i, 1)[0];
    rows.splice(i - 1, 0, r);
    return;
  }
  const b = blockOf(rows, i);
  if (b[0] === 0) return;
  let ps = b[0] - 1;
  while (ps > 0 && rows[ps].type !== 'section') ps--;
  const block = rows.splice(b[0], b[1] - b[0] + 1);
  rows.splice(ps, 0, ...block);
}

function moveDown(tab, id) {
  const rows = tab.rows;
  const i = rows.findIndex((r) => r.id === id);
  if (i < 0) return;
  if (rows[i].type !== 'section') {
    if (i >= rows.length - 1) return;
    const r = rows.splice(i, 1)[0];
    rows.splice(i + 1, 0, r);
    return;
  }
  const b = blockOf(rows, i);
  if (b[1] >= rows.length - 1) return;
  const nb = blockOf(rows, b[1] + 1);
  const len = b[1] - b[0] + 1;
  const block = rows.splice(b[0], len);
  rows.splice(nb[1] - len + 1, 0, ...block);
}

function dupRow(tab, id) {
  const i = tab.rows.findIndex((r) => r.id === id);
  if (i < 0) return;
  const b = blockOf(tab.rows, i);
  const copy = tab.rows.slice(b[0], b[1] + 1).map((r) => normRow(Object.assign({}, r, { id: null })));
  tab.rows.splice(b[1] + 1, 0, ...copy);
}

function moveByDrag(tab, srcId, dstId, after) {
  const rows = tab.rows;
  const si = rows.findIndex((r) => r.id === srcId);
  const di = rows.findIndex((r) => r.id === dstId);
  if (si < 0 || di < 0) return;
  const b = blockOf(rows, si);
  if (di >= b[0] && di <= b[1]) return;
  const block = rows.slice(b[0], b[1] + 1);
  const rest = rows.slice(0, b[0]).concat(rows.slice(b[1] + 1));
  const ri = rest.findIndex((r) => r.id === dstId);
  if (ri < 0) return;
  let ins = after ? ri + 1 : ri;
  if (after && rest[ri].type === 'section') ins = blockOf(rest, ri)[1] + 1;
  rest.splice(ins, 0, ...block);
  tab.rows = rest;
}

/* ================= 탭 조작 ================= */

/* ================= 탭을 오간 기록 ================= */
/* 탭을 닫았을 때 엉뚱하게 첫 탭으로 튀지 않고, 보던 자리로 돌아가기 위한 것 */
let tabHist = [];

/** 탭을 옮긴다. 떠나는 탭을 기록에 남긴다 */
function goTab(id) {
  if (!id || id === ws.activeTabId) return;
  if (ws.activeTabId) {
    tabHist = tabHist.filter((x) => x !== ws.activeTabId);
    tabHist.push(ws.activeTabId);
    if (tabHist.length > 20) tabHist.shift();
  }
  tabHist = tabHist.filter((x) => x !== id);
  ws.activeTabId = id;
}

/**
 * 탭 하나를 닫을 때 어디로 갈지 고른다.
 *  1) 바로 전에 보던 탭  (찾기 결과를 닫으면 고치던 글로 돌아온다)
 *  2) 기록이 없으면 닫은 자리의 왼쪽 탭
 */
function tabAfterClose(closingId) {
  for (let i = tabHist.length - 1; i >= 0; i--) {
    const h = tabHist[i];
    if (h !== closingId && ws.tabs.some((t) => t.id === h)) return h;
  }
  const i = ws.tabs.findIndex((t) => t.id === closingId);
  const rest = ws.tabs.filter((t) => t.id !== closingId);
  if (!rest.length) return null;
  return rest[Math.max(0, Math.min(i - 1, rest.length - 1))].id;
}

function addTab(tab, activate) {
  ws.tabs.push(tab);
  if (activate !== false) goTab(tab.id);
  render();
  saveNow();
}

function uniqueName(base, exceptId) {
  let n = base, i = 2;
  const names = ws.tabs.filter((t) => t.id !== exceptId).map((t) => t.name);
  while (names.indexOf(n) >= 0) { n = base + ' (' + i + ')'; i++; }
  return n;
}

function renameTabInline(id) {
  const el = $('#tabs .tab[data-id="' + id + '"]');
  const tab = ws.tabs.find((t) => t.id === id);
  if (!el || !tab) return;
  el.innerHTML = '';
  const inp = document.createElement('input');
  inp.className = 'rename';
  inp.value = tab.name;
  el.appendChild(inp);
  inp.focus();
  inp.select();
  const commit = () => {
    const v = inp.value.trim();
    if (v) tab.name = v;
    render();
    saveNow();
  };
  inp.addEventListener('blur', commit);
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); render(); }
  });
}

/** 파일과 연결돼 있는데 아직 저장하지 않은 글 블록들 */
function unsavedFileRows(tab) {
  return tab.rows.filter((r) => r.filePath && r.savedText !== null && r.text !== r.savedText);
}

/** 파일로 저장되지 않는, 탭에만 있는 내용이 있는지 */
function hasLocalContent(tab) {
  return tab.rows.some((r) => {
    if (r.type === 'section') return !!r.label;
    if (r.type === 'text') return !r.filePath && !!r.text;
    if (r.type === 'table') return r.cells.some((rr) => rr.some((v) => v !== ''));
    return !!(r.label || r.current || r.target || r.cmd || r.note);
  });
}


/* ================= 같은 파일을 두 곳에서 고칠 때 ================= */

/** 같은 파일을 열어둔 다른 블록을 찾는다 (윈도우라 대소문자는 안 가린다) */
function findOpenRow(path, exceptRowId) {
  if (!path) return null;
  const key = path.toLowerCase();
  for (const t of ws.tabs) {
    for (const r of t.rows) {
      if (r.filePath && r.filePath.toLowerCase() === key && r.id !== exceptRowId) {
        return { tab: t, row: r };
      }
    }
  }
  return null;
}

/** 이 탭이 다른 탭과 같은 파일을 쓰고 있나 */
function tabSharesFile(tab) {
  return tab.rows.some((r) => r.filePath && findOpenRow(r.filePath, r.id));
}

/**
 * 파일에 쓴다.
 * 읽어온 뒤로 파일이 바뀌었으면 (다른 탭에서 저장했거나, 밖에서 고쳤거나)
 * 그냥 덮지 않고 먼저 물어본다.
 * 돌려주는 값 : { ok, path, stamp } / 그만두면 null
 */
async function putFile(row, text, asNew, nameHint) {
  const enc = row.encoding || 'UTF-8';
  if (asNew || !row.filePath) return await window.jj.saveTextAs(nameHint, text, enc);

  let r = await window.jj.saveTextTo(row.filePath, text, enc, row.fileStamp || null);
  if (r && r.conflict) {
    const other = findOpenRow(row.filePath, row.id);
    const why = other
      ? '같은 파일이 탭 "' + other.tab.name + '" 에도 열려 있습니다.\n' +
        '그 탭에서 저장한 내용을 지금 덮어쓰게 됩니다.'
      : '짱디터 밖에서 이 파일이 바뀌었습니다.';
    const ans = await window.jj.confirm3(
      '이 파일은 열어본 뒤로 내용이 바뀌었습니다. 그대로 덮어쓸까요?',
      row.filePath + '\n' +
      (r.when ? '지금 파일 : ' + r.when + '\n' : '') + '\n' + why + '\n\n' +
      '[예] 덮어쓰기    [아니오] 다른 이름으로 저장    [취소] 저장 안 함');
    if (ans === 'cancel') return null;
    if (ans === 'no') return await window.jj.saveTextAs(nameHint, text, enc);
    r = await window.jj.saveTextTo(row.filePath, text, enc, null);   // 뜻을 밝혔으니 그냥 쓴다
  }
  return r;
}

/** 저장이 끝난 블록에 새 지문을 적어 둔다 */
function markSaved(row, r, text) {
  row.filePath = (r && r.path) || row.filePath;
  row.encoding = row.encoding || 'UTF-8';
  row.savedText = text;
  row.fileStamp = (r && r.stamp) || null;
}

async function saveRowToFile(row) {
  const r = await putFile(row, row.text, false, row.label || '글');
  if (r && r.ok) { markSaved(row, r, row.text); return true; }
  return false;
}

async function deleteTab(id) {
  const tab = ws.tabs.find((t) => t.id === id);
  if (!tab) return;
  if (ws.tabs.length === 1) { toast('마지막 탭은 닫을 수 없습니다'); return; }

  const dirty = unsavedFileRows(tab);
  busy = true;
  try {
    if (dirty.length) {
      // 파일로 열어둔 글이 바뀌었으면 저장 여부를 묻는다
      const names = dirty.map((r) => r.filePath).join('\n');
      const ans = await window.jj.confirm3(
        '"' + tab.name + '" 의 바뀐 내용을 저장할까요?', names);
      if (ans === 'cancel') return;
      if (ans === 'yes') {
        for (const r of dirty) {
          if (!await saveRowToFile(r)) { toast('저장하지 못했습니다: ' + r.filePath); return; }
        }
        toast(dirty.length + '개 파일을 저장했습니다');
      }
    } else if (hasLocalContent(tab) && !tab.rows.every((r) => r.filePath)) {
      // 파일이 아니라 짱디터 안에만 있는 내용이면 한 번 확인
      const c = countOf(tab.rows);
      const ok = await window.jj.confirm(
        '탭 "' + tab.name + '" 을(를) 닫을까요?',
        '이 탭에만 있는 내용 ' + c.total + '개가 없어집니다. 남겨두려면 [파일 → 현재 탭 내보내기] 를 먼저 쓰세요.',
        '닫기');
      if (!ok) return;
    }
  } finally {
    busy = false;
  }

  const back = tabAfterClose(id);
  ws.tabs = ws.tabs.filter((t) => t.id !== id);
  tabHist = tabHist.filter((x) => x !== id);
  if (ws.activeTabId === id) ws.activeTabId = back || ws.tabs[0].id;
  render();
  saveNow();
}

/* ================= 내보내기 / 가져오기 ================= */
async function openTextFile() {
  busy = true;
  const r = await window.jj.openText();
  busy = false;
  if (!r || !r.ok) {
    if (r && r.error) toast(r.error);
    return;
  }
  // 이미 열어둔 파일이면 한 번 알려 준다 (모르고 두 탭에서 고치면 서로 덮어쓴다)
  const dup = findOpenRow(r.path);
  if (dup) {
    const ans = await window.jj.confirm3(
      '이 파일은 이미 탭 "' + dup.tab.name + '" 에 열려 있습니다.',
      r.path + '\n\n' +
      '두 탭에서 따로 고치면 나중에 저장한 쪽이 먼저 저장한 내용을 덮어씁니다.\n\n' +
      '[예] 열려 있는 탭으로 가기    [아니오] 새 탭으로 또 열기    [취소] 그만두기');
    if (ans === 'cancel') return;
    if (ans === 'yes') {
      goTab(dup.tab.id);
      render();
      toast('이미 열려 있는 탭으로 왔습니다');
      return;
    }
    toast('또 열었습니다 — 저장할 때 덮어쓰기 전에 물어봅니다');
  }

  // 파일 하나 = 글 블록 하나를 가진 새 탭
  const row = normRow({ type: 'text', label: r.name || '글', text: r.text,
    filePath: r.path, encoding: r.enc, savedText: r.text, fileStamp: r.stamp || null });
  const t = normTab({ name: uniqueName(r.name || '새 글'), rows: [row] });
  addTab(t);
  pushRecent('file', r.name || '글', r.path);
  fitRowToPanel(row.id);
  toast('열었습니다 (' + (r.enc || 'UTF-8') + ')');
}

/** 블록을 '패널 높이에 맞춤' 으로 바꾼다 (실제 px 는 그릴 때마다 다시 잰다) */
function fitRowToPanel(rowId) {
  const row = rowById(rowId);
  if (!row) return;
  row.fit = true;
  row.height = null;
  rerender();
  scheduleSave();
}

/* ---------------- 최근 항목 ---------------- */
function pushRecent(kind, label, key) {
  if (!ws.recent) ws.recent = [];
  ws.recent = ws.recent.filter((x) => !(x.kind === kind && x.key === key));
  ws.recent.unshift({ kind: kind, label: label, key: key, at: Date.now() });
  if (ws.recent.length > 12) ws.recent.length = 12;
  scheduleSave();
}

function recentItems() {
  const list = (ws.recent || []);
  if (!list.length) return [{ icon: '', label: '아직 없습니다' }];
  return list.map((r) => ({
    icon: r.kind === 'file' ? '\ud83d\udcc2' : '\ud83d\udccb',
    label: r.label,
    tag: r.kind === 'file' ? '파일' : '템플릿',
    onClick: () => {
      if (r.kind === 'template') {
        const t = tabFromTemplate(r.key);
        t.name = uniqueName(t.name);
        addTab(t);
        pushRecent('template', r.label, r.key);
      } else {
        reopenFile(r.key, r.label);
      }
    }
  }));
}

async function reopenFile(path, label, line, q) {
  // 이미 열어둔 파일이면 그 탭으로 간다
  for (const t of ws.tabs) {
    const hit = t.rows.find((r) => r.filePath === path);
    if (hit) {
      goTab(t.id);
      render();
      if (line) { openZoom(hit.id, 'text', hit.label); setTimeout(() => window.JJDoc.gotoLine(line, q), 80); }
      return;
    }
  }
  busy = true;
  const r = await window.jj.readText(path);
  busy = false;
  if (!r || !r.ok) { toast(r && r.error ? r.error : '파일을 열지 못했습니다'); return; }
  const row = normRow({ type: 'text', label: label || '글', text: r.text,
    filePath: path, encoding: r.enc, savedText: r.text, fileStamp: r.stamp || null });
  const t = normTab({ name: uniqueName(label || '새 글'), rows: [row] });
  addTab(t);
  pushRecent('file', label || '글', path);
  if (line) {
    openZoom(row.id, 'text', row.label);
    setTimeout(() => window.JJDoc.gotoLine(line, q), 120);
  } else {
    fitRowToPanel(row.id);
  }
}

function tabPayload(tab) {
  return {
    kind: 'jjangditer-tab', version: 1,
    exportedAt: new Date().toISOString(),
    tab: { name: tab.name, rows: tab.rows }
  };
}

async function exportTab(id) {
  const tab = ws.tabs.find((t) => t.id === id) || activeTab();
  if (!tab) return;
  busy = true;
  const r = await window.jj.exportTab(tab.name, tabPayload(tab));
  busy = false;
  if (r && r.ok) toast('저장 완료: ' + r.path);
}

async function exportAll() {
  busy = true;
  const r = await window.jj.exportAll({
    kind: 'jjangditer-workspace', version: 1,
    exportedAt: new Date().toISOString(),
    ui: ws.ui,
    tabs: ws.tabs.map((t) => ({ name: t.name, rows: t.rows }))
  });
  busy = false;
  if (r && r.ok) toast('전체 저장 완료: ' + r.path);
}

async function importFiles() {
  busy = true;
  const r = await window.jj.import();
  busy = false;
  if (!r || !r.ok) return;
  let added = 0;
  for (const it of r.items) {
    const d = it.data;
    if (d && d.kind === 'jjangditer-workspace' && Array.isArray(d.tabs)) {
      for (const t of d.tabs) {
        const nt = normTab(t);
        nt.id = uid();
        nt.name = uniqueName(nt.name);
        ws.tabs.push(nt);
        added++;
      }
    } else if (d && d.tab) {
      const nt = normTab(d.tab);
      nt.id = uid();
      nt.name = uniqueName(nt.name || it.file.replace(/\.[^.]+$/, ''));
      ws.tabs.push(nt);
      added++;
    } else if (d && Array.isArray(d.rows)) {
      const nt = normTab(d);
      nt.id = uid();
      nt.name = uniqueName(nt.name || it.file.replace(/\.[^.]+$/, ''));
      ws.tabs.push(nt);
      added++;
    }
  }
  if (added) {
    goTab(ws.tabs[ws.tabs.length - 1].id);
    render();
    saveNow();
    toast(added + '개 탭을 불러왔습니다');
  } else {
    toast('짱디터 파일 형식이 아닙니다');
  }
}

function tabToMarkdown(tab) {
  const vars = varsOf(tab);
  const out = ['# ' + tab.name, ''];
  for (const r of tab.rows) {
    if (r.type === 'section') { out.push('', '## ' + r.label, ''); continue; }
    const mark = r.done ? '[x]' : '[ ]';
    if (r.type === 'text') {
      out.push('- ' + mark + ' **' + (r.label || '메모') + '**');
      out.push('');
      out.push(resolve(r.text, vars));
      out.push('');
      continue;
    }
    if (r.type === 'table') {
      out.push('- ' + mark + ' **' + (r.label || '표') + '**');
      out.push('');
      out.push(tblMarkdown(r, vars));
      out.push('');
      continue;
    }
    if (r.type === 'cmd') {
      out.push('- ' + mark + ' ' + (r.label || '(명령)'));
      out.push('');
      out.push('```');
      out.push(resolve(r.cmd, vars));
      out.push('```');
      out.push('');
    } else {
      let line = '- ' + mark + ' **' + (r.label || '-') + '**';
      const bits = [];
      if (r.current) bits.push('현재: `' + r.current + '`');
      if (r.target) bits.push('설정: `' + r.target + '`');
      if (bits.length) line += ' — ' + bits.join(' / ');
      out.push(line);
      if (r.note) out.push('  - 메모: ' + r.note);
    }
  }
  return out.join('\n');
}


/* ================= 찾기 / 바꾸기 =================
 * 창 자체는 호스트(윈도우 창)가 그린다. 앱 창 밖으로도 끌어낼 수 있다.
 * 여기서는 찾고·옮기고·바꾸는 일만 한다.
 */
const fb = {
  open: false,
  opt: { q: '', r: '', cs: false, word: false, re: false, hl: true, up: false, tab: false },
  hits: [],          // [{ rowId, field, k }]
  i: -1,
  moved: false,
  rowId: null
};

function fieldOf(row) { return row.type === 'cmd' ? 'cmd' : 'text'; }

function taOf(rowId, field) {
  return document.querySelector('#rows .row[data-id="' + rowId + '"] textarea[data-field="' +
    (field || 'text') + '"]');
}

/** 지금 찾기 대상이 될 글 블록 */
function findTargetRow() {
  const el = document.activeElement;
  const ta = el && el.closest ? el.closest('textarea.memo, textarea.code') : null;
  if (ta) {
    const h = ta.closest('[data-id]');
    const r = h && rowById(h.dataset.id);
    if (r) return r;
  }
  if (fb.rowId) { const r = rowById(fb.rowId); if (r) return r; }
  const tab = activeTab();
  if (!tab) return null;
  return tab.rows.find((r) => r.type === 'text' && !r.results)
      || tab.rows.find((r) => r.type === 'cmd') || null;
}

function fdStat(msg, bad) { window.jj.findStatus(msg || '', !!bad); }

/** 찾기 창을 띄운다 */
async function openFindDlg(mode, preset) {
  const row = findTargetRow();
  if (!row) { toast('이 탭에는 찾을 글이 없습니다'); return; }
  fb.rowId = row.id;

  const pick = preset || (window.JJDoc.selText ? window.JJDoc.selText() : '');
  const o = await window.jj.findShow(mode || 'find', pick || null);
  fb.open = true;
  if (o) fb.opt = Object.assign(fb.opt, o);
  refreshFind(false);
}

function closeFindDlg() {
  fb.open = false;
  fb.hits = []; fb.i = -1; fb.moved = false;
  window.jj.findHide();
  if (window.JJDoc.clearFind) window.JJDoc.clearFind();
}

/** 찾을 대상이 되는 블록들 */
function findRows() {
  const tab = activeTab();
  if (!tab) return [];
  if (fb.opt.tab) {
    return tab.rows.filter((r) => (r.type === 'text' && !r.results) || r.type === 'cmd');
  }
  const r = rowById(fb.rowId);
  return r ? [r] : [];
}

/** 목록을 다시 만든다 */
function refreshFind(move) {
  const opt = fb.opt;
  fb.hits = []; fb.i = -1; fb.moved = false;

  if (!opt.q) { fdStat(''); if (window.JJDoc.clearFind) window.JJDoc.clearFind(); return; }

  let bad = false;
  for (const r of findRows()) {
    const f = fieldOf(r);
    const ms = window.JJDoc.listIn(r[f] || '', opt);
    if (ms === null) { bad = true; break; }
    for (let k = 0; k < ms.length; k++) fb.hits.push({ rowId: r.id, field: f, k: k });
  }

  if (bad) { fdStat('정규식이 올바르지 않습니다', true); return; }
  if (!fb.hits.length) {
    fdStat('찾지 못했습니다');
    if (window.JJDoc.clearFind) window.JJDoc.clearFind();
    return;
  }

  fb.i = 0;
  fdStat(fb.hits.length + '곳' + (opt.tab ? ' (이 탭 전체)' : ''));

  const first = fb.hits[0];
  const t = taOf(first.rowId, first.field);
  if (t) {
    bindDocTo(t);
    window.JJDoc.setFind(opt.q, opt);
    window.JJDoc.setHilite(opt.hl);
  }
  if (move) gotoHit(0);
}

function gotoHit(n) {
  if (!fb.hits.length) return;
  fb.i = ((n % fb.hits.length) + fb.hits.length) % fb.hits.length;
  fb.moved = true;
  const h = fb.hits[fb.i];
  const t = taOf(h.rowId, h.field);
  if (!t) return;

  const opt = fb.opt;
  bindDocTo(t);
  window.JJDoc.setFind(opt.q, opt);
  window.JJDoc.setHilite(opt.hl);
  window.JJDoc.gotoIndex(h.k);

  fdStat((fb.i + 1) + ' / ' + fb.hits.length + (opt.tab ? ' (이 탭 전체)' : ''));

  const rowEl = t.closest('.row');
  if (rowEl) {
    const host = $('#rows');
    const rb = rowEl.getBoundingClientRect(), hb = host.getBoundingClientRect();
    if (rb.top < hb.top || rb.bottom > hb.bottom) rowEl.scrollIntoView({ block: 'nearest' });
  }
}

/** 다음/이전 찾기 */
function findStep(dir) {
  const d = dir != null ? dir : (fb.opt.up ? -1 : 1);
  if (!fb.open) {
    const el = document.activeElement;
    const ta = el && el.closest ? el.closest('textarea.memo, textarea.code') : null;
    if (ta) bindDocTo(ta);
    const pick = window.JJDoc.selText ? window.JJDoc.selText() : '';
    openFindDlg('find', pick || undefined);
    return;
  }
  if (!fb.hits.length) { refreshFind(true); return; }
  if (!fb.moved) { gotoHit(fb.i < 0 ? 0 : fb.i); return; }
  gotoHit(fb.i + d);
}

/** 지금 자리 하나만 바꾼다 */
function replaceOne() {
  if (!fb.hits.length) { refreshFind(true); return; }
  if (!fb.moved) { gotoHit(fb.i < 0 ? 0 : fb.i); return; }
  const h = fb.hits[fb.i];
  const t = taOf(h.rowId, h.field);
  if (!t) return;
  const start = t.selectionStart, end = t.selectionEnd;
  if (end > start) {
    bindDocTo(t);
    window.JJDoc.replaceRange(start, end, fb.opt.r || '');
    const row = rowById(h.rowId);
    if (row) { row[h.field] = t.value; scheduleSave(); }
  }
  const keep = fb.i;
  refreshFind(false);
  if (fb.hits.length) gotoHit(Math.min(keep, fb.hits.length - 1));
  else fdStat('모두 바꿨습니다');
}

/** 범위 안에서 모두 바꾼다 */
function replaceAll() {
  const opt = fb.opt;
  if (!opt.q) return;
  const to = opt.r || '';
  let total = 0, touched = 0;

  for (const r of findRows()) {
    const f = fieldOf(r);
    const t = taOf(r.id, f);
    if (!t) continue;
    bindDocTo(t);
    window.JJDoc.setFind(opt.q, opt);
    const n = window.JJDoc.replaceAllHere(to);
    if (n) { r[f] = t.value; total += n; touched++; }
  }
  if (total) { scheduleSave(); rerender(); }
  refreshFind(false);
  if (total) {
    fdStat(total + '곳을 바꿨습니다' + (touched > 1 ? ' (' + touched + '개 글)' : ''));
    toast(total + '곳을 바꿨습니다');
  } else {
    fdStat('바꿀 내용을 찾지 못했습니다');
  }
}

/** 호스트의 찾기 창에서 오는 신호 */
function bindFindDlg() {
  if (!window.jj.onFindDlg) return;
  window.jj.onFindDlg((what, d) => {
    if (d) fb.opt = Object.assign(fb.opt, d);
    fb.open = true;
    switch (what) {
      case 'change': refreshFind(false); break;
      case 'next':   findStep(1); break;
      case 'prev':   findStep(-1); break;
      case 'count':
        refreshFind(false);
        if (fb.hits.length) toast(fb.hits.length + '곳을 찾았습니다');
        break;
      case 'rep':    replaceOne(); break;
      case 'repall': replaceAll(); break;
    }
  });
}

/** 메뉴 밑 아이콘 줄 — 자주 쓰는 것만 */

/* ================= 아이콘 줄 =================
   어떤 아이콘을 어느 자리에 둘지 사용자가 고른다.
   ws.ui.iconbar 에 아이디를 늘어놓은 차례가 곧 화면 차례다. '|' 는 구분선.   */

const IC_ALL = [
  { id: 'open',   ic: '\ud83d\udcc2', label: '파일 열기',     title: '텍스트 파일 열기 (Ctrl+O)',
    run: () => openTextFile() },
  { id: 'save',   ic: '\ud83d\udcbe', label: '저장',          title: '파일 저장 (Ctrl+S)',
    run: () => saveCurrentFile(false) },
  { id: 'saveas', ic: '\ud83d\udcdd', label: '다른 이름으로', title: '다른 이름으로 저장 (Ctrl+Shift+S)',
    run: () => saveCurrentFile(true) },
  { id: 'find',   ic: '\ud83d\udd0e', label: '찾기',          title: '이 글에서 찾기 (Ctrl+F)',
    run: () => openFindDlg('find') },
  { id: 'repl',   ic: '\ud83d\udd01', label: '바꾸기',        title: '바꾸기 (Ctrl+H)',
    run: () => openFindDlg('repl') },
  { id: 'fif',    ic: '\ud83d\udcc1', label: '파일에서 찾기', title: '파일 내에서 찾기 (Ctrl+Shift+F)',
    run: () => openFindInFiles(window.innerWidth - 24, 60) },
  { id: 'undo',   ic: '\u21a9', label: '되돌리기',   title: '되돌리기 (Ctrl+Z)',
    run: () => icDoc((d) => d.undo()) },
  { id: 'redo',   ic: '\u21aa', label: '다시 하기',  title: '다시 하기 (Ctrl+Y)',
    run: () => icDoc((d) => d.redo()) },
  { id: 'col',    ic: '\u25a5', label: '열 편집',    title: '열 편집 켜기 / 끄기 (Alt+C)',
    run: () => {
      const row = findTargetRow();
      if (row) toggleColHere(row.id, fieldOf(row)); else toast('열 편집할 글이 없습니다');
    } },
  { id: 'fit',    ic: '\u2922', label: '높이 맞춤',  title: '글 칸을 패널 높이에 맞추기',
    run: () => {
      const row = findTargetRow();
      if (!row) { toast('글이 없습니다'); return; }
      row.fit = !row.fit;
      if (row.fit) row.height = null;
      rerender(); scheduleSave();
    } },
  { id: 'copy',   ic: '\u29c9', label: '전체 복사',  title: '이 글 전체 복사',
    run: () => {
      const row = findTargetRow();
      if (row) copyText(resolve(row[fieldOf(row)], varsOf(activeTab())));
      else toast('복사할 글이 없습니다');
    } },
  { id: 'newtab', ic: '\uff0b', label: '새 탭',      title: '새 탭',
    run: () => addTabMenu(60, 80) },

  /* --- 여기부터는 원하면 넣어 쓰는 것들 --- */
  { id: 'theme',  label: '다크 / 라이트',
    ic: () => (cfg.theme === 'dark' ? '\u2600' : '\ud83c\udf19'),
    title: () => (cfg.theme === 'dark' ? '라이트 모드로 바꾸기' : '다크 모드로 바꾸기'),
    run: () => window.jj.setPrefs({ theme: cfg.theme === 'dark' ? 'light' : 'dark' }) },
  { id: 'pin',    label: '패널 고정',
    ic: () => (cfg.pinned ? '\ud83d\udccc' : '\ud83d\udccd'),
    title: () => (cfg.pinned ? '고정 해제 (자동 숨김)' : '우측에 고정'),
    run: () => window.jj.setPinned(!cfg.pinned) },
  { id: 'mode',   label: '작업 / 설정 화면',
    ic: () => (ws.ui.mode === 'edit' ? '\u2713' : '\u2699'),
    title: () => (ws.ui.mode === 'edit' ? '작업 화면으로 (Ctrl+D)' : '설정 화면으로 (Ctrl+D)'),
    run: () => { const b = $('#btnMode'); if (b) b.click(); } },
  { id: 'export', ic: '\ud83d\udce4', label: '탭 내보내기', title: '현재 탭 내보내기 (Ctrl+E)',
    run: () => exportTab(ws.activeTabId) },
  { id: 'update', ic: '\u27f3', label: '업데이트 확인', title: '업데이트 확인',
    run: () => { toast('업데이트 확인 중…'); window.jj.checkUpdate(); } },
  { id: 'about',  ic: '\u24d8', label: '짱디터 정보', title: '짱디터 정보',
    run: () => openAbout() },
  { id: 'colfill', ic: '\u270e', label: '열 채우기', title: '세로로 잡은 칸을 같은 글로 채우기',
    run: () => { if (colReady()) colFillDlg(); } },
  { id: 'colnum',  ic: '\u2460', label: '숫자 넣기', title: '세로로 잡은 칸에 1, 2, 3 … 넣기',
    run: () => { if (colReady()) colNumDlg(); } },
  { id: 'colsum',  ic: '\u03a3', label: '열 합계', title: '세로로 잡은 숫자 더하기',
    run: () => {
      if (!colReady()) return;
      const r = window.JJDoc.sumRect();
      if (!r) return;
      const t = r.sum.toLocaleString(undefined, { maximumFractionDigits: 6 });
      copyText(t);
      toast('합계 ' + t + '  (숫자 ' + r.count + '개) — 복사했습니다');
    } },
  { id: 'icset',  ic: '\u22ef', label: '아이콘 편집', title: '이 줄에 둘 아이콘 고르기',
    run: () => iconbarSettings() }
];

const IC_DEFAULT = ['open', 'save', 'saveas', '|', 'find', 'repl', 'fif', '|',
                    'undo', 'redo', '|', 'col', 'fit', 'copy', '|', 'theme', 'newtab'];

function icById(id) { return IC_ALL.find((x) => x.id === id) || null; }

/** 되돌리기·다시하기처럼 글 칸을 먼저 붙잡아야 하는 것들 */
function icDoc(fn) {
  const row = findTargetRow();
  const ta = row ? taOf(row.id, fieldOf(row)) : null;
  if (ta) { ta.focus(); bindDocTo(ta); }
  fn(window.JJDoc);
}

/** 설정에 적힌 차례대로 아이콘 줄을 그린다 */
function renderIconbar() {
  const bar = $('#iconbar');
  if (!bar || !ws) return;          // 작업 내용을 읽기 전에는 그리지 않는다
  const list = (ws.ui.iconbar && ws.ui.iconbar.length) ? ws.ui.iconbar : IC_DEFAULT;
  let h = '';
  for (let i = 0; i < list.length; i++) {
    const id = list[i];
    if (id === '|') { h += '<span class="sep"></span>'; continue; }
    const it = icById(id);
    if (!it) continue;
    const ic = typeof it.ic === 'function' ? it.ic() : it.ic;
    const ti = typeof it.title === 'function' ? it.title() : it.title;
    h += '<button data-ic="' + id + '" data-at="' + i + '" draggable="true" title="' +
         esc(ti) + '">' + esc(ic) + '</button>';
  }
  bar.innerHTML = h;
  updateSaveIcon();
}

/* ---------------- 아이콘 고르기 ---------------- */

/** 지금 쓰는 차례 (설정이 없으면 기본값) */
function icList() {
  if (!ws) return IC_DEFAULT.slice();
  return (ws.ui.iconbar && ws.ui.iconbar.length) ? ws.ui.iconbar.slice() : IC_DEFAULT.slice();
}

function icSave(list) {
  ws.ui.iconbar = list;
  renderIconbar();
  saveNow();
}

/** 아이콘 줄 꾸미기 창 */
function iconbarSettings() {
  const m = $('#menu');
  m.innerHTML = '';

  const hd = document.createElement('div');
  hd.className = 'hd abhd';
  hd.innerHTML = '<span>아이콘 줄 꾸미기</span><button class="abx" title="닫기 (Esc)">\u2715</button>';
  hd.querySelector('.abx').addEventListener('click', closePopup);
  m.appendChild(hd);

  const box = document.createElement('div');
  box.className = 'icset';
  m.appendChild(box);

  const draw = () => {
    const list = icList();
    const used = {};
    for (const id of list) used[id] = true;

    let h = '<div class="icnote">쓰는 아이콘 — 화살표로 자리를 옮기고, ✕ 로 뺍니다.<br>' +
            '아이콘 줄에서 바로 끌어다 옮길 수도 있습니다.</div><div class="icnow">';
    for (let i = 0; i < list.length; i++) {
      const id = list[i];
      const it = id === '|' ? null : icById(id);
      if (id !== '|' && !it) continue;
      const ic = it ? (typeof it.ic === 'function' ? it.ic() : it.ic) : '\u2502';
      const nm = it ? it.label : '구분선';
      h += '<div class="icrow" data-at="' + i + '">' +
             '<span class="icic">' + esc(ic) + '</span>' +
             '<span class="icnm">' + esc(nm) + '</span>' +
             '<button class="icup" title="위로"' + (i === 0 ? ' disabled' : '') + '>\u25b2</button>' +
             '<button class="icdn" title="아래로"' + (i === list.length - 1 ? ' disabled' : '') + '>\u25bc</button>' +
             '<button class="icdel" title="빼기">\u2715</button>' +
           '</div>';
    }
    h += '</div>';

    const rest = IC_ALL.filter((x) => !used[x.id]);
    h += '<div class="icnote2">넣을 수 있는 것 — 눌러서 맨 뒤에 넣습니다</div><div class="icpool">';
    for (const it of rest) {
      const ic = typeof it.ic === 'function' ? it.ic() : it.ic;
      h += '<button class="icadd" data-id="' + it.id + '" title="' + esc(it.label) + '">' +
             esc(ic) + '<em>' + esc(it.label) + '</em></button>';
    }
    h += '<button class="icadd" data-id="|" title="구분선 넣기">\u2502<em>구분선</em></button>';
    h += '</div>';

    h += '<div class="btnline"><button class="icreset">기본값으로</button>' +
         '<button class="icdone prim">다 했습니다</button></div>';
    box.innerHTML = h;

    box.querySelectorAll('.icrow').forEach((el) => {
      const at = +el.dataset.at;
      el.querySelector('.icup').addEventListener('click', () => {
        const l = icList(); if (at <= 0) return;
        [l[at - 1], l[at]] = [l[at], l[at - 1]]; icSave(l); draw();
      });
      el.querySelector('.icdn').addEventListener('click', () => {
        const l = icList(); if (at >= l.length - 1) return;
        [l[at + 1], l[at]] = [l[at], l[at + 1]]; icSave(l); draw();
      });
      el.querySelector('.icdel').addEventListener('click', () => {
        const l = icList(); l.splice(at, 1); icSave(l); draw();
      });
    });
    box.querySelectorAll('.icadd').forEach((b) => {
      b.addEventListener('click', () => {
        const l = icList(); l.push(b.dataset.id); icSave(l); draw();
      });
    });
    box.querySelector('.icreset').addEventListener('click', () => {
      icSave(IC_DEFAULT.slice()); draw(); toast('아이콘 줄을 기본값으로 되돌렸습니다');
    });
    box.querySelector('.icdone').addEventListener('click', closePopup);
  };
  draw();

  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.round((window.innerWidth - r.width) / 2)) + 'px';
  m.style.top = '60px';
  popupOpen = true;
}


/* ================= 열(세로) 편집 =================
   Alt+C 로 세로로 잡은 다음, 그 칸을 한꺼번에 채우거나 번호를 매긴다.   */

/** 지금 글 칸을 붙잡아 둔다 (메뉴를 누르면 포커스가 옮겨가므로) */
function colGrab() {
  const row = findTargetRow();
  const ta = row ? taOf(row.id, fieldOf(row)) : null;
  if (ta) bindDocTo(ta);
  return row;
}

/** 세로로 잡힌 게 있는지 확인하고, 없으면 알려 준다 */
function colReady() {
  colGrab();
  if (!window.JJDoc.hasRect || !window.JJDoc.hasRect()) {
    toast('먼저 Alt+C 로 열 편집을 켜고 세로로 잡아 주세요');
    return false;
  }
  return true;
}

function colItems() {
  const on = !!(window.JJDoc.hasRect && window.JJDoc.hasRect());
  const n = (window.JJDoc.rectLines && window.JJDoc.rectLines()) || 0;
  return [
    {
      icon: '\u25a5', label: '열 편집 모드', tag: 'Alt+C',
      onClick: () => {
        const row = findTargetRow();
        if (row) toggleColHere(row.id, fieldOf(row));
        else toast('열 편집할 글이 없습니다');
      }
    },
    { sep: true },
    { hd: on ? ('세로로 ' + n + '줄 잡혀 있습니다') : '먼저 세로로 잡으세요 (Alt+C)' },
    {
      icon: '\u270e', label: '열 채우기…', tag: '같은 글로',
      onClick: () => { if (colReady()) colFillDlg(); }
    },
    {
      icon: '\u2460', label: '숫자 넣기…', tag: '1, 2, 3 …',
      onClick: () => { if (colReady()) colNumDlg(); }
    },
    { sep: true },
    {
      icon: '\u29c9', label: '열 복사', tag: 'Ctrl+C',
      onClick: () => { if (colReady()) window.JJDoc.copyRect(); }
    },
    {
      icon: '\u2702', label: '열 잘라내기', tag: 'Ctrl+X',
      onClick: () => { if (colReady()) window.JJDoc.cutRect(); }
    },
    {
      icon: '\u2715', label: '열 삭제', tag: 'Del',
      onClick: () => {
        if (!colReady()) return;
        const k = window.JJDoc.deleteRect();
        toast(k + '줄에서 지웠습니다');
      }
    },
    { sep: true },
    {
      icon: '\u03a3', label: '선택 열 합계',
      onClick: () => {
        if (!colReady()) return;
        const r = window.JJDoc.sumRect();
        if (!r) return;
        const txt = r.sum.toLocaleString(undefined, { maximumFractionDigits: 6 });
        copyText(txt);
        toast('합계 ' + txt + '  (숫자 ' + r.count + '개' +
              (r.skipped ? ', 숫자가 아닌 줄 ' + r.skipped + '개는 건너뜀' : '') +
              ') — 복사했습니다');
      }
    }
  ];
}

/* ---------------- 열 채우기 ---------------- */
function colFillDlg() {
  const n = window.JJDoc.rectLines();
  const m = $('#menu');
  m.innerHTML = '';

  const hd = document.createElement('div');
  hd.className = 'hd abhd';
  hd.innerHTML = '<span>열 채우기</span><button class="abx" title="닫기 (Esc)">\u2715</button>';
  hd.querySelector('.abx').addEventListener('click', closePopup);
  m.appendChild(hd);

  const box = document.createElement('div');
  box.className = 'coldlg';
  box.innerHTML =
    '<div class="colnote">세로로 잡은 <b>' + n + '줄</b> 을 같은 글로 채웁니다.</div>' +
    '<label class="colf"><span>채울 글</span>' +
      '<input class="cfText" spellcheck="false" placeholder="예) - 또는 0 또는 TODO"></label>' +
    '<label class="colchk"><input type="checkbox" class="cfWide">' +
      '잡은 너비만큼 되풀이해 채우기</label>' +
    '<div class="btnline">' +
      '<button class="cfCancel">그만</button>' +
      '<button class="cfOk prim">채우기</button>' +
    '</div>';
  m.appendChild(box);

  const inp = $('.cfText', box);
  const go = () => {
    let t = inp.value;
    if ($('.cfWide', box).checked && t) {
      const w = colRectWidth();
      let r = '';
      while (r.length < w) r += t;
      t = r.slice(0, w);
    }
    const k = window.JJDoc.fillRect(t);
    closePopup();
    toast(k + '줄을 채웠습니다');
  };
  $('.cfOk', box).addEventListener('click', go);
  $('.cfCancel', box).addEventListener('click', closePopup);
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); go(); }
  });

  m.classList.remove('hidden');
  colPlace(m);
  popupOpen = true;
  setTimeout(() => inp.focus(), 30);
}

/** 잡은 네모의 가로 칸 수 */
function colRectWidth() {
  const t = window.JJDoc.rectTexts();
  let w = 0;
  for (const x of t) if (x.length > w) w = x.length;
  return Math.max(1, w);
}

/* ---------------- 숫자 넣기 ---------------- */
function colNumDlg() {
  const n = window.JJDoc.rectLines();
  const m = $('#menu');
  m.innerHTML = '';

  const hd = document.createElement('div');
  hd.className = 'hd abhd';
  hd.innerHTML = '<span>숫자 넣기</span><button class="abx" title="닫기 (Esc)">\u2715</button>';
  hd.querySelector('.abx').addEventListener('click', closePopup);
  m.appendChild(hd);

  const box = document.createElement('div');
  box.className = 'coldlg';
  box.innerHTML =
    '<div class="colnote">세로로 잡은 <b>' + n + '줄</b> 에 번호를 매깁니다.</div>' +
    '<div class="colgrid">' +
      '<label class="colf"><span>시작</span><input class="cnStart" value="1"></label>' +
      '<label class="colf"><span>증가</span><input class="cnStep" value="1"></label>' +
      '<label class="colf"><span>자릿수</span><input class="cnPad" value="0" ' +
        'title="0 이면 그대로, 3 이면 001 002 …"></label>' +
    '</div>' +
    '<div class="colgrid2">' +
      '<label class="colf"><span>앞에</span><input class="cnPre" spellcheck="false" ' +
        'placeholder="예) srv-"></label>' +
      '<label class="colf"><span>뒤에</span><input class="cnSuf" spellcheck="false" ' +
        'placeholder="예) ,"></label>' +
    '</div>' +
    '<label class="colchk"><input type="checkbox" class="cnRight" checked>' +
      '자릿수를 오른쪽으로 맞추기</label>' +
    '<div class="colprev"></div>' +
    '<div class="btnline">' +
      '<button class="cnCancel">그만</button>' +
      '<button class="cnOk prim">넣기</button>' +
    '</div>';
  m.appendChild(box);

  const opts = () => ({
    start: parseFloat($('.cnStart', box).value) || 0,
    step: parseFloat($('.cnStep', box).value) || 0,
    pad: parseInt($('.cnPad', box).value, 10) || 0,
    prefix: $('.cnPre', box).value,
    suffix: $('.cnSuf', box).value,
    right: $('.cnRight', box).checked
  });

  /* 넣기 전에 어떤 모습인지 보여 준다 */
  const prev = $('.colprev', box);
  const draw = () => {
    const o = opts();
    const show = Math.min(n, 4);
    const out = [];
    for (let i = 0; i < show; i++) {
      let v = String(o.start + o.step * i);
      let neg = '';
      if (v.charAt(0) === '-') { neg = '-'; v = v.slice(1); }
      while (o.pad > 0 && v.length < o.pad) v = '0' + v;
      out.push(o.prefix + neg + v + o.suffix);
    }
    prev.textContent = out.join('\n') + (n > show ? '\n…' : '');
  };
  box.querySelectorAll('input').forEach((el) => {
    el.addEventListener('input', draw);
    el.addEventListener('change', draw);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); go(); }
    });
  });
  draw();

  const go = () => {
    const k = window.JJDoc.numberRect(opts());
    closePopup();
    toast(k + '줄에 번호를 넣었습니다');
  };
  $('.cnOk', box).addEventListener('click', go);
  $('.cnCancel', box).addEventListener('click', closePopup);

  m.classList.remove('hidden');
  colPlace(m);
  popupOpen = true;
  setTimeout(() => { const i = $('.cnStart', box); i.focus(); i.select(); }, 30);
}

function colPlace(m) {
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.round((window.innerWidth - r.width) / 2)) + 'px';
  m.style.top = '70px';
}

function bindIconbar() {
  const bar = $('#iconbar');
  if (!bar) return;

  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-ic]');
    if (!b) return;
    const it = icById(b.dataset.ic);
    if (it) it.run();
  });

  // 아이콘 줄을 우클릭하면 꾸미기
  bar.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    iconbarSettings();
  });

  /* --- 끌어서 자리 옮기기 --- */
  let from = -1;
  bar.addEventListener('dragstart', (e) => {
    const b = e.target.closest('button[data-ic]');
    if (!b) return;
    from = +b.dataset.at;
    b.classList.add('dragging');
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', b.dataset.ic); }
    catch (err) { /* 무시 */ }
  });
  bar.addEventListener('dragover', (e) => {
    if (from < 0) return;
    e.preventDefault();
    const b = e.target.closest('button[data-ic], .sep');
    bar.querySelectorAll('.dropmark').forEach((x) => x.classList.remove('dropmark'));
    if (b) b.classList.add('dropmark');
  });
  bar.addEventListener('drop', (e) => {
    e.preventDefault();
    const b = e.target.closest('button[data-ic]');
    bar.querySelectorAll('.dropmark').forEach((x) => x.classList.remove('dropmark'));
    if (from < 0 || !b) { from = -1; return; }
    const to = +b.dataset.at;
    if (to === from) { from = -1; return; }
    const l = icList();
    const [moved] = l.splice(from, 1);
    l.splice(to, 0, moved);
    icSave(l);
    from = -1;
  });
  bar.addEventListener('dragend', () => {
    bar.querySelectorAll('.dragging, .dropmark')
       .forEach((x) => x.classList.remove('dragging', 'dropmark'));
    from = -1;
  });

  renderIconbar();
}

/* ================= 팝업 메뉴 ================= */
let popupOpen = false;

/* 하위 메뉴(▶) 여닫기
 * 마우스가 하위 메뉴로 가는 길에 다른 항목을 스쳐 지나가더라도
 * 바로 바뀌지 않도록, 잠깐 머무를 때만 바꾼다.
 */
const SUB_SWITCH_MS = 280;   // 다른 항목으로 바꾸기까지 기다리는 시간
const SUB_FIRST_MS = 90;     // 처음 열 때는 거의 바로
let subTimer = null;
let subOwner = null;         // 지금 열려 있는 하위 메뉴의 주인 버튼

function cancelSubTimer() {
  if (subTimer) { clearTimeout(subTimer); subTimer = null; }
}
function laterSub(fn, ms) {
  cancelSubTimer();
  subTimer = setTimeout(() => { subTimer = null; fn(); }, ms);
}

function closePopup() {
  closeSubmenu();
  $('#menu').classList.add('hidden');
  popupOpen = false;
  menuOpenIndex = -1;
  $$('#menubar .mb').forEach((b) => b.classList.remove('on'));
}
function fillPopup(m, items, onPick) {
  m.innerHTML = '';
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { const d = document.createElement('div'); d.className = 'sep'; m.appendChild(d); continue; }
    if (it.hd) { const d = document.createElement('div'); d.className = 'hd'; d.textContent = it.hd; m.appendChild(d); continue; }
    const b = document.createElement('button');
    b.className = 'mi' + (it.danger ? ' danger' : '') + (it.sub ? ' hassub' : '');
    b.innerHTML = '<span class="ic">' + esc(it.icon || '') + '</span><span>' + esc(it.label) + '</span>' +
      (it.tag ? '<span class="tag">' + esc(it.tag) + '</span>' : '') +
      (it.sub ? '<span class="arrow">\u25b6</span>' : '');
    if (it.sub) {
      const open = () => {
        cancelSubTimer();
        if (subOwner && subOwner !== b) subOwner.classList.remove('subopen');
        subOwner = b;
        b.classList.add('subopen');
        openSubmenu(b, it.sub());
      };
      b.addEventListener('mouseenter', () => {
        // 이미 이 항목의 하위 메뉴가 열려 있으면 그대로 둔다
        if (subOwner === b) { cancelSubTimer(); return; }
        laterSub(open, subOwner ? SUB_SWITCH_MS : SUB_FIRST_MS);
      });
      b.addEventListener('click', (e) => { e.stopPropagation(); open(); });
    } else {
      b.addEventListener('mouseenter', () => {
        if (!subOwner) { cancelSubTimer(); return; }
        laterSub(closeSubmenu, SUB_SWITCH_MS);     // 스쳐 지나가는 것만으로는 안 닫는다
      });
      b.addEventListener('click', () => { closePopup(); it.onClick && it.onClick(); });
    }
    m.appendChild(b);
  }
}

function placePopup(m, x, y) {
  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 6)) + 'px';
  m.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 6)) + 'px';
}

function openSubmenu(anchor, items) {
  const m2 = $('#menu2');
  if (!m2.dataset.jjhover) {
    m2.dataset.jjhover = '1';
    // 하위 메뉴 안에 들어왔으면 닫지 않는다
    m2.addEventListener('mouseenter', cancelSubTimer);
    m2.addEventListener('mousemove', cancelSubTimer);
  }
  fillPopup(m2, items);
  const r = anchor.getBoundingClientRect();
  m2.classList.remove('hidden');
  const rr = m2.getBoundingClientRect();
  // 오른쪽에 공간이 없으면 왼쪽으로 펼친다
  let x = r.right - 2;                  // 사이에 틈이 없도록 살짝 겹친다
  if (x + rr.width > window.innerWidth - 4) x = r.left - rr.width + 2;
  placePopup(m2, x, r.top - 4);
}

function closeSubmenu() {
  cancelSubTimer();
  const m2 = $('#menu2');
  if (m2) m2.classList.add('hidden');
  if (subOwner) { subOwner.classList.remove('subopen'); subOwner = null; }
}

function openPopup(items, x, y) {
  closeSubmenu();
  const m = $('#menu');
  fillPopup(m, items);
  placePopup(m, x, y);
  popupOpen = true;
}

async function saveAsText() {
  const tab = activeTab();
  busy = true;
  const r = await window.jj.exportText(tab.name, tabToMarkdown(tab));
  busy = false;
  if (r && r.ok) toast('저장 완료: ' + r.path);
}

async function clearChecks() {
  const tab = activeTab();
  busy = true;
  const ok = await window.jj.confirm('현재 탭의 체크를 모두 해제할까요?', tab.name, '해제');
  busy = false;
  if (!ok) return;
  tab.rows.forEach((r) => { r.done = false; });
  rerender();
  saveNow();
  toast('체크를 모두 해제했습니다');
}

function duplicateForNew() {
  const tab = activeTab();
  const nt = normTab({
    name: uniqueName(tab.name),
    rows: tab.rows.map((r) => normRow(Object.assign({}, r, { id: null, done: false })))
  });
  addTab(nt);
  toast('복제했습니다');
}


/* ================= 정보 (About) ================= */
const REPO_URL = 'https://github.com/oo8hoon/jjangditer';

const MIT_TEXT = [
  'MIT License',
  '',
  'Copyright (c) 2026 JJangs',
  '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
  'in the Software without restriction, including without limitation the rights',
  'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
  'copies of the Software, and to permit persons to whom the Software is',
  'furnished to do so, subject to the following conditions:',
  '',
  'The above copyright notice and this permission notice shall be included in all',
  'copies or substantial portions of the Software.',
  '',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
  'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
  'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
  'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
  'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
  'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
  'SOFTWARE.'
].join('\n');

/** 보안 점검 등에 그대로 붙여 낼 수 있는 요약 */
function aboutText() {
  return [
    '짱디터 (JJangditer) v' + (cfg.version || ''),
    '만든이 : 짱스 (JJangs)',
    '소스   : ' + REPO_URL,
    '',
    '[라이선스]',
    'MIT License — 라이선스 비용이 없습니다.',
    '사용·복사·수정·배포·상업적 사용 모두 자유롭고,',
    '별도 구매나 등록 절차가 필요 없습니다. (무보증 / as-is)',
    '',
    '[설치 · 권한]',
    '설치 필요 없음 — exe 파일 하나로 실행됩니다.',
    '관리자 권한 필요 없음. 레지스트리를 쓰지 않습니다.',
    '',
    '[쓰이는 구성요소]',
    'Microsoft Edge WebView2 Runtime  (윈도우 기본 구성요소)',
    '.NET Framework 4.8               (윈도우 기본 구성요소)',
    '',
    '[주고받는 정보]',
    '짱디터가 밖으로 보내는 정보는 없습니다.',
    '업데이트 확인 때만 GitHub 에서 받아오기만 합니다.',
    '  · latest.json (버전 정보)',
    '  · 새 버전 exe (사용자가 [업데이트] 를 눌렀을 때만)',
    '',
    '[저장 위치]',
    '설정 · 작업 내용 : ' + (cfg.dataDir || '%APPDATA%\\JJangditer'),
    '화면 캐시        : %LOCALAPPDATA%\\JJangditer'
  ].join('\n');
}


/**
 * 정보 창 안에 한 줄 알려 준다. 창이 닫혀 있으면 아무 일도 하지 않는다.
 * kind : wait(확인 중) / ok(최신) / new(새 버전) / bad(실패)
 */
/** 정보 창이 지금 화면에 보이는가 (닫아도 내용은 그대로 남아 있다) */
function aboutOpen() {
  const m = document.querySelector('#menu');
  return !!(m && !m.classList.contains('hidden') && m.querySelector('.aboutbox'));
}

function abSay(kind, html) {
  if (!aboutOpen()) return false;
  const el = document.querySelector('.aboutbox .abstat');
  if (!el) return false;
  el.className = 'abstat ' + kind;
  el.innerHTML = html;
  return true;
}

/** 업데이트 소식이 오면 정보 창에도 알려 준다 */
function aboutOnUpdate(kind, d) {
  if (!aboutOpen()) return;
  const now = esc(cfg.version || '');

  if (kind === 'none') {
    abSay('ok', '<b>\u2713 최신 버전을 쓰고 계십니다</b><em>v' + now + '</em>');
  } else if (kind === 'available') {
    abSay('new',
      '<b>\u2191 새 버전 v' + esc(d.version) + ' 이 있습니다</b>' +
      '<em>지금 v' + now + '</em>' +
      (d.notes ? '<div class="abnote">' + esc(d.notes) + '</div>' : '') +
      '<button class="abgo">지금 업데이트</button>');
    const go = document.querySelector('.aboutbox .abgo');
    if (go) {
      go.addEventListener('click', () => {
        go.disabled = true;
        go.textContent = '내려받는 중…';
        window.jj.applyUpdate();
      });
    }
  } else if (kind === 'progress') {
    const go = document.querySelector('.aboutbox .abgo');
    if (go && d && d.percent != null) go.textContent = '내려받는 중… ' + d.percent + '%';
  } else if (kind === 'error') {
    abSay('bad', '<b>\u26a0 확인하지 못했습니다</b><em>지금 v' + now + '</em>' +
      '<div class="abnote">' + esc((d && d.message) || '잠시 뒤에 다시 해 보세요') + '</div>');
  }
}

function openAbout() {
  const m = $('#menu');
  m.innerHTML = '';

  const hd = document.createElement('div');
  hd.className = 'hd abhd';
  hd.innerHTML = '<span>짱디터 정보</span>' +
    '<button class="abx" title="닫기 (Esc)">\u2715</button>';
  hd.querySelector('.abx').addEventListener('click', closePopup);
  m.appendChild(hd);

  const box = document.createElement('div');
  box.className = 'aboutbox';
  box.innerHTML =
    '<div class="abtop">' +
      '<div class="abname">짱디터</div>' +
      '<div class="absub">JJangditer — 서버 작업용 사이드 에디터</div>' +
      '<div class="abmeta">' +
        '<span class="abver">v' + esc(cfg.version || '') + '</span>' +
        '<span class="abby">만든이 <b>짱스 (JJangs)</b></span>' +
      '</div>' +
    '</div>' +

    '<div class="abfree">' +
      '<b>라이선스 없이 자유롭게 쓰셔도 됩니다.</b>' +
      '<div>MIT License — 비용·구매·등록 절차가 없습니다.</div>' +
      '<div>사내 배포와 수정도 자유롭습니다. <i>(무보증 / as-is)</i></div>' +
    '</div>' +

    '<div class="abrow"><span>설치</span><div><b>필요 없음</b> — exe 하나로 실행</div></div>' +
    '<div class="abrow"><span>권한</span><div>관리자 권한 불필요 · 레지스트리 미사용</div></div>' +
    '<div class="abrow"><span>구성</span><div>Edge WebView2 · .NET Framework 4.8' +
      '<br><em>둘 다 윈도우 기본 구성요소</em></div></div>' +
    '<div class="abrow"><span>통신</span><div><b>밖으로 보내는 정보 없음</b>' +
      '<br><em>업데이트 확인 때만 GitHub 에서 받아오기만 합니다</em></div></div>' +
    '<div class="abrow"><span>저장</span><div class="abpath">' +
      esc(cfg.dataDir || '%APPDATA%\\JJangditer') + '</div></div>' +

    '<div class="btnline">' +
      '<button class="abupd prim wide">\u27f3  업데이트 확인</button>' +
    '</div>' +
    '<div class="abstat hidden"></div>' +
    '<div class="btnline three">' +
      '<button class="abrepo">소스 저장소</button>' +
      '<button class="ablic">라이선스</button>' +
      '<button class="abcopy">정보 복사</button>' +
    '</div>';
  m.appendChild(box);

  $('.abupd', box).addEventListener('click', () => {
    // 창을 닫지 않는다. 결과를 이 창 안에서 보여 준다.
    abSay('wait', '<span class="abspin">\u27f3</span> 최신 버전을 확인하는 중…');
    window.jj.checkUpdate();
  });

  $('.abrepo', box).addEventListener('click', () => {
    window.jj.openUrl(REPO_URL);
    closePopup();
  });
  $('.ablic', box).addEventListener('click', () => {
    closePopup();
    const row = normRow({ type: 'text', label: 'MIT License', text: MIT_TEXT });
    addTab(normTab({ name: uniqueName('라이선스'), rows: [row] }));
  });
  $('.abcopy', box).addEventListener('click', () => {
    copyText(aboutText());
    abSay('ok', '\u2713 정보를 복사했습니다 — 보안 점검 답변에 붙여 쓰세요');
  });

  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.round((window.innerWidth - r.width) / 2)) + 'px';
  m.style.top = '70px';
  popupOpen = true;
}

function helpItems() {
  return [
    { hd: '단축키' },
    { icon: '', label: 'Alt+Shift+J : 패널 열기/닫기 (전역)' },
    { icon: '', label: 'Ctrl+N : 항목 추가' },
    { icon: '', label: 'Ctrl+Shift+N : 섹션 추가' },
    { icon: '', label: 'Ctrl+K : 명령 추가' },
    { icon: '', label: 'Ctrl+M : 글(메모) 추가' },
    { icon: '', label: 'Ctrl+T : 표 추가' },
    { icon: '', label: 'Shift+F3 : 이전 찾기 · 낱말을 고르고 F3 이면 그 말로 찾기' },
    { icon: '', label: 'Ctrl+D : 작업 화면 ↔ 설정 화면' },
    { icon: '', label: 'Ctrl+F : 찾기 · Ctrl+H : 바꾸기 · F3 : 다음 찾기' },
    { icon: '', label: 'Ctrl+Tab : 다음 탭' },
    { icon: '', label: 'Ctrl+E : 현재 탭 내보내기' },
    { icon: '', label: 'Ctrl+S : 파일 저장 · Ctrl+Shift+S : 다른 이름으로 저장' },
    { icon: '', label: 'Ctrl+O : 텍스트 파일 열기' },
    { sep: true },
    { hd: '팁' },
    { icon: '', label: '명령·글에 {{키}} 를 쓰면 항목 값이 들어갑니다' },
    { icon: '', label: '긴 글은 [⤢ 크게] 로 넓게 펼쳐 고칩니다' },
    { icon: '', label: '줄을 우클릭하면 삭제·이동·칸 켜고 끄기 메뉴가 나옵니다' },
    { icon: '', label: '표: 셀 더블클릭 = 복사, 우클릭 = 행/열 메뉴' },
    { icon: '', label: '표: 칸에서 Ctrl+V = 표를 칸칸이 나눠 넣기 (탭·마크다운·CSV)' },
    { icon: '', label: '표: 행/열 머리를 누르면 그 줄 전체 복사' },
    { icon: '', label: '탭 더블클릭 = 이름 변경, 우클릭 = 메뉴' },
    { icon: '', label: '탭의 ✕ 또는 가운데 버튼 = 탭 닫기' },
    { sep: true },
    { hd: '일반 글(txt) 탭' },
    { icon: '', label: '＋ 탭 → 빈 글 / 텍스트 파일 열기' },
    { icon: '', label: 'Alt+C = 열 편집 모드 켜기/끄기 (또는 Alt+드래그)' },
    { icon: '', label: '세로로 잡은 뒤 [열] 메뉴 = 채우기 · 숫자 넣기 · 합계' },
    { icon: '', label: '글 칸에서 Ctrl+F 또는 [찾기] 버튼 = 그 글에서 찾기' },
    { icon: '', label: 'Ctrl+Shift+F = 폴더 전체에서 찾기 (파일 내에서 찾기)' },
    { icon: '', label: '열 편집 중 입력·Backspace·Ctrl+C/X/V 가 모두 먹습니다' },
    { icon: '', label: 'Ctrl+S = 파일로 저장, Ctrl+Z / Ctrl+Y = 되돌리기' },
    { icon: '', label: '왼쪽 테두리를 드래그하면 폭이 바뀝니다' },
    { sep: true },
    { sep: true },
    {
      icon: 'ⓘ', label: '짱디터 정보', tag: 'v' + (cfg.version || '') + ' · 무료',
      onClick: openAbout
    }
  ];
}

function mainMenu(x, y) {
  const tab = activeTab();
  openPopup([
    { hd: '현재 탭: ' + (tab ? tab.name : '-') },
    { icon: '⬆', label: '현재 탭 내보내기 (.jjt)', onClick: () => exportTab(ws.activeTabId) },
    { icon: '⬇', label: '파일 불러오기 (.jjt / .jjw)', onClick: importFiles },
    { icon: '🗂', label: '전체 내보내기 (.jjw)', onClick: exportAll },
    { sep: true },
    { icon: '📄', label: '텍스트(.md)로 저장', onClick: async () => {
        busy = true;
        const r = await window.jj.exportText(tab.name, tabToMarkdown(tab));
        busy = false;
        if (r && r.ok) toast('저장 완료: ' + r.path);
      } },
    { icon: '⧉', label: '현재 탭 전체 복사', onClick: () => copyText(tabToMarkdown(tab)) },
    { sep: true },
    { icon: '🔁', label: '찾기 / 바꾸기…', tag: 'Ctrl+H', onClick: () => openFindDlg('repl') },
    { icon: '🗂', label: '모든 탭에서 바꾸기…', tag: '항목·탭 이름까지', onClick: () => openReplace(window.innerWidth - 24, 60) },
    { sep: true },
    { icon: '↺', label: '체크 모두 해제', onClick: async () => {
        busy = true;
        const ok = await window.jj.confirm('현재 탭의 체크를 모두 해제할까요?', tab.name, '해제');
        busy = false;
        if (!ok) return;
        tab.rows.forEach((r) => { r.done = false; });
        rerender(); saveNow(); toast('체크를 모두 해제했습니다');
      } },
    { icon: '⧉', label: '새 서버용으로 복제', tag: '체크 해제', onClick: () => {
        const nt = normTab({ name: uniqueName(tab.name), rows: tab.rows.map((r) => normRow(Object.assign({}, r, { id: null, done: false }))) });
        addTab(nt);
        toast('복제했습니다');
      } },
    { sep: true },
    { hd: '보기' },
    { icon: ws.ui.showCurrent ? '☑' : '☐', label: '현재값 입력란 표시', onClick: () => { ws.ui.showCurrent = !ws.ui.showCurrent; rerender(); saveNow(); } },
    { icon: ws.ui.showKey === true ? '☑' : '☐', label: '변수 키 입력란 항상 표시', onClick: () => { ws.ui.showKey = ws.ui.showKey === true ? 'auto' : true; rerender(); saveNow(); } },
    { icon: '🎨', label: '테마 전환', tag: cfg.theme === 'dark' ? '다크' : '라이트', onClick: () => {
        const t = cfg.theme === 'dark' ? 'light' : 'dark';
        window.jj.setPrefs({ theme: t });
      } },
    { icon: '⏱', label: '자동 숨김 지연', tag: (cfg.hideDelay / 1000).toFixed(1) + '초', onClick: () => {
        const next = cfg.hideDelay >= 1500 ? 300 : cfg.hideDelay + 400;
        window.jj.setPrefs({ hideDelay: next });
        toast('자동 숨김 지연: ' + (next / 1000).toFixed(1) + '초');
      } },
    { sep: true },
    { icon: '📌', label: cfg.pinned ? '고정 해제 (자동 숨김)' : '우측에 고정', onClick: () => window.jj.setPinned(!cfg.pinned) },
    { icon: '🖥', label: '다음 모니터로 이동', tag: '제목줄을 끌어도 됨', onClick: async () => {
        const r = await window.jj.nextDisplay();
        toast(r && r.count > 1 ? r.name + ' 로 이동' : '모니터가 1대뿐입니다');
      } },
    { icon: '⟳', label: '업데이트 확인', onClick: () => { toast('확인 중…'); window.jj.checkUpdate(); } },
    { icon: '⚙', label: '업데이트 설정…', onClick: () => updateSettings(window.innerWidth - 24, 60) },
    { icon: '⚡', label: '자원 절약 모드', tag: cfg.lowResource === false ? '끔' : '켬', onClick: async () => {
        const next = !(cfg.lowResource !== false);
        cfg.lowResource = next;
        await window.jj.setPrefs({ lowResource: next });
        toast('자원 절약 모드 ' + (next ? '켬' : '끔') + ' — 다시 시작하면 적용됩니다');
      } },
    { sep: true },
    { icon: '📁', label: '데이터 폴더 열기', onClick: () => window.jj.openDataDir() },
    { icon: '⌨', label: '단축키 보기', onClick: () => helpMenu() },
    { sep: true },
    { icon: '✕', label: '짱디터 종료', danger: true, onClick: () => window.jj.quit() }
  ], x, y);
}

function helpMenu() {
  openPopup(helpItems(), window.innerWidth - 20, 40);
}

function helpMenuOld() {
  openPopup([
    { hd: '단축키' },
    { icon: '', label: 'Alt+Shift+J : 패널 열기/닫기 (전역)' },
    { icon: '', label: 'Ctrl+N : 항목 추가' },
    { icon: '', label: 'Ctrl+Shift+N : 섹션 추가' },
    { icon: '', label: 'Ctrl+K : 명령어 추가' },
    { icon: '', label: 'Ctrl+T : 표 추가' },
    { icon: '', label: 'Ctrl+M : 텍스트(메모) 추가' },
    { icon: '', label: 'Shift+F3 : 이전 찾기 · 낱말을 고르고 F3 이면 그 말로 찾기' },
    { icon: '', label: 'Ctrl+D : 작업 화면 ↔ 설정 화면' },
    { icon: '', label: 'Ctrl+F : 찾기 · Ctrl+H : 바꾸기 · F3 : 다음 찾기' },
    { icon: '', label: 'Ctrl+Tab : 다음 탭' },
    { icon: '', label: 'Ctrl+E : 현재 탭 내보내기' },
    { sep: true },
    { hd: '팁' },
    { icon: '', label: '명령어에 {{키}} 를 쓰면 항목 값이 들어갑니다' },
    { icon: '', label: '줄을 우클릭하면 삭제·이동·칸 켜고 끄기 메뉴가 나옵니다' },
    { icon: '', label: '표: 셀 더블클릭 = 복사, 우클릭 = 행/열 메뉴' },
    { icon: '', label: '표: 칸에서 Ctrl+V = 표를 칸칸이 나눠 넣기 (탭·마크다운·CSV)' },
    { icon: '', label: '표: 행/열 머리를 누르면 그 줄 전체 복사' },
    { icon: '', label: '탭 더블클릭 = 이름 변경, 우클릭 = 메뉴' },
    { icon: '', label: '탭의 ✕ 또는 가운데 버튼 = 탭 닫기' },
    { sep: true },
    { hd: '일반 글(txt) 탭' },
    { icon: '', label: '＋ 탭 → 빈 글 / 텍스트 파일 열기' },
    { icon: '', label: 'Alt+C = 열 편집 모드 켜기/끄기 (또는 Alt+드래그)' },
    { icon: '', label: '세로로 잡은 뒤 [열] 메뉴 = 채우기 · 숫자 넣기 · 합계' },
    { icon: '', label: '글 칸에서 Ctrl+F 또는 [찾기] 버튼 = 그 글에서 찾기' },
    { icon: '', label: 'Ctrl+Shift+F = 폴더 전체에서 찾기 (파일 내에서 찾기)' },
    { icon: '', label: '열 편집 중 입력·Backspace·Ctrl+C/X/V 가 모두 먹습니다' },
    { icon: '', label: 'Ctrl+S = 파일로 저장, Ctrl+Z / Ctrl+Y = 되돌리기' },
    { icon: '', label: '왼쪽 테두리를 드래그하면 폭이 바뀝니다' }
  ], window.innerWidth - 20, 40);
}

/* 내 템플릿 : %APPDATA%\JJangditer\templates 의 .jjt 파일들.
 * 회사 내부 값이 든 템플릿은 프로그램에 넣지 않고 여기에 둔다. */
let myTplCache = null;

async function loadMyTemplates() {
  try {
    const r = await window.jj.myTemplates();
    myTplCache = (r && r.ok) ? r : { items: [], dir: '' };
  } catch (e) {
    myTplCache = { items: [], dir: '' };
  }
  return myTplCache;
}

/** 내 템플릿 파일을 탭으로 연다 */
async function openMyTemplate(path, name) {
  const r = await window.jj.readTemplate(path);
  if (!r || !r.ok) { toast('템플릿을 읽지 못했습니다'); return; }
  let data;
  try { data = JSON.parse(r.json); } catch (e) { toast('템플릿 형식이 아닙니다'); return; }
  const src = (data && data.tab) ? data.tab : data;
  if (!src || !Array.isArray(src.rows)) { toast('템플릿 형식이 아닙니다'); return; }
  const t = normTab({ name: uniqueName(src.name || name), rows: src.rows });
  addTab(t);
  pushRecent('template', name, path);
}

/** 지금 탭을 내 템플릿으로 저장 */
async function saveTabAsTemplate() {
  const tab = activeTab();
  if (!tab) return;
  const r = await window.jj.saveTemplate(tab.name, JSON.stringify(tabPayload(tab), null, 2));
  if (r && r.ok) {
    myTplCache = null;
    toast('내 템플릿으로 저장했습니다: ' + tab.name);
  } else {
    toast((r && r.error) || '저장하지 못했습니다');
  }
}

function templateItems() {
  const items = [];

  // 내 템플릿 먼저
  const mine = (myTplCache && myTplCache.items) || [];
  if (mine.length) {
    items.push({ hd: '내 템플릿' });
    for (const m of mine) {
      items.push({
        icon: '\u2b50', label: m.name, tag: m.rows ? (m.rows + '행') : '',
        onClick: () => openMyTemplate(m.path, m.name)
      });
    }
    items.push({ sep: true });
  }

  items.push({ hd: '기본 템플릿' });
  for (const tpl of (window.JJ_TEMPLATES || [])) {
    items.push({
      icon: '\ud83d\udccb', label: tpl.name,
      onClick: () => {
        const t = tabFromTemplate(tpl.id);
        t.name = uniqueName(t.name);
        addTab(t);
        pushRecent('template', tpl.name, tpl.id);
      }
    });
  }

  items.push({ sep: true });
  items.push({
    icon: '\u2b50', label: '지금 탭을 내 템플릿으로 저장', onClick: saveTabAsTemplate
  });
  items.push({
    icon: '\ud83d\udcc1', label: '내 템플릿 폴더 열기',
    tag: '.jjt 를 넣으면 목록에 나옵니다',
    onClick: async () => { await window.jj.openTemplateDir(); myTplCache = null; }
  });
  return items;
}

async function addTabMenu(x, y) {
  await loadMyTemplates();
  openPopup([
    {
      icon: '\uff0b', label: '새로 만들기', tag: '빈 탭',
      onClick: () => addTab(normTab({ name: uniqueName('새 작업'), rows: [normRow({ type: 'item' })] }))
    },
    { icon: '\ud83d\udcc2', label: '열기…', tag: 'txt · jjt · jjw', onClick: openAnyFile },
    { sep: true },
    { label: '템플릿', icon: '\ud83d\udccb', sub: templateItems },
    { label: '최근 항목', icon: '\u23f1', sub: recentItems }
  ], x, y);
}

/** 어떤 파일이든 알아서 연다 (글 파일이면 글 탭, 짱디터 파일이면 탭으로) */
async function openAnyFile() {
  openPopup([
    { hd: '무엇을 열까요?' },
    { icon: '\ud83d\udcc2', label: '텍스트 파일', tag: '.txt .log .conf', onClick: openTextFile },
    { icon: '\u2b07', label: '짱디터 파일', tag: '.jjt .jjw', onClick: importFiles }
  ], window.innerWidth - 24, 70);
}

function tabMenu(id, x, y) {
  const tab = ws.tabs.find((t) => t.id === id);
  if (!tab) return;

  // 이 탭이 파일과 연결돼 있는지 / 저장 안 한 내용이 있는지
  const files = fileRowsOf(tab);
  const dirty = unsavedFileRows(tab);
  const saveTag = dirty.length ? '● 변경됨' : (files.length ? '저장됨' : '파일 없음');
  // 파일을 연 탭이면 '닫기' (파일은 그대로 남는다), 아니면 '삭제'
  const closeLabel = files.length ? '탭 닫기' : '탭 삭제';

  openPopup([
    { hd: tab.name },
    { icon: '✎', label: '이름 변경', onClick: () => renameTabInline(id) },
    { icon: '⧉', label: '복제', onClick: () => {
        const nt = normTab({ name: uniqueName(tab.name), rows: tab.rows.map((r) => normRow(Object.assign({}, r, { id: null }))) });
        addTab(nt);
      } },
    { icon: '⧉', label: '복제 (체크 해제)', onClick: () => {
        const nt = normTab({ name: uniqueName(tab.name), rows: tab.rows.map((r) => normRow(Object.assign({}, r, { id: null, done: false }))) });
        addTab(nt);
      } },
    { sep: true },
    {
      icon: '💾', label: '파일 저장', tag: saveTag,
      onClick: () => saveTabFile(id, false)
    },
    {
      icon: '📝', label: '다른 이름으로 저장…', tag: 'Ctrl+Shift+S',
      onClick: () => saveTabFile(id, true)
    },
    { sep: true },
    { icon: '⬆', label: '이 탭 내보내기 (.jjt)', onClick: () => exportTab(id) },
    { icon: '⧉', label: '텍스트로 복사', onClick: () => copyText(tabToMarkdown(tab)) },
    { sep: true },
    { icon: '←', label: '왼쪽으로 이동', onClick: () => {
        const i = ws.tabs.findIndex((t) => t.id === id);
        if (i > 0) { const t = ws.tabs.splice(i, 1)[0]; ws.tabs.splice(i - 1, 0, t); render(); saveNow(); }
      } },
    { icon: '→', label: '오른쪽으로 이동', onClick: () => {
        const i = ws.tabs.findIndex((t) => t.id === id);
        if (i >= 0 && i < ws.tabs.length - 1) { const t = ws.tabs.splice(i, 1)[0]; ws.tabs.splice(i + 1, 0, t); render(); saveNow(); }
      } },
    { sep: true },
    {
      icon: '✕', label: closeLabel, danger: true,
      tag: files.length ? '파일은 남습니다' : '',
      onClick: () => deleteTab(id)
    }
  ], x, y);
}

/* ================= 줄 메뉴 (우클릭) ================= */
const TYPE_NAME = { section: '섹션', item: '항목', cmd: '명령', text: '글', table: '표' };

function deleteRow(id, ask) {
  const tab = activeTab();
  const i = tab.rows.findIndex((r) => r.id === id);
  if (i < 0) return;
  const b = blockOf(tab.rows, i);
  const n = b[1] - b[0] + 1;
  const go = () => {
    tab.rows.splice(b[0], n);
    rerender();
    scheduleSave();
    toast(n > 1 ? (n + '줄을 지웠습니다') : '한 줄을 지웠습니다');
  };
  if (ask && n > 1) {
    window.jj.confirm('섹션과 그 안의 ' + (n - 1) + '줄을 함께 지울까요?', '', '삭제').then((ok) => { if (ok) go(); });
    return;
  }
  go();
}

/** 이 블록이 패널을 가득 채우려면 몇 px 이어야 하는지 (제목줄·버튼 높이를 빼고 계산) */
/**
 * 이 블록이 패널을 꽉 채우려면 글 칸이 몇 px 이어야 하는지.
 * 패널 안쪽 여백, 블록 머리말·꼬리말·테두리·바깥 여백을 모두 빼고 계산한다.
 */
function fullHeightFor(ta) {
  const host = $('#rows');
  if (!host) return 600;
  const hs = getComputedStyle(host);
  let avail = host.clientHeight
    - (parseFloat(hs.paddingTop) || 0)
    - (parseFloat(hs.paddingBottom) || 0);

  const rowEl = ta && ta.closest ? ta.closest('.row') : null;
  if (rowEl) {
    const rs = getComputedStyle(rowEl);
    // 머리말 + 꼬리말 + 테두리 = 블록 전체 높이 - 글 칸 높이
    avail -= rowEl.getBoundingClientRect().height - ta.getBoundingClientRect().height;
    avail -= (parseFloat(rs.marginTop) || 0) + (parseFloat(rs.marginBottom) || 0);
  } else {
    avail -= 110;
  }
  return Math.max(120, Math.round(avail));
}

function heightItems(row) {
  const set = (h) => { row.height = h; row.fit = false; rerender(); scheduleSave(); };
  const mark = (h) => (!row.fit && row.height === h ? '●' : '○');
  return [
    { icon: (!row.fit && !row.height) ? '●' : '○', label: '자동 (내용에 맞춤)', onClick: () => set(null) },
    { sep: true },
    { icon: mark(160), label: '작게', tag: '160px', onClick: () => set(160) },
    { icon: mark(320), label: '보통', tag: '320px', onClick: () => set(320) },
    { icon: mark(560), label: '크게', tag: '560px', onClick: () => set(560) },
    { icon: mark(900), label: '아주 크게', tag: '900px', onClick: () => set(900) },
    { sep: true },
    {
      icon: row.fit ? '●' : '⤢', label: '패널 높이에 맞추기', tag: '모니터 바뀌어도 자동',
      onClick: () => { row.fit = true; row.height = null; rerender(); scheduleSave(); }
    },
    { sep: true },
    { icon: '', label: '모서리를 끌어서도 조절됩니다' }
  ];
}

/* ================= 글 칸 편집 메뉴 (오른쪽 버튼) ================= */

/** 글 칸에 글을 끼워 넣고 커서를 그 뒤로 보낸다 */
function insertAt(ta, text) {
  const a = ta.selectionStart, b = ta.selectionEnd;
  ta.value = ta.value.slice(0, a) + text + ta.value.slice(b);
  const at = a + text.length;
  ta.setSelectionRange(at, at);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
}

function textMenu(ta, x, y, forceRow, forceField) {
  const inZoom = !!forceRow;
  let row = forceRow;
  if (!row) {
    const holder = ta.closest('[data-id]');
    row = holder && rowById(holder.dataset.id);
  }
  if (!row) return;
  const field = forceField || (ta.dataset.field === 'cmd' ? 'cmd' : 'text');

  const selText = ta.value.slice(ta.selectionStart, ta.selectionEnd);
  const hasSel = selText.length > 0;
  const hasRect = window.JJDoc.hasRect && window.JJDoc.hasRect();
  const colOn = window.JJDoc.isColMode && window.JJDoc.isColMode();

  const items = [];
  items.push({ hd: (row.label || '글') + (hasRect ? '  —  열 선택 중' : '') });

  if (hasRect) {
    const n = window.JJDoc.rectTexts().length;
    items.push({
      icon: '⧉', label: '열 복사', tag: n + '줄',
      onClick: () => { window.JJDoc.copyRect(); }
    });
    items.push({
      icon: '✂', label: '열 잘라내기', tag: n + '줄',
      onClick: () => { window.JJDoc.cutRect(); }
    });
    items.push({
      icon: '📋', label: '열에 붙여넣기', tag: 'Ctrl+V',
      onClick: async () => {
        const t = await window.jj.paste();
        if (t) window.JJDoc.pasteRect(t);
      }
    });
    items.push({ sep: true });
  }

  items.push({
    icon: '✂', label: '잘라내기', tag: 'Ctrl+X',
    onClick: () => {
      if (!hasSel) { toast('선택한 글자가 없습니다'); return; }
      window.jj.copy(selText);
      insertAt(ta, '');
      toast('잘라냈습니다');
    }
  });
  items.push({
    icon: '⧉', label: '복사', tag: 'Ctrl+C',
    onClick: () => {
      if (hasSel) { copyText(selText); return; }
      copyText(ta.value);
      toast('이 칸 전체를 복사했습니다');
    }
  });
  items.push({
    icon: '📋', label: '붙여넣기', tag: 'Ctrl+V',
    onClick: async () => {
      const t = await window.jj.paste();
      if (!t) { toast('클립보드가 비어 있습니다'); return; }
      insertAt(ta, t);
    }
  });
  items.push({
    icon: '▭', label: '모두 선택', tag: 'Ctrl+A',
    onClick: () => { ta.focus(); ta.setSelectionRange(0, ta.value.length); }
  });

  items.push({ sep: true });
  items.push({
    icon: colOn ? '●' : '▥', label: '열 편집 켜기 / 끄기', tag: 'Alt+C',
    onClick: () => { ta.focus(); bindDocTo(ta); window.JJDoc.setColMode(!colOn); }
  });
  if (inZoom) {
    items.push({
      icon: '🔎', label: '찾기 / 바꾸기', tag: 'Ctrl+F',
      onClick: () => window.JJDoc.openFind(false)
    });
    items.push({
      icon: '≡', label: '줄 도구', tag: '정렬 · 중복 제거',
      onClick: () => {
        const b = document.querySelector('#zoom .ltools');
        if (b) b.click();
      }
    });
    items.push({ sep: true });
    items.push({
      icon: '↩', label: '되돌리기', tag: 'Ctrl+Z',
      onClick: () => { ta.focus(); window.JJDoc.undo(); }
    });
  } else {
    items.push({
      icon: '🔎', label: '이 글에서 찾기', tag: 'Ctrl+F',
      onClick: () => openZoomFind(row.id, field)
    });
    items.push({
      icon: '⤢', label: '편집기로 열기', tag: '줄 도구 · 바꾸기',
      onClick: () => openZoom(row.id, field, row.label)
    });
    items.push({ sep: true });
    items.push({
      icon: '⋯', label: '이 줄 메뉴', tag: '이동 · 높이 · 삭제',
      onClick: () => rowMenu(row, x, y)
    });
  }

  openPopup(items, x, y);
}

function rowMenu(row, x, y) {
  const tab = activeTab();
  const after = () => { rerender(); scheduleSave(); };
  const items = [{ hd: (TYPE_NAME[row.type] || '줄') + (row.label ? ' — ' + row.label : '') }];

  if (row.type === 'item') {
    items.push({
      icon: (ws.ui.showCurrent && !row.hideCurrent) ? '☑' : '☐', label: '현재값 칸 쓰기',
      onClick: () => {
        if (!ws.ui.showCurrent) { ws.ui.showCurrent = true; row.hideCurrent = false; }
        else row.hideCurrent = !row.hideCurrent;
        after();
      }
    });
    items.push({
      icon: row.showNote ? '☑' : '☐', label: '메모 칸 쓰기',
      onClick: () => { row.showNote = !row.showNote; if (!row.showNote) row.note = ''; after(); }
    });
    items.push({
      icon: (ws.ui.showKey === true || row.key) ? '☑' : '☐', label: '변수 키 쓰기',
      tag: row.key || '', onClick: () => {
        if (row.key) { row.key = ''; after(); }
        else { ws.ui.showKey = true; after(); }
      }
    });
    items.push({ sep: true });
  }

  if (row.type === 'text' || row.type === 'cmd') {
    items.push({
      icon: '⤢', label: '편집기로 열기', tag: '열 편집 · 줌 도구',
      onClick: () => openZoom(row.id, row.type === 'text' ? 'text' : 'cmd', row.label)
    });
    items.push({
      icon: '🔎', label: '이 글에서 찾기', tag: 'Ctrl+F',
      onClick: () => openZoomFind(row.id, row.type === 'text' ? 'text' : 'cmd')
    });
    items.push({
      icon: '▥', label: '열 편집 켜기 / 끄기', tag: 'Alt+C',
      onClick: () => toggleColHere(row.id, row.type === 'text' ? 'text' : 'cmd')
    });
    items.push({
      icon: '↕', label: '높이', tag: row.height ? row.height + 'px' : '자동',
      sub: () => heightItems(row)
    });
    items.push({ sep: true });
  }

  if (row.type !== 'section') {
    items.push({
      icon: row.done ? '☑' : '☐', label: '완료 표시',
      onClick: () => { row.done = !row.done; after(); }
    });
    items.push({ sep: true });
  }

  items.push({ icon: '▲', label: '위로 이동', onClick: () => { moveUp(tab, row.id); after(); } });
  items.push({ icon: '▼', label: '아래로 이동', onClick: () => { moveDown(tab, row.id); after(); } });
  items.push({ icon: '⧉', label: '복제', onClick: () => { dupRow(tab, row.id); after(); } });
  items.push({ sep: true });
  items.push({ hd: '아래에 끼워 넣기' });
  items.push({ icon: '☐', label: '항목', onClick: () => addRow('item', row.id) });
  items.push({ icon: '＞', label: '명령', onClick: () => addRow('cmd', row.id) });
  items.push({ icon: '✎', label: '글', onClick: () => addRow('text', row.id) });
  items.push({ icon: '§', label: '섹션', onClick: () => addRow('section', row.id) });
  items.push({ sep: true });
  items.push({
    icon: '✕',
    label: row.type === 'section' ? '섹션 삭제 (안의 줄까지)' : '이 줄 삭제',
    danger: true,
    onClick: () => deleteRow(row.id, row.type === 'section')
  });

  openPopup(items, x, y);
}

/* ================= 크게 열어 편집 ================= */
let zoomCtx = null;

/** 글·명령 블록을 전체 편집기로 연다 (열 편집 · 찾기 · 줄 도구) */
function openZoom(rowId, field, title) {
  const row = rowById(rowId);
  if (!row) return;
  zoomCtx = { id: rowId, field: field };

  // 편집기에서 글이 바뀔 때마다 바로 반영된다
  window.JJDocSink = function (text) {
    const r = rowById(zoomCtx ? zoomCtx.id : null);
    if (!r) return;
    r[zoomCtx.field] = text;
    scheduleSave();
  };

  const z = $('#zoom');
  updateZoomHead(row);
  z.classList.remove('hidden');
  window.JJDoc.bind(document.getElementById('zoom'), null);
  window.JJDoc.load(row[field] || '');
  applyPastEnd();                      // 편집기에도 끝 여백을 넣는다
  setTimeout(() => { window.JJDoc.focus(); applyPastEnd(); }, 20);
}

/** 편집(열 편집) 기능을 이 글 칸에 붙인다 */
function bindDocTo(ta) {
  const wrap = ta.closest('.docwrap');
  const holder = ta.closest('[data-id]');
  if (!wrap || !holder) return null;
  const row = rowById(holder.dataset.id);
  if (!row) return null;
  const field = ta.dataset.field === 'cmd' ? 'cmd' : 'text';
  window.JJDoc.bind(wrap, (text) => {
    row[field] = text;
    scheduleSave();
  });
  return row;
}

/** 지금 글 칸에서 열 편집을 켜고 끈다 (블록 안에서 그대로) */
function toggleColHere(rowId, field) {
  const sel = '#rows .row[data-id="' + rowId + '"] textarea.' + (field === 'cmd' ? 'code' : 'memo');
  const ta = document.querySelector(sel);
  if (!ta) return false;
  ta.focus();
  bindDocTo(ta);
  window.JJDoc.setColMode(!window.JJDoc.isColMode());
  return true;
}

/** 전체 편집기를 열면서 열 편집 모드까지 켠다 */
function openZoomCol(rowId, field) {
  openZoom(rowId, field);
  setTimeout(() => {
    window.JJDoc.setColMode(true);
    window.JJDoc.focus();
  }, 60);
}

/** 전체 편집기를 열면서 바로 찾기 줄까지 연다 */
function openZoomFind(rowId, field) {
  openZoom(rowId, field);
  setTimeout(() => window.JJDoc.openFind(false), 60);
}

/** 지금 탭의 글·명령 블록에서 찾기를 연다 */
function findInCurrentText(preferId) {
  const tab = activeTab();
  if (!tab) return false;
  let row = preferId ? tab.rows.find((r) => r.id === preferId) : null;
  if (!row) row = tab.rows.find((r) => r.type === 'text') || tab.rows.find((r) => r.type === 'cmd');
  if (!row) return false;
  openZoomFind(row.id, row.type === 'text' ? 'text' : 'cmd');
  return true;
}

/* ================= 파일 내에서 찾기 (폴더 전체) ================= */
function openFindInFiles(x, y) {
  const m = $('#menu');
  m.innerHTML = '';
  const hd = document.createElement('div');
  hd.className = 'hd';
  hd.textContent = '파일 내에서 찾기';
  m.appendChild(hd);

  const f = document.createElement('div');
  f.className = 'setform fif';
  f.innerHTML =
    '<label>찾기</label>' +
    '<input type="text" class="q" placeholder="찾을 내용" spellcheck="false">' +
    '<label>파일 형식</label>' +
    '<input type="text" class="pat" placeholder="*.txt" spellcheck="false">' +
    '<label>디렉토리</label>' +
    '<div class="rowline">' +
      '<input type="text" class="dir" placeholder="D:\\폴더" spellcheck="false">' +
      '<button class="browse" title="폴더 찾아보기">\u2026</button>' +
    '</div>' +
    '<label class="chkline"><input type="checkbox" class="sub" checked> 하위 폴더까지 찾기</label>' +
    '<label class="chkline"><input type="checkbox" class="cs"> 대/소문자 구분</label>' +
    '<div class="hintline">찾은 결과가 새 탭에 정리되어 열립니다.<br>' +
      '찾은 줄을 클릭하면 그 파일 그 줄로 바로 갑니다.</div>' +
    '<div class="btnline"><button class="cancel">취소</button><button class="go prim">찾기</button></div>';
  m.appendChild(f);

  const qi = $('.q', f), pi = $('.pat', f), di = $('.dir', f);
  qi.value = ws.fif && ws.fif.query ? ws.fif.query : '';
  pi.value = (ws.fif && ws.fif.pattern) || '*.txt';
  di.value = (ws.fif && ws.fif.dir) || guessDir();
  if (ws.fif) {
    $('.sub', f).checked = ws.fif.sub !== false;
    $('.cs', f).checked = !!ws.fif.cs;
  }

  $('.browse', f).addEventListener('click', async () => {
    busy = true;
    const d = await window.jj.browseFolder('찾을 폴더 선택', di.value);
    busy = false;
    if (d) di.value = d;
  });
  $('.cancel', f).addEventListener('click', () => closePopup());
  $('.go', f).addEventListener('click', () => {
    const opt = {
      query: qi.value, pattern: pi.value || '*.txt', dir: di.value,
      sub: $('.sub', f).checked, cs: $('.cs', f).checked
    };
    ws.fif = opt;
    scheduleSave();
    closePopup();
    runFindInFiles(opt);
  });
  f.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('.go', f).click(); }
  });

  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 6)) + 'px';
  m.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 6)) + 'px';
  popupOpen = true;
  setTimeout(() => qi.focus(), 30);
}

/** 지금 탭에 열린 파일이 있으면 그 폴더를 기본값으로 */
function guessDir() {
  const tab = activeTab();
  if (tab) {
    for (const r of tab.rows) {
      if (r.filePath) {
        const i = Math.max(r.filePath.lastIndexOf('\\'), r.filePath.lastIndexOf('/'));
        if (i > 0) return r.filePath.slice(0, i);
      }
    }
  }
  return '';
}

function showProgress(text) {
  const el = $('#prog');
  $('.ptext', el).textContent = text;
  el.classList.remove('hidden');
}
function hideProgress() { $('#prog').classList.add('hidden'); }

async function runFindInFiles(opt) {
  showProgress('찾는 중… ' + opt.dir);
  busy = true;
  const r = await window.jj.findInFiles(opt);
  busy = false;
  hideProgress();
  if (!r || !r.ok) { toast((r && r.error) || '찾지 못했습니다'); return; }

  const head = [
    '찾기 : "' + opt.query + '"',
    '폴더 : ' + opt.dir + (opt.sub ? '  (하위 폴더 포함)' : ''),
    '형식 : ' + opt.pattern + (opt.cs ? '   대/소문자 구분' : ''),
    ''
  ];
  if (!r.items.length) {
    head.push('찾은 내용이 없습니다. (' + r.scanned + '개 파일을 살펴봤습니다)');
  } else {
    let last = null;
    for (const it of r.items) {
      if (it.file !== last) { if (last) head.push(''); head.push(it.file); last = it.file; }
      head.push('  ' + String(it.line).padStart(6, ' ') + ' : ' + it.text);
    }
    head.push('');
    head.push('파일 ' + r.files + '개에서 ' + r.hits + '곳을 찾았습니다.' +
      (r.truncated ? '  (너무 많아 일부만 표시)' : ''));
  }

  const row = normRow({
    type: 'text', label: '찾기 결과 — ' + opt.query, text: head.join('\n'),
    results: {
      query: opt.query, dir: opt.dir, pattern: opt.pattern, sub: opt.sub, cs: opt.cs,
      files: r.files, hits: r.hits, scanned: r.scanned, truncated: r.truncated, items: r.items
    }
  });
  const t = normTab({ name: uniqueName('찾기: ' + opt.query), rows: [row] });
  addTab(t);
  fitRowToPanel(row.id);
  toast(r.hits ? ('파일 ' + r.files + '개 / ' + r.hits + '곳') : '찾은 내용이 없습니다');
}

function closeZoom() {
  if (zoomCtx) {
    const row = rowById(zoomCtx.id);
    if (row) row[zoomCtx.field] = window.JJDoc.text();
  }
  zoomCtx = null;
  window.JJDocSink = null;
  window.JJDoc.setColMode(false);
  $('#zoom').classList.add('hidden');
  rerender();
  saveNow();
}

function updateZoomHead(row) {
  const z = $('#zoom');
  $('.ztitle', z).textContent =
    (row.label || '글') + (row.filePath ? '  —  ' + row.filePath : '');
  $('.zfile', z).textContent = row.filePath ? '파일 저장' : '파일로 저장…';
  const e = $('.zenc', z);
  if (e) {
    e.textContent = row.encoding || 'UTF-8';
    e.classList.toggle('warn', row.encoding === 'ANSI');
  }
}

/** 글자 인코딩 바꾸기 (다른 프로그램에서 안 깨지게) */
function encMenu(x, y) {
  if (!zoomCtx) return;
  const row = rowById(zoomCtx.id);
  if (!row) return;
  const cur = row.encoding || 'UTF-8';
  const pick = (name) => {
    row.encoding = name;
    updateZoomHead(row);
    scheduleSave();
    toast('저장할 때 ' + name + ' 로 씁니다' + (row.filePath ? ' — [파일 저장] 을 눌러 적용하세요' : ''));
  };
  openPopup([
    { hd: '글자 인코딩' },
    { icon: cur === 'UTF-8' ? '●' : '○', label: 'UTF-8', tag: '요즘 표준', onClick: () => pick('UTF-8') },
    { icon: cur === 'UTF-8 BOM' ? '●' : '○', label: 'UTF-8 BOM', onClick: () => pick('UTF-8 BOM') },
    { icon: cur === 'ANSI' ? '●' : '○', label: 'ANSI (CP949)', tag: '한글 윈도우', onClick: () => pick('ANSI') },
    { icon: cur === 'UTF-16 LE' ? '●' : '○', label: 'UTF-16 LE', onClick: () => pick('UTF-16 LE') },
    { sep: true },
    { icon: '', label: '파일을 열 때 자동으로 알아냅니다' }
  ], x, y);
}

/** 지금 글을 쓰던 자리(어느 칸, 커서 위치, 스크롤)를 적어 둔다 */
function keepCaret() {
  const el = document.activeElement;
  if (!el || !el.closest) return null;
  const ta = el.closest('textarea.memo, textarea.code');
  if (!ta) return null;
  const holder = ta.closest('[data-id]');
  if (!holder) return null;
  return {
    id: holder.dataset.id,
    field: ta.dataset.field || 'text',
    start: ta.selectionStart,
    end: ta.selectionEnd,
    top: ta.scrollTop,
    left: ta.scrollLeft
  };
}

/** 적어 둔 자리로 커서를 되돌린다 */
function restoreCaret(c) {
  if (!c) return;
  const ta = document.querySelector(
    '#rows .row[data-id="' + c.id + '"] textarea[data-field="' + c.field + '"]');
  if (!ta) return;
  ta.focus();
  try { ta.setSelectionRange(c.start, c.end); } catch (e) { /* 무시 */ }
  ta.scrollTop = c.top;
  ta.scrollLeft = c.left;
  if (!zoomCtx) bindDocTo(ta);     // 열 편집 기능도 다시 이 칸에 붙인다
}

/**
 * 지금 저장해야 할 글 블록.
 * 편집기가 열려 있으면 그 블록, 아니면 이 탭의 파일 글 → 보통 글 순서로 고른다.
 */
function currentTextRow() {
  if (zoomCtx) {
    const r = rowById(zoomCtx.id);
    if (r && (r.type === 'text' || r.type === 'cmd')) return r;
  }
  const tab = activeTab();
  if (!tab) return null;
  return tab.rows.find((r) => r.type === 'text' && r.filePath && !r.results)
    || tab.rows.find((r) => r.type === 'text' && !r.results)
    || null;
}

/** 저장 대화상자에 넣을 기본 파일 이름 */
function suggestName(row, tab) {
  if (row.filePath) {
    const base = row.filePath.split(/[\\/]/).pop();
    return base.replace(/\.[^.]+$/, '');
  }
  const t = tab || activeTab();
  return row.label || (t && t.name) || '새 파일';
}

/** 그 탭에서 파일로 열어 둔 글 블록 */
function fileRowsOf(tab) {
  return tab ? tab.rows.filter((r) => r.type === 'text' && r.filePath && !r.results) : [];
}

/** 그 탭에서 저장 대상이 될 글 블록 하나 */
function saveRowOf(tab) {
  const f = fileRowsOf(tab);
  if (f.length) return f[0];
  return tab ? tab.rows.find((r) => r.type === 'text' && !r.results) : null;
}

/**
 * 탭 하나를 파일로 저장한다. 지금 보고 있는 탭이 아니어도 된다.
 * (보고 있는 탭이면 커서를 지켜 주는 기존 흐름을 그대로 쓴다)
 */
async function saveTabFile(id, asNew) {
  const tab = ws.tabs.find((t) => t.id === id);
  if (!tab) return;
  // 저장할 글이 아예 없으면 먼저 알려 준다
  // (Ctrl+S 는 이때 작업공간을 저장하지만, 메뉴의 '파일 저장' 은 그러면 안 된다)
  const row = saveRowOf(tab);
  if (!row) { toast('이 탭에는 저장할 글이 없습니다'); return; }

  if (tab.id === ws.activeTabId && !zoomCtx) { await saveCurrentFile(asNew); return; }

  busy = true;
  const r = await putFile(row, row.text, asNew, suggestName(row, tab));
  busy = false;
  if (!r || !r.ok) return;

  markSaved(row, r, row.text);

  const base = row.filePath.split(/[\\/]/).pop();
  if (asNew || !row.label) {
    row.label = base;
    if (tab.rows.length === 1) tab.name = uniqueName(base, tab.id);
  }
  pushRecent('file', base, row.filePath);
  render();
  scheduleSave();
  updateSaveIcon();
  toast('저장했습니다 (' + row.encoding + '): ' + row.filePath);
}

/**
 * Ctrl+S / Ctrl+Shift+S 가 부르는 저장.
 * asNew 가 true 면 늘 '다른 이름으로 저장' 대화상자를 연다.
 */
async function saveCurrentFile(asNew) {
  if (zoomCtx) { await saveZoomToFile(asNew); return; }

  const row = currentTextRow();
  if (!row) {
    if (asNew) { toast('이 탭에는 저장할 글이 없습니다'); return; }
    saveNow();
    toast('저장했습니다');
    return;
  }

  // 쓰던 자리를 적어 둔다 (저장하고 나서 그대로 이어 쓸 수 있도록)
  const caret = keepCaret();

  busy = true;
  const r = await putFile(row, row.text, asNew, suggestName(row));
  busy = false;
  if (!r || !r.ok) { restoreCaret(caret); return; }

  markSaved(row, r, row.text);

  // 다른 이름으로 저장했으면 블록·탭 이름도 새 파일 이름을 따른다
  const base = row.filePath.split(/[\\/]/).pop();
  let renamed = false;
  if (asNew || !row.label) {
    row.label = base;
    const tab = activeTab();
    if (tab && tab.rows.length === 1) tab.name = uniqueName(base, tab.id);
    renamed = true;
  }
  pushRecent('file', base, row.filePath);

  // 이름이 바뀐 게 아니면 다시 그릴 이유가 없다 (그리면 커서가 풀린다)
  if (renamed) render();
  scheduleSave();
  updateSaveIcon();
  restoreCaret(caret);
  toast('저장했습니다 (' + (row.encoding) + '): ' + row.filePath);
}

/** 지금 편집기에 열린 글을 텍스트 파일로 저장 */
async function saveZoomToFile(asNew) {
  if (!zoomCtx) return;
  const row = rowById(zoomCtx.id);
  if (!row) return;
  const text = window.JJDoc.text();
  // 편집기에서 쓰던 자리도 적어 둔다 (저장 대화상자가 포커스를 가져가므로)
  const dt = document.querySelector('#zoom .doctext');
  const zc = dt ? { start: dt.selectionStart, end: dt.selectionEnd,
                    top: dt.scrollTop, left: dt.scrollLeft } : null;
  const backZ = () => {
    if (!dt || !zc) return;
    dt.focus();
    try { dt.setSelectionRange(zc.start, zc.end); } catch (e) { /* 무시 */ }
    dt.scrollTop = zc.top;
    dt.scrollLeft = zc.left;
  };

  busy = true;
  const r = await putFile(row, text, asNew, row.label || activeTab().name);
  busy = false;
  if (!r || !r.ok) { backZ(); return; }
  markSaved(row, r, text);
  row[zoomCtx.field] = text;

  const base = row.filePath.split(/[\\/]/).pop();
  if (asNew || !row.label) {
    row.label = base;
    const tab = activeTab();
    if (tab && tab.rows.length === 1) tab.name = uniqueName(base, tab.id);
  }
  scheduleSave();
  $('#zoom .zfile').textContent = '파일 저장';
  $('#zoom .ztitle').textContent = (row.label || '글') + '  —  ' + row.filePath;
  pushRecent('file', row.label || '글', row.filePath);
  updateZoomHead(row);
  updateSaveIcon();
  backZ();
  toast('저장했습니다 (' + enc + '): ' + row.filePath);
}

function bindZoom() {
  const z = $('#zoom');
  $('.doctext', z).addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const row = zoomCtx && rowById(zoomCtx.id);
    if (!row) return;
    textMenu(e.currentTarget, e.clientX, e.clientY, row, zoomCtx.field);
  });

  $('.zclose', z).addEventListener('click', () => closeZoom());
  $('.zsave', z).addEventListener('click', () => closeZoom());
  $('.zfile', z).addEventListener('click', (e) => saveZoomToFile(e.shiftKey));
  $('.zfileas', z).addEventListener('click', () => saveZoomToFile(true));
  $('.zenc', z).addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    encMenu(r.left, r.top - 8);
  });
  $('.zcopy', z).addEventListener('click', () => {
    copyText(resolve(window.JJDoc.text(), varsOf(activeTab())));
  });
  $('.doctext', z).addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape' && !ctrl) {
      // 찾기 줄이 열려 있으면 doc.js 가 먼저 처리한다
      if (!z.querySelector('.findwrap').classList.contains('hidden')) return;
      e.preventDefault(); closeZoom();
    } else if (ctrl && e.code === 'KeyS') {
      e.preventDefault(); saveZoomToFile(e.shiftKey);
    } else if (ctrl && e.key === 'Enter') {
      e.preventDefault(); closeZoom();
    }
  });
}

/* ================= 찾아 바꾸기 ================= */
const RFIELDS = ['label', 'current', 'target', 'cmd', 'text', 'note'];

function countIn(str, find, cs) {
  if (!find) return 0;
  const a = cs ? String(str) : String(str).toLowerCase();
  const b = cs ? find : find.toLowerCase();
  let n = 0, i = 0;
  while ((i = a.indexOf(b, i)) >= 0) { n++; i += b.length; }
  return n;
}

function replaceIn(str, find, repl, cs) {
  if (!find) return str;
  if (cs) return String(str).split(find).join(repl);
  let out = '', rest = String(str);
  const low = find.toLowerCase();
  for (;;) {
    const i = rest.toLowerCase().indexOf(low);
    if (i < 0) { out += rest; break; }
    out += rest.slice(0, i) + repl;
    rest = rest.slice(i + find.length);
  }
  return out;
}

function scanTabs(all) { return all ? ws.tabs : [activeTab()]; }

function findCount(find, opt) {
  let n = 0;
  for (const tab of scanTabs(opt.all)) {
    if (opt.tabName) n += countIn(tab.name, find, opt.cs);
    for (const r of tab.rows) {
      for (const f of RFIELDS) n += countIn(r[f] || '', find, opt.cs);
      if (r.cells) for (const rr of r.cells) for (const v of rr) n += countIn(v, find, opt.cs);
    }
  }
  return n;
}

function doReplace(find, repl, opt) {
  let n = 0;
  for (const tab of scanTabs(opt.all)) {
    if (opt.tabName && countIn(tab.name, find, opt.cs)) {
      n += countIn(tab.name, find, opt.cs);
      tab.name = replaceIn(tab.name, find, repl, opt.cs);
    }
    for (const r of tab.rows) {
      for (const f of RFIELDS) {
        const c = countIn(r[f] || '', find, opt.cs);
        if (c) { n += c; r[f] = replaceIn(r[f], find, repl, opt.cs); }
      }
      if (r.cells) {
        for (let i = 0; i < r.cells.length; i++) {
          for (let j = 0; j < r.cells[i].length; j++) {
            const c = countIn(r.cells[i][j], find, opt.cs);
            if (c) { n += c; r.cells[i][j] = replaceIn(r.cells[i][j], find, repl, opt.cs); }
          }
        }
      }
    }
  }
  return n;
}

function openReplace(x, y) {
  const m = $('#menu');
  m.innerHTML = '';
  const hd = document.createElement('div');
  hd.className = 'hd';
  hd.textContent = '찾아 바꾸기';
  m.appendChild(hd);

  const f = document.createElement('div');
  f.className = 'setform';
  f.innerHTML =
    '<label>찾을 내용</label>' +
    '<input type="text" class="rf" placeholder="예: 서울" spellcheck="false">' +
    '<label>바꿀 내용</label>' +
    '<input type="text" class="rt" placeholder="예: 부산" spellcheck="false">' +
    '<label class="chkline"><input type="checkbox" class="rall"> 모든 탭에서 바꾸기</label>' +
    '<label class="chkline"><input type="checkbox" class="rname" checked> 탭 이름도 바꾸기</label>' +
    '<label class="chkline"><input type="checkbox" class="rcs"> 대소문자 구분</label>' +
    '<div class="hintline rcount">찾을 내용을 입력하세요</div>' +
    '<div class="btnline"><button class="rcancel">취소</button><button class="rgo prim">바꾸기</button></div>';
  m.appendChild(f);

  const fi = $('.rf', f), ti = $('.rt', f);
  const opt = () => ({ all: $('.rall', f).checked, tabName: $('.rname', f).checked, cs: $('.rcs', f).checked });
  const refresh = () => {
    const v = fi.value;
    const box = $('.rcount', f);
    if (!v) { box.textContent = '찾을 내용을 입력하세요'; return; }
    const n = findCount(v, opt());
    box.innerHTML = n ? ('<b>' + n + '곳</b> 에서 찾았습니다') : '찾은 내용이 없습니다';
  };
  f.addEventListener('input', refresh);
  f.addEventListener('change', refresh);

  $('.rcancel', f).addEventListener('click', () => closePopup());
  $('.rgo', f).addEventListener('click', () => {
    const v = fi.value;
    if (!v) { toast('찾을 내용을 입력하세요'); return; }
    const n = doReplace(v, ti.value, opt());
    closePopup();
    render();
    saveNow();
    toast(n ? (n + '곳을 바꿨습니다') : '바꿀 내용이 없었습니다');
  });

  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 6)) + 'px';
  m.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 6)) + 'px';
  popupOpen = true;
  setTimeout(() => fi.focus(), 30);
}

/* ================= 업데이트 ================= */
let pendingUpdate = null;

function bindUpdates() {
  const bar = $('#updbar');
  const txt = $('.utext', bar);
  const btn = $('.ubtn', bar);

  $('.uclose', bar).addEventListener('click', () => bar.classList.add('hidden'));
  btn.addEventListener('click', () => {
    if (!pendingUpdate) return;
    btn.disabled = true;
    txt.textContent = '내려받는 중…';
    window.jj.applyUpdate();
  });

  window.jj.onUpdate((kind, d) => {
    aboutOnUpdate(kind, d);          // 정보 창이 열려 있으면 거기에도 알려 준다
    if (kind === 'available') {
      pendingUpdate = d;
      txt.textContent = '새 버전 ' + d.version + ' 이 있습니다' + (d.notes ? ' — ' + d.notes : '');
      btn.disabled = false;
      btn.classList.remove('hidden');
      bar.classList.remove('hidden');
    } else if (kind === 'progress') {
      if (d && d.percent != null) txt.textContent = '내려받는 중… ' + d.percent + '%';
    } else if (kind === 'none') {
      if (!aboutOpen()) toast('이미 최신 버전입니다 (v' + d.version + ')');
    } else if (kind === 'error') {
      if (!aboutOpen()) toast(d.message || '업데이트 확인 실패');
    }
  });
}

/** 업데이트 배포 위치 설정 */
async function updateSettings(x, y) {
  const info = await window.jj.updateInfo();
  const m = $('#menu');
  m.innerHTML = '';

  const hd = document.createElement('div');
  hd.className = 'hd';
  hd.textContent = '업데이트 설정  (현재 v' + info.version + ')';
  m.appendChild(hd);

  const form = document.createElement('div');
  form.className = 'setform';
  form.innerHTML =
    '<label>배포 위치</label>' +
    '<div class="rowline">' +
      '<input type="text" class="url" placeholder="\\\\서버\\공유\\짱디터  또는  https://..." spellcheck="false">' +
      '<button class="browse" title="폴더 찾기">…</button>' +
    '</div>' +
    '<label class="chkline"><input type="checkbox" class="auto"> 시작할 때 / 6시간마다 자동 확인</label>' +
    '<div class="hintline">이 폴더(주소)에 <b>latest.json</b> 과 새 exe 를 올려두면<br>직원들의 짱디터가 자동으로 새 버전을 안내합니다.</div>' +
    '<div class="btnline"><button class="now">지금 확인</button><button class="save prim">저장</button></div>';
  m.appendChild(form);

  const url = $('.url', form);
  const auto = $('.auto', form);
  url.value = info.updateUrl || '';
  auto.checked = !!info.autoUpdate;

  $('.browse', form).addEventListener('click', async () => {
    const d = await window.jj.browseFolder();
    if (d) url.value = d;
  });
  $('.save', form).addEventListener('click', async () => {
    await window.jj.updateConfig({ updateUrl: url.value, autoUpdate: auto.checked });
    closePopup();
    toast('업데이트 설정을 저장했습니다');
  });
  $('.now', form).addEventListener('click', async () => {
    await window.jj.updateConfig({ updateUrl: url.value, autoUpdate: auto.checked });
    closePopup();
    toast('확인 중…');
    window.jj.checkUpdate();
  });

  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 6)) + 'px';
  m.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 6)) + 'px';
  popupOpen = true;
  setTimeout(() => url.focus(), 30);
}

/* ================= 상단 메뉴 바 ================= */
const MENUS = [
  {
    name: '파일',
    items: () => [
      { icon: '＋', label: '새 탭…', onClick: () => addTabMenu(60, 80) },
      { sep: true },
      { icon: '📂', label: '텍스트 파일 열기…', tag: 'Ctrl+O', onClick: openTextFile },
      { icon: '💾', label: '파일 저장', tag: 'Ctrl+S', onClick: () => saveCurrentFile(false) },
      { icon: '📝', label: '다른 이름으로 저장…', tag: 'Ctrl+Shift+S', onClick: () => saveCurrentFile(true) },
      { sep: true },
      { icon: '⬇', label: '짱디터 파일 불러오기', tag: '.jjt .jjw', onClick: importFiles },
      { icon: '⬆', label: '현재 탭 내보내기', tag: 'Ctrl+E', onClick: () => exportTab(ws.activeTabId) },
      { icon: '🗂', label: '전체 내보내기', tag: '.jjw', onClick: exportAll },
      { icon: '📄', label: '텍스트(.md)로 저장', onClick: saveAsText },
      { sep: true },
      { icon: '🗃', label: '작업공간 지금 저장', tag: '탭 전체', onClick: () => { saveNow(); toast('저장했습니다'); } },
      { icon: '📁', label: '데이터 폴더 열기', onClick: () => window.jj.openDataDir() },
      { sep: true },
      { icon: '－', label: '트레이로 숨기기', onClick: () => window.jj.hide() },
      { icon: '✕', label: '종료', danger: true, onClick: () => window.jj.quit() }
    ]
  },
  {
    name: '편집',
    items: () => [
      { icon: '☐', label: '항목 추가', tag: 'Ctrl+N', onClick: () => addRow('item') },
      { icon: '＞', label: '명령 추가', tag: 'Ctrl+K', onClick: () => addRow('cmd') },
      { icon: '✎', label: '글 추가', tag: 'Ctrl+M', onClick: () => addRow('text') },
      { icon: '▦', label: '표 추가', tag: 'Ctrl+T', onClick: () => openTablePicker(60, 120) },
      { icon: '§', label: '섹션 추가', tag: 'Ctrl+Shift+N', onClick: () => addRow('section') },
      { sep: true },
      { icon: '⧉', label: '현재 탭 전체 복사', onClick: () => copyText(tabToMarkdown(activeTab())) },
      { icon: '↺', label: '체크 모두 해제', onClick: clearChecks },
      { icon: '⧉', label: '새 서버용으로 복제', tag: '체크 해제', onClick: duplicateForNew },
      { sep: true },
      { icon: '✎', label: '탭 이름 변경', onClick: () => renameTabInline(ws.activeTabId) },
      { icon: '✕', label: '현재 탭 삭제', danger: true, onClick: () => deleteTab(ws.activeTabId) }
    ]
  },
  {
    name: '찾기',
    items: () => [
      {
        icon: '🔎', label: '글에서 찾기…', tag: 'Ctrl+F',
        onClick: () => { if (!findInCurrentText()) toast('이 탭에 글·명령 블록이 없습니다'); }
      },
      {
        icon: '📁', label: '파일 내에서 찾기…', tag: 'Ctrl+Shift+F',
        onClick: () => openFindInFiles(window.innerWidth - 24, 60)
      },
      {
        icon: '🔁', label: '찾아 바꾸기…', tag: 'Ctrl+H',
        onClick: () => openReplace(60, 120)
      },
      { sep: true },
      {
        icon: ws.ui.filterUndone ? '☑' : '☐', label: '미완료만 보기', tag: 'Ctrl+F',
        onClick: () => $('#btnFilter').click()
      },
      { icon: '▾', label: '다음 할 항목으로', onClick: () => $('#btnNext').click() }
    ]
  },
  { name: '열', items: () => colItems() },
  {
    name: '보기',
    items: () => [
      {
        icon: ws.ui.mode === 'edit' ? '⚙' : '✓',
        label: ws.ui.mode === 'edit' ? '작업 화면으로' : '설정 화면으로',
        tag: 'Ctrl+E 아님 / 상단 버튼',
        onClick: () => $('#btnMode').click()
      },
      { sep: true },
      {
        icon: ws.ui.showCurrent ? '☑' : '☐', label: '현재값 입력란 표시',
        onClick: () => { ws.ui.showCurrent = !ws.ui.showCurrent; rerender(); saveNow(); }
      },
      {
        icon: ws.ui.showKey === true ? '☑' : '☐', label: '변수 키 입력란 항상 표시',
        onClick: () => { ws.ui.showKey = ws.ui.showKey === true ? 'auto' : true; rerender(); saveNow(); }
      },
      {
        icon: '⋯', label: '아이콘 줄 꾸미기…', tag: '넣기 · 빼기 · 자리',
        onClick: () => iconbarSettings()
      },
      {
        icon: ws.ui.pastEnd !== false ? '☑' : '☐', label: '글 끝 뒤로도 스크롤',
        tag: '울트라에디트처럼',
        onClick: () => {
          ws.ui.pastEnd = ws.ui.pastEnd === false;
          rerender(); saveNow();
        }
      },
      { sep: true },
      {
        icon: '🅰', label: '글자체', tag: monoById(ws.ui.mono).label,
        sub: () => fontItems()
      },
      {
        icon: '↕', label: '패널 열리는 자리', tag: zoneLabel(cfg.triggerZone),
        sub: () => zoneItems()
      },
      {
        icon: '🔡', label: '글자 크기', tag: (ws.ui.monoSize || 13) + 'px',
        sub: () => fontSizeItems()
      },
      {
        icon: '≡', label: '줄 간격', tag: lhLabel(ws.ui.monoLh),
        sub: () => lineHeightItems()
      },
      { sep: true },
      {
        icon: '🎨', label: '테마 전환', tag: cfg.theme === 'dark' ? '다크' : '라이트',
        onClick: () => window.jj.setPrefs({ theme: cfg.theme === 'dark' ? 'light' : 'dark' })
      },
      {
        icon: '📌', label: cfg.pinned ? '고정 해제 (자동 숨김)' : '우측에 고정',
        onClick: () => window.jj.setPinned(!cfg.pinned)
      },
      {
        icon: '🖥', label: '다음 모니터로 이동',
        onClick: async () => {
          const r = await window.jj.nextDisplay();
          toast(r && r.count > 1 ? r.name + ' 로 이동' : '모니터가 1대뿐입니다');
        }
      },
      {
        icon: '⏱', label: '자동 숨김 지연', tag: (cfg.hideDelay / 1000).toFixed(1) + '초',
        onClick: () => {
          const next = cfg.hideDelay >= 1500 ? 300 : cfg.hideDelay + 400;
          window.jj.setPrefs({ hideDelay: next });
          toast('자동 숨김 지연: ' + (next / 1000).toFixed(1) + '초');
        }
      }
    ]
  },
  {
    name: '도구',
    items: () => [
      {
        icon: cfg.startup ? '☑' : '☐', label: '윈도우 시작 시 자동 실행',
        tag: '권장', onClick: async () => {
          const on = await window.jj.setStartup(!cfg.startup);
          cfg.startup = on;
          toast(on ? '부팅할 때 자동으로 실행됩니다' : '자동 실행을 껐습니다');
        }
      },
      { sep: true },
      { icon: '⟳', label: '업데이트 확인', onClick: () => { toast('확인 중…'); window.jj.checkUpdate(); } },
      { icon: '⚙', label: '업데이트 설정…', onClick: () => updateSettings(60, 120) },
      { sep: true },
      {
        icon: '⚡', label: '자원 절약 모드', tag: cfg.lowResource === false ? '끔' : '켬',
        onClick: async () => {
          const next = !(cfg.lowResource !== false);
          cfg.lowResource = next;
          await window.jj.setPrefs({ lowResource: next });
          toast('자원 절약 모드 ' + (next ? '켬' : '끔') + ' — 다시 시작하면 적용됩니다');
        }
      }
    ]
  },
  { name: '도움말', items: () => helpItems() }
];

let menuOpenIndex = -1;

function renderMenubar() {
  const bar = $('#menubar');
  bar.innerHTML = '';
  MENUS.forEach((m, i) => {
    const b = document.createElement('button');
    b.className = 'mb';
    b.textContent = m.name;
    b.dataset.i = i;
    bar.appendChild(b);
  });
}

function openMenubarMenu(i) {
  const btn = $('#menubar .mb[data-i="' + i + '"]');
  if (!btn) return;
  const r = btn.getBoundingClientRect();
  menuOpenIndex = i;
  $$('#menubar .mb').forEach((b) => b.classList.toggle('on', +b.dataset.i === i));
  openPopup(MENUS[i].items(), r.left, r.bottom + 2);
}

function bindMenubar() {
  renderMenubar();
  const bar = $('#menubar');
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('.mb');
    if (!b) return;
    const i = +b.dataset.i;
    if (menuOpenIndex === i && popupOpen) { closePopup(); return; }
    openMenubarMenu(i);
  });
  // 메뉴가 열려 있을 때는 다른 메뉴 위로 지나가기만 해도 전환 (일반 메뉴 바처럼)
  bar.addEventListener('mouseover', (e) => {
    if (!popupOpen || menuOpenIndex < 0) return;
    const b = e.target.closest('.mb');
    if (!b || +b.dataset.i === menuOpenIndex) return;
    openMenubarMenu(+b.dataset.i);
  });
}

/* ================= 이벤트 ================= */
function bindRows() {
  const host = $('#rows');

  host.addEventListener('input', (e) => {
    // 표 셀
    if (e.target.classList && e.target.classList.contains('cell')) {
      const holder = e.target.closest('[data-id]');
      const row = holder && rowById(holder.dataset.id);
      if (row && row.cells) {
        row.cells[+e.target.dataset.r][+e.target.dataset.c] = e.target.value;
        scheduleSave();
      }
      return;
    }
    const f = e.target.getAttribute && e.target.getAttribute('data-field');
    if (!f) return;
    const holder = e.target.closest('[data-id]');
    if (!holder) return;
    const row = rowById(holder.dataset.id);
    if (!row) return;
    row[f] = e.target.value;
    updateSaveIcon();                 // 바뀌면 저장 아이콘을 칼라로
    if (e.target.tagName === 'TEXTAREA') autosize(e.target);
    if (f === 'cmd' || f === 'text') {
      const box = holder.querySelector('.resolved');
      if (box) {
        const src = row[f];
        const res = HAS_VAR.test(src) ? resolve(src, varsOf(activeTab())) : '';
        box.textContent = res !== src ? res : '';
      }
    }
    if (f === 'key' || f === 'target' || f === 'current') refreshResolved();
    scheduleSave();
  });

  host.addEventListener('change', (e) => {
    if (!e.target.classList.contains('chk')) return;
    const holder = e.target.closest('[data-id]');
    const row = rowById(holder.dataset.id);
    if (!row) return;
    row.done = e.target.checked;
    rerender();
    scheduleSave();
  });

  // 글·명령 칸을 누르거나 들어가면, 열 편집 기능을 그 칸에 붙인다
  const attachDoc = (e) => {
    const ta = e.target.closest && e.target.closest('textarea.memo, textarea.code');
    if (!ta || zoomCtx) return;
    if (ta.dataset.jjbound !== '1') bindDocTo(ta);
  };
  host.addEventListener('focusin', attachDoc);
  host.addEventListener('mousedown', attachDoc, true);   // 누르는 즉시

  // '전체 보기' 단추
  host.addEventListener('click', (e) => {
    if (!e.target.closest('[data-showall]')) return;
    ws.ui.filterUndone = false;
    $('#btnFilter').classList.remove('on');
    rerender(); saveNow();
  });

  // 빈 탭에서 바로 추가
  host.addEventListener('click', (e) => {
    const b = e.target.closest('[data-new]');
    if (!b) return;
    const kind = b.dataset.new;
    if (kind === 'table') {
      const r = b.getBoundingClientRect();
      openTablePicker(r.left, r.bottom + 4);
    } else {
      addRow(kind);
    }
  });

  // 찾기 결과 : 한 번 클릭으로 그 파일 그 줄 열기
  host.addEventListener('click', (e) => {
    const hit = e.target.closest('.reshit, .resfile');
    if (!hit) return;
    const f = hit.dataset.f;
    if (!f) return;
    const owner = rowById(hit.closest('[data-id]').dataset.id);
    reopenFile(f, f.split(/[\\/]/).pop(),
      hit.dataset.l ? parseInt(hit.dataset.l, 10) : 0,
      owner && owner.results ? owner.results.query : null);
  });

  host.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const holder = btn.closest('[data-id]');
    if (!holder) return;
    const tab = activeTab();
    const row = rowById(holder.dataset.id);
    if (!row) return;
    const act = btn.dataset.act;

    if (act.indexOf('tbl-') === 0) { tableAct(act, row, btn); return; }
    if (act === 'fit') {
      row.fit = !row.fit;
      if (row.fit) row.height = null;    // 맞춤 상태에서는 저장된 px 를 쓰지 않는다
      rerender();
      scheduleSave();
      toast(row.fit ? '패널 높이에 맞췄습니다' : '원래 크기로 돌아왔습니다');
    } else if (act === 'col') {
      toggleColHere(row.id, btn.dataset.f);
    } else if (act === 'find') {
      const fta = holder.querySelector('textarea');
      if (fta) { fta.focus(); bindDocTo(fta); }
      fb.rowId = row.id;
      openFindDlg('find');
    } else if (act === 'zoom') {
      openZoom(row.id, btn.dataset.f, row.label);
    } else if (act === 'refind') {
      if (row.results) {
        runFindInFiles({
          query: row.results.query, pattern: row.results.pattern, dir: row.results.dir,
          sub: row.results.sub, cs: row.results.cs
        });
      }
    } else if (act === 'copytext') {
      copyText(resolve(row.text, varsOf(tab)));
    } else if (act === 'copy') {
      copyText(row[btn.dataset.src]);
    } else if (act === 'copycmd') {
      copyText(resolve(row.cmd, varsOf(tab)));
    } else if (act === 'caret') {
      row.collapsed = !row.collapsed; rerender(); scheduleSave();
    } else if (act === 'note') {
      row.showNote = !row.showNote; rerender(); scheduleSave();
    } else if (act === 'up') {
      moveUp(tab, row.id); rerender(); scheduleSave();
    } else if (act === 'down') {
      moveDown(tab, row.id); rerender(); scheduleSave();
    } else if (act === 'dup') {
      dupRow(tab, row.id); rerender(); scheduleSave();
    } else if (act === 'del') {
      deleteRow(row.id, row.type === 'section');
    } else if (act === 'more') {
      const r = btn.getBoundingClientRect();
      rowMenu(row, r.left, r.bottom + 4);
    }
  });

  /* 글·명령 블록의 오른쪽 아래 모서리를 끌면 높이가 바뀌고, 그 높이를 기억한다 */
  let resizingTa = null;
  const SNAP = 28;                // 패널 아래 끝에서 이만큼 안으로 들어오면 '가득'

  host.addEventListener('mousedown', (e) => {
    const ta = e.target.closest && e.target.closest('textarea.memo, textarea.code');
    if (!ta) return;
    const r = ta.getBoundingClientRect();
    if (e.clientX > r.right - 20 && e.clientY > r.bottom - 20) resizingTa = ta;
  });

  // 끌다가 패널 아래 끝에 닿으면 미리 표시해 준다 (윈도우 화면 끝 맞춤처럼)
  document.addEventListener('mousemove', (e) => {
    if (!resizingTa) return;
    const hb = host.getBoundingClientRect();
    resizingTa.classList.toggle('willsnap', e.clientY >= hb.bottom - SNAP);
  });

  document.addEventListener('mouseup', (e) => {
    if (!resizingTa) return;
    const ta = resizingTa;
    resizingTa = null;
    const snap = ta.classList.contains('willsnap');
    ta.classList.remove('willsnap');

    const holder = ta.closest('[data-id]');
    const row = holder && rowById(holder.dataset.id);
    if (!row) return;

    if (snap) {
      // 아래 끝까지 끌면 '패널에 맞춤' 으로 바꾼다 (px 로 굳히지 않는다)
      row.fit = true;
      row.height = null;
      rerender();
      scheduleSave();
      toast('패널 높이에 맞췄습니다');
      return;
    }
    row.fit = false;
    const h = Math.round(ta.getBoundingClientRect().height);
    if (h > 40 && row.height !== h) {
      row.height = h;
      ta.dataset.fixedh = '1';
      scheduleSave();
    }
  });

  /* 표 셀: 더블클릭 = 복사, 우클릭 = 메뉴, Enter = 아래 칸으로 */
  host.addEventListener('dblclick', (e) => {
    // 찾기 결과에서 "경로(줄)" 을 더블클릭하면 그 파일을 연다
    const ta = e.target.closest && e.target.closest('textarea.memo');
    if (ta) {
      const v = ta.value;
      const upto = v.slice(0, ta.selectionStart);
      const start = upto.lastIndexOf('\n') + 1;
      let end = v.indexOf('\n', start);
      if (end < 0) end = v.length;
      const line = v.slice(start, end);
      const m = line.match(/^\s*(\d+)\s*:/);
      if (m) {
        // 위로 올라가며 파일 경로 줄을 찾는다
        const before = v.slice(0, start).split('\n');
        for (let i = before.length - 1; i >= 0; i--) {
          const L = before[i].trim();
          if (/^[A-Za-z]:\\/.test(L) || /^\\\\/.test(L)) { reopenFile(L, L.split(/[\\/]/).pop()); return; }
        }
      }
    }
    const cell = e.target.closest('.cell');
    if (!cell) return;
    const row = rowById(cell.closest('[data-id]').dataset.id);
    if (!row || !row.cells) return;
    copyText(resolve(row.cells[+cell.dataset.r][+cell.dataset.c], varsOf(activeTab())));
  });

  // 글·명령 칸 : 편집 메뉴 (잘라내기 / 복사 / 붙여넣기 …)
  host.addEventListener('contextmenu', (e) => {
    const ta = e.target.closest && e.target.closest('textarea.memo, textarea.code');
    if (!ta) return;
    e.preventDefault();
    e.stopImmediatePropagation();   // 같은 자리에 걸린 줄 메뉴가 덮어쓰지 않도록
    bindDocTo(ta);
    textMenu(ta, e.clientX, e.clientY);
  });

  host.addEventListener('contextmenu', (e) => {
    const cell = e.target.closest('.cell');
    if (cell) {
      e.preventDefault();
      const row = rowById(cell.closest('[data-id]').dataset.id);
      if (row && row.cells) tableCellMenu(row, +cell.dataset.r, +cell.dataset.c, e.clientX, e.clientY);
      return;
    }
    // 글 칸은 위에서 편집 메뉴로 처리한다
    if (e.target.closest('textarea.memo, textarea.code')) return;
    const holder = e.target.closest('#rows [data-id]');
    if (!holder) return;
    e.preventDefault();
    const row = rowById(holder.dataset.id);
    if (row) rowMenu(row, e.clientX, e.clientY);
  });

  /* 글 칸 모서리(크기 조절 손잡이)를 누르면 끝 여백을 잠깐 뺀다.
     여백이 남아 있으면 그 높이보다 작게 줄일 수 없기 때문이다. */
  host.addEventListener('mousedown', (e) => {
    const el = e.target.closest && e.target.closest('textarea[data-fixedh="1"]');
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (e.clientX > r.right - 22 && e.clientY > r.bottom - 22) holdPastEnd(el);
  });

  /* 표 칸에 여러 칸짜리 글을 붙여넣으면 칸칸이 나눠 넣는다 */
  host.addEventListener('paste', (e) => {
    const cell = e.target.closest && e.target.closest('.cell');
    if (!cell) return;
    const t = (e.clipboardData || window.clipboardData).getData('text') || '';
    const parsed = parseTableText(t);
    if (!parsed) return;                                   // 그냥 글이면 평소대로
    const g = parsed.grid;
    if (g.length === 1 && g[0].length === 1) return;        // 한 칸이면 평소대로
    e.preventDefault();
    const holder = cell.closest('[data-id]');
    const row = rowById(holder.dataset.id);
    if (!row || !row.cells) return;
    const r0 = +cell.dataset.r, c0 = +cell.dataset.c;
    const res = tablePasteAt(row, r0, c0, g);
    if (parsed.md && r0 === 0 && c0 === 0 && g.length > 1) row.header = true;
    tablePasteDone(res, parsed, g);
  });

  host.addEventListener('keydown', (e) => {
    const cell = e.target.closest && e.target.closest('.cell');
    if (!cell || e.key !== 'Enter') return;
    e.preventDefault();
    const holder = cell.closest('[data-id]');
    const row = rowById(holder.dataset.id);
    if (!row || !row.cells) return;
    const r = +cell.dataset.r, c = +cell.dataset.c;
    const nr = e.shiftKey ? r - 1 : r + 1;
    if (nr < 0) return;
    if (nr >= row.cells.length) {
      if (row.cells.length >= MAX_TBL_ROWS) return;
      row.cells.push(new Array(row.cells[0].length).fill(''));
      rerender();
      scheduleSave();
    }
    const next = $('#rows .row[data-id="' + row.id + '"] .cell[data-r="' + nr + '"][data-c="' + c + '"]');
    if (next) { next.focus(); next.select(); }
  });

  /* 드래그 정렬 */
  let dragId = null;
  host.addEventListener('dragstart', (e) => {
    const h = e.target.closest('.handle');
    if (!h) { e.preventDefault(); return; }
    const holder = h.closest('[data-id]');
    dragId = holder.dataset.id;
    holder.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  host.addEventListener('dragend', () => {
    dragId = null;
    $$('#rows .dragging, #rows .dropafter, #rows .dropbefore')
      .forEach((el) => el.classList.remove('dragging', 'dropafter', 'dropbefore'));
  });
  host.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const t = e.target.closest('.row, .section');
    $$('#rows .dropafter, #rows .dropbefore').forEach((el) => el.classList.remove('dropafter', 'dropbefore'));
    if (!t || t.dataset.id === dragId) return;
    const r = t.getBoundingClientRect();
    t.classList.add(e.clientY > r.top + r.height / 2 ? 'dropafter' : 'dropbefore');
  });
  host.addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const t = e.target.closest('.row, .section');
    if (t && t.dataset.id !== dragId) {
      const r = t.getBoundingClientRect();
      moveByDrag(activeTab(), dragId, t.dataset.id, e.clientY > r.top + r.height / 2);
      dragId = null;
      rerender(); scheduleSave();
    }
  });
}

function refreshResolved() {
  const tab = activeTab();
  const vars = varsOf(tab);
  $$('#rows .row.cmd, #rows .row.txt').forEach((el) => {
    const row = rowById(el.dataset.id);
    if (!row) return;
    const box = el.querySelector('.resolved');
    if (!box) return;
    const src = row.type === 'text' ? row.text : row.cmd;
    const res = HAS_VAR.test(src) ? resolve(src, vars) : '';
    box.textContent = res !== src ? res : '';
  });
}

function bindTabs() {
  const host = $('#tabs');
  host.addEventListener('click', (e) => {
    const t = e.target.closest('.tab');
    if (!t || e.target.tagName === 'INPUT') return;
    if (e.target.closest('.tclose')) {
      e.stopPropagation();
      deleteTab(t.dataset.id);
      return;
    }
    goTab(t.dataset.id);
    render();
    saveNow();
  });

  // 가운데 버튼으로도 닫기 (브라우저 탭처럼)
  host.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const t = e.target.closest('.tab');
    if (!t) return;
    e.preventDefault();
    deleteTab(t.dataset.id);
  });
  host.addEventListener('dblclick', (e) => {
    const t = e.target.closest('.tab');
    if (t) renameTabInline(t.dataset.id);
  });
  host.addEventListener('contextmenu', (e) => {
    const t = e.target.closest('.tab');
    if (!t) return;
    e.preventDefault();
    tabMenu(t.dataset.id, e.clientX, e.clientY);
  });

  let dragTab = null;
  host.addEventListener('dragstart', (e) => {
    const t = e.target.closest('.tab');
    if (!t) return;
    dragTab = t.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
  });
  host.addEventListener('dragover', (e) => { if (dragTab) e.preventDefault(); });
  host.addEventListener('drop', (e) => {
    const t = e.target.closest('.tab');
    if (!dragTab || !t || t.dataset.id === dragTab) { dragTab = null; return; }
    e.preventDefault();
    const from = ws.tabs.findIndex((x) => x.id === dragTab);
    let to = ws.tabs.findIndex((x) => x.id === t.dataset.id);
    const moved = ws.tabs.splice(from, 1)[0];
    ws.tabs.splice(to, 0, moved);
    dragTab = null;
    render(); saveNow();
  });
}

function bindChrome() {
  // 제목줄 끌어서 창 옮기기 (WebView2 에는 -webkit-app-region 이 없어 직접 처리)
  $('#titlebar').addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, .tb')) return;
    if (!e.target.closest('.drag')) return;
    if (window.jj.dragWindow) window.jj.dragWindow();
  });
  // 제목줄을 두 번 누르면 최대화 / 이전 크기로 (윈도우 기본 동작)
  // 다른 모니터로 보내는 것은 [보기 → 다음 모니터로 이동] 이나 제목줄을 끌어서 합니다.
  $('#titlebar').addEventListener('dblclick', (e) => {
    if (e.target.closest('button, input, .tb')) return;
    if (!e.target.closest('.drag')) return;
    window.jj.toggleMax();
  });

  $('#btnPin').addEventListener('click', () => window.jj.setPinned(!cfg.pinned));
  $('#btnMax').addEventListener('click', () => window.jj.toggleMax());
  $('#btnHide').addEventListener('click', () => window.jj.hide());
  $('#btnClose').addEventListener('click', async () => {
    busy = true;
    const ok = await window.jj.confirm('짱디터를 종료할까요?', '작성 내용은 자동 저장됩니다.', '종료');
    busy = false;
    if (ok) { saveNow(); setTimeout(() => window.jj.quit(), 120); }
  });
  $('#btnAddTab').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    addTabMenu(r.right, r.bottom + 4);
  });
  $('#btnMode').addEventListener('click', () => {
    ws.ui.mode = ws.ui.mode === 'edit' ? 'work' : 'edit';
    rerender();
    saveNow();
    toast(ws.ui.mode === 'edit' ? '설정 화면 — 항목과 틀을 고칩니다' : '작업 화면 — 값만 채우고 복사합니다');
  });
  $('#btnFilter').addEventListener('click', (e) => {
    ws.ui.filterUndone = !ws.ui.filterUndone;
    e.currentTarget.classList.toggle('on', ws.ui.filterUndone);
    rerender(); saveNow();
  });
  $('#btnNext').addEventListener('click', () => {
    const el = $('#rows .row.next');
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    else toast('모든 항목이 완료되었습니다 🎉');
  });
  $$('#addbar .addbtn').forEach((b) => {
    b.addEventListener('click', (e) => {
      if (b.dataset.add === 'table') {
        const r = e.currentTarget.getBoundingClientRect();
        openTablePicker(r.left, r.top - 8);
      } else {
        addRow(b.dataset.add);
      }
    });
  });

  document.addEventListener('mousedown', (e) => {
    if (popupOpen && !e.target.closest('#menu') && !e.target.closest('#menu2')) closePopup();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && popupOpen) { closePopup(); return; }

    // F3 : 다음 찾기 / Shift+F3 : 이전 찾기
    // 찾을 말이 없으면 지금 고른 낱말로 찾는다 (더블클릭 -> F3)
    // F3 : 다음 / Shift+F3 : 이전.  고른 낱말이 있으면 그 말로 바로 찾는다.
    if (e.key === 'F3') {
      e.preventDefault();
      if (zoomCtx) { window.JJDoc.findNext(e.shiftKey ? -1 : 1); return; }
      findStep(e.shiftKey ? -1 : 1);
      return;
    }
    // 찾기 줄이 열려 있으면 Esc 로 닫는다
    if (e.key === 'Escape' && fb.open) { e.preventDefault(); closeFindDlg(); return; }
    const ctrl = e.ctrlKey || e.metaKey;

    // Alt+C : 글·명령 칸에서 눌러도 그 자리에서 열 편집이 켜진다.
    // 칸에 이미 편집 기능이 붙어 있으면 doc.js 가 알아서 처리하므로
    // 여기서 또 한 번 뒤집지 않는다 (두 번 뒤집혀 도로 꺼지던 문제).
    if (e.altKey && !ctrl && !zoomCtx) {
      const k = (e.key || '').toLowerCase();
      if (e.code === 'KeyC' || k === 'c' || k === 'ㅊ') {
        const ta = e.target.closest && e.target.closest('textarea.memo, textarea.code');
        if (ta) {
          e.preventDefault();
          if (ta.dataset.jjbound !== '1') {
            bindDocTo(ta);
            window.JJDoc.setColMode(true);
          }
          return;
        }
        // 칸 밖에서 눌렀으면 이 탭의 첫 글 블록에서 켠다
        const tab = activeTab();
        const first = tab && (tab.rows.find((r) => r.type === 'text' && !r.results)
                           || tab.rows.find((r) => r.type === 'cmd'));
        if (first) {
          e.preventDefault();
          toggleColHere(first.id, first.type === 'text' ? 'text' : 'cmd');
          return;
        }
      }
    }

    if (!ctrl) return;
    const k = e.key.toLowerCase();
    if (k === 'n' && !e.shiftKey) { e.preventDefault(); addRow('item'); }
    else if (k === 'n' && e.shiftKey) { e.preventDefault(); addRow('section'); }
    else if (k === 'k') { e.preventDefault(); addRow('cmd'); }
    else if (k === 'm') { e.preventDefault(); addRow('text'); }
    else if (k === 'd') { e.preventDefault(); $('#btnMode').click(); }
    else if (k === 'h') {
      e.preventDefault();
      if (zoomCtx) { window.JJDoc.openFind(true); return; }
      openFindDlg('repl');
    }
    else if (k === 't') {
      e.preventDefault();
      const b = $('#addbar .addbtn[data-add="table"]').getBoundingClientRect();
      openTablePicker(b.left, b.top - 8);
    }
    else if (k === 'f' && e.shiftKey) {
      e.preventDefault();
      openFindInFiles(window.innerWidth - 24, 60);
    }
    else if (k === 'f') {
      e.preventDefault();
      // 편집기 안이면 편집기 찾기, 아니면 상단 찾기 줄
      if (zoomCtx) { window.JJDoc.openFind(false); return; }
      openFindDlg('find');
      return;
    }
    else if (k === 'e') { e.preventDefault(); exportTab(ws.activeTabId); }
    else if (k === 's') {
      e.preventDefault();
      saveCurrentFile(e.shiftKey);
    }
    else if (k === 'o') {
      e.preventDefault();
      openTextFile();
    }
    else if (e.key === 'Tab') {
      e.preventDefault();
      const i = ws.tabs.findIndex((t) => t.id === ws.activeTabId);
      goTab(ws.tabs[(i + (e.shiftKey ? ws.tabs.length - 1 : 1)) % ws.tabs.length].id);
      render(); saveNow();
    }
  });
}

/* ---------- 자동 숨김 / 폭 조절 ---------- */
function bindDock() {
  const strip = $('#strip');
  const panel = $('#panel');

  if (strip) {
    strip.addEventListener('mouseenter', () => { clearTimeout(hideTimer); window.jj.expand(); });
    strip.addEventListener('click', () => { clearTimeout(hideTimer); window.jj.expand(); window.jj.focus(); });
  }
  panel.addEventListener('mouseenter', () => clearTimeout(hideTimer));

  const scheduleHide = () => {
    if (cfg.pinned || busy || popupOpen || zoomCtx) return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => window.jj.collapse(), cfg.hideDelay);
  };
  // 주의: mouseout 으로 판단하면 목록을 다시 그릴 때(커서 아래 요소가 사라질 때)
  // relatedTarget 이 null 인 가짜 이벤트가 떠서 패널이 멋대로 닫힌다. mouseleave 만 쓴다.
  document.addEventListener('mouseleave', scheduleHide);
  window.addEventListener('blur', () => { if (!document.hasFocus()) scheduleHide(); });

  // 폭 조절
  const rz = $('#resizer');
  let drag = null;
  rz.addEventListener('pointerdown', (e) => {
    drag = { x: e.screenX, w: cfg.width };
    rz.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  rz.addEventListener('pointermove', (e) => {
    if (!drag) return;
    window.jj.setWidth(drag.w + (drag.x - e.screenX));
  });
  const end = (e) => {
    if (!drag) return;
    drag = null;
    try { rz.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }
  };
  rz.addEventListener('pointerup', end);
  rz.addEventListener('pointercancel', end);
}

function applyState(s) {
  cfg = Object.assign(cfg, s);
  document.body.dataset.theme = cfg.theme || 'dark';
  document.documentElement.style.setProperty('--strip', (cfg.strip || 9) + 'px');
  const mx = $('#btnMax');
  if (mx) {
    mx.textContent = cfg.maximized ? '\u2750' : '\u2b1c';
    mx.title = cfg.maximized ? '이전 크기로 (제목줄 두 번 눌러도 됩니다)'
                             : '화면 전체로 (제목줄 두 번 눌러도 됩니다)';
    mx.classList.toggle('on', !!cfg.maximized);
  }
  const pin = $('#btnPin');
  pin.classList.toggle('on', !!cfg.pinned);
  pin.textContent = cfg.pinned ? '📌' : '📍';
  pin.title = cfg.pinned ? '고정됨 — 클릭하면 자동 숨김' : '자동 숨김 — 클릭하면 우측 고정';
  renderIconbar();        // 다크/라이트·고정 아이콘이 지금 상태를 보이도록
}

/* ================= 시작 ================= */
(async function init() {
  const st = await window.jj.getState();
  applyState(st);
  $('#titlebar .ver').textContent = 'v' + (st.version || '1.0.0');

  const loaded = await window.jj.load();
  ws = normWs(loaded);
  // 처음이거나 예전 형식이면 바뀐 내용을 바로 저장해 둔다
  if (!loaded || loaded.version !== WS_VERSION) saveNow();

  $('#btnFilter').classList.toggle('on', !!ws.ui.filterUndone);
  applyFont();
  loadMyTemplates();

  cfg.lowResource = st.lowResource;
  cfg.version = st.version;
  cfg.startup = await window.jj.getStartup();

  window.JJDoc.bind();          // render() 가 글 편집기를 쓰므로 먼저 연결한다

  render();
  bindRows();
  bindIconbar();
  bindFindDlg();
  bindTabs();
  bindChrome();
  bindDock();
  bindUpdates();
  bindZoom();
  bindMenubar();

  window.jj.onState(applyState);

  // 파일 찾기 진행 상황
  if (window.jj.onFindProgress) {
    window.jj.onFindProgress((kind, d) => {
      if (kind !== 'progress' || !d) return;
      const name = (d.file || '').split(/[\\/]/).pop();
      showProgress('찾는 중… ' + d.scanned + '개 파일 · ' + d.hits + '곳 발견' +
        (name ? '   (' + name + ')' : ''));
    });
  }
  $('#prog .pcancel').addEventListener('click', () => {
    window.jj.findInFilesCancel();
    showProgress('취소하는 중…');
  });
  window.addEventListener('mouseup', () => setTimeout(releasePastEnd, 0));
  window.addEventListener('blur', () => setTimeout(releasePastEnd, 0));

  // 모니터를 옮기거나 창 크기가 바뀌면 '패널 맞춤' 블록을 다시 잰다
  let fitTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(applyFit, 60);
  });

  window.addEventListener('beforeunload', () => saveNow());






  window.addEventListener('load', () => {
    requestAnimationFrame(() => $$('#rows textarea').forEach(autosize));
  });
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => $$('#rows textarea').forEach(autosize));
  }
})();
