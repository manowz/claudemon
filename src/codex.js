// Conexão com o OpenAI Codex (plano ChatGPT) — mesmo fluxo OAuth+PKCE do Codex CLI,
// com callback local em http://localhost:1455/auth/callback.
// ATENÇÃO: endpoints internos, não documentados oficialmente. Podem mudar sem aviso.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createPkce } = require('./oauth'); // mesmo PKCE do fluxo Claude

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'; // client público do Codex CLI
const ISSUER = 'https://auth.openai.com';
const PORT = 1455; // porta do redirect_uri registrado p/ esse client — não trocar
const REDIRECT_URI = `http://localhost:${PORT}/auth/callback`;
const SCOPES = 'openid profile email offline_access';
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
// O backend espera parecer o CLI oficial (originator/User-Agent do codex_cli_rs).
const ORIGINATOR = 'codex_cli_rs';
const USER_AGENT = 'codex_cli_rs/0.48.0';
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

// ---- JWT (só o payload; sem validar assinatura — uso local) -----------------

function jwtPayload(jwt) {
  try {
    return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}

// Claims úteis do id_token/access_token: conta, e-mail, plano e expiração.
function claimsInfo(idToken, accessToken) {
  const id = jwtPayload(idToken) || {};
  const ac = jwtPayload(accessToken) || {};
  const auth = id['https://api.openai.com/auth'] || ac['https://api.openai.com/auth'] || {};
  return {
    accountId:
      auth.chatgpt_account_id ||
      (Array.isArray(auth.organizations) ? auth.organizations[0]?.id : null) ||
      null,
    email: id.email || id['https://api.openai.com/profile']?.email || null,
    plan: auth.chatgpt_plan_type || null,
    expiresAt: (Number(ac.exp) || 0) * 1000,
  };
}

function normalize(data, old = {}) {
  if (!data || !data.access_token) throw new Error('resposta sem access_token');
  const info = claimsInfo(data.id_token, data.access_token);
  return {
    provider: 'codex',
    source: 'oauth',
    accessToken: data.access_token,
    refreshToken: data.refresh_token || old.refreshToken || null,
    expiresAt: info.expiresAt || Date.now() + 3600 * 1000,
    accountId: info.accountId || old.accountId || null,
    email: info.email || old.email || null,
    plan: info.plan || old.plan || null,
  };
}

// ---- OAuth ------------------------------------------------------------------

function buildAuthorizeUrl({ challenge, state }) {
  const u = new URL(`${ISSUER}/oauth/authorize`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', CLIENT_ID);
  u.searchParams.set('redirect_uri', REDIRECT_URI);
  u.searchParams.set('scope', SCOPES);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('id_token_add_organizations', 'true');
  u.searchParams.set('codex_cli_simplified_flow', 'true');
  u.searchParams.set('state', state);
  u.searchParams.set('originator', ORIGINATOR);
  return u.toString();
}

async function exchangeCode(code, verifier) {
  const res = await fetch(`${ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(`token HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return normalize(await res.json());
}

// O refresh token do Codex ROTACIONA (com detecção de reuso): sempre salvar o
// novo. A resposta pode omitir campos — preservamos os anteriores.
async function refreshTokens(old) {
  const res = await fetch(`${ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: old.refreshToken,
    }),
  });
  if (!res.ok) {
    const err = new Error(`refresh HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  // resposta sem access_token é falha (normalize lança) — mascarar com o token
  // antigo geraria loop de refresh queimando rotações
  return normalize(await res.json(), old);
}

// Abre o servidor de callback e devolve { authUrl, ready, promise, cancel }.
// `ready` resolve quando a porta está aberta (só então abrir o navegador);
// `promise` resolve com os tokens normalizados após o usuário autorizar.
function startLogin() {
  const pkce = createPkce();
  const authUrl = buildAuthorizeUrl(pkce);
  let done = false;
  let timer = null;
  let resolveP;
  let rejectP;
  const promise = new Promise((res, rej) => { resolveP = res; rejectP = rej; });
  let readyResolve;
  let readyReject;
  const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
  ready.catch(() => {}); // rejeição é entregue a quem der await; sem await, não vira unhandled

  const finish = (err, tokens) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    server.close();
    // keep-alive do navegador pode segurar a porta — derruba as conexões
    // depois de dar tempo da última resposta chegar
    setTimeout(() => {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    }, 1500);
    if (err) {
      readyReject(err); // desbloqueia quem espera o bind (no-op se já resolveu)
      rejectP(err);
    } else {
      resolveP(tokens);
    }
  };

  const page = (title, body) =>
    `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Claudemon</title></head>` +
    `<body style="font-family:system-ui;background:#10141f;color:#cdd6e4;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">` +
    `<div style="text-align:center"><h2 style="color:#10a37f">${title}</h2><p>${body}</p></div></body></html>`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const sendHtml = (status, html) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    };
    if (url.pathname !== '/auth/callback') { res.writeHead(404); res.end(); return; }
    if (url.searchParams.get('state') !== pkce.state) {
      sendHtml(400, page('Login inválido', 'Verificação de segurança falhou. Tente de novo no Claudemon.'));
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      sendHtml(400, page('Login cancelado', url.searchParams.get('error_description') || 'Nenhum código recebido.'));
      finish(new Error('login negado no navegador'));
      return;
    }
    try {
      const tokens = await exchangeCode(code, pkce.verifier);
      sendHtml(200, page('Conectado!', 'Pode fechar esta aba e voltar ao Claudemon.'));
      finish(null, tokens);
    } catch (e) {
      sendHtml(500, page('Erro no login', e.message));
      finish(e);
    }
  });

  // a porta pode demorar a ser liberada (login anterior recém-cancelado) —
  // tenta de novo por ~2s antes de desistir
  let bindTries = 0;
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && bindTries < 8 && !done) {
      bindTries++;
      setTimeout(() => { if (!done) server.listen(PORT, '127.0.0.1'); }, 250);
      return;
    }
    finish(e.code === 'EADDRINUSE'
      ? new Error(`porta ${PORT} em uso — feche o login do Codex CLI e tente de novo`)
      : e);
  });

  server.on('listening', () => readyResolve());
  server.listen(PORT, '127.0.0.1');
  timer = setTimeout(() => finish(new Error('tempo esgotado — tente de novo')), LOGIN_TIMEOUT_MS);

  return { authUrl, ready, promise, cancel: (msg = 'login cancelado') => finish(new Error(msg)) };
}

// ---- Login do Codex CLI (atalho) ---------------------------------------------
// Se o Codex CLI já está logado, reaproveitamos o access token de
// ~/.codex/auth.json (ou $CODEX_HOME/auth.json). NUNCA usamos o refresh token
// dele: a rotação com detecção de reuso derrubaria a sessão do Codex CLI —
// quando expirar, apenas relemos o arquivo (o CLI o atualiza quando é usado).

function codexAuthPath() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(home, 'auth.json');
}

function readCodexCliCreds() {
  try {
    const j = JSON.parse(fs.readFileSync(codexAuthPath(), 'utf-8'));
    const t = j.tokens;
    if (!t || !t.access_token) return null;
    const info = claimsInfo(t.id_token, t.access_token);
    return {
      provider: 'codex',
      source: 'codex-cli',
      accessToken: t.access_token,
      refreshToken: null, // de propósito — ver comentário acima
      // sem exp decodável no JWT, assume válido por 15 min e relê o arquivo;
      // se o token estiver mesmo inválido, o 401 do usage derruba pro login
      expiresAt: info.expiresAt || Date.now() + 15 * 60 * 1000,
      accountId: t.account_id || info.accountId,
      email: info.email,
      plan: info.plan,
    };
  } catch {
    return null;
  }
}

function hasCodexCliCreds() {
  return readCodexCliCreds() !== null;
}

// ---- Usage --------------------------------------------------------------------
// Mesmo endpoint que alimenta o /status do Codex CLI. Normalizamos para o
// formato que o renderer já entende (five_hour/seven_day como no Claude).

async function fetchUsage(accessToken, accountId) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
    originator: ORIGINATOR,
  };
  if (accountId) headers['ChatGPT-Account-Id'] = accountId;
  const res = await fetch(USAGE_URL, { headers });
  if (!res.ok) {
    const err = new Error(`usage HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  // Formato (pode variar):
  // {
  //   plan_type: "plus" | "pro" | ...,
  //   rate_limit: {
  //     primary_window:   { used_percent, limit_window_seconds, reset_at },   // sessão (~5h)
  //     secondary_window: { used_percent, limit_window_seconds, reset_at },   // semana
  //   },
  //   credits: { has_credits, unlimited, balance }
  // }
  const j = await res.json();
  const rl = j.rate_limit || j.rate_limits || {};
  // reset_at vem em segundos epoch; tolera milissegundos e string ISO
  const toIso = (v) => {
    if (!v) return null;
    const n = Number(v);
    const d = Number.isFinite(n) ? new Date(n > 1e12 ? n : n * 1000) : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  const win = (w) => (w ? {
    utilization: Number(w.used_percent) || 0,
    resets_at: toIso(w.reset_at),
  } : null);
  return {
    provider: 'codex',
    plan: j.plan_type || null,
    five_hour: win(rl.primary_window),
    seven_day: win(rl.secondary_window),
    credits: j.credits
      ? {
          has_credits: !!j.credits.has_credits,
          unlimited: !!j.credits.unlimited,
          balance: j.credits.balance ?? null,
        }
      : null,
  };
}

module.exports = {
  startLogin,
  refreshTokens,
  codexAuthPath,
  readCodexCliCreds,
  hasCodexCliCreds,
  fetchUsage,
};
