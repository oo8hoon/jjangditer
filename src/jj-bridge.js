/* 짱디터 - 화면(JS) ↔ 호스트(C#) 다리
 *
 * Electron 으로 실행할 때는 preload.js 가 이미 window.jj 를 만들어 두므로 아무 것도 하지 않는다.
 * WebView2 호스트에서 실행할 때만 window.chrome.webview 를 통해 같은 모양의 window.jj 를 만든다.
 */
(function () {
  'use strict';
  if (window.jj) return;                                   // Electron 판
  if (!window.chrome || !window.chrome.webview) return;    // 둘 다 아니면 그대로 둔다

  const wv = window.chrome.webview;
  const pending = new Map();
  const stateCbs = [];
  const updateCbs = [];
  const fifCbs = [];
  const fdCbs = [];
  let seq = 0;

  wv.addEventListener('message', function (e) {
    const m = e.data;
    if (!m || typeof m !== 'object') return;

    if (m.ev === 'state') { stateCbs.forEach(function (cb) { cb(m.d); }); return; }
    if (m.ev === 'update') { updateCbs.forEach(function (cb) { cb(m.k, m.d); }); return; }
    if (m.ev === 'fif') { fifCbs.forEach(function (cb) { cb(m.k, m.d); }); return; }
    if (m.ev === 'fd') { fdCbs.forEach(function (cb) { cb(m.k, m.d); }); return; }

    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.e) p.reject(new Error(m.e));
    else p.resolve(m.r);
  });

  function call(method) {
    const args = Array.prototype.slice.call(arguments, 1);
    return new Promise(function (resolve, reject) {
      const id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      wv.postMessage({ id: id, m: method, a: args });
    });
  }

  const parse = (s) => {
    if (s == null) return null;
    try { return JSON.parse(s); } catch (e) { return null; }
  };

  window.jj = {
    getState: () => call('getState'),
    onState: (cb) => { stateCbs.push(cb); },

    setPinned: (v) => call('setPinned', !!v),
    expand: () => call('expand'),
    collapse: () => call('collapse'),
    setWidth: (w) => call('setWidth', Math.round(w)),
    toggleMax: () => call('toggleMax'),
    nextDisplay: () => call('nextDisplay'),
    dragWindow: () => call('dragWindow'),
    hide: () => call('hide'),
    quit: () => call('quit'),
    focus: () => call('focus'),

    setPrefs: (p) => call('setPrefs', p),
    copy: (t) => call('copy', t == null ? '' : String(t)),
    paste: () => call('paste'),
    findShow: (mode, preset) => call('findShow', mode || 'find', preset || null),
    findHide: () => call('findHide'),
    findStatus: (t, bad) => call('findStatus', t || '', !!bad),
    findOpts: () => call('findOpts'),
    findVisible: () => call('findVisible'),
    onFindDlg: (cb) => { fdCbs.push(cb); },
    myTemplates: () => call('myTemplates'),
    readTemplate: (p) => call('readTemplate', p),
    saveTemplate: (n, j) => call('saveTemplate', n, j),
    openTemplateDir: () => call('openTemplateDir'),

    load: () => call('load').then(parse),
    save: (d) => call('save', JSON.stringify(d)),

    exportTab: (name, payload) => call('exportTab', name, JSON.stringify(payload, null, 2)),
    exportAll: (payload) => call('exportAll', JSON.stringify(payload, null, 2)),
    exportText: (name, text) => call('exportText', name, text),
    openText: () => call('openText'),
    readText: (path) => call('readText', path),
    saveTextAs: (name, text, enc) => call('saveTextAs', name, text, enc || null),
    saveTextTo: (path, text, enc) => call('saveTextTo', path, text, enc || null),
    import: () => call('import').then(function (r) {
      if (!r || !r.ok) return { ok: false, items: [] };
      return {
        ok: true,
        items: (r.items || []).map(function (it) { return { file: it.file, data: parse(it.data) }; })
                              .filter(function (it) { return !!it.data; })
      };
    }),

    confirm: (message, detail, okLabel) => call('confirm', message, detail, okLabel),
    openDataDir: () => call('openDataDir'),
    browseFolder: (title, start) => call('browseFolder', title || null, start || null),
    findInFiles: (opt) => call('findInFiles', opt),
    findInFilesCancel: () => call('findInFilesCancel'),
    confirm3: (message, detail) => call('confirm3', message, detail),

    getStartup: () => call('getStartup'),
    setStartup: (v) => call('setStartup', !!v),

    checkUpdate: () => call('checkUpdate'),
    applyUpdate: () => call('applyUpdate'),
    updateInfo: () => call('updateInfo'),
    updateConfig: (p) => call('updateConfig', p),
    onUpdate: (cb) => { updateCbs.push(cb); },
    onFindProgress: (cb) => { fifCbs.push(cb); }
  };
})();
