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
    cache = JSON.parse(fs.readFileSync(FILE(), 'utf-8'));
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

// ---- tokens ----------------------------------------------------------------

function setTokens(tokens) {
  load();
  if (!tokens) {
    delete cache.tokens;
    save();
    return;
  }
  const json = JSON.stringify(tokens);
  if (safeStorage.isEncryptionAvailable()) {
    cache.tokens = { enc: true, data: safeStorage.encryptString(json).toString('base64') };
  } else {
    cache.tokens = { enc: false, data: json };
  }
  save();
}

function getTokens() {
  const t = load().tokens;
  if (!t) return null;
  try {
    const json = t.enc
      ? safeStorage.decryptString(Buffer.from(t.data, 'base64'))
      : t.data;
    return JSON.parse(json);
  } catch {
    return null;
  }
}

module.exports = { get, set, setTokens, getTokens };
