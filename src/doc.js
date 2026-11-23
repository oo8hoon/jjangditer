/* 짱디터 - 일반 텍스트 문서 편집기
 *
 *  - 열(블록) 편집 : Alt+C 로 모드를 켜고 끄거나, Alt 를 누른 채 드래그
 *  - 파일 내 찾기  : Ctrl+F (다음 F3 / 이전 Shift+F3), 바꾸기 포함
 */
(function () {
  'use strict';

  const TABW = 4;          // 탭 한 칸을 몇 글자로 볼지
  const UNDO_MAX = 60;
  const HILITE_MAX = 400;  // 한 번에 표시할 강조 개수

  let root = null;         // 붙어 있는 곳 (#zoom 또는 블록의 .docwrap)
  let sink = null;         // 글이 바뀌면 알려줄 곳
  let ta = null;           // 편집 영역
  let selBox = null;       // 네모 선택 표시
  let hilBox = null;       // 찾은 글자 강조
  let rect = null;         // { l1, c1, l2, c2 }  (c 는 화면상의 칸 번호)
  let dragging = false;
  const SNAP_GAP = 700;         // 이만큼 쉬었다 치면 되돌리기 단계를 끊는다
  let typePre = null;           // 글자가 들어가기 직전 상태
  let lastSnapAt = 0;
  let composing = false;        // 한글 등 IME 조합 중
  let imeBefore = null;         // 조합 시작 전 상태 (네모에 넣을 때 되돌리려고)
  let colMode = false;     // Alt+C 로 켜는 열 편집 모드
  let metricsCache = null;
  const undoStack = [];
  const redoStack = [];

  const find = { q: '', cs: false, matches: [], idx: -1, open: false, repl: false,
                 hl: false };   // hl = 찾은 곳을 칠해 둘지 (찾기 줄을 안 열어도 칠한다)

  /** 지금 붙어 있는 곳 안에서 찾는다 (없으면 null) */
  function q(sel) { return root ? root.querySelector(sel) : null; }

  /** 이 글 칸이 '어디 것'인지 (화면을 다시 그려도 같은 값이 나온다) */
  function ownerKey(el) {
    if (!el) return '';
    if (el.id === 'zoom') return 'zoom';
    const h = el.closest ? el.closest('[data-id]') : null;
    const f = el.querySelector ? el.querySelector('textarea') : null;
    return h ? ('row:' + h.dataset.id + ':' + (f ? (f.dataset.field || '') : '')) : '';
  }

  /* ---------- 글자 크기 재기 ---------- */
  function metrics() {
    if (metricsCache) return metricsCache;
    const probe = document.createElement('span');
    const cs = getComputedStyle(ta);
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;';
    probe.style.font = cs.font;
    probe.textContent = 'M'.repeat(100);
    document.body.appendChild(probe);
    const cw = probe.getBoundingClientRect().width / 100;

    // 한글이 영문 두 글자 폭인지 실제로 재 본다
    const probe2 = document.createElement('span');
    probe2.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;';
    probe2.style.font = cs.font;
    probe2.textContent = '가'.repeat(100);
    document.body.appendChild(probe2);
    const cwWide = probe2.getBoundingClientRect().width / 100;
    probe2.remove();
    probe.remove();

    metricsCache = {
      cw: cw,
      cwWide: cwWide,
      wideRatio: cw > 0 ? cwWide / cw : 2,
      lh: parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) * 1.5),
      padL: parseFloat(cs.paddingLeft) || 0,
      padT: parseFloat(cs.paddingTop) || 0
    };
    return metricsCache;
  }
  function resetMetrics() { metricsCache = null; }

  /* ---------- 두 칸을 차지하는 글자 ----------
   * 한글·한자·가나·전각기호는 고정폭 글꼴에서 영문 두 글자 폭으로 그려진다.
   * 이걸 세지 않으면 한글이 섞인 줄에서 네모가 어긋난다.
   */
  function isWide(c) {
    return (c >= 0x1100 && c <= 0x115F) ||      // 한글 자모
           (c >= 0x2E80 && c <= 0x303E) ||      // 한자 부수 · 한중일 기호
           (c >= 0x3041 && c <= 0x33FF) ||      // 가나 · 한글 호환 자모 · 한중일 기호
           (c >= 0x3400 && c <= 0x4DBF) ||      // 한자 확장 A
           (c >= 0x4E00 && c <= 0x9FFF) ||      // 한자
           (c >= 0xA000 && c <= 0xA4CF) ||      // 이 문자
           (c >= 0xAC00 && c <= 0xD7A3) ||      // 한글
           (c >= 0xF900 && c <= 0xFAFF) ||      // 한자 호환
           (c >= 0xFE10 && c <= 0xFE19) ||
           (c >= 0xFE30 && c <= 0xFE6F) ||
           (c >= 0xFF00 && c <= 0xFF60) ||      // 전각 영숫자·기호
           (c >= 0xFFE0 && c <= 0xFFE6);
  }

  /** 글자 하나가 몇 칸인지 (탭은 다음 탭 자리까지) */
  function charW(ch, col) {
    if (ch === '\t') return TABW - (col % TABW);
    return isWide(ch.charCodeAt(0)) ? 2 : 1;
  }

  /* ---------- 탭 ↔ 화면 칸 변환 ---------- */
  function colsOf(line) {
    const map = [];
    let col = 0;
    for (let i = 0; i < line.length; i++) {
      map.push(col);
      col += charW(line.charAt(i), col);
    }
    map.push(col);
    return map;
  }
  function colToIndex(line, col) {
    const map = colsOf(line);
    for (let i = 0; i < map.length; i++) if (map[i] >= col) return i;
    return line.length;
  }

  /** 그 칸이 두 칸짜리 글자의 한가운데인지 (네모 가장자리를 글자 경계로 맞출 때 쓴다) */
  function snapCol(line, col) {
    const map = colsOf(line);
    for (let i = 0; i < map.length; i++) {
      if (map[i] === col) return col;
      if (map[i] > col) return map[i];      // 글자 중간이면 그 글자 끝으로
    }
    return map[map.length - 1];
  }
  function endCol(line) { const m = colsOf(line); return m[m.length - 1]; }

  /* ---------- 되돌리기 ---------- */
  function snapshot() {
    undoStack.push({ text: ta.value, start: ta.selectionStart, end: ta.selectionEnd });
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    redoStack.length = 0;
    typePre = null;             // 타이핑 기록과 겹치지 않게
    lastSnapAt = Date.now();
  }

  /** 타이핑 직전 상태를 되돌리기 기록에 넣는다 */
  function pushTyped(pre) {
    undoStack.push(pre);
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    redoStack.length = 0;
  }
  function restore(stackFrom, stackTo) {
    if (!stackFrom.length) return false;
    typePre = null;
    lastSnapAt = 0;             // 되돌린 뒤 친 글자는 새 단계로
    stackTo.push({ text: ta.value, start: ta.selectionStart, end: ta.selectionEnd });
    const s = stackFrom.pop();
    ta.value = s.text;
    ta.setSelectionRange(s.start, s.end);
    clearRect();
    pushToModel();
    runFind(false);
    return true;
  }
  const undo = () => restore(undoStack, redoStack);
  const redo = () => restore(redoStack, undoStack);

  /* ---------- 네모(열) 선택 ---------- */
  function norm() {
    return {
      l1: Math.min(rect.l1, rect.l2), l2: Math.max(rect.l1, rect.l2),
      c1: Math.min(rect.c1, rect.c2), c2: Math.max(rect.c1, rect.c2)
    };
  }

  function clearRect() {
    rect = null;
    if (selBox) selBox.innerHTML = '';
    updateStatus();
  }

  function drawRect() {
    if (!selBox) return;
    selBox.innerHTML = '';
    if (rect) {
      const m = metrics();
      const r = norm();
      const lines = ta.value.split('\n');
      for (let l = r.l1; l <= r.l2 && l < lines.length; l++) {
        const d = document.createElement('div');
        d.className = 'csl';
        d.style.left = (m.padL + r.c1 * m.cw - ta.scrollLeft) + 'px';
        d.style.top = (m.padT + l * m.lh - ta.scrollTop) + 'px';
        d.style.width = Math.max(2, (r.c2 - r.c1) * m.cw) + 'px';
        d.style.height = m.lh + 'px';
        selBox.appendChild(d);
      }
    }
    updateStatus();
  }

  function posFromEvent(e) {
    const m = metrics();
    const box = ta.getBoundingClientRect();
    const x = e.clientX - box.left + ta.scrollLeft - m.padL;
    const y = e.clientY - box.top + ta.scrollTop - m.padT;
    const lines = ta.value.split('\n');
    return {
      line: Math.max(0, Math.min(lines.length - 1, Math.floor(y / m.lh))),
      col: Math.max(0, Math.round(x / m.cw))
    };
  }

  function rectTexts() {
    const r = norm();
    const lines = ta.value.split('\n');
    const out = [];
    for (let l = r.l1; l <= r.l2 && l < lines.length; l++) {
      const line = lines[l];
      out.push(line.slice(colToIndex(line, r.c1), colToIndex(line, r.c2)));
    }
    return out;
  }

  /** 네모 영역을 texts(문자열 또는 줄별 배열)로 바꾼다 */
  function rectReplace(texts) {
    const r = norm();
    const lines = ta.value.split('\n');
    let k = 0;
    for (let l = r.l1; l <= r.l2 && l < lines.length; l++, k++) {
      let line = lines[l];
      const e = endCol(line);
      if (e < r.c1) line += ' '.repeat(r.c1 - e);        // 짧은 줄은 칸을 맞춰 공백 채움
      const a = colToIndex(line, r.c1);
      const b = colToIndex(line, r.c2);
      const t = Array.isArray(texts) ? (texts[k] == null ? '' : texts[k]) : texts;
      lines[l] = line.slice(0, a) + t + line.slice(b);
    }
    ta.value = lines.join('\n');
    const w = Array.isArray(texts) ? 0 : texts.length;
    rect = { l1: r.l1, l2: r.l2, c1: r.c1 + w, c2: r.c1 + w };
    drawRect();
    pushToModel();
    runFind(false);
  }

  /** 네모가 있으면 글자 입력 지점을 네모 왼쪽 위로 옮긴다 (한글 조합이 엉뚱한 데 끼지 않도록) */
  function caretToRectStart() {
    if (!rect || !ta) return;
    const r = norm();
    const lines = ta.value.split('\n');
    let idx = 0;
    for (let i = 0; i < r.l1 && i < lines.length; i++) idx += lines[i].length + 1;
    idx += colToIndex(lines[r.l1] == null ? '' : lines[r.l1], r.c1);
    try { ta.setSelectionRange(idx, idx); } catch (e) { /* 무시 */ }
  }

  function copyRect() {
    const t = rectTexts();
    window.jj.copy(t.join('\n'));
    toast(t.length + '줄을 복사했습니다');
  }

  function setColMode(on, quiet) {
    colMode = !!on;
    if (!colMode) clearRect();
    if (root) root.classList.toggle('colmode', colMode);
    updateStatus();
    if (!quiet) toast(colMode ? '열 편집 모드 — 드래그하면 세로로 잡힙니다 (Alt+C 로 해제)' : '열 편집 모드 해제');
  }

  /* ---------- 찾기 ---------- */
  function runFind(move) {
    find.matches = [];
    find.idx = -1;
    if (find.q) {
      const text = find.cs ? ta.value : ta.value.toLowerCase();
      const q = find.cs ? find.q : find.q.toLowerCase();
      let i = 0;
      while (q.length) {
        const at = text.indexOf(q, i);
        if (at < 0) break;
        find.matches.push({ start: at, end: at + q.length });
        i = at + q.length;
        if (find.matches.length > 20000) break;
      }
      if (find.matches.length) {
        find.hl = true;
        const caret = ta.selectionStart;
        let k = find.matches.findIndex((m) => m.start >= caret);
        find.idx = k < 0 ? 0 : k;
        if (move) gotoMatch(find.idx);
      }
    }
    drawHighlights();
    updateFindBar();
  }

  function gotoMatch(k) {
    if (!find.matches.length) return;
    find.idx = ((k % find.matches.length) + find.matches.length) % find.matches.length;
    const m = find.matches[find.idx];
    ta.focus();
    ta.setSelectionRange(m.start, m.end);
    scrollToIndex(m.start);
    drawHighlights();
    updateFindBar();
  }

  function scrollToIndex(i) {
    const m = metrics();
    const before = ta.value.slice(0, i);
    const line = before.split('\n').length - 1;
    const top = m.padT + line * m.lh;
    if (top < ta.scrollTop) ta.scrollTop = Math.max(0, top - m.lh * 3);
    else if (top > ta.scrollTop + ta.clientHeight - m.lh * 2) ta.scrollTop = top - ta.clientHeight + m.lh * 4;

    const lineStart = before.lastIndexOf('\n') + 1;
    const x = m.padL + endCol(ta.value.slice(lineStart, i)) * m.cw;
    if (x < ta.scrollLeft) ta.scrollLeft = Math.max(0, x - 80);
    else if (x > ta.scrollLeft + ta.clientWidth - 60) ta.scrollLeft = x - ta.clientWidth + 160;
  }

  function drawHighlights() {
    if (!hilBox) return;
    hilBox.innerHTML = '';
    if (!find.hl || !find.matches.length) return;
    const m = metrics();
    const text = ta.value;
    const n = Math.min(find.matches.length, HILITE_MAX);
    for (let k = 0; k < n; k++) {
      const mt = find.matches[k];
      if (text.slice(mt.start, mt.end).indexOf('\n') >= 0) continue;
      const before = text.slice(0, mt.start);
      const line = before.split('\n').length - 1;
      const lineStart = before.lastIndexOf('\n') + 1;
      const c1 = endCol(text.slice(lineStart, mt.start));
      const c2 = endCol(text.slice(lineStart, mt.end));
      const d = document.createElement('div');
      d.className = 'hil' + (k === find.idx ? ' cur' : '');
      d.style.left = (m.padL + c1 * m.cw - ta.scrollLeft) + 'px';
      d.style.top = (m.padT + line * m.lh - ta.scrollTop) + 'px';
      d.style.width = Math.max(2, (c2 - c1) * m.cw) + 'px';
      d.style.height = m.lh + 'px';
      hilBox.appendChild(d);
    }
  }

  function updateFindBar() {
    const c = q('.fcount');
    if (!c) return;
    if (!find.q) { c.textContent = ''; c.classList.remove('none'); return; }
    if (!find.matches.length) { c.textContent = '없음'; c.classList.add('none'); return; }
    c.classList.remove('none');
    c.textContent = (find.idx + 1) + ' / ' + find.matches.length;
  }

  function openFind(withReplace) {
    const bar = q('.findwrap');
    if (!bar) return false;          // 블록 안에는 찾기 바가 없다
    find.open = true;
    find.repl = !!withReplace || find.repl;
    bar.classList.remove('hidden');
    bar.classList.toggle('with-repl', find.repl);
    const qi = q('.fq');
    // 선택한 글자가 있으면 그걸 찾을 말로
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    if (sel && qi && sel.indexOf('\n') < 0) { qi.value = sel; find.q = sel; }
    runFind(false);
    qi.focus();
    qi.select();
    return true;
  }

  /**
   * F3 처리.
   *   dir = 1 다음 / -1 이전
   * 고른 글자가 있으면 그걸로 새로 찾고, 없으면 이어서 다음으로 간다.
   * 찾기 줄을 열지 않아도 동작한다 (칠하기는 그대로 보인다).
   */
  function findNext(dir) {
    if (!ta) return false;

    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    const isNewPick = sel && sel.indexOf('\n') < 0 &&
                      (find.cs ? sel !== find.q : sel.toLowerCase() !== (find.q || '').toLowerCase());

    if (isNewPick) {
      // 더블클릭 등으로 새 낱말을 골랐다 -> 그 말로 찾기 시작
      find.q = sel;
      const qi = q('.fq');
      if (qi) qi.value = sel;
      runFind(false);
      if (find.matches.length) {
        // 고른 자리의 '다음' 것으로 간다 (더블클릭 -> F3 -> 다음 -> 다음)
        const here = find.matches.findIndex((m) => m.start === ta.selectionStart);
        if (here >= 0) gotoMatch(here + (dir < 0 ? -1 : 1));
        else gotoMatch(find.idx);
      }
      return find.matches.length > 0;
    }

    if (!find.q) return false;
    if (!find.matches.length) runFind(false);
    if (!find.matches.length) { updateFindBar(); return false; }

    gotoMatch(find.idx + (dir < 0 ? -1 : 1));
    return true;
  }

  function closeFind() {
    find.open = false;
    find.hl = false;
    const w = q('.findwrap');
    if (w) w.classList.add('hidden');
    if (hilBox) hilBox.innerHTML = '';
    if (ta) ta.focus();
  }

  function replaceCurrent() {
    if (find.idx < 0 || !find.matches.length) return;
    const re = q('.fr'); if (!re) return;
    const r = re.value;
    const m = find.matches[find.idx];
    snapshot();
    ta.value = ta.value.slice(0, m.start) + r + ta.value.slice(m.end);
    ta.setSelectionRange(m.start + r.length, m.start + r.length);
    pushToModel();
    runFind(false);
    if (find.matches.length) gotoMatch(find.idx);
    toast('한 곳을 바꿨습니다');
  }

  function replaceAll() {
    if (!find.q || !find.matches.length) { toast('찾은 내용이 없습니다'); return; }
    const re = q('.fr'); if (!re) return;
    const r = re.value;
    snapshot();
    const n = find.matches.length;
    let out = '', last = 0;
    for (const m of find.matches) { out += ta.value.slice(last, m.start) + r; last = m.end; }
    out += ta.value.slice(last);
    ta.value = out;
    pushToModel();
    runFind(false);
    toast(n + '곳을 바꿨습니다');
  }

  /* ---------- 모델 반영 ---------- */
  function pushToModel() {
    if (typeof sink === 'function') sink(ta.value);
    else if (typeof window.JJDocSink === 'function') window.JJDocSink(ta.value);
    updateStatus();
  }

  function updateStatus() {
    if (!ta) return;
    const txt = ta.value;
    const posEl = q('.pos');
    const lenEl = q('.len');
    const modeEl = q('.cmode');
    if (lenEl) lenEl.textContent = txt.split('\n').length + '줄 · ' + txt.length + '자';
    if (modeEl) modeEl.classList.toggle('on', colMode);
    if (!posEl) return;
    if (rect) {
      const r = norm();
      posEl.textContent = '열 ' + (r.l2 - r.l1 + 1) + '줄 × ' + (r.c2 - r.c1) + '칸';
      posEl.classList.add('on');
      return;
    }
    posEl.classList.remove('on');
    const upto = txt.slice(0, ta.selectionStart).split('\n');
    posEl.textContent = upto.length + '행 ' + (endCol(upto[upto.length - 1]) + 1) + '열';
  }

  /* ---------- 줄 도구 ---------- */
  function lineTools(x, y) {
    const eachLine = (fn) => { snapshot(); ta.value = ta.value.split('\n').map(fn).join('\n'); pushToModel(); runFind(false); };
    const whole = (fn) => { snapshot(); ta.value = fn(ta.value.split('\n')).join('\n'); pushToModel(); runFind(false); };
    openPopup([
      { hd: '줄 도구' },
      { icon: '␠', label: '줄 끝 공백 지우기', onClick: () => eachLine((l) => l.replace(/[ \t]+$/, '')) },
      { icon: '⇤', label: '줄 앞 공백 지우기', onClick: () => eachLine((l) => l.replace(/^[ \t]+/, '')) },
      { icon: '␥', label: '빈 줄 지우기', onClick: () => whole((ls) => ls.filter((l) => l.trim() !== '')) },
      { sep: true },
      {
        icon: '#', label: '번호 매기기 (1. 2. 3.)',
        onClick: () => { let n = 0; whole((ls) => ls.map((l) => (l.trim() === '' ? l : (++n) + '. ' + l))); }
      },
      { icon: '⇅', label: '가나다 순 정렬', onClick: () => whole((ls) => ls.slice().sort((a, b) => a.localeCompare(b, 'ko'))) },
      {
        icon: '≠', label: '중복 줄 지우기',
        onClick: () => whole((ls) => { const seen = Object.create(null); return ls.filter((l) => (seen[l] ? false : (seen[l] = 1, true))); })
      },
      { sep: true },
      {
        icon: '⇥', label: '탭을 공백 ' + TABW + '칸으로',
        onClick: () => eachLine((l) => {
          let out = '', col = 0;
          for (const ch of l) {
            if (ch === '\t') { const n = TABW - (col % TABW); out += ' '.repeat(n); col += n; }
            else { out += ch; col++; }
          }
          return out;
        })
      },
      { sep: true },
      { icon: '⧉', label: '전체 복사', onClick: () => { window.jj.copy(ta.value); toast('전체를 복사했습니다'); } }
    ], x, y);
  }

  /* ---------- 연결 ---------- */
  /**
   * 편집 기능을 글 칸 하나에 붙인다.
   *   rootEl : 글 칸을 감싼 곳 (#zoom 또는 블록의 .docwrap). 없으면 #zoom
   *   sinkFn : 글이 바뀔 때마다 알려줄 함수
   * 같은 칸에 두 번 붙어도 이벤트가 겹치지 않는다.
   */
  function bind(rootEl, sinkFn) {
    const doc = rootEl || document.getElementById('zoom');
    const nextTa = doc.querySelector('.doctext, textarea.memo, textarea.code');
    if (!nextTa) return false;

    // 다른 '줄' 로 옮겨 갈 때만 네모 선택과 열 편집을 푼다.
    // 화면을 다시 그려서 칸만 새로 만들어진 경우는 그대로 이어 간다.
    const before = ownerKey(root), now = ownerKey(doc);
    const sameOwner = before !== '' && before === now;
    if (ta && ta !== nextTa && !sameOwner) { clearRect(); colMode = false; }
    if (root && root !== doc && !sameOwner) root.classList.remove('colmode');

    root = doc;
    sink = sinkFn || null;
    ta = nextTa;
    selBox = doc.querySelector('.colsel');
    hilBox = doc.querySelector('.hilite');
    resetMetrics();
    root.classList.toggle('colmode', colMode);

    if (ta.dataset.jjbound === '1') { drawRect(); updateStatus(); return true; }
    ta.dataset.jjbound = '1';

    // 글자가 들어가기 '직전' 상태를 잡아 둔다
    ta.addEventListener('beforeinput', () => {
      if (rect) return;                    // 네모 편집은 따로 기록한다
      if (composing && typePre) return;    // 조합 중에는 맨 처음 것만 유지
      typePre = { text: ta.value, start: ta.selectionStart, end: ta.selectionEnd };
    });

    ta.addEventListener('input', (e) => {
      if (composing) { pushToModel(); return; }   // 조합 중에는 네모를 그대로 둔다

      // 보통 타이핑도 Ctrl+Z 로 되돌릴 수 있게 기록한다.
      // 빠르게 이어 친 글자는 한 덩어리로 묶는다.
      if (typePre) {
        const t = e && e.inputType ? e.inputType : '';
        const big = t === 'insertFromPaste' || t === 'deleteByCut' ||
                    t === 'insertLineBreak' || t === 'insertParagraph' ||
                    t === 'historyUndo' || t === 'historyRedo';
        const now = Date.now();
        if (big || !undoStack.length || now - lastSnapAt > SNAP_GAP) pushTyped(typePre);
        lastSnapAt = now;
        typePre = null;
      }

      clearRect(); pushToModel(); runFind(false);
    });

    /* ---- 한글 입력 (IME) ----
     * 네모가 잡힌 채로 한글을 치면, 조합이 끝났을 때
     * 조합 전 상태로 되돌린 뒤 네모 전체에 한꺼번에 넣는다.
     */
    ta.addEventListener('compositionstart', () => {
      composing = true;
      imeBefore = rect
        ? { text: ta.value, rect: { l1: rect.l1, c1: rect.c1, l2: rect.l2, c2: rect.c2 } }
        : null;
    });
    ta.addEventListener('compositionend', (e) => {
      composing = false;
      const saved = imeBefore;
      imeBefore = null;
      if (!saved) {
        // 조합으로 들어간 글자도 되돌릴 수 있게
        if (typePre) {
          const now = Date.now();
          if (!undoStack.length || now - lastSnapAt > SNAP_GAP) pushTyped(typePre);
          lastSnapAt = now;
          typePre = null;
        }
        clearRect(); pushToModel(); runFind(false);
        return;
      }

      const typed = e.data || '';
      ta.value = saved.text;                 // 조합이 끼워 넣은 글자를 되돌리고
      rect = saved.rect;                     // 네모를 되살린 뒤
      if (typed) { snapshot(); rectReplace(typed); }   // 세로로 한꺼번에 넣는다
      else { drawRect(); }
      ta.focus();
    });
    ta.addEventListener('scroll', () => { drawRect(); drawHighlights(); });
    ta.addEventListener('click', updateStatus);
    ta.addEventListener('keyup', updateStatus);
    bindWindowOnce();

    /* 드래그로 네모 선택 : 열 편집 모드이거나 Alt 를 누른 채 */
    ta.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !(colMode || e.altKey)) { if (rect) clearRect(); return; }
      e.preventDefault();
      const p = posFromEvent(e);
      rect = { l1: p.line, c1: p.col, l2: p.line, c2: p.col };
      dragging = true;
      drawRect();
      ta.focus();
      caretToRectStart();
    });
    bindDocOnce();
    drawRect();          // 다시 그려진 칸에도 네모를 되살린다

    ta.addEventListener('keydown', (e) => {
      const ctrl = e.ctrlKey || e.metaKey;

      // 열 편집 모드 켜고 끄기 (자판/IME 상태와 상관없이 잡히도록 code 와 key 둘 다 본다)
      if (e.altKey && !ctrl) {
        const k = (e.key || '').toLowerCase();
        if (e.code === 'KeyC' || k === 'c' || k === 'ㅊ') {
          e.preventDefault();
          e.stopPropagation();
          setColMode(!colMode);
          return;
        }
      }

      if (ctrl && e.code === 'KeyF') { if (openFind(false)) { e.preventDefault(); } return; }
      if (ctrl && e.code === 'KeyH') { if (openFind(true)) { e.preventDefault(); } return; }
      if (e.key === 'F3') {
        e.preventDefault();
        e.stopPropagation();        // 바깥에서 또 처리하지 않도록
        findNext(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key === 'Escape' && find.open && !rect) { e.preventDefault(); closeFind(); return; }

      // 되돌릴 기록이 없으면 가로채지 않는다 (브라우저 기본 되돌리기에 맡김)
      if (ctrl && e.code === 'KeyZ' && !e.shiftKey) {
        if (undoStack.length) { e.preventDefault(); undo(); }
        return;
      }
      if (ctrl && (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey))) {
        if (redoStack.length) { e.preventDefault(); redo(); }
        return;
      }

      // Alt 와 함께 누른 글자는 편집 내용에 들어가지 않게 막는다
      if (e.altKey && !ctrl && e.key && e.key.length === 1) { e.preventDefault(); return; }

      if (!rect) {
        if (e.key === 'Tab') {
          e.preventDefault();
          snapshot();
          const s = ta.selectionStart, en = ta.selectionEnd;
          ta.value = ta.value.slice(0, s) + '\t' + ta.value.slice(en);
          ta.setSelectionRange(s + 1, s + 1);
          pushToModel();
        }
        return;
      }

      /* ---- 네모 선택 중 ---- */
      if (e.key === 'Escape') { e.preventDefault(); clearRect(); return; }
      if (ctrl && e.code === 'KeyC') { e.preventDefault(); copyRect(); return; }
      if (ctrl && e.code === 'KeyX') { e.preventDefault(); copyRect(); snapshot(); rectReplace(''); return; }
      if (ctrl && e.code === 'KeyV') return;              // paste 이벤트에서 처리
      if (ctrl) return;

      if (e.key === 'Backspace') {
        e.preventDefault(); snapshot();
        const r = norm();
        if (r.c1 === r.c2 && r.c1 > 0) rect = { l1: r.l1, l2: r.l2, c1: r.c1 - 1, c2: r.c2 };
        rectReplace('');
        return;
      }
      if (e.key === 'Delete') {
        e.preventDefault(); snapshot();
        const r = norm();
        if (r.c1 === r.c2) rect = { l1: r.l1, l2: r.l2, c1: r.c1, c2: r.c2 + 1 };
        rectReplace('');
        return;
      }
      if (e.key.length === 1) { e.preventDefault(); snapshot(); rectReplace(e.key); return; }
      if (e.key.indexOf('Arrow') === 0 || e.key === 'Home' || e.key === 'End') clearRect();
    });

    ta.addEventListener('paste', (e) => {
      if (!rect) return;
      e.preventDefault();
      const t = (e.clipboardData || window.clipboardData).getData('text') || '';
      const r = norm();
      const n = r.l2 - r.l1 + 1;
      const parts = t.split(/\r?\n/);
      snapshot();
      rectReplace(parts.length === n ? parts : t.replace(/\r?\n/g, ' '));
    });

    /* 아래 단추들은 전체 편집기에만 있다.
     * 블록 안에 붙을 때는 없으므로, 있을 때만 연결한다. */
    const on = (sel, ev, fn) => {
      const el = doc.querySelector(sel);
      if (el) el.addEventListener(ev, fn);
      return el;
    };

    on('.ltools', 'click', (e) => {
      const b = e.currentTarget.getBoundingClientRect();
      lineTools(b.left, b.top - 8);
    });
    on('.cmode', 'click', () => setColMode(!colMode));
    on('.zfind', 'click', () => openFind(false));

    /* 찾기 줄 */
    const qi = on('.fq', 'input', (e) => { find.q = e.target.value; runFind(false); });
    on('.fq', 'keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); gotoMatch(find.idx + (e.shiftKey ? -1 : 1)); }
      else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
    });
    on('.fnext', 'click', () => gotoMatch(find.idx + 1));
    on('.fprev', 'click', () => gotoMatch(find.idx - 1));
    on('.fcs', 'change', (e) => { find.cs = e.target.checked; runFind(false); });
    on('.ftoggle', 'click', () => {
      find.repl = !find.repl;
      const w = doc.querySelector('.findwrap');
      if (w) w.classList.toggle('with-repl', find.repl);
      const r = doc.querySelector('.fr');
      if (find.repl && r) r.focus();
    });
    on('.fclose', 'click', closeFind);
    on('.frep', 'click', replaceCurrent);
    on('.frepall', 'click', replaceAll);
    on('.fr', 'keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); replaceCurrent(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
    });
    if (qi) { /* 찾기 칸이 있는 곳에서만 쓴다 */ }
    updateStatus();
    return true;
  }

  /* 창·문서 전체에 거는 것은 딱 한 번만 건다 */
  let winBound = false, docBound = false;
  function bindWindowOnce() {
    if (winBound) return;
    winBound = true;
    window.addEventListener('resize', () => { resetMetrics(); drawRect(); drawHighlights(); });
  }
  function bindDocOnce() {
    if (docBound) return;
    docBound = true;
    document.addEventListener('mousemove', (e) => {
      if (!dragging || !rect) return;
      const p = posFromEvent(e);
      rect.l2 = p.line; rect.c2 = p.col;
      drawRect();
    });
    document.addEventListener('mouseup', () => {
      if (dragging) { dragging = false; caretToRectStart(); }
    });
  }

  /* ---------- 바깥에서 쓰는 것 ---------- */
  window.JJDoc = {
    bind: bind,
    /** 되돌릴 수 있는 단계 수 */
    undoDepth: function () { return undoStack.length; },
    /** 되돌리기 / 다시 하기 */
    undo: function () { if (ta) undo(); },
    redo: function () { if (ta) redo(); },
    /** 네모(열) 선택이 있는지 */
    hasRect: function () { return !!rect; },
    /** 네모로 잡힌 글자들 (줄 배열) */
    rectTexts: function () { return rect ? rectTexts() : []; },
    /** 네모를 복사한다 */
    copyRect: function () { if (rect) copyRect(); },
    /** 네모를 잘라낸다 */
    cutRect: function () { if (rect) { copyRect(); snapshot(); rectReplace(''); } },
    /** 네모 자리에 글을 넣는다 (줄 수가 맞으면 줄마다, 아니면 통째로) */
    pasteRect: function (t) {
      if (!rect || t == null) return false;
      const r = norm();
      const n = r.l2 - r.l1 + 1;
      const parts = String(t).split(/\r?\n/);
      snapshot();
      rectReplace(parts.length === n ? parts : String(t).replace(/\r?\n/g, ' '));
      return true;
    },
    /** 글꼴이 바뀌었을 때 글자 크기를 다시 잰다 */
    remeasure: function () { resetMetrics(); drawRect(); drawHighlights(); },
    /** 지금 붙어 있는 글 칸 */
    target: function () { return ta; },
    ready: function () { return !!ta; },
    /** 편집기에 글을 올린다 */
    load: function (text) {
      if (!ta) return;
      resetMetrics();
      ta.value = text == null ? '' : String(text);
      ta.setSelectionRange(0, 0);
      undoStack.length = 0;
      redoStack.length = 0;
      setColMode(false, true);
      clearRect();
      find.q = '';
      find.matches = [];
      closeFind();
      updateStatus();
    },
    focus: function () { if (ta) ta.focus(); },
    /** n 번째 줄로 이동한다. q 를 주면 그 줄 안의 q 를 골라 모두 강조한다 */
    gotoLine: function (n, q) {
      if (!ta || !n) return;
      const lines = ta.value.split('\n');
      const k = Math.max(0, Math.min(n - 1, lines.length - 1));
      let idx = 0;
      for (let i = 0; i < k; i++) idx += lines[i].length + 1;

      let a = idx, b = idx + lines[k].length;
      if (q) {
        const off = lines[k].toLowerCase().indexOf(String(q).toLowerCase());
        if (off >= 0) { a = idx + off; b = a + String(q).length; }
      }
      ta.focus();
      ta.setSelectionRange(a, b);
      scrollToIndex(a);
      updateStatus();
      if (q) {
        // 같은 말이 있는 곳을 모두 강조해 둔다
        openFind(false);
        ta.focus();
        ta.setSelectionRange(a, b);
        scrollToIndex(a);
      }
    },
    text: function () { return ta ? ta.value : ''; },
    openFind: function (withReplace) { if (ta) return openFind(withReplace); return false; },
    /** 찾을 말을 정하고 바로 찾는다. 찾은 개수를 돌려준다 */
    setFind: function (text, cs) {
      if (!ta) return 0;
      find.q = text == null ? '' : String(text);
      find.cs = !!cs;
      runFind(false);
      return find.matches.length;
    },
    /** k 번째 결과로 간다 */
    gotoIndex: function (k) { if (ta && find.matches.length) gotoMatch(k); },
    /** 지금 찾은 개수 / 몇 번째인지 */
    matchCount: function () { return find.matches.length; },
    matchIndex: function () { return find.idx; },
    /** 지금 고른 글자 (한 줄짜리만) */
    selText: function () {
      if (!ta) return '';
      const t = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      return (t && t.indexOf('\n') < 0) ? t : '';
    },
    /** 칠하기를 지운다 */
    clearFind: function () {
      find.q = ''; find.matches = []; find.idx = -1; find.hl = false;
      if (hilBox) hilBox.innerHTML = '';
    },
    /** F3 : 다음(1) / 이전(-1) 찾기. 고른 낱말이 있으면 그 말로 새로 찾는다 */
    findNext: function (dir) { return findNext(dir); },
    /** 찾기 줄이 열려 있는지 */
    findOpen: function () { return !!find.open; },
    toggleColMode: function () { if (ta) setColMode(!colMode); },
    /** 열 편집 모드를 켜거나 끈다 (밖에서 바로 지정) */
    setColMode: function (on) { if (ta) setColMode(!!on); },
    isColMode: function () { return colMode; },
    lineTools: lineTools
  };
})();
