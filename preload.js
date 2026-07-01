const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claudemon', {
  getState: () => ipcRenderer.invoke('state:get'),
  useClaudeCode: () => ipcRenderer.invoke('auth:claude-code'),
  startOAuth: () => ipcRenderer.invoke('auth:start'),
  finishOAuth: (code) => ipcRenderer.invoke('auth:finish', code),
  getUsage: () => ipcRenderer.invoke('usage:get'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  savePokemon: (id) => ipcRenderer.invoke('pokemon:save', id),
  quit: () => ipcRenderer.invoke('app:quit'),
  onUsage: (cb) => ipcRenderer.on('usage:update', (_e, p) => cb(p)),
  onAuthRequired: (cb) => ipcRenderer.on('auth:required', (_e, p) => cb(p)),
  onReroll: (cb) => ipcRenderer.on('pokemon:reroll', () => cb()),
});
