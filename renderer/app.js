/* global claudemon */
const $ = (id) => document.getElementById(id);

const views = {
  login: $('view-login'),
  code: $('view-code'),
  dash: $('view-dash'),
  settings: $('view-settings'),
};
let lastMainView = 'login'; // p/ onde voltar ao fechar as configurações
function show(name) {
  Object.entries(views).forEach(([k, el]) => el.classList.toggle('hidden', k !== name));
  if (name !== 'settings') lastMainView = name;
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

function displayName(name, id) {
  return name ? `${name} · #${String(id).padStart(3, '0')}` : `#${String(id).padStart(3, '0')}`;
}

async function showPokemon(id, name = null, tries = 0) {
  const img = $('poke-img');
  const nameEl = $('poke-name');
  nameEl.textContent = '…';

  img.onerror = () => {
    if (tries > 1) loadPokemon(tries - 1); // só re-sorteia se veio de sorteio
    else { img.onerror = null; img.src = pngUrl(id); } // fallback estático
  };
  img.onload = () => {
    currentPoke = id;
    lastPokeId = id;
    claudemon.savePokemon(id);
    img.classList.toggle('flip', Math.random() < 0.5);
  };
  img.src = gifUrl(id);

  if (name) { nameEl.textContent = displayName(name, id); return; }
  try {
    const r = await fetch(`https://pokeapi.co/api/v2/pokemon/${id}`);
    const j = await r.json();
    nameEl.textContent = displayName(j.name, id);
  } catch {
    nameEl.textContent = displayName(null, id);
  }
}

function loadPokemon(tries = 3) {
  showPokemon(randomPokeId(), null, tries);
}

// Resolve nome (em inglês) ou número via PokeAPI → { id, name }, ou null.
async function resolvePokemon(query) {
  const slug = query
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // tira acentos
    .replace(/[.']/g, '')                              // "mr. mime" → "mr mime"
    .trim()
    .replace(/\s+/g, '-');
  if (!slug) return null;
  try {
    const r = await fetch(`https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(slug)}`);
    if (!r.ok) return null;
    const j = await r.json();
    return { id: j.id, name: j.name };
  } catch {
    return null;
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

function hopBurst() {
  hop();
  setTimeout(hop, 700);
  setTimeout(hop, 1400);
}

// ============================== BALÃO DE FALA ================================

let bubbleTimer = null;

function showBubble(text, ms = 2500) {
  const b = $('bubble');
  clearTimeout(bubbleTimer);
  b.textContent = text;
  b.classList.remove('hidden');
  if (ms > 0) bubbleTimer = setTimeout(hideBubble, ms);
}

function hideBubble() {
  clearTimeout(bubbleTimer);
  $('bubble').classList.add('hidden');
}

// ============================== SOM (bip 8-bit) ==============================

let audioCtx = null;

function beep(offsets = [0]) {
  if (!settings.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    for (const off of offsets) {
      const t = audioCtx.currentTime + off;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'square';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.05, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.16);
    }
  } catch { /* sem áudio disponível */ }
}

// ============================== ALARME =======================================
// Pokémon chacoalha + balão fixo até o usuário clicar (ou 60s).

let alarmOn = false;
let alarmBeepInt = null;
let alarmAutoStop = null;

function startAlarm(msg) {
  stopAlarm();
  alarmOn = true;
  showBubble(msg, 0);
  $('poke-img').classList.add('alarm');
  beep([0, 0.25, 0.5]);
  alarmBeepInt = setInterval(() => beep([0, 0.25]), 3000);
  alarmAutoStop = setTimeout(stopAlarm, 60000);
}

function stopAlarm() {
  if (!alarmOn) return;
  alarmOn = false;
  clearInterval(alarmBeepInt);
  clearTimeout(alarmAutoStop);
  $('poke-img').classList.remove('alarm');
  hideBubble();
}

// ============================== NECESSIDADES (tamagotchi) ====================
// Fome/sede/carinho caem com o tempo (também offline, com piso de 10).

const CARE_KEY = 'care';
const NEEDS = {
  food:  { rate: 12, gain: 35, icon: '🍖', ask: '🍖 ESTOU COM FOME!',  thanks: '🍖 NHAM NHAM!' },
  water: { rate: 16, gain: 40, icon: '💧', ask: '💧 ESTOU COM SEDE!',  thanks: '💧 GLUB GLUB!' },
  love:  { rate: 10, gain: 30, icon: '❤️', ask: '❤️ QUERO CARINHO!',   thanks: '❤️ QUE BOM!' },
};

let care = loadCare();
let lastComplaint = 0;

function loadCare() {
  const now = Date.now();
  try {
    const c = JSON.parse(localStorage.getItem(CARE_KEY));
    const hrs = Math.max(0, (now - (c.ts || now)) / 3600000);
    const out = { ts: now };
    for (const k of Object.keys(NEEDS)) {
      const v = Number.isFinite(Number(c[k])) ? Number(c[k]) : 80;
      out[k] = Math.max(10, Math.min(100, v - NEEDS[k].rate * hrs));
    }
    return out;
  } catch {
    return { food: 80, water: 80, love: 80, ts: now };
  }
}

function saveCare() {
  localStorage.setItem(CARE_KEY, JSON.stringify(care));
}

function renderNeeds() {
  let min = 100;
  for (const k of Object.keys(NEEDS)) {
    const v = care[k];
    min = Math.min(min, v);
    $(`bar-${k}`).style.width = `${Math.round(v)}%`;
    const btn = $(`need-${k}`);
    btn.classList.toggle('low', v < 30);
    btn.classList.toggle('mid', v >= 30 && v < 60);
  }
  $('poke-img').classList.toggle('sad', min < 25);
}

function tickCare() {
  const now = Date.now();
  const hrs = (now - care.ts) / 3600000;
  if (hrs > 0) {
    for (const k of Object.keys(NEEDS)) {
      care[k] = Math.max(0, care[k] - NEEDS[k].rate * hrs);
    }
    care.ts = now;
    saveCare();
    renderNeeds();
  }
  // reclama de tempos em tempos se algo está baixo (sem atropelar um alarme)
  if (!alarmOn && now - lastComplaint > 3 * 60000) {
    const needy = Object.keys(NEEDS).filter((k) => care[k] < 25);
    if (needy.length) {
      lastComplaint = now;
      showBubble(NEEDS[needy[0]].ask, 8000);
      hop();
    }
  }
}
setInterval(tickCare, 30000);

function careAction(k) {
  care[k] = Math.min(100, care[k] + NEEDS[k].gain);
  care.ts = Date.now();
  saveCare();
  renderNeeds();
  if (!alarmOn) showBubble(NEEDS[k].thanks, 1800);
  hop();
}

// ============================== LEMBRETES ====================================

let settings = { waterMin: 45, standMin: 60, breakMin: 90, sound: true };
let reminderTimers = [];

const REMINDERS = [
  ['waterMin', '💧 HORA DE BEBER ÁGUA!'],
  ['standMin', '🧍 LEVANTA E ESTICA AS PERNAS!'],
  ['breakMin', '☕ HORA DE UMA PAUSA!'],
];

function scheduleReminders() {
  reminderTimers.forEach(clearInterval);
  reminderTimers = [];
  for (const [key, msg] of REMINDERS) {
    const min = Number(settings[key]) || 0;
    if (min > 0) {
      reminderTimers.push(setInterval(() => remind(msg), min * 60000));
    }
  }
}

function remind(msg) {
  if (alarmOn) return; // alarme do timer tem prioridade
  showBubble(msg, 30000);
  hopBurst();
  beep([0, 0.3]);
}

// ============================== TIMER / POMODORO =============================

let timerEnd = null;
let timerInt = null;

function timerUI(running) {
  $('timer-min').classList.toggle('hidden', running);
  $('timer-unit').classList.toggle('hidden', running);
  $('timer-display').classList.toggle('hidden', !running);
  const btn = $('btn-timer');
  btn.textContent = running ? '■' : '▶';
  btn.title = running ? 'Parar timer' : 'Iniciar timer';
  btn.classList.toggle('running', running);
}

function startTimer(min) {
  timerEnd = Date.now() + min * 60000;
  timerUI(true);
  updateTimer();
  timerInt = setInterval(updateTimer, 250);
}

function stopTimer() {
  clearInterval(timerInt);
  timerInt = null;
  timerEnd = null;
  timerUI(false);
}

function updateTimer() {
  const ms = timerEnd - Date.now();
  if (ms <= 0) {
    stopTimer();
    startAlarm('⏰ DEU O TEMPO!');
    return;
  }
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  $('timer-display').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ============================== CONFIGURAÇÕES ================================

async function openSettings() {
  const s = await claudemon.getSettings();
  $('set-water').value = s.waterMin;
  $('set-stand').value = s.standMin;
  $('set-break').value = s.breakMin;
  $('set-sound').checked = !!s.sound;
  $('set-top').checked = !!s.alwaysOnTop;
  $('set-poke').value = s.pokemon || '';
  $('set-error').classList.add('hidden');
  show('settings');
}

async function saveSettings() {
  const clampMin = (id) => Math.max(0, Math.min(480, Math.round(Number($(id).value) || 0)));
  $('set-error').classList.add('hidden');

  // pokémon fixo: vazio = aleatório; senão valida na PokeAPI antes de salvar
  const rawPoke = $('set-poke').value.trim();
  let pokemon = '';
  let pokemonId = null;
  if (rawPoke) {
    const found = await resolvePokemon(rawPoke);
    if (!found) {
      const el = $('set-error');
      el.textContent = `"${rawPoke}" não encontrado — use o nome em inglês (ex.: pikachu) ou o número`;
      el.classList.remove('hidden');
      return;
    }
    pokemon = found.name;
    pokemonId = found.id;
  }

  const payload = {
    waterMin: clampMin('set-water'),
    standMin: clampMin('set-stand'),
    breakMin: clampMin('set-break'),
    sound: $('set-sound').checked,
    alwaysOnTop: $('set-top').checked,
    pokemon,
    pokemonId,
  };
  await claudemon.saveSettings(payload);
  settings = { ...settings, ...payload };
  scheduleReminders();
  if (pokemonId && pokemonId !== currentPoke) showPokemon(pokemonId, pokemon);
  show(lastMainView);
}

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
  renderNeeds();

  settings = { ...settings, ...(await claudemon.getSettings()) };
  scheduleReminders();

  const state = await claudemon.getState();
  lastPokeId = state.lastPokemonId || null;

  // pokémon fixo das configurações; sem ele, sorteia
  if (settings.pokemonId) showPokemon(settings.pokemonId, settings.pokemon);
  else loadPokemon();

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
$('btn-settings').addEventListener('click', () => {
  views.settings.classList.contains('hidden') ? openSettings() : show(lastMainView);
});
$('btn-quit').addEventListener('click', () => claudemon.quit());

// clicar no pokémon = carinho (ou desliga o alarme)
$('poke-img').addEventListener('click', () => {
  if (alarmOn) { stopAlarm(); return; }
  careAction('love');
});

// necessidades / balão / timer / configurações
$('need-food').addEventListener('click', () => careAction('food'));
$('need-water').addEventListener('click', () => careAction('water'));
$('need-love').addEventListener('click', () => careAction('love'));
$('bubble').addEventListener('click', () => (alarmOn ? stopAlarm() : hideBubble()));

$('btn-timer').addEventListener('click', () => {
  if (timerEnd) { stopTimer(); return; }
  const min = Math.max(1, Math.min(180, Math.round(Number($('timer-min').value) || 0)));
  $('timer-min').value = min;
  startTimer(min);
});
$('timer-min').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-timer').click();
});

$('btn-set-save').addEventListener('click', saveSettings);
$('btn-set-back').addEventListener('click', () => show(lastMainView));

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
