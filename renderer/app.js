/* global claudemon */
const $ = (id) => document.getElementById(id);

const views = { login: $('view-login'), code: $('view-code'), dash: $('view-dash') };
function show(name) {
  Object.entries(views).forEach(([k, el]) => el.classList.toggle('hidden', k !== name));
}

// ============================== POKÉMON ======================================
// Sprites animados da Gen V (pixel art que já "dança" sozinha), via PokeAPI.
const POKE_MAX = 649;
const gifUrl = (id) =>
  `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated/${id}.gif`;
const pngUrl = (id) =>
  `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${id}.png`;

let currentPoke = null;
let lastPokeId = null;

function randomPokeId() {
  let id;
  do { id = 1 + Math.floor(Math.random() * POKE_MAX); } while (id === lastPokeId);
  return id;
}

async function loadPokemon(tries = 3) {
  const id = randomPokeId();
  const img = $('poke-img');
  const nameEl = $('poke-name');
  nameEl.textContent = '…';

  img.onerror = () => {
    if (tries > 1) loadPokemon(tries - 1);
    else { img.onerror = null; img.src = pngUrl(id); } // fallback estático
  };
  img.onload = () => {
    currentPoke = id;
    lastPokeId = id;
    claudemon.savePokemon(id);
    img.classList.toggle('flip', Math.random() < 0.5);
  };
  img.src = gifUrl(id);

  try {
    const r = await fetch(`https://pokeapi.co/api/v2/pokemon/${id}`);
    const j = await r.json();
    nameEl.textContent = `${j.name} · #${String(id).padStart(3, '0')}`;
  } catch {
    nameEl.textContent = `#${String(id).padStart(3, '0')}`;
  }
}

// pulinho de vez em quando + ao clicar
function hop() {
  const img = $('poke-img');
  img.classList.remove('hop');
  void img.offsetWidth; // reinicia a animação
  img.classList.add('hop');
}
setInterval(() => { if (Math.random() < 0.4) hop(); }, 9000);

// ============================== BARRAS =======================================

function buildBar(el) {
  el.innerHTML = '';
  for (let i = 0; i < 10; i++) el.appendChild(document.createElement('span'));
}

function tone(pct) { return pct >= 85 ? 'bad' : pct >= 60 ? 'warn' : 'ok'; }

function setBar(barEl, pctEl, utilization) {
  const pct = Math.max(0, Math.min(100, Number(utilization) || 0));
  const t = tone(pct);
  barEl.className = `bar ${t}`;
  const cells = barEl.children;
  const filled = Math.round(pct / 10);
  for (let i = 0; i < cells.length; i++) cells[i].className = i < filled ? 'fill' : '';
  pctEl.className = `value ${t}`;
  pctEl.textContent = `${Math.round(pct)}%`;
}

// ============================== FORMATOS =====================================

function fmtCountdown(iso) {
  if (!iso) return 'sem janela ativa';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'resetando…';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `reseta em ${h}h ${String(m).padStart(2, '0')}min`;
  if (m > 0) return `reseta em ${m}min`;
  return 'reseta em <1min';
}

function fmtDay(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const wd = d.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '');
  const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return `reseta ${wd} · ${hm}`;
}

function fmtCredits(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
}

// ============================== RENDER =======================================

let resets = { fiveHour: null, sevenDay: null };

function render(usage) {
  const fh = usage?.five_hour || {};
  const sd = usage?.seven_day || {};
  resets = { fiveHour: fh.resets_at || null, sevenDay: sd.resets_at || null };

  setBar($('fh-bar'), $('fh-pct'), fh.utilization);
  setBar($('sd-bar'), $('sd-pct'), sd.utilization);
  $('fh-reset').textContent = fmtCountdown(resets.fiveHour);
  $('sd-reset').textContent = fmtDay(resets.sevenDay);

  // linhas por modelo (aparecem conforme o plano)
  const rows = $('model-rows');
  rows.innerHTML = '';
  [['seven_day_sonnet', 'SONNET · 7D'], ['seven_day_opus', 'OPUS · 7D']].forEach(([key, label]) => {
    const m = usage?.[key];
    if (!m) return;
    const pct = Math.round(Math.max(0, Math.min(100, Number(m.utilization) || 0)));
    const row = document.createElement('div');
    row.className = 'model-row';
    row.innerHTML = `<span>${label}</span><span class="value ${tone(pct)}">${pct}%</span>`;
    rows.appendChild(row);
  });

  // extra usage = o "pote" mensal pago à parte
  const ex = usage?.extra_usage;
  if (ex?.is_enabled) {
    setBar($('ex-bar'), $('ex-pct'), ex.utilization);
    $('ex-detail').textContent =
      `${fmtCredits(ex.used_credits)} de ${fmtCredits(ex.monthly_limit)} créditos`;
  } else {
    $('ex-pct').className = 'value';
    $('ex-pct').textContent = '—';
    $('ex-bar').className = 'bar';
    for (const c of $('ex-bar').children) c.className = '';
    $('ex-detail').textContent = 'extra usage desativado';
  }
}

function cleanErr(e) {
  return String(e?.message || e)
    .replace(/Error invoking remote method '.*?':\s*/, '')
    .replace(/^Error:\s*/, '');
}

function setStatus(text, isError = false) {
  const el = $('status');
  el.textContent = text;
  el.style.color = isError ? 'var(--bad)' : '';
}

// contagem regressiva da sessão a cada segundo
setInterval(() => {
  if (!views.dash.classList.contains('hidden')) {
    $('fh-reset').textContent = fmtCountdown(resets.fiveHour);
  }
}, 1000);

// ============================== FLUXOS =======================================

async function boot() {
  ['fh-bar', 'sd-bar', 'ex-bar'].forEach((id) => buildBar($(id)));
  loadPokemon();

  const state = await claudemon.getState();
  lastPokeId = state.lastPokemonId || null;

  if (state.authenticated) {
    show('dash');
    setStatus('carregando…');
    refresh();
  } else {
    show('login');
    if (state.hasClaudeCodeCreds) $('btn-claude-code').classList.remove('hidden');
  }
}

async function refresh() {
  try {
    setStatus('atualizando…');
    render(await claudemon.getUsage());
    setStatus(`atualizado ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`);
  } catch (e) {
    setStatus(cleanErr(e), true);
  }
}

function loginError(el, e) {
  el.textContent = cleanErr(e);
  el.classList.remove('hidden');
}

// login via credenciais locais do Claude Code
$('btn-claude-code').addEventListener('click', async () => {
  try {
    const { data } = await claudemon.useClaudeCode();
    show('dash');
    render(data);
    setStatus('conectado via Claude Code');
  } catch (e) { loginError($('login-error'), e); }
});

// login via OAuth (abre navegador, usuário cola o código)
$('btn-oauth').addEventListener('click', async () => {
  $('login-error').classList.add('hidden');
  await claudemon.startOAuth();
  $('code-input').value = '';
  $('code-error').classList.add('hidden');
  show('code');
  $('code-input').focus();
});

$('btn-code-ok').addEventListener('click', async () => {
  try {
    const { data } = await claudemon.finishOAuth($('code-input').value);
    show('dash');
    render(data);
    setStatus('conectado!');
  } catch (e) { loginError($('code-error'), e); }
});

$('code-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-code-ok').click();
});

$('btn-code-cancel').addEventListener('click', () => show('login'));

$('btn-logout').addEventListener('click', async () => {
  await claudemon.logout();
  const state = await claudemon.getState();
  show('login');
  $('btn-claude-code').classList.toggle('hidden', !state.hasClaudeCodeCreds);
});

// barra de título
$('btn-refresh').addEventListener('click', refresh);
$('btn-dice').addEventListener('click', () => loadPokemon());
$('btn-quit').addEventListener('click', () => claudemon.quit());
$('poke-img').addEventListener('click', hop);

// push do processo principal
claudemon.onUsage((p) => {
  if (views.dash.classList.contains('hidden')) return;
  if (p.ok) {
    render(p.data);
    setStatus(`atualizado ${new Date(p.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`);
  } else {
    setStatus(p.error, true);
  }
});

claudemon.onAuthRequired((p) => {
  show('login');
  loginError($('login-error'), new Error(p.message));
});

claudemon.onReroll(() => loadPokemon());

boot();
