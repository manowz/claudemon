/* global claudemon */
const $ = (id) => document.getElementById(id);

const views = {
  login: $('view-login'),
  code: $('view-code'),
  wait: $('view-wait'),
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
const gifUrl = (id, shiny) =>
  `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated/${shiny ? 'shiny/' : ''}${id}.gif`;
const pngUrl = (id, shiny) =>
  `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${shiny ? 'shiny/' : ''}${id}.png`;

let currentPoke = null;
let currentName = null;
let lastPokeId = null;

function randomPokeId() {
  let id;
  do { id = 1 + Math.floor(Math.random() * POKE_MAX); } while (id === lastPokeId);
  return id;
}

function displayName(name, id, shiny) {
  const base = name ? `${name} · #${String(id).padStart(3, '0')}` : `#${String(id).padStart(3, '0')}`;
  return shiny ? `✨ ${base}` : base;
}

async function showPokemon(id, name = null, tries = 0) {
  const img = $('poke-img');
  const nameEl = $('poke-name');
  const shiny = isShiny(id);
  nameEl.textContent = '…';

  img.onerror = () => {
    if (tries > 1) loadPokemon(tries - 1); // só re-sorteia se veio de sorteio
    else { img.onerror = null; img.src = pngUrl(id, shiny); } // fallback estático
  };
  img.onload = () => {
    currentPoke = id;
    lastPokeId = id;
    claudemon.savePokemon(id);
    img.classList.toggle('flip', Math.random() < 0.5);
  };
  img.src = gifUrl(id, shiny);

  if (name) { currentName = name; nameEl.textContent = displayName(name, id, shiny); return; }
  try {
    const r = await fetch(`https://pokeapi.co/api/v2/pokemon/${id}`);
    const j = await r.json();
    currentName = j.name;
    nameEl.textContent = displayName(j.name, id, shiny);
  } catch {
    currentName = null;
    nameEl.textContent = displayName(null, id, shiny);
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
let reminderXpArmed = false; // balão de lembrete ativo dá XP ao ser clicado

function showBubble(text, ms = 2500) {
  reminderXpArmed = false; // qualquer balão novo invalida o lembrete anterior
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

// arpejo ascendente de level up (estilo fanfarra de Game Boy)
function jingle() {
  if (!settings.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    [523, 659, 784, 1047].forEach((freq, i) => {
      const t = audioCtx.currentTime + i * 0.13;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.05, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.21);
    });
  } catch { /* sem áudio disponível */ }
}

// ============================== LEVEL / XP ===================================
// Level único, compartilhado por todos os pokémon. XP vem de cuidar do bicho
// (com cooldown anti-spam), cumprir lembretes clicando no balão e — por que
// não — torrar 100% da sessão de 5h. A cada level (sem evolução) há chance de
// virar shiny; a cada EVOLVE_EVERY levels o pokémon evolui de verdade.

const XP_KEY = 'xp';
const SHINY_CHANCE = 0.3;
const EVOLVE_EVERY = 5;
const XP_CARE_COOLDOWN_MS = 5 * 60000;
const XP_CARE = 5;
const XP_REMINDER = 10;
const XP_SESSION = 30;

let xpState = loadXp();

function loadXp() {
  try {
    const s = JSON.parse(localStorage.getItem(XP_KEY)) || {};
    return {
      level: Math.max(1, Math.round(Number(s.level) || 1)),
      xp: Math.max(0, Number(s.xp) || 0),
      shinyId: Number.isInteger(s.shinyId) ? s.shinyId : null,
    };
  } catch {
    return { level: 1, xp: 0, shinyId: null };
  }
}

function saveXp() {
  localStorage.setItem(XP_KEY, JSON.stringify(xpState));
}

function isShiny(id) {
  return xpState.shinyId != null && xpState.shinyId === id;
}

function xpNeeded(level) {
  return 30 + (level - 1) * 10;
}

function renderLevel() {
  $('level-num').textContent = `LV ${xpState.level}`;
  const pct = Math.max(0, Math.min(100, (xpState.xp / xpNeeded(xpState.level)) * 100));
  $('xp-fill').style.width = `${Math.round(pct)}%`;
}

// "+N XP" flutuando sobre o palco
function floatXp(text) {
  const el = document.createElement('span');
  el.className = 'xp-float';
  el.textContent = text;
  document.querySelector('.stage').appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

function gainXp(amount) {
  xpState.xp += amount;
  floatXp(`+${amount} XP`);
  let leveled = false;
  while (xpState.xp >= xpNeeded(xpState.level)) {
    xpState.xp -= xpNeeded(xpState.level);
    xpState.level += 1;
    leveled = true;
  }
  saveXp();
  renderLevel();
  if (leveled) onLevelUp();
}

function onLevelUp() {
  jingle();
  hopBurst();
  const img = $('poke-img');
  img.classList.add('levelup');
  setTimeout(() => img.classList.remove('levelup'), 2400);
  if (!alarmOn) showBubble(`🎉 LEVEL ${xpState.level}!`, 4000);
  if (xpState.level % EVOLVE_EVERY === 0) tryEvolve();
  else maybeShiny();
}

function maybeShiny() {
  if (!currentPoke || isShiny(currentPoke)) return;
  if (Math.random() >= SHINY_CHANCE) return;
  const id = currentPoke;
  xpState.shinyId = id;
  saveXp();
  // deixa o balão de level respirar antes da surpresa
  setTimeout(() => {
    if (currentPoke !== id) return;
    showPokemon(id, currentName);
    jingle();
    if (!alarmOn) showBubble('✨ UAU… EU VIREI SHINY! ✨', 6000);
  }, 1500);
}

// A cada EVOLVE_EVERY levels, evolui via cadeia de evolução da PokeAPI (se a
// espécie tiver próxima etapa com sprite animado). Sem evolução → roleta shiny.
async function tryEvolve() {
  const id = currentPoke;
  if (!id) return;
  try {
    const sp = await (await fetch(`https://pokeapi.co/api/v2/pokemon-species/${id}`)).json();
    const chain = (await (await fetch(sp.evolution_chain.url)).json()).chain;
    const next = findEvoNode(chain, sp.name)?.evolves_to?.[0];
    const nextId = next ? Number((next.species.url.match(/\/(\d+)\/?$/) || [])[1]) : NaN;
    if (!nextId || nextId > POKE_MAX) { maybeShiny(); return; }
    setTimeout(() => {
      if (currentPoke !== id) return; // usuário trocou de pokémon no meio
      if (xpState.shinyId === id) { xpState.shinyId = nextId; saveXp(); } // o brilho acompanha
      showPokemon(nextId, next.species.name);
      jingle();
      hopBurst();
      if (!alarmOn) showBubble('🎉 OLHA SÓ… EU EVOLUÍ!', 6000);
    }, 1500);
  } catch {
    maybeShiny();
  }
}

function findEvoNode(node, name) {
  if (node.species.name === name) return node;
  for (const n of node.evolves_to || []) {
    const found = findEvoNode(n, name);
    if (found) return found;
  }
  return null;
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

const lastCareXp = {}; // anti-spam: XP por necessidade no máximo a cada 5 min

function careAction(k) {
  const before = care[k];
  care[k] = Math.min(100, care[k] + NEEDS[k].gain);
  care.ts = Date.now();
  saveCare();
  renderNeeds();
  if (!alarmOn) showBubble(NEEDS[k].thanks, 1800);
  hop();
  // XP só quando o cuidado "valeu" (barra não estava cheia) e fora do cooldown
  if (before < 95 && Date.now() - (lastCareXp[k] || 0) >= XP_CARE_COOLDOWN_MS) {
    lastCareXp[k] = Date.now();
    gainXp(XP_CARE);
  }
}

// ============================== LEMBRETES ====================================

let settings = { waterMin: 45, standMin: 60, breakMin: 90, usageAlertPct: 50, sound: true };
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
  reminderXpArmed = true; // clicar no balão = "feito!" → XP
  hopBurst();
  beep([0, 0.3]);
}

// ============================== ALERTA DE USO ================================
// Avisa UMA vez quando a sessão de 5h cruza o limiar configurado (0 = desligado)
// e só rearma quando o consumo cai abaixo dele (sessão nova). Dedupe por
// cruzamento, não por janela: o resets_at reportado pela API pode variar entre
// polls, e usá-lo na chave fazia o alerta repetir toda hora.

const USAGE_ALERT_KEY = 'usageAlerted';

function usageAlertSeen() {
  try { return JSON.parse(localStorage.getItem(USAGE_ALERT_KEY)) || {}; }
  catch { return {}; }
}

function checkUsageAlert(provider, usage) {
  const threshold = Math.max(0, Math.min(100, Number(settings.usageAlertPct) || 0));
  if (threshold <= 0) return;
  const util = Number(usage?.five_hour?.utilization);
  if (!Number.isFinite(util)) return;
  const seen = usageAlertSeen();
  if (util < threshold) {
    // caiu abaixo do limiar (sessão resetou ou limiar subiu) — rearma o alerta
    if (seen[provider]) {
      delete seen[provider];
      localStorage.setItem(USAGE_ALERT_KEY, JSON.stringify(seen));
    }
    return;
  }
  if (seen[provider]) return; // já avisou nesta subida — só volta a avisar após rearmar
  if (alarmOn) return; // alarme do timer tem prioridade — o próximo poll re-tenta
  seen[provider] = new Date().toISOString();
  localStorage.setItem(USAGE_ALERT_KEY, JSON.stringify(seen));
  showBubble(`⚠️ SEUS TOKENS ESTÃO ACABANDO! ${PROV_LABEL[provider] || provider} ${Math.round(util)}%`, 30000);
  hopBurst();
  beep([0, 0.3, 0.6]);
}

// ============================== XP POR SESSÃO TORRADA ========================
// Gastar 100% da sessão de 5h dá XP — uma vez por janela, por provedor.

const SESSION_XP_KEY = 'sessionXp';

function checkSessionXp(provider, usage) {
  const fh = usage?.five_hour;
  const util = Number(fh?.utilization);
  if (!Number.isFinite(util) || util < 100) return;
  const key = fh.resets_at || 'sem-janela';
  let seen = {};
  try { seen = JSON.parse(localStorage.getItem(SESSION_XP_KEY)) || {}; } catch { /* recomeça */ }
  if (seen[provider] === key) return;
  seen[provider] = key;
  localStorage.setItem(SESSION_XP_KEY, JSON.stringify(seen));
  if (!alarmOn) showBubble('💥 VOCÊ TORROU A SESSÃO INTEIRA! RESPEITO.', 8000);
  gainXp(XP_SESSION); // depois do balão: level up, se rolar, fala mais alto
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
  $('set-alert').value = s.usageAlertPct;
  $('set-sound').checked = !!s.sound;
  $('set-top').checked = !!s.alwaysOnTop;
  $('set-startup').checked = !!s.launchAtStartup;
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
    usageAlertPct: Math.max(0, Math.min(100, Math.round(Number($('set-alert').value) || 0))),
    sound: $('set-sound').checked,
    alwaysOnTop: $('set-top').checked,
    launchAtStartup: $('set-startup').checked,
    pokemon,
    pokemonId,
  };
  await claudemon.saveSettings(payload);
  settings = { ...settings, ...payload };
  scheduleReminders();
  // procurar de novo um pokémon que virou shiny devolve a versão normal dele
  const unshined = pokemonId && isShiny(pokemonId);
  if (unshined) { xpState.shinyId = null; saveXp(); }
  if (pokemonId && (pokemonId !== currentPoke || unshined)) showPokemon(pokemonId, pokemon);
  show(lastMainView);
}

// ============================== BARRAS =======================================

function buildBar(el) {
  el.innerHTML = '';
  for (let i = 0; i < 10; i++) el.appendChild(document.createElement('span'));
}

function tone(pct) { return pct >= 85 ? 'bad' : pct >= 60 ? 'warn' : 'ok'; }

function setBar(barEl, pctEl, utilization) {
  const missing = utilization == null; // sem dado ≠ 0% — mostra estado vazio
  const pct = Math.max(0, Math.min(100, Number(utilization) || 0));
  const t = missing ? '' : tone(pct);
  barEl.className = `bar ${t}`.trim();
  const cells = barEl.children;
  const filled = missing ? 0 : Math.round(pct / 10);
  for (let i = 0; i < cells.length; i++) cells[i].className = i < filled ? 'fill' : '';
  pctEl.className = `value ${t}`.trim();
  pctEl.textContent = missing ? '—' : `${Math.round(pct)}%`;
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
  if (!Number.isFinite(Number(n))) return String(n);
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

  // bloco extra: Claude = "pote" mensal pago à parte; Codex = plano + créditos
  const setExtraInfo = (label, value, detail) => {
    $('ex-label').textContent = label;
    $('ex-pct').className = 'value';
    $('ex-pct').textContent = value;
    $('ex-bar').className = 'bar';
    for (const c of $('ex-bar').children) c.className = '';
    $('ex-detail').textContent = detail;
  };
  if (usage?.provider === 'codex') {
    const cr = usage.credits;
    const detail = cr?.unlimited
      ? 'créditos ilimitados'
      : cr?.has_credits
        ? `créditos: ${fmtCredits(cr.balance)}`
        : 'sem créditos extras';
    setExtraInfo('PLANO', String(usage.plan || '—').toUpperCase(), detail);
    return;
  }
  // Claude: limite semanal por modelo (Fable etc.) vem em limits[] com
  // kind "weekly_scoped" — os buckets fixos (seven_day_opus/...) viraram null
  const scoped = (usage?.limits || []).filter(
    (l) => l?.kind === 'weekly_scoped' && l?.scope?.model
  );
  const m = scoped.find((l) => l.is_active) || scoped[0];
  if (m) {
    const name = String(m.scope.model.display_name || 'modelo').toUpperCase();
    $('ex-label').textContent = `${name} · SEMANA`;
    setBar($('ex-bar'), $('ex-pct'), m.percent);
    $('ex-detail').textContent = fmtDay(m.resets_at);
  } else {
    setExtraInfo('FABLE · SEMANA', '—', 'sem limite por modelo');
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

function hhmm(at) {
  return new Date(at || Date.now()).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// ============================== PROVEDORES ===================================
// O widget pode ter Claude e Codex conectados ao mesmo tempo; o dashboard
// mostra um por vez e a setinha ▶ alterna entre eles.

const PROV_LABEL = { claude: 'CLAUDE', codex: 'CODEX' };
const PROV_COLOR = { claude: 'var(--accent)', codex: '#10a37f' };

let connected = { claude: false, codex: false };
let usageBy = {};    // provider -> último usage renderizável
let lastResult = {}; // provider -> último {ok, error, authRequired, at}
let current = localStorage.getItem('provider') || null;

function connectedList() {
  return Object.keys(connected).filter((k) => connected[k]);
}

function otherProvider() {
  return current === 'claude' ? 'codex' : 'claude';
}

function renderProvRow() {
  const list = connectedList();
  $('prov-name').textContent = current ? PROV_LABEL[current] : '—';
  $('prov-name').style.color = (current && PROV_COLOR[current]) || '';
  $('btn-prov-next').classList.toggle('hidden', list.length < 2);
  $('btn-prov-add').classList.toggle('hidden', list.length !== 1);
}

function setCurrent(p) {
  current = p;
  if (p) localStorage.setItem('provider', p);
  renderProvRow();
}

// usage "vazio" na forma certa pro render de cada provedor
function emptyUsage(p) {
  return p === 'codex' ? { provider: 'codex' } : {};
}

// troca o painel para o provedor p usando o que já temos em cache
function showProvider(p) {
  setCurrent(p);
  const r = lastResult[p];
  // sempre re-renderiza: sem cache, limpa as barras (senão os números do
  // provedor anterior ficariam na tela sob o nome do novo)
  render(usageBy[p] || emptyUsage(p));
  if (usageBy[p]) {
    setStatus(r?.ok ? `atualizado ${hhmm(r.at)}` : r?.error || '…', r ? !r.ok && !r.waitingCli : false);
  } else if (r && !r.ok) {
    setStatus(r.error, !r.waitingCli);
  } else {
    setStatus('carregando…');
    refresh(); // sem cache ainda — busca agora
  }
}

// aplica o retrato completo de usage:get / usage:update (todos os provedores)
function applyResults(results) {
  const wasEmpty = connectedList().length === 0;
  for (const [p, r] of Object.entries(results)) {
    connected[p] = true; // o main só sonda contas conectadas
    lastResult[p] = r;
    if (r.ok) {
      usageBy[p] = r.data;
      checkUsageAlert(p, r.data); // avalia até o provedor fora da tela
      checkSessionXp(p, r.data);
    }
  }
  if (!current || !results[current]) {
    const first = Object.keys(results)[0];
    if (first && !connected[current]) setCurrent(first);
  }
  const r = results[current];
  if (r?.ok) {
    render(r.data);
    setStatus(`atualizado ${hhmm(r.at)}`);
  } else if (r) {
    setStatus(r.error, !r.waitingCli); // esperando o CLI renovar não é erro — sem vermelho
  }
  renderProvRow();
  // renderer recarregado no meio de um login (ex.: Ctrl+R na tela de espera):
  // quando os dados chegam, entra no dash sozinho
  if (wasEmpty && (!views.login.classList.contains('hidden') || !views.wait.classList.contains('hidden'))) {
    const okP = Object.keys(results).find((p) => results[p].ok) || Object.keys(results)[0];
    if (okP) {
      setCurrent(okP);
      show('dash');
      render(usageBy[okP] || emptyUsage(okP));
    }
  }
  checkAllExpired();
}

// se TODAS as sessões conectadas expiraram, volta pra tela de login (uma vez)
let expiredShown = false;
async function checkAllExpired() {
  const list = connectedList();
  const allBad = list.length > 0 &&
    list.every((p) => lastResult[p] && !lastResult[p].ok && lastResult[p].authRequired);
  if (!allBad) {
    // a sessão voltou (ex.: usuário abriu o Claude Code e o token foi renovado):
    // se fomos nós que empurramos pra tela de login, voltamos ao dash sozinhos
    if (expiredShown && !views.login.classList.contains('hidden')) {
      const okP = list.find((p) => lastResult[p]?.ok);
      if (okP) { show('dash'); showProvider(okP); }
    }
    expiredShown = false;
    return;
  }
  // "expirado" só porque o CLI ainda não regravou o arquivo de credenciais:
  // fica no dashboard com o aviso no rodapé — a tela de login não ajudaria
  // (o atalho de lá leria o mesmo arquivo vencido) e o watcher do main
  // recupera sozinho assim que o CLI for usado de novo
  if (list.every((p) => lastResult[p]?.waitingCli)) return;
  if (expiredShown || views.dash.classList.contains('hidden')) return;
  expiredShown = true;
  const msg = lastResult[current]?.error || 'sessão expirou — conecte de novo';
  try { await showLogin(); } catch { show('login'); }
  loginError($('login-error'), new Error(msg));
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
  renderLevel();

  settings = { ...settings, ...(await claudemon.getSettings()) };
  scheduleReminders();

  const state = await claudemon.getState();
  lastPokeId = state.lastPokemonId || null;

  // pokémon fixo das configurações; sem ele, sorteia
  if (settings.pokemonId) showPokemon(settings.pokemonId, settings.pokemon);
  else loadPokemon();

  connected = { ...connected, ...state.connected };
  const list = connectedList();
  if (list.length) {
    if (!current || !connected[current]) current = list[0];
    setCurrent(current);
    show('dash');
    setStatus('carregando…');
    refresh();
  } else {
    showLogin(state);
  }
}

// mostra a tela de login só com as opções que fazem sentido: provedores já
// conectados E com sessão válida somem (expirados continuam oferecidos, senão
// a tela mandaria reconectar sem dar botão); "Voltar" aparece se há conectado
async function showLogin(state = null) {
  const s = state || (await claudemon.getState());
  connected = { ...connected, ...s.connected };
  const expired = (p) => !!(lastResult[p] && !lastResult[p].ok && lastResult[p].authRequired);
  const offerClaude = !connected.claude || expired('claude');
  const offerCodex = !connected.codex || expired('codex');
  $('btn-claude-code').classList.toggle('hidden', !(offerClaude && s.hasClaudeCodeCreds));
  $('btn-oauth').classList.toggle('hidden', !offerClaude);
  $('btn-codex-cli').classList.toggle('hidden', !(offerCodex && s.hasCodexCliCreds));
  $('btn-codex').classList.toggle('hidden', !offerCodex);
  $('login-or').classList.toggle('hidden', !(offerClaude && offerCodex));
  $('btn-login-back').classList.toggle('hidden', connectedList().length === 0);
  $('login-error').classList.add('hidden');
  show('login');
}

async function refresh() {
  try {
    setStatus('atualizando…');
    applyResults(await claudemon.getUsage());
  } catch (e) {
    setStatus(cleanErr(e), true);
  }
}

function loginError(el, e) {
  el.textContent = cleanErr(e);
  el.classList.remove('hidden');
}

// troca de view que respeita a tela de configurações aberta: em vez de fechar
// uma edição no meio, só ajusta pra onde o "Voltar" das configurações leva
function showUnlessSettings(name) {
  if (views.settings.classList.contains('hidden')) show(name);
  else lastMainView = name;
}

// entrada no dashboard após qualquer login bem-sucedido
// (data pode vir null se a 1ª leitura falhou por rede/429 — o polling recupera;
// waitingCli = atalho de CLI com token vencido — aviso neutro, watcher resolve)
function loginDone({ provider, data, error, waitingCli }, statusMsg) {
  connected[provider] = true;
  if (data) {
    usageBy[provider] = data;
    lastResult[provider] = { ok: true, at: Date.now() };
  } else if (error) {
    // espelha o formato dos polls: waitingCli é o único erro "de auth" que chega aqui
    lastResult[provider] = {
      ok: false, error, authRequired: !!waitingCli, waitingCli: !!waitingCli, at: Date.now(),
    };
  }
  expiredShown = false;
  setCurrent(provider);
  showUnlessSettings('dash');
  render(usageBy[provider] || emptyUsage(provider));
  setStatus(data ? statusMsg : error || 'carregando…', !data && !!error && !waitingCli);
}

// login via credenciais locais do Claude Code
$('btn-claude-code').addEventListener('click', async () => {
  try {
    loginDone(await claudemon.useClaudeCode(), 'conectado via Claude Code');
  } catch (e) { loginError($('login-error'), e); }
});

// login via OAuth do Claude (abre navegador, usuário cola o código)
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
    loginDone(await claudemon.finishOAuth($('code-input').value), 'conectado!');
  } catch (e) { loginError($('code-error'), e); }
});

$('code-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-code-ok').click();
});

$('btn-code-cancel').addEventListener('click', () => showLogin());

// login via credenciais locais do Codex CLI
$('btn-codex-cli').addEventListener('click', async () => {
  try {
    loginDone(await claudemon.useCodexCli(), 'conectado via Codex CLI');
  } catch (e) { loginError($('login-error'), e); }
});

// login via OAuth do Codex: tela de espera dedicada enquanto o navegador abre;
// o callback local resolve sozinho (sem colar código)
let codexPending = false;
$('btn-codex').addEventListener('click', async () => {
  if (codexPending) return;
  codexPending = true;
  show('wait');
  try {
    loginDone(await claudemon.startCodex(), 'conectado ao Codex!');
  } catch (e) {
    if (views.settings.classList.contains('hidden')) {
      await showLogin();
      if (!/cancelado/i.test(String(e?.message || e))) loginError($('login-error'), e);
    } else {
      lastMainView = 'login'; // não fecha as configurações no meio da edição
    }
  } finally {
    codexPending = false;
  }
});

$('btn-wait-cancel').addEventListener('click', () => claudemon.cancelCodex());

$('btn-login-back').addEventListener('click', () => show('dash'));

// sair desconecta só o provedor exibido; se sobrar outro, alterna pra ele
$('btn-logout').addEventListener('click', async () => {
  const p = current;
  await claudemon.logout(p);
  connected[p] = false;
  delete usageBy[p];
  delete lastResult[p];
  const rest = connectedList();
  if (rest.length) showProvider(rest[0]);
  else { setCurrent(null); showLogin(); }
});

// setinha ▶ alterna a IA exibida; + conecta a outra
$('btn-prov-next').addEventListener('click', () => showProvider(otherProvider()));
$('btn-prov-add').addEventListener('click', () => showLogin());

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
$('bubble').addEventListener('click', () => {
  if (alarmOn) { stopAlarm(); return; }
  const armed = reminderXpArmed;
  hideBubble();
  if (armed) { // cumprir o lembrete (água, levantar, pausa) dá XP
    showBubble('👍 BOA!', 2000); // antes do XP: balão de level up tem prioridade
    hop();
    gainXp(XP_REMINDER);
  }
});

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

// push do processo principal: um evento por poll com o mapa completo
claudemon.onUsage((results) => applyResults(results));

claudemon.onReroll(() => loadPokemon());

boot();
