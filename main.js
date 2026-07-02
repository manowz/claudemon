const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage } = require('electron');
const path = require('path');
const config = require('./src/config');
const oauth = require('./src/oauth');
const { fetchUsage, fetchProfile } = require('./src/usage');

const POLL_MS = 2 * 60 * 1000;      // consulta a cada 2 min
const POLL_MAX_MS = 15 * 60 * 1000; // teto do backoff em caso de 429

let win = null;
let tray = null;
let pkce = null;        // PKCE do login em andamento
let pollTimer = null;
let pollDelay = POLL_MS;
let profile = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (win) { win.show(); win.focus(); }
});

// ---- tokens -----------------------------------------------------------------

async function ensureAccessToken(forceRefresh = false) {
  let t = config.getTokens();
  if (!t) throw authError('sem login');

  const valid = t.accessToken && Date.now() < (t.expiresAt || 0) - 60 * 1000;
  if (valid && !forceRefresh) return t.accessToken;

  if (t.source === 'claude-code') {
    // Nunca rotacionamos o refresh token do Claude Code: só relemos o arquivo,
    // que o próprio Claude Code atualiza quando é usado.
    const fresh = oauth.readClaudeCodeCreds();
    if (fresh && Date.now() < fresh.expiresAt - 60 * 1000) {
      config.setTokens(fresh);
      return fresh.accessToken;
    }
    throw authError('token do Claude Code expirou — abra o Claude Code uma vez ou use "Conectar com Claude"');
  }

  if (!t.refreshToken) throw authError('sessão expirou — conecte de novo');
  const renewed = await oauth.refreshTokens(t.refreshToken);
  config.setTokens(renewed);
  return renewed.accessToken;
}

function authError(msg) {
  const e = new Error(msg);
  e.authRequired = true;
  return e;
}

async function getUsageAuthed() {
  let token = await ensureAccessToken();
  try {
    return await fetchUsage(token);
  } catch (e) {
    if (e.status === 401) {
      token = await ensureAccessToken(true); // força refresh/releitura e tenta 1x
      return fetchUsage(token);
    }
    throw e;
  }
}

// ---- polling ----------------------------------------------------------------

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

function schedulePoll(delay = pollDelay) {
  stopPolling();
  pollTimer = setTimeout(pollOnce, delay);
}

async function pollOnce() {
  try {
    const data = await getUsageAuthed();
    pollDelay = POLL_MS;
    send('usage:update', { ok: true, data, at: Date.now() });
  } catch (e) {
    if (e.authRequired) {
      send('auth:required', { message: e.message });
      return; // para de sondar até logar de novo
    }
    if (e.status === 429) pollDelay = Math.min(pollDelay * 2, POLL_MAX_MS);
    send('usage:update', { ok: false, error: e.message, at: Date.now() });
  }
  schedulePoll();
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---- janela / tray ----------------------------------------------------------

function createWindow() {
  const bounds = config.get('bounds');
  win = new BrowserWindow({
    width: 340,
    height: 404,
    x: bounds?.x,
    y: bounds?.y,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: config.get('alwaysOnTop', true),
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // nível 'screen-saver' mantém o widget acima até de janelas fullscreen
  if (config.get('alwaysOnTop', true)) win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('moved', () => config.set('bounds', win.getBounds()));
  win.on('closed', () => { win = null; });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('Claudemon — consumo do Claude');
  const rebuild = () => {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Atualizar agora', click: () => pollOnce() },
      { label: 'Trocar Pokémon', click: () => send('pokemon:reroll') },
      { type: 'separator' },
      {
        label: 'Sempre visível',
        type: 'checkbox',
        checked: config.get('alwaysOnTop', true),
        click: (item) => {
          config.set('alwaysOnTop', item.checked);
          if (win) win.setAlwaysOnTop(item.checked, 'screen-saver');
        },
      },
      {
        label: 'Iniciar com o sistema',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked });
          rebuild();
        },
      },
      { type: 'separator' },
      { label: 'Sair', click: () => app.quit() },
    ]));
  };
  rebuild();
  tray.on('click', () => { if (win) { win.show(); win.focus(); } });
}

// ---- IPC ---------------------------------------------------------------------

ipcMain.handle('state:get', () => {
  const t = config.getTokens();
  return {
    authenticated: !!t,
    source: t?.source || null,
    hasClaudeCodeCreds: oauth.hasClaudeCodeCreds(),
    email: profile?.email || null,
    lastPokemonId: config.get('lastPokemonId', null),
  };
});

ipcMain.handle('auth:claude-code', async () => {
  const creds = oauth.readClaudeCodeCreds();
  if (!creds) throw new Error('credenciais do Claude Code não encontradas');
  config.setTokens(creds);
  const data = await getUsageAuthed();
  profile = await fetchProfile(creds.accessToken);
  schedulePoll();
  return { data, email: profile?.email || null };
});

ipcMain.handle('auth:start', () => {
  pkce = oauth.createPkce();
  const url = oauth.buildAuthorizeUrl(pkce);
  shell.openExternal(url);
  return url;
});

ipcMain.handle('auth:finish', async (_e, pasted) => {
  if (!pkce) throw new Error('fluxo de login não iniciado');
  const tokens = await oauth.exchangeCode(pasted, pkce);
  pkce = null;
  config.setTokens(tokens);
  const data = await getUsageAuthed();
  profile = await fetchProfile(tokens.accessToken);
  schedulePoll();
  return { data, email: profile?.email || null };
});

ipcMain.handle('usage:get', async () => {
  const data = await getUsageAuthed();
  schedulePoll(); // reinicia o relógio do polling
  return data;
});

ipcMain.handle('auth:logout', () => {
  config.setTokens(null);
  profile = null;
  stopPolling();
});

ipcMain.handle('pokemon:save', (_e, id) => config.set('lastPokemonId', id));
ipcMain.handle('app:quit', () => app.quit());

// ---- configurações (lembretes, som, sempre visível) ---------------------------

const DEFAULT_SETTINGS = { waterMin: 45, standMin: 60, breakMin: 90, sound: true, pokemon: '', pokemonId: null };

ipcMain.handle('settings:get', () => ({
  ...DEFAULT_SETTINGS,
  ...(config.get('settings', {}) || {}),
  alwaysOnTop: config.get('alwaysOnTop', true),
}));

ipcMain.handle('settings:set', (_e, s) => {
  const { alwaysOnTop, ...rest } = s || {};
  config.set('settings', { ...DEFAULT_SETTINGS, ...(config.get('settings', {}) || {}), ...rest });
  if (typeof alwaysOnTop === 'boolean') {
    config.set('alwaysOnTop', alwaysOnTop);
    if (win) win.setAlwaysOnTop(alwaysOnTop, 'screen-saver');
  }
});

// ---- ciclo de vida ------------------------------------------------------------

app.whenReady().then(() => {
  createWindow();
  createTray();
  if (config.getTokens()) schedulePoll(3000); // primeira leitura logo após abrir
});

app.on('window-all-closed', () => app.quit());
