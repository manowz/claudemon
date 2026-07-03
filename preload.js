const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claudemon', {
  getState: () => ipcRenderer.invoke('state:get'),
  useClaudeCode: () => ipcRenderer.invoke('auth:claude-code'),
  startOAuth: () => ipcRenderer.invoke('auth:start'),
  finishOAuth: (code) => ipcRenderer.invoke('auth:finish', code),
  useCodexCli: () => ipcRenderer.invoke('auth:codex-cli'),
  startCodex: () => ipcRenderer.invoke('auth:codex-start'),
  cancelCodex: () => ipcRenderer.invoke('auth:codex-cancel'),
  getUsage: () => ipcRenderer.invoke('usage:get'),
  logout: (provider) => ipcRenderer.invoke('auth:logout', provider),
  savePokemon: (id) => ipcRenderer.invoke('pokemon:save', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:set', s),
  quit: () => ipcRenderer.invoke('app:quit'),
  onUsage: (cb) => ipcRenderer.on('usage:update', (_e, p) => cb(p)),
  onReroll: (cb) => ipcRenderer.on('pokemon:reroll', () => cb()),
});
