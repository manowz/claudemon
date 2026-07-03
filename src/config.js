// Persistência simples em userData/config.json.
// Tokens são criptografados com safeStorage (DPAPI no Windows) quando disponível.
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const FILE = () => path.join(app.getPath('userData'), 'config.json');

let cache = null;

function load() {
  if (cache) return cache;
  try {
    // tolera BOM (editores/scripts externos salvam UTF-8 com BOM e o JSON.parse
    // rejeita) — sem isso, um set() qualquer regravaria o arquivo vazio,
    // destruindo o blob de contas
    cache = JSON.parse(fs.readFileSync(FILE(), 'utf-8').replace(/^\uFEFF/, ''));
  } catch {
    cache = {};
  }
  return cache;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(cache, null, 2));
  } catch (e) {
    console.error('config save:', e.message);
  }
}

function get(key, fallback = null) {
  const c = load();
  return key in c ? c[key] : fallback;
}

function set(key, value) {
  load();
  cache[key] = value;
  save();
}

// ---- contas (tokens por provedor: claude, codex) -----------------------------
// Guardadas juntas num blob criptografado em cache.accounts.

function encryptBlob(json) {
  if (safeStorage.isEncryptionAvailable()) {
    return { enc: true, data: safeStorage.encryptString(json).toString('base64') };
  }
  return { enc: false, data: json };
}

function decryptBlob(t) {
  try {
    const json = t.enc
      ? safeStorage.decryptString(Buffer.from(t.data, 'base64'))
      : t.data;
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Migra o formato antigo (conta única em cache.tokens) para cache.accounts,
// preservando a sessão de quem atualizou o app.
function migrate() {
  const c = load();
  if (!c.tokens) return;
  const old = decryptBlob(c.tokens);
  if (!old) return; // decrypt falhou (ex.: keychain negou) — não destrói o blob
  if (!c.accounts) {
    c.accounts = encryptBlob(JSON.stringify({ [old.provider || 'claude']: old }));
  }
  delete c.tokens;
  save();
}

// Cache do blob descriptografado: um poll chama isto várias vezes e cada
// decrypt é uma ida síncrona ao DPAPI/keychain.
let accountsCache = null;

function getAccounts() {
  if (accountsCache) return accountsCache;
  migrate();
  const t = load().accounts;
  if (!t) {
    accountsCache = {};
    return accountsCache;
  }
  const dec = decryptBlob(t);
  if (!dec) return {}; // falha de decrypt: não cacheia — a próxima chamada tenta de novo
  accountsCache = dec;
  return accountsCache;
}

function getAccount(provider) {
  return getAccounts()[provider] || null;
}

function setAccount(provider, tokens) {
  const accounts = { ...getAccounts() };
  if (tokens) accounts[provider] = tokens;
  else delete accounts[provider];
  accountsCache = accounts;
  load();
  cache.accounts = encryptBlob(JSON.stringify(accounts));
  save();
}

module.exports = { get, set, getAccounts, getAccount, setAccount };
