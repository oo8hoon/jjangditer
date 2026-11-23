'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jj', {
  getState: () => ipcRenderer.invoke('win:getState'),
  onState: (cb) => ipcRenderer.on('win:state', (_e, s) => cb(s)),

  setPinned: (v) => ipcRenderer.invoke('win:setPinned', v),
  expand: () => ipcRenderer.invoke('win:expand'),
  collapse: () => ipcRenderer.invoke('win:collapse'),
  setWidth: (w) => ipcRenderer.invoke('win:setWidth', w),
  toggleMax: () => Promise.resolve(false),
  nextDisplay: () => ipcRenderer.invoke('win:nextDisplay'),
  dragWindow: () => Promise.resolve(),   // Electron 은 CSS(-webkit-app-region) 로 처리됨
  hide: () => ipcRenderer.invoke('win:hide'),
  quit: () => ipcRenderer.invoke('win:quit'),
  focus: () => ipcRenderer.invoke('win:focus'),

  setPrefs: (p) => ipcRenderer.invoke('prefs:set', p),
  copy: (t) => ipcRenderer.invoke('clip:write', t),
  paste: () => Promise.resolve(''),
  openUrl: () => Promise.resolve(true),
  findShow: () => Promise.resolve({}),
  findHide: () => Promise.resolve(true),
  findStatus: () => Promise.resolve(true),
  findOpts: () => Promise.resolve({}),
  findVisible: () => Promise.resolve(false),
  onFindDlg: () => {},
  myTemplates: () => Promise.resolve({ ok: true, dir: '', items: [] }),
  readTemplate: () => Promise.resolve({ ok: false }),
  saveTemplate: () => Promise.resolve({ ok: false }),
  openTemplateDir: () => Promise.resolve(''),

  load: () => ipcRenderer.invoke('store:load'),
  save: (d) => ipcRenderer.invoke('store:save', d),

  exportTab: (name, payload) => ipcRenderer.invoke('file:exportTab', { name, payload }),
  exportAll: (payload) => ipcRenderer.invoke('file:exportAll', payload),
  exportText: (name, text) => ipcRenderer.invoke('file:exportText', { name, text }),
  openText: () => Promise.resolve({ ok: false, error: 'Electron 개발 모드에서는 지원하지 않습니다' }),
  readText: () => Promise.resolve({ ok: false, error: 'Electron 개발 모드에서는 지원하지 않습니다' }),
  saveTextAs: (name, text) => ipcRenderer.invoke('file:exportText', { name, text }),
  saveTextTo: () => Promise.resolve({ ok: false }),
  import: () => ipcRenderer.invoke('file:import'),

  confirm: (message, detail, okLabel) => ipcRenderer.invoke('ui:confirm', { message, detail, okLabel }),
  openDataDir: () => ipcRenderer.invoke('ui:openDataDir'),
  browseFolder: () => ipcRenderer.invoke('ui:browseFolder'),
  findInFiles: () => Promise.resolve({ ok: false, error: 'Electron 개발 모드에서는 지원하지 않습니다' }),
  findInFilesCancel: () => Promise.resolve(true),
  confirm3: (m, d) => ipcRenderer.invoke('ui:confirm', { message: m, detail: d }).then((ok) => (ok ? 'yes' : 'cancel')),
  onFindProgress: () => {},
  getStartup: () => ipcRenderer.invoke('startup:get'),
  setStartup: (v) => ipcRenderer.invoke('startup:set', v),

  checkUpdate: () => ipcRenderer.invoke('update:check'),
  applyUpdate: () => ipcRenderer.invoke('update:apply'),
  updateInfo: () => ipcRenderer.invoke('update:info'),
  updateConfig: (p) => ipcRenderer.invoke('update:config', p),
  onUpdate: (cb) => {
    ipcRenderer.on('update:available', (_e, d) => cb('available', d));
    ipcRenderer.on('update:none', (_e, d) => cb('none', d));
    ipcRenderer.on('update:error', (_e, d) => cb('error', d));
    ipcRenderer.on('update:progress', (_e, d) => cb('progress', d));
  }
});
