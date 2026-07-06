const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const config = require('./src/config');
const oauth = require('./src/oauth');
const codex = require('./src/codex');
const { fetchUsage } = require('./src/usage');

const POLL_MS = 2 * 60 * 1000;      // consulta a cada 2 min
const POLL_MAX_MS = 15 * 60 * 1000; // teto do backoff em caso de 429

let win = null;
let tray = null;
let pkce = null;        // PKCE do login Claude em andamento
let pollTimer = null;
let pollDelay = POLL_MS;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (win) { win.show(); win.focus(); }
});

// ---- tokens -----------------------------------------------------------------

// Fontes "atalho de CLI": só relemos o arquivo do CLI — nunca usamos o refresh
// token dele (a rotação derrubaria a sessão do CLI dono do arquivo).
const CLI_SOURCES = {
  'claude-code': {
    read: () => oauth.readClaudeCodeCreds(),
    expired: 'token do Claude Code expirou — abra o Claude Code uma vez ou use "Conectar com Claude"',
  },
  'codex-cli': {
    read: () => codex.readCodexCliCreds(),
    expired: 'token do Codex expirou — use o Codex CLI uma vez ou "Conectar com Codex"',
  },
};

// Conta conectada pelo atalho de um CLI (relemos o arquivo dele, sem refresh próprio)?
function isCliAccount(provider) {
  const a = config.getAccount(provider);
  return !!(a && CLI_SOURCES[a.source]);
}

const refreshing = {}; // provider -> Promise do refresh em voo

// Garante tokens válidos do provedor e devolve o registro completo.
async function ensureAccessToken(provider, forceRefresh = false) {
  const t = config.getAccount(provider);
  if (!t) throw authError('sem login');

  const valid = t.accessToken && Date.now() < (t.expiresAt || 0) - 60 * 1000;
  if (valid && !forceRefresh) return t;

  const cli = CLI_SOURCES[t.source];
  if (cli) {
    const fresh = cli.read();
    if (fresh && Date.now() < fresh.expiresAt - 60 * 1000) {
      config.setAccount(provider, fresh);
      return fresh;
    }
    throw authError(cli.expired);
  }

  if (!t.refreshToken) throw authError('sessão expirou — conecte de novo');
  // Trava por provedor: dois chamadores concorrentes (boot + poll) compartilham
  // o MESMO refresh — o refresh token do Codex rotaciona com detecção de reuso,
  // e dois POSTs com o mesmo token derrubariam a sessão inteira.
  if (!refreshing[provider]) {
    refreshing[provider] = (async () => {
      try {
        const renewed = provider === 'codex'
          ? await codex.refreshTokens(t)
          : await oauth.refreshTokens(t.refreshToken);
        // logout pode ter acontecido durante o await — não recria a conta
        if (!config.getAccount(provider)) throw authError('sem login');
        config.setAccount(provider, renewed);
        return renewed;
      } catch (e) {
        // refresh rejeitado pelo servidor (token revogado/rotacionado) = relogar
        if (e.status === 400 || e.status === 401) throw authError('sessão expirou — conecte de novo');
        throw e;
      } finally {
        delete refreshing[provider];
      }
    })();
  }
  return refreshing[provider];
}

function authError(msg) {
  const e = new Error(msg);
  e.authRequired = true;
  return e;
}

// Consulta o usage de um provedor.
async function getUsageAuthed(provider) {
  const doFetch = (t) => (provider === 'codex'
    ? codex.fetchUsage(t.accessToken, t.accountId)
    : fetchUsage(t.accessToken));
  try {
    return await doFetch(await ensureAccessToken(provider));
  } catch (e) {
    if (e.status !== 401) throw e;
    try {
      return await doFetch(await ensureAccessToken(provider, true)); // força refresh/releitura e tenta 1x
    } catch (e2) {
      // ainda 401 com token "válido" localmente = revogado no servidor → relogar
      if (e2.status === 401) throw authError('sessão inválida — conecte de novo');
      throw e2;
    }
  }
}

// Sessões que falharam com authRequired entram em quarentena por 10 min:
// sem isso, um refresh token revogado geraria POSTs no endpoint de token a
// cada poll de 2 min, para sempre. Refresh manual (força) ignora a quarentena.
// Contas via atalho de CLI ficam de fora: renovar é só reler um arquivo local
// (custo zero), e a quarentena atrasaria a recuperação depois que o CLI roda.
const AUTH_FAIL_COOLDOWN_MS = 10 * 60 * 1000;
const authFail = {}; // provider -> { until, result }

// Consulta todos os provedores conectados; nunca rejeita — erros vão por item.
async function fetchAllUsage(force = false) {
  const out = {};
  await Promise.all(Object.keys(config.getAccounts()).map(async (p) => {
    if (!force && authFail[p] && authFail[p].until > Date.now()) {
      out[p] = authFail[p].result;
      return;
    }
    try {
      out[p] = { ok: true, data: await getUsageAuthed(p), at: Date.now() };
      delete authFail[p];
    } catch (e) {
      out[p] = {
        ok: false,
        error: e.message,
        authRequired: !!e.authRequired,
        status: e.status,
        at: Date.now(),
      };
      if (e.authRequired && !isCliAccount(p)) {
        authFail[p] = { until: Date.now() + AUTH_FAIL_COOLDOWN_MS, result: out[p] };
      }
    }
  }));
  return out;
}

// Epílogo comum dos fluxos de login: persiste tokens, primeira leitura, polling.
async function finishLogin(provider, tokens) {
  config.setAccount(provider, tokens);
  delete authFail[provider];
  try {
    const data = await getUsageAuthed(provider);
    // push imediato: se o renderer recarregou no meio do login (a resposta do
    // invoke se perde), ele ainda fica sabendo da conta nova agora
    send('usage:update', { [provider]: { ok: true, data, at: Date.now() } });
    schedulePoll();
    return { provider, data };
  } catch (e) {
    if (e.authRequired) {
      config.setAccount(provider, null); // credencial inútil — desfaz o login
      throw e;
    }
    schedulePoll(); // conta válida, leitura falhou (429/rede) — o polling recupera
    return { provider, data: null, error: e.message };
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
  const results = await fetchAllUsage();
  const provs = Object.keys(results);
  if (!provs.length) { stopPolling(); return; } // sem contas = nada a sondar
  // um único evento com o mapa completo: o renderer avalia um retrato
  // consistente (nada de decidir "tudo expirou" com metade dos resultados)
  send('usage:update', results);
  pollDelay = provs.some((p) => results[p].status === 429)
    ? Math.min(pollDelay * 2, POLL_MAX_MS)
    : POLL_MS;
  schedulePoll();
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---- vigia das credenciais de CLI ---------------------------------------------

// Quem renova o token dos atalhos de CLI é o próprio CLI, quando é usado — no
// boot do Windows o token da véspera já expirou e o widget ficaria "expirado"
// até o próximo poll DEPOIS de o usuário rodar o CLI. Vigiando o arquivo de
// credenciais, a recuperação é imediata: o CLI grava tokens novos, sondamos na hora.
function watchCliCreds(provider, credsFile) {
  let timer = null;
  try {
    // vigia o diretório: CLIs regravam o arquivo por rename e um watch direto
    // no arquivo morreria na primeira renovação
    fs.watch(path.dirname(credsFile), (_ev, name) => {
      if (name && name !== path.basename(credsFile)) return;
      if (!isCliAccount(provider)) return;
      clearTimeout(timer); // debounce: uma gravação gera vários eventos
      timer = setTimeout(() => {
        delete authFail[provider];
        pollOnce();
      }, 1000);
    });
  } catch {
    // pasta não existe (CLI nunca logado nesta máquina) — sem o que vigiar
  }
}

// ---- iniciar com o sistema ----------------------------------------------------

// O build portátil roda extraído numa pasta temporária: o registro de startup
// precisa apontar pro exe original (PORTABLE_EXECUTABLE_FILE), não pro extraído.
const LOGIN_PATH = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;

function getLaunchAtStartup() {
  return app.getLoginItemSettings({ path: LOGIN_PATH }).openAtLogin;
}

// O SO (registro/Login Items) é a fonte da verdade; config.launchAtStartup só
// registra a escolha pra sabermos que o padrão da primeira execução já foi aplicado.
function setLaunchAtStartup(enabled) {
  app.setLoginItemSettings({ openAtLogin: enabled, path: LOGIN_PATH });
  config.set('launchAtStartup', enabled);
  if (rebuildTray) rebuildTray();
}

// ---- janela / tray ----------------------------------------------------------

function createWindow() {
  const bounds = config.get('bounds');
  win = new BrowserWindow({
    width: 340,
    height: 464,
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

let rebuildTray = null;

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('Claudemon — consumo do Claude/Codex');
  rebuildTray = () => {
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
        checked: getLaunchAtStartup(),
        click: (item) => setLaunchAtStartup(item.checked),
      },
      { type: 'separator' },
      { label: 'Sair', click: () => app.quit() },
    ]));
  };
  rebuildTray();
  tray.on('click', () => { if (win) { win.show(); win.focus(); } });
}

// ---- IPC ---------------------------------------------------------------------

ipcMain.handle('state:get', () => {
  const accounts = config.getAccounts();
  return {
    connected: { claude: !!accounts.claude, codex: !!accounts.codex },
    hasClaudeCodeCreds: oauth.hasClaudeCodeCreds(),
    hasCodexCliCreds: codex.hasCodexCliCreds(),
    lastPokemonId: config.get('lastPokemonId', null),
  };
});

ipcMain.handle('auth:claude-code', async () => {
  const creds = oauth.readClaudeCodeCreds();
  if (!creds) throw new Error('credenciais do Claude Code não encontradas');
  return finishLogin('claude', creds);
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
  return finishLogin('claude', tokens);
});

// ---- Codex ---------------------------------------------------------------

ipcMain.handle('auth:codex-cli', async () => {
  const creds = codex.readCodexCliCreds();
  if (!creds) throw new Error('credenciais do Codex CLI não encontradas');
  return finishLogin('codex', creds);
});

let codexLogin = null; // fluxo OAuth do Codex em andamento

ipcMain.handle('auth:codex-start', async () => {
  if (codexLogin) codexLogin.cancel();
  const login = codex.startLogin();
  codexLogin = login;
  login.promise.catch(() => {}); // rejeição antes do await abaixo não pode virar unhandled
  try {
    await login.ready; // só manda pro navegador com a porta de callback aberta
    shell.openExternal(login.authUrl);
    const tokens = await login.promise;
    return await finishLogin('codex', tokens);
  } finally {
    // um login novo pode já ter substituído este — só limpa se ainda for o nosso
    if (codexLogin === login) codexLogin = null;
  }
});

ipcMain.handle('auth:codex-cancel', () => {
  if (codexLogin) codexLogin.cancel();
  codexLogin = null;
});

ipcMain.handle('usage:get', async () => {
  const results = await fetchAllUsage(true); // refresh manual fura a quarentena
  schedulePoll(); // reinicia o relógio do polling
  return results;
});

ipcMain.handle('auth:logout', (_e, provider) => {
  config.setAccount(provider, null);
  delete authFail[provider];
  if (!Object.keys(config.getAccounts()).length) stopPolling();
});

ipcMain.handle('pokemon:save', (_e, id) => config.set('lastPokemonId', id));
ipcMain.handle('app:quit', () => app.quit());

// ---- configurações (lembretes, som, sempre visível) ---------------------------

const DEFAULT_SETTINGS = { waterMin: 45, standMin: 60, breakMin: 90, usageAlertPct: 50, sound: true, pokemon: '', pokemonId: null };

ipcMain.handle('settings:get', () => ({
  ...DEFAULT_SETTINGS,
  ...(config.get('settings', {}) || {}),
  alwaysOnTop: config.get('alwaysOnTop', true),
  launchAtStartup: getLaunchAtStartup(),
}));

ipcMain.handle('settings:set', (_e, s) => {
  const { alwaysOnTop, launchAtStartup, ...rest } = s || {};
  config.set('settings', { ...DEFAULT_SETTINGS, ...(config.get('settings', {}) || {}), ...rest });
  if (typeof alwaysOnTop === 'boolean') {
    config.set('alwaysOnTop', alwaysOnTop);
    if (win) win.setAlwaysOnTop(alwaysOnTop, 'screen-saver');
  }
  if (typeof launchAtStartup === 'boolean' && launchAtStartup !== getLaunchAtStartup()) {
    setLaunchAtStartup(launchAtStartup);
  }
});

// ---- ciclo de vida ------------------------------------------------------------

app.whenReady().then(() => {
  // primeira execução do app instalado: liga "iniciar com o sistema" por padrão
  // (só empacotado e não-portátil — em dev registraria o electron.exe, e no
  // portátil quem decide é o usuário, já que o exe pode viver num pendrive)
  if (app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE
      && config.get('launchAtStartup') === null) {
    setLaunchAtStartup(true);
  }
  createWindow();
  createTray();
  watchCliCreds('claude', oauth.claudeCodeCredsPath());
  watchCliCreds('codex', codex.codexAuthPath());
  if (Object.keys(config.getAccounts()).length) schedulePoll(3000); // primeira leitura logo após abrir
});

app.on('window-all-closed', () => app.quit());
