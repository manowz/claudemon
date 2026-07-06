// Login com a conta Claude (Pro/Max) — mesmo fluxo OAuth+PKCE do Claude Code.
// ATENÇÃO: endpoints internos, não documentados oficialmente. Podem mudar sem aviso.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'; // client público do Claude Code
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
// O endpoint de token migrou de console.anthropic.com -> platform.claude.com;
// tentamos os dois, com form-encoded e JSON, para sobreviver a mudanças.
const TOKEN_URLS = [
  'https://platform.claude.com/v1/oauth/token',
  'https://console.anthropic.com/v1/oauth/token',
];
// Escopos mínimos p/ monitoramento. Se /api/oauth/usage retornar 403,
// acrescente 'user:sessions:claude_code' aqui e refaça o login.
const SCOPES = 'user:profile user:inference';

const b64url = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function createPkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(32));
  return { verifier, challenge, state };
}

function buildAuthorizeUrl({ challenge, state }) {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set('code', 'true'); // fluxo manual: página mostra o código p/ copiar
  u.searchParams.set('client_id', CLIENT_ID);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', REDIRECT_URI);
  u.searchParams.set('scope', SCOPES);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  return u.toString();
}

async function postToken(body) {
  let lastErr = new Error('token exchange falhou');
  for (const url of TOKEN_URLS) {
    for (const mode of ['form', 'json']) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type':
              mode === 'form' ? 'application/x-www-form-urlencoded' : 'application/json',
          },
          body: mode === 'form' ? new URLSearchParams(body).toString() : JSON.stringify(body),
        });
        if (res.ok) return await res.json();
        const text = (await res.text()).slice(0, 200);
        lastErr = new Error(`HTTP ${res.status} em ${new URL(url).host} (${mode}): ${text}`);
        lastErr.status = res.status; // p/ o main distinguir refresh revogado (400/401)
        // 4xx de validação: tentar próximo formato/endpoint mesmo assim
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw lastErr;
}

function normalize(data, fallbackRefresh = null) {
  if (!data || !data.access_token) throw new Error('resposta sem access_token');
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || fallbackRefresh,
    expiresAt: Date.now() + (Number(data.expires_in) || 28800) * 1000,
    source: 'oauth',
  };
}

// Cole aqui o que a página de callback mostrar (formato "codigo#state").
async function exchangeCode(pasted, pkce) {
  const raw = String(pasted || '').trim();
  const [code, stateFromPage] = raw.split('#');
  if (!code) throw new Error('código vazio');
  return normalize(
    await postToken({
      grant_type: 'authorization_code',
      code,
      state: stateFromPage || pkce.state,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: pkce.verifier,
    })
  );
}

async function refreshTokens(refreshToken) {
  const t = normalize(
    await postToken({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
    refreshToken
  );
  return t;
}

// ---- Login do Claude Code (atalho) -----------------------------------------
// Se o Claude Code já está logado nesta máquina, reaproveitamos o access token
// de ~/.claude/.credentials.json. NUNCA usamos o refresh token dele (a rotação
// derrubaria a sessão do Claude Code) — quando expirar, apenas relemos o arquivo.

function claudeCodeCredsPath() {
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

function readClaudeCodeCreds() {
  try {
    const j = JSON.parse(fs.readFileSync(claudeCodeCredsPath(), 'utf-8'));
    const c = j.claudeAiOauth || j;
    if (!c || !c.accessToken) return null;
    let expiresAt = c.expiresAt;
    if (typeof expiresAt === 'string') expiresAt = Date.parse(expiresAt);
    if (typeof expiresAt !== 'number' || Number.isNaN(expiresAt)) expiresAt = 0;
    return {
      accessToken: c.accessToken,
      refreshToken: null, // de propósito — ver comentário acima
      expiresAt,
      source: 'claude-code',
    };
  } catch {
    return null;
  }
}

function hasClaudeCodeCreds() {
  return readClaudeCodeCreds() !== null;
}

module.exports = {
  createPkce,
  buildAuthorizeUrl,
  exchangeCode,
  refreshTokens,
  claudeCodeCredsPath,
  readClaudeCodeCreds,
  hasClaudeCodeCreds,
};
