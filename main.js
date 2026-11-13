'use strict';
/**
 * 짱디터 (JJangditer) - 메인 프로세스
 *
 * 창 구성
 *  - panel   : 실제 체크리스트 패널. 화면 우측에 도킹된다.
 *  - trigger : 화면 우측 끝에 떠 있는 얇은 띠(9px). 여기에 마우스를 올리면 패널이 나온다.
 *
 * 숨길 때 패널을 "화면 밖으로 밀어내는" 방식은 오른쪽에 모니터가 더 있으면 그 모니터에 그대로
 * 보이기 때문에 쓰지 않는다. 대신 패널 창을 완전히 감추고 트리거 띠만 남긴다.
 * 다시 나올 때는 우측 끝에 붙인 채 폭을 늘려 슬라이드되는 것처럼 보이게 한다.
 */
const {
  app, BrowserWindow, ipcMain, screen, dialog, Tray, Menu,
  clipboard, globalShortcut, nativeImage, shell, net
} = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const STRIP = 9;          // 트리거 띠 폭(px)
const SEED_W = 48;        // 슬라이드 시작 폭 (Windows 가 강제하는 최소 창 폭)
const MIN_W = 320;
const MAX_W = 1100;

let win = null;           // 패널 창
let trigger = null;       // 트리거 띠 창
let tray = null;
let quitting = false;
let animTimer = null;
let guardTimer = null;
let redockTimer = null;
let collapsed = false;
let internalMove = false;
let lastCollapseAt = 0;   // 접자마자 커서가 띠 위에 있어 바로 다시 펼쳐지는 깜빡임 방지

const PREFS_FILE = () => path.join(app.getPath('userData'), 'prefs.json');
const DATA_FILE = () => path.join(app.getPath('userData'), 'workspace.json');

let prefs = {
  width: 440,
  pinned: true,
  theme: 'dark',
  hideDelay: 500,
  displayId: null,       // 도킹할 모니터 (마지막으로 쓴 모니터를 기억)
  lastDir: null,         // 마지막으로 저장/불러온 폴더
  updateUrl: '',         // 업데이트 배포 위치 (공유폴더 경로 또는 http(s) 주소)
  autoUpdate: true,      // 시작할 때 / 6시간마다 자동 확인
  lowResource: true      // GPU 가속을 끄고 메모리를 줄인다 (재시작 필요)
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function readJson(file, fallback) {
  try {
    let txt = fs.readFileSync(file, 'utf8');
    if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);   // BOM 제거
    return JSON.parse(txt);
  } catch (e) { return fallback; }
}
/**
 * 저장 중에 전원이 나가거나 프로세스가 죽어도 기존 파일이 깨지지 않도록
 * 임시 파일에 먼저 쓰고 이름을 바꾼다(원자적 교체).
 */
function writeJson(file, obj) {
  const tmp = file + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    console.error('write fail', file, e.message);
    try { fs.unlinkSync(tmp); } catch (e2) { /* 임시 파일이 없으면 무시 */ }
    return false;
  }
}

function loadPrefs() {
  Object.assign(prefs, readJson(PREFS_FILE(), {}));
  prefs.width = clamp(prefs.width, MIN_W, MAX_W);
}
function savePrefs() { writeJson(PREFS_FILE(), prefs); }

/* ---------- 작업 내용 저장 (백업 포함) ---------- */
const BACKUP_EVERY = 5 * 60 * 1000;     // 백업은 5분에 한 번이면 충분
let lastBackup = 0;

const looksValid = (d) => !!(d && Array.isArray(d.tabs) && d.tabs.length);

function loadWorkspace() {
  const f = DATA_FILE();
  const cur = readJson(f, null);
  if (looksValid(cur)) return cur;

  // 본 파일이 없거나 깨졌으면 백업에서 되살린다
  const bak = readJson(f + '.bak', null);
  if (looksValid(bak)) {
    console.warn('workspace.json 을 읽지 못해 백업에서 복구했습니다');
    try { if (fs.existsSync(f)) fs.renameSync(f, f + '.broken'); } catch (e) { /* 무시 */ }
    writeJson(f, bak);
    return bak;
  }
  return null;
}

function saveWorkspace(data) {
  if (!looksValid(data)) return false;        // 빈 내용으로 덮어쓰지 않는다
  const f = DATA_FILE();
  const now = Date.now();
  if (now - lastBackup > BACKUP_EVERY) {
    const cur = readJson(f, null);
    if (looksValid(cur)) {
      try { fs.copyFileSync(f, f + '.bak'); lastBackup = now; } catch (e) { /* 무시 */ }
    } else {
      lastBackup = now;
    }
  }
  return writeJson(f, data);
}

/* ---------- 마지막으로 쓴 폴더 기억 ---------- */
function defaultPathFor(name) {
  if (prefs.lastDir) {
    try { if (fs.statSync(prefs.lastDir).isDirectory()) return path.join(prefs.lastDir, name); }
    catch (e) { /* 폴더가 사라졌으면 무시 */ }
  }
  return path.join(app.getPath('documents'), name);
}
function rememberDir(filePath) {
  if (!filePath) return;
  const d = path.dirname(filePath);
  if (d && d !== prefs.lastDir) { prefs.lastDir = d; savePrefs(); }
}

/* ---------- 위치 계산 ---------- */
function targetDisplay() {
  const all = screen.getAllDisplays();
  if (prefs.displayId != null) {
    const found = all.find((d) => String(d.id) === String(prefs.displayId));
    if (found) return found;
  }
  return screen.getPrimaryDisplay();
}
function workArea() { return targetDisplay().workArea; }

function panelBounds(width) {
  const wa = workArea();
  const w = clamp(width, 1, MAX_W);
  return { x: wa.x + wa.width - w, y: wa.y, width: w, height: wa.height };
}

/* ---------- 애니메이션 ---------- */
function stopAnim() { if (animTimer) { clearInterval(animTimer); animTimer = null; } }

function releaseGuard() {
  clearTimeout(guardTimer);
  guardTimer = setTimeout(() => { internalMove = false; }, 200);
}

function setBoundsSafe(b) {
  if (!win || win.isDestroyed()) return;
  internalMove = true;
  win.setBounds(b);
  releaseGuard();
}

/** 우측 끝에 붙인 채 폭만 늘였다 줄였다 하여 슬라이드처럼 보이게 한다. */
function animateWidth(toWidth, dur, done) {
  if (!win || win.isDestroyed()) { if (done) done(); return; }
  stopAnim();
  const from = win.getBounds().width;
  const dw = toWidth - from;
  if (Math.abs(dw) < 2) { setBoundsSafe(panelBounds(toWidth)); if (done) done(); return; }
  const t0 = Date.now();
  dur = dur || 160;
  internalMove = true;
  animTimer = setInterval(() => {
    if (!win || win.isDestroyed()) { stopAnim(); if (done) done(); return; }
    const t = Math.min(1, (Date.now() - t0) / dur);
    const e = 1 - Math.pow(1 - t, 3);                   // easeOutCubic
    win.setBounds(panelBounds(Math.round(from + dw * e)));
    if (t >= 1) {
      stopAnim();
      win.setBounds(panelBounds(toWidth));
      releaseGuard();
      if (done) done();
    }
  }, 8);
}

/* ---------- 트리거 띠 창 ---------- */
function triggerBounds() {
  const wa = workArea();
  return { x: wa.x + wa.width - STRIP, y: wa.y, width: STRIP, height: wa.height };
}

function createTrigger() {
  if (trigger && !trigger.isDestroyed()) trigger.destroy();
  const b = triggerBounds();
  trigger = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false,
    // Windows 는 일반 창에 최소 폭(약 48px)을 강제한다. transparent:true 로 만든
    // 레이어드 창만 9px 로 유지되므로 반드시 함께 지정해야 한다.
    transparent: true,
    resizable: false,
    minWidth: 1,
    minHeight: 1,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  trigger.setAlwaysOnTop(true, 'screen-saver');
  trigger.loadFile(path.join(__dirname, 'src', 'trigger.html'));
}

function showTrigger() {
  // 크기 변경이 불가한 창이라, 모니터/해상도가 바뀌었으면 다시 만든다
  if (!trigger || trigger.isDestroyed()) createTrigger();
  else {
    const want = triggerBounds();
    const cur = trigger.getBounds();
    if (cur.x !== want.x || cur.y !== want.y || cur.width !== want.width || cur.height !== want.height) {
      createTrigger();
    }
  }
  if (!trigger.isVisible()) trigger.showInactive();
}
function hideTrigger() {
  if (!trigger || trigger.isDestroyed()) return;
  // 우측 고정 상태에서는 띠가 전혀 필요 없으므로 창을 없애 메모리를 돌려준다
  if (prefs.pinned) { trigger.destroy(); trigger = null; return; }
  if (trigger.isVisible()) trigger.hide();
}

/* ---------- 펼치기 / 접기 ---------- */
function expandPanel(opts) {
  if (!win || win.isDestroyed()) return;
  const animate = !opts || opts.animate !== false;
  collapsed = false;
  hideTrigger();
  if (!win.isVisible()) {
    setBoundsSafe(panelBounds(animate ? SEED_W : prefs.width));
    win.showInactive();
    win.setAlwaysOnTop(true, 'screen-saver');
  }
  if (animate) animateWidth(prefs.width, 170);
  else setBoundsSafe(panelBounds(prefs.width));
  sendState();
}

function collapsePanel(opts) {
  if (!win || win.isDestroyed()) return;
  const animate = !opts || opts.animate !== false;
  collapsed = true;
  const finish = () => {
    if (!win || win.isDestroyed()) return;
    if (collapsed) { win.hide(); showTrigger(); lastCollapseAt = Date.now(); }
  };
  if (animate && win.isVisible()) animateWidth(SEED_W, 140, finish);
  else finish();
  sendState();
}

function setCollapsed(v, opts) {
  v = !!v;
  if (collapsed === v) {
    // 상태는 같아도 창이 실제로 숨겨져 있으면 다시 띄운다
    if (!v && win && !win.isDestroyed() && !win.isVisible()) expandPanel(opts);
    return;
  }
  if (v) collapsePanel(opts); else expandPanel(opts);
}

function relayout() {
  if (!win || win.isDestroyed()) return;
  if (collapsed) showTrigger();
  else setBoundsSafe(panelBounds(prefs.width));
  sendState();
}

function sendState() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('win:state', {
      pinned: prefs.pinned, collapsed: collapsed, width: prefs.width,
      theme: prefs.theme, hideDelay: prefs.hideDelay, strip: STRIP
    });
  }
  if (tray) tray.setToolTip('짱디터 - ' + (prefs.pinned ? '고정됨' : '자동 숨김'));
}

function iconPath() {
  const p = path.join(__dirname, 'build', 'icon.ico');
  return fs.existsSync(p) ? p : null;
}

/* ---------- 패널 창 ---------- */
function createWindow() {
  const b = panelBounds(prefs.width);
  win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false,
    backgroundColor: '#14161c',
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: '짱디터',
    icon: iconPath() || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
    expandPanel({ animate: false });
    if (!prefs.pinned) setTimeout(() => { if (!prefs.pinned) collapsePanel(); }, 1800);
  });

  // 고정 해제 상태에서 포커스를 잃으면 접기
  win.on('blur', () => {
    if (prefs.pinned) return;
    setTimeout(() => {
      if (!prefs.pinned && win && !win.isDestroyed() && win.isVisible() && !win.isFocused()) collapsePanel();
    }, 300);
  });

  // 타이틀바로 다른 모니터에 끌어다 놓으면 그 모니터 우측에 다시 도킹
  win.on('moved', () => {
    if (internalMove || collapsed || !win || win.isDestroyed()) return;
    clearTimeout(redockTimer);
    redockTimer = setTimeout(() => {
      if (internalMove || collapsed || !win || win.isDestroyed()) return;
      const d = screen.getDisplayMatching(win.getBounds());
      if (String(d.id) !== String(prefs.displayId)) {
        prefs.displayId = d.id;
        savePrefs();
        if (trigger && !trigger.isDestroyed()) createTrigger();
      }
      const want = panelBounds(prefs.width);
      const cur = win.getBounds();
      if (cur.x !== want.x || cur.y !== want.y || cur.width !== want.width || cur.height !== want.height) {
        setBoundsSafe(want);
      }
    }, 200);
  });

  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); hideTrigger(); }
  });

  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  const onDisplayChange = () => {
    if (trigger && !trigger.isDestroyed()) createTrigger();
    relayout();
  };
  screen.on('display-metrics-changed', onDisplayChange);
  screen.on('display-added', onDisplayChange);
  screen.on('display-removed', onDisplayChange);
}

function showPanel() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (!win.isVisible()) win.show();
  expandPanel();
  win.setAlwaysOnTop(true, 'screen-saver');
  win.focus();
}

/* ---------- 트레이 ---------- */
const TRAY_ICON_PNG =
  'data:image/png;base64,' +
  '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' +
  '3qGflxAAAAAASUVORK5CYII=';

function createTray() {
  try {
    // asar 로 패키징되면 nativeImage 가 .ico 를 직접 읽지 못하므로 내장 PNG 를 쓴다
    tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_PNG));
  } catch (e) {
    console.error('tray 생성 실패:', e.message);
    return;
  }
  const menu = Menu.buildFromTemplate([
    { label: '짱디터 열기', click: () => showPanel() },
    { type: 'separator' },
    {
      label: '우측에 고정', type: 'checkbox', checked: prefs.pinned,
      click: (mi) => {
        prefs.pinned = mi.checked; savePrefs();
        if (prefs.pinned) showPanel(); else collapsePanel();
        sendState();
      }
    },
    { type: 'separator' },
    { label: '데이터 폴더 열기', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    { label: '종료', click: () => { quitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip('짱디터');
  tray.on('click', () => showPanel());
}

/* ---------- 업데이트 ----------
 * 배포 위치(공유 폴더 또는 http 주소)에 latest.json 과 새 exe 를 올려두면
 * 실행 중인 짱디터가 그것을 보고 새 버전을 알려준다.
 *   latest.json 예:
 *   { "version": "1.2.0", "file": "짱디터-1.2.0.exe", "notes": "표 기능 추가", "date": "2026-11-10" }
 */
const UPDATE_EVERY = 6 * 60 * 60 * 1000;
let updateInfo = null;
let updateBusy = false;


function send(ch, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, payload);
}

function cmpVer(a, b) {
  const pa = String(a).split(/[.\-+]/).map(Number);
  const pb = String(b).split(/[.\-+]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

const isHttp = (u) => /^https?:\/\//i.test(u);
const joinUrl = (base, name) => base.replace(/\/+$/, '') + '/' + encodeURIComponent(name);

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = net.request(url);
    req.on('response', (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error('HTTP ' + res.statusCode)); return; }
      let buf = '';
      res.on('data', (c) => { buf += c.toString('utf8'); });
      res.on('end', () => resolve(buf));
    });
    req.on('error', reject);
    req.end();
  });
}

function fetchFile(url, dest) {
  return new Promise((resolve, reject) => {
    const req = net.request(url);
    req.on('response', (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error('HTTP ' + res.statusCode)); return; }
      const total = Number(res.headers['content-length'] || 0);
      let got = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (c) => {
        got += c.length;
        out.write(c);
        if (total) send('update:progress', { percent: Math.round((got / total) * 100) });
      });
      res.on('end', () => out.end(() => resolve()));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

async function checkUpdate(manual) {
  const base = String(prefs.updateUrl || '').trim();
  if (!base) {
    if (manual) send('update:error', { message: '업데이트 위치가 설정되어 있지 않습니다. ☰ → 업데이트 설정에서 지정하세요.' });
    return;
  }
  try {
    const txt = isHttp(base)
      ? await fetchText(joinUrl(base, 'latest.json'))
      : fs.readFileSync(path.join(base, 'latest.json'), 'utf8');
    const info = JSON.parse(txt.replace(/^\uFEFF/, ''));
    if (!info || !info.version || !info.file) throw new Error('latest.json 내용이 올바르지 않습니다');
    prefs.lastCheck = Date.now();
    savePrefs();
    if (cmpVer(info.version, app.getVersion()) > 0) {
      updateInfo = info;
      send('update:available', { version: info.version, notes: info.notes || '', date: info.date || '' });
    } else {
      updateInfo = null;
      if (manual) send('update:none', { version: app.getVersion() });
    }
  } catch (e) {
    if (manual) send('update:error', { message: e.message });
  }
}

async function applyUpdate() {
  if (!updateInfo || updateBusy) return;
  updateBusy = true;
  const base = String(prefs.updateUrl || '').trim();
  const dir = path.join(app.getPath('userData'), 'update');
  try {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 없으면 무시 */ }
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, updateInfo.file);
    send('update:progress', { percent: 0, state: 'download' });
    if (isHttp(base)) await fetchFile(joinUrl(base, updateInfo.file), dest);
    else fs.copyFileSync(path.join(base, updateInfo.file), dest);

    // 포터블이면 실행 파일을 교체하고, 설치본이면 받아온 설치 프로그램을 실행한다
    const portable = process.env.PORTABLE_EXECUTABLE_FILE;
    if (portable) {
      const bat = path.join(dir, 'apply-update.cmd');
      fs.writeFileSync(bat, [
        '@echo off',
        'title JJangditer Update',
        'echo Updating...',
        'set "SRC=%~1"',
        'set "DST=%~2"',
        'set /a n=0',
        ':retry',
        'set /a n+=1',
        'copy /y "%SRC%" "%DST%" >nul 2>&1',
        'if not errorlevel 1 goto ok',
        'if %n% geq 40 goto fail',
        'ping -n 2 127.0.0.1 >nul',
        'goto retry',
        ':ok',
        'start "" "%DST%"',
        'del "%~f0" >nul 2>&1',
        'exit /b 0',
        ':fail',
        'echo.',
        'echo Update failed - the program file is still in use.',
        'echo Copy it manually:',
        'echo   from: %SRC%',
        'echo     to: %DST%',
        'pause',
        'exit /b 1'
      ].join('\r\n'), 'ascii');
      spawn('cmd.exe', ['/c', bat, dest, portable], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn(dest, [], { detached: true, stdio: 'ignore' }).unref();
    }
    quitting = true;
    setTimeout(() => app.quit(), 300);
  } catch (e) {
    updateBusy = false;
    send('update:error', { message: '업데이트 실패: ' + e.message });
  }
}

function scheduleUpdateChecks() {
  if (!prefs.autoUpdate || !String(prefs.updateUrl || '').trim()) return;
  setTimeout(() => checkUpdate(false), 8000);
  setInterval(() => { if (prefs.autoUpdate) checkUpdate(false); }, UPDATE_EVERY);
}

/* ---------- IPC ---------- */
function registerIpc() {
  ipcMain.handle('win:getState', () => ({
    pinned: prefs.pinned, collapsed: collapsed, width: prefs.width,
    theme: prefs.theme, hideDelay: prefs.hideDelay, strip: STRIP,
    lowResource: prefs.lowResource,
    version: app.getVersion(), dataDir: app.getPath('userData')
  }));

  ipcMain.handle('win:setPinned', (_e, v) => {
    prefs.pinned = !!v; savePrefs();
    if (prefs.pinned) { expandPanel(); if (win && !win.isDestroyed()) win.focus(); }
    else collapsePanel();
    sendState();
    return prefs.pinned;
  });

  ipcMain.handle('win:expand', () => {
    if (collapsed && Date.now() - lastCollapseAt < 350) return;   // 방금 접혔으면 무시
    setCollapsed(false);
  });
  ipcMain.handle('win:collapse', () => { if (!prefs.pinned) setCollapsed(true); });

  ipcMain.handle('win:setWidth', (_e, w) => {
    prefs.width = clamp(Math.round(w), MIN_W, MAX_W);
    savePrefs();
    if (!collapsed) setBoundsSafe(panelBounds(prefs.width));
    sendState();
    return prefs.width;
  });

  ipcMain.handle('win:nextDisplay', () => {
    const all = screen.getAllDisplays();
    if (all.length < 2) return { count: 1, name: '모니터 1' };
    const curId = String(targetDisplay().id);
    const i = all.findIndex((d) => String(d.id) === curId);
    const idx = (i + 1) % all.length;
    const next = all[idx];
    prefs.displayId = next.id;
    savePrefs();
    if (trigger && !trigger.isDestroyed()) createTrigger();
    collapsed = false;
    hideTrigger();
    if (win && !win.isDestroyed()) {
      if (!win.isVisible()) win.show();
      setBoundsSafe(panelBounds(prefs.width));
      win.focus();
    }
    sendState();
    return {
      count: all.length, index: idx + 1,
      name: '모니터 ' + (idx + 1) + ' (' + next.bounds.width + '×' + next.bounds.height + ')'
    };
  });

  ipcMain.handle('win:hide', () => {
    if (win && !win.isDestroyed()) win.hide();
    hideTrigger();
  });
  ipcMain.handle('win:quit', () => { quitting = true; app.quit(); });
  ipcMain.handle('win:focus', () => { if (win && !win.isDestroyed()) win.focus(); });

  ipcMain.handle('prefs:set', (_e, patch) => {
    Object.assign(prefs, patch || {});
    prefs.width = clamp(prefs.width, MIN_W, MAX_W);
    savePrefs();
    sendState();
    return prefs;
  });

  ipcMain.handle('clip:write', (_e, text) => {
    clipboard.writeText(text == null ? '' : String(text));
    return true;
  });

  ipcMain.handle('store:load', () => loadWorkspace());
  ipcMain.handle('store:save', (_e, data) => saveWorkspace(data));

  ipcMain.handle('file:exportTab', async (_e, arg) => {
    const name = String((arg && arg.name) || 'tab').replace(/[\\/:*?"<>|]/g, '_');
    const r = await dialog.showSaveDialog(win, {
      title: '탭 내보내기',
      defaultPath: defaultPathFor(name + '.jjt'),
      filters: [{ name: '짱디터 탭', extensions: ['jjt'] }, { name: 'JSON', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false };
    rememberDir(r.filePath);
    return { ok: writeJson(r.filePath, arg.payload), path: r.filePath };
  });

  ipcMain.handle('file:exportAll', async (_e, payload) => {
    const r = await dialog.showSaveDialog(win, {
      title: '전체 내보내기',
      defaultPath: defaultPathFor('jjangditer-workspace.jjw'),
      filters: [{ name: '짱디터 워크스페이스', extensions: ['jjw'] }, { name: 'JSON', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false };
    rememberDir(r.filePath);
    return { ok: writeJson(r.filePath, payload), path: r.filePath };
  });

  ipcMain.handle('file:import', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '불러오기',
      defaultPath: prefs.lastDir || undefined,
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '짱디터 파일', extensions: ['jjt', 'jjw', 'json'] },
        { name: '모든 파일', extensions: ['*'] }
      ]
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, items: [] };
    rememberDir(r.filePaths[0]);
    const items = [];
    for (const f of r.filePaths) {
      const data = readJson(f, null);
      if (data) items.push({ file: path.basename(f), data: data });
    }
    return { ok: items.length > 0, items: items };
  });

  ipcMain.handle('file:exportText', async (_e, arg) => {
    const name = String((arg && arg.name) || 'checklist').replace(/[\\/:*?"<>|]/g, '_');
    const r = await dialog.showSaveDialog(win, {
      title: '텍스트로 저장',
      defaultPath: defaultPathFor(name + '.md'),
      filters: [{ name: 'Markdown', extensions: ['md'] }, { name: '텍스트', extensions: ['txt'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false };
    rememberDir(r.filePath);
    try {
      fs.writeFileSync(r.filePath, arg.text, 'utf8');
      return { ok: true, path: r.filePath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('ui:confirm', async (_e, arg) => {
    arg = arg || {};
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: [arg.okLabel || '확인', '취소'],
      defaultId: 0, cancelId: 1,
      message: arg.message || '진행할까요?',
      detail: arg.detail || ''
    });
    return r.response === 0;
  });

  ipcMain.handle('ui:openDataDir', () => shell.openPath(app.getPath('userData')));

  // 윈도우 시작 시 자동 실행 (부팅할 때 한 번만 뜨고 하루 종일 트레이에 상주)
  const exePath = () => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  ipcMain.handle('startup:get', () => {
    try { return app.getLoginItemSettings({ path: exePath() }).openAtLogin; }
    catch (e) { return false; }
  });
  ipcMain.handle('startup:set', (_e, on) => {
    try {
      app.setLoginItemSettings({ openAtLogin: !!on, path: exePath(), args: [] });
      return app.getLoginItemSettings({ path: exePath() }).openAtLogin;
    } catch (e) { return false; }
  });

  ipcMain.handle('update:check', () => checkUpdate(true));
  ipcMain.handle('update:apply', () => applyUpdate());
  ipcMain.handle('update:config', (_e, patch) => {
    if (patch && typeof patch.updateUrl === 'string') prefs.updateUrl = patch.updateUrl.trim();
    if (patch && typeof patch.autoUpdate === 'boolean') prefs.autoUpdate = patch.autoUpdate;
    savePrefs();
    return { updateUrl: prefs.updateUrl, autoUpdate: prefs.autoUpdate };
  });
  ipcMain.handle('update:info', () => ({
    version: app.getVersion(),
    updateUrl: prefs.updateUrl,
    autoUpdate: prefs.autoUpdate,
    lowResource: prefs.lowResource,
    pending: updateInfo ? updateInfo.version : null
  }));
  ipcMain.handle('ui:browseFolder', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '업데이트 배포 폴더 선택',
      properties: ['openDirectory']
    });
    return (r.canceled || !r.filePaths.length) ? null : r.filePaths[0];
  });
}

/* ---------- 앱 라이프사이클 ---------- */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 설정은 창을 만들기 전에 읽어야 한다 (아래 최적화 스위치는 ready 이전에만 적용됨)
  loadPrefs();

  /* 자원 사용 줄이기 */
  app.commandLine.appendSwitch('js-flags', '--max-old-space-size=128 --max-semi-space-size=2');
  app.commandLine.appendSwitch('disable-features',
    'HardwareMediaKeyHandling,MediaSessionService,Translate,AutofillServerCommunication,OptimizationHints');
  app.commandLine.appendSwitch('disable-renderer-accessibility');
  if (prefs.lowResource) app.disableHardwareAcceleration();

  app.on('second-instance', () => showPanel());

  app.whenReady().then(() => {
    registerIpc();
    createWindow();
    if (!prefs.pinned) createTrigger();
    createTray();
    scheduleUpdateChecks();
    globalShortcut.register('Alt+Shift+J', () => {
      if (!win || win.isDestroyed()) { createWindow(); return; }
      if (collapsed || !win.isVisible()) showPanel();
      else if (!prefs.pinned) collapsePanel();
      else win.focus();
    });
  });

  app.on('window-all-closed', () => { /* 트레이에 남아있음 */ });
  app.on('before-quit', () => {
    quitting = true;
    stopAnim();
    globalShortcut.unregisterAll();
    if (trigger && !trigger.isDestroyed()) trigger.destroy();
  });
}
