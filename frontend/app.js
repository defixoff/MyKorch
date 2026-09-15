/**
 * Мой корч — NextGen PWA Mining Calculator
 * 
 * Точный расчёт профита майнинг-фермы по каждому ригу и каждой видеокарте.
 * Optimistic UI, интерактивная аврора с частицами, 3D-тилт и spring-анимации.
 */

// График работы: рабочая смена 18ч, выходная 24ч
const TIME = { workingDayDuration: 18, weekendDayDuration: 24 };

// Горизонты времени для калькулятора
const HORIZONS = {
  '24h':  { id: '24h',  label: '24 часа', short: '24 ч',  suffix: '/ сут', mult: 1 },
  '7d':   { id: '7d',   label: '7 дней',   short: '7 дн',  suffix: '/ нед', mult: 7 },
  '30d':  { id: '30d',  label: '30 дней',  short: '30 дн', suffix: '/ мес', mult: 30 },
  '365d': { id: '365d', label: '1 год',    short: '1 год', suffix: '/ год', mult: 365 },
};

// Расчёт средней суточной добычи монеты с учётом графика работы рига
function avgDailyYield(rig) {
  const coinsPerDay = Number(rig?.coin_per_day || 0);
  const workingDays = Number(rig?.working_days ?? 5);
  const weekendDays = Number(rig?.weekend_days ?? 2);
  const totalDays = workingDays + weekendDays;
  if (totalDays <= 0) return coinsPerDay;

  if (rig?.calculation_mode === 'weekend_days') {
    // Входная ставка coin_per_day измерена в выходные (24ч непрерывной работы).
    // В рабочие сутки (18ч) добыча составляет coin_per_day / 24 * 18.
    return ((coinsPerDay / TIME.weekendDayDuration * TIME.workingDayDuration) * workingDays + coinsPerDay * weekendDays) / totalDays;
  }
  // По умолчанию: входная ставка измерена в рабочие сутки (18ч).
  // В выходные сутки (24ч) добыча составляет coin_per_day / 18 * 24.
  return (coinsPerDay * workingDays + (coinsPerDay / TIME.workingDayDuration * TIME.weekendDayDuration) * weekendDays) / totalDays;
}

// Конфигурация API: относительный /api надёжно работает на всех доменах, портах и Vercel
const configuredApi = window.localStorage.getItem('korch_api_url') || new URLSearchParams(window.location.search).get('api');
const API = (configuredApi || '/api').replace(/\/$/, '');
const CACHE_KEY = 'korch_cache_v2';

// Глобальное состояние приложения
const state = {
  token: localStorage.getItem('korch_token'),
  user: null,
  rigs: [],
  coins: [],
  selectedRigId: null,
  cards: [],
  cardsByRig: {},
  theme: localStorage.getItem('korch_theme') || 'dark',
  timeHorizon: localStorage.getItem('korch_horizon') || '24h',
  viewScope: 'rig', // 'rig' (по умолчанию) или 'farm'
  editingCardId: null,
};

const app = document.querySelector('#app');

// Хелперы форматирования
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[char]));
const money = (value) => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value) || 0);
const number = (value, digits = 2) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(Number(value) || 0);

// Иконки SVG из спрайта
const ico = (name, extra = '') => `<svg class="ico ${extra}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

// Получить текущий курс монеты к USD
function coinRate(coinName) {
  if (!coinName) return 0;
  const match = state.coins.find((coin) => coin.name.toLowerCase() === String(coinName).toLowerCase());
  return Number(match?.price_usd || 0);
}

// Расчёт сводки по отдельному ригу
function rigCalculation(rig, cards = []) {
  const cardList = Array.isArray(cards) ? cards : [];
  const totalHashrate = cardList.reduce((sum, c) => sum + Number(c.hashrate || 0) * Number(c.quantity || 1), 0);
  const totalPower = cardList.reduce((sum, c) => sum + Number(c.power || 0) * Number(c.quantity || 1), 0);
  const dailyYield = avgDailyYield(rig);
  const incomePerMhs = totalHashrate > 0 ? dailyYield / totalHashrate : 0;
  const priceUsd = coinRate(rig?.coin);

  // Грязный суточный доход рига в USD
  const grossIncomeDaily = totalHashrate > 0 ? dailyYield * priceUsd : 0;
  // Суточный расход на электроэнергию
  const electricityDaily = (totalPower / 1000) * 24 * Number(rig?.electricity_cost || 0);
  const profitDaily = grossIncomeDaily - electricityDaily;
  const margin = grossIncomeDaily > 0 ? (profitDaily / grossIncomeDaily) * 100 : (profitDaily < 0 ? -100 : 0);
  const totalCardsCount = cardList.reduce((sum, c) => sum + Number(c.quantity || 1), 0);

  return {
    totalHashrate,
    totalPower,
    dailyYield,
    incomePerMhs,
    priceUsd,
    grossIncomeDaily,
    electricityDaily,
    profitDaily,
    margin,
    totalCardsCount,
  };
}

// Расчёт дохода по конкретной видеокарте (НОВАЯ ФИЧА!)
function cardCalculation(card, rig, rigTotals) {
  const qty = Math.max(1, Number(card.quantity || 1));
  const unitHash = Number(card.hashrate || 0);
  const unitPower = Number(card.power || 0);
  const totalHash = unitHash * qty;
  const totalPower = unitPower * qty;

  const incomePerMhs = rigTotals?.incomePerMhs || 0;
  const priceUsd = rigTotals?.priceUsd || 0;
  const electricityCost = Number(rig?.electricity_cost || 0);

  // Добыча и доход для всей группы одинаковых карт
  const dailyCoins = totalHash * incomePerMhs;
  const dailyGross = dailyCoins * priceUsd;
  const dailyElectricity = (totalPower / 1000) * 24 * electricityCost;
  const dailyProfit = dailyGross - dailyElectricity;
  const margin = dailyGross > 0 ? (dailyProfit / dailyGross) * 100 : (dailyProfit < 0 ? -100 : 0);

  // Расчёт на одну штуку
  const unitCoins = unitHash * incomePerMhs;
  const unitGross = unitCoins * priceUsd;
  const unitElectricity = (unitPower / 1000) * 24 * electricityCost;
  const unitProfit = unitGross - unitElectricity;

  // Энергоэффективность и доля в риге
  const wattPerMhs = unitHash > 0 ? unitPower / unitHash : 0;
  const rigShare = rigTotals?.totalHashrate > 0 ? (totalHash / rigTotals.totalHashrate) * 100 : 0;

  return {
    qty,
    unitHash,
    unitPower,
    totalHash,
    totalPower,
    dailyCoins,
    dailyGross,
    dailyElectricity,
    dailyProfit,
    margin,
    unitCoins,
    unitGross,
    unitElectricity,
    unitProfit,
    wattPerMhs,
    rigShare,
  };
}

// Кэширование состояния
function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      user: state.user,
      coins: state.coins,
      rigs: state.rigs,
      cardsByRig: state.cardsByRig,
      selectedRigId: state.selectedRigId,
      timeHorizon: state.timeHorizon,
    }));
  } catch (error) {}
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY) || localStorage.getItem('korch_cache_v1');
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
}

// Работа с сетью
const AUTH_ENDPOINTS = new Set(['/auth/login', '/auth/register', '/auth/reset-password', '/auth/change-password']);
async function request(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  let response;
  try {
    response = await fetch(`${API}${path}`, { ...options, headers });
  } catch (error) {
    throw new Error(`Не удалось подключиться к серверу (${API}). Проверьте подключение к сети.`);
  }
  if (response.status === 401) {
    if (!AUTH_ENDPOINTS.has(path)) {
      logout(false);
      throw new Error('Сессия истекла. Пожалуйста, войдите снова.');
    }
    const payload = await response.json().catch(() => ({}));
    throw new Error(typeof payload.detail === 'string' ? payload.detail : 'Неверные учётные данные');
  }
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload.detail === 'string' ? payload.detail : 'Ошибка сервера');
  }
  return payload;
}

// Всплывающие уведомления (Toasts)
function toast(message, type = 'success') {
  const region = document.querySelector('#toast-region');
  if (!region) return;
  const node = document.createElement('div');
  node.className = `toast ${type === 'error' ? 'error' : 'ok'}`;
  node.innerHTML = `${ico(type === 'error' ? 'close' : 'check')}<span>${escapeHtml(message)}</span>`;
  region.append(node);
  setTimeout(() => {
    node.classList.add('toast-out');
    node.addEventListener('animationend', () => node.remove(), { once: true });
    setTimeout(() => node.remove(), 300);
  }, 3200);
}

// Праздничный салют конфетти при важных действиях (добавление рига, карты, профит)
function launchConfetti(originX = window.innerWidth / 2, originY = window.innerHeight / 2) {
  const canvas = document.querySelector('#confetti-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const count = 40;
  const particles = [];
  const colors = ['#fbbf24', '#f97316', '#34d399', '#10b981', '#38bdf8', '#a855f7'];

  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
    const speed = 4 + Math.random() * 8;
    particles.push({
      x: originX,
      y: originY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 2,
      color: colors[Math.floor(Math.random() * colors.length)],
      radius: 3 + Math.random() * 4,
      rotation: Math.random() * Math.PI,
      vRot: (Math.random() - 0.5) * 0.2,
      alpha: 1,
      decay: 0.015 + Math.random() * 0.02,
    });
  }

  function frame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    particles.forEach((p) => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.2; // гравитация
      p.rotation += p.vRot;
      p.alpha -= p.decay;
      if (p.alpha > 0) {
        alive = true;
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.alpha);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.radius, -p.radius, p.radius * 2, p.radius * 1.5);
        ctx.restore();
      }
    });
    if (alive) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  requestAnimationFrame(frame);
}

// Применение темы оформления
function applyTheme() {
  const dark = state.theme === 'dark';
  document.documentElement.classList.toggle('dark', dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#05070e' : '#eef2f8');
  localStorage.setItem('korch_theme', state.theme);
}

// Плавное закрытие модальных окон
function closeModal(node) {
  if (!node || node.classList.contains('closing')) return;
  node.classList.add('closing');
  let done = false;
  const finish = () => { if (done) return; done = true; node.remove(); };
  node.addEventListener('animationend', finish, { once: true });
  setTimeout(finish, 260);
}

// Кастомный стеклянный селект (Dropdown)
function dropdownHtml(name, options, current) {
  const norm = (v) => String(v || '').toLowerCase();
  const cur = options.find((o) => norm(o.value) === norm(current)) || options[0];
  return `<div class="dd" data-dd>
    <input type="hidden" name="${name}" value="${escapeHtml(cur?.value ?? '')}">
    <button type="button" class="dd-btn field" aria-haspopup="listbox" aria-expanded="false">
      <span class="dd-label truncate">${escapeHtml(cur?.label ?? '')}</span>
      ${ico('chevron', 'dd-caret')}
    </button>
    <ul class="dd-list" role="listbox">
      ${options.map((o) => `<li><button type="button" class="dd-item ${o.value === cur?.value ? 'selected' : ''}" data-value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</button></li>`).join('')}
    </ul>
  </div>`;
}

function initDropdowns(root) {
  root.querySelectorAll('[data-dd]').forEach((dd) => {
    const input = dd.querySelector('input');
    const btn = dd.querySelector('.dd-btn');
    const labelSpan = dd.querySelector('.dd-label');

    btn.onclick = () => {
      const wasOpen = dd.classList.contains('open');
      closeAllDropdowns();
      if (!wasOpen) {
        dd.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
        requestAnimationFrame(() => dd.querySelector('.dd-list')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
      }
    };

    dd.querySelectorAll('.dd-item').forEach((item) => {
      item.onclick = () => {
        input.value = item.dataset.value;
        if (labelSpan) labelSpan.textContent = item.textContent;
        dd.querySelectorAll('.dd-item').forEach((i) => i.classList.toggle('selected', i === item));
        closeAllDropdowns();
      };
    });
  });
}

function closeAllDropdowns() {
  document.querySelectorAll('.dd.open').forEach((d) => {
    d.classList.remove('open');
    d.querySelector('.dd-btn')?.setAttribute('aria-expanded', 'false');
  });
}
document.addEventListener('click', (event) => {
  if (!event.target.closest('[data-dd]')) closeAllDropdowns();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeAllDropdowns();
});

// Плавная числовая интерполяция (Spring Tween) для анимированной смены чисел
const displayedNumbers = new Map();
const activeTweens = new WeakMap();

function fmtTween(node, value) {
  const type = node.dataset.tweenFmt || 'money';
  if (type === 'money') return money(value);
  if (type === 'number0') return number(value, 0);
  if (type === 'number1') return number(value, 1);
  return number(value, 2);
}

function tweenNode(node, from, to) {
  if (activeTweens.has(node)) {
    cancelAnimationFrame(activeTweens.get(node));
    activeTweens.delete(node);
  }

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || Math.abs(to - from) < 1e-6) {
    node.textContent = fmtTween(node, to);
    return;
  }

  const start = performance.now();
  const duration = 460;
  const delta = to - from;

  const step = (now) => {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    // easeOutCubic
    const eased = 1 - Math.pow(1 - progress, 3);
    node.textContent = fmtTween(node, from + delta * eased);

    if (progress < 1 && document.contains(node)) {
      const rafId = requestAnimationFrame(step);
      activeTweens.set(node, rafId);
    } else {
      node.textContent = fmtTween(node, to);
      activeTweens.delete(node);
    }
  };
  const rafId = requestAnimationFrame(step);
  activeTweens.set(node, rafId);
}

function triggerFlash(scope, direction) {
  scope.querySelectorAll('[data-tween]').forEach((el) => {
    el.classList.remove('flash-up', 'flash-down');
    void el.offsetWidth;
    el.classList.add(direction === 'up' ? 'flash-up' : 'flash-down');
  });
}

function syncTweenValues(valuesMap) {
  for (const [id, next] of Object.entries(valuesMap)) {
    const node = document.querySelector(`[data-tween="${id}"]`);
    if (!node) continue;
    const prev = displayedNumbers.get(id);
    if (prev !== undefined && Number.isFinite(prev) && Math.abs(prev - next) > 1e-6) {
      tweenNode(node, prev, next);
      triggerFlash(node.closest('.stat-card, .gpu-card, [data-stat-scope]') || node, next > prev ? 'up' : 'down');
    } else {
      node.textContent = fmtTween(node, next);
    }
    displayedNumbers.set(id, next);
  }
}

// Интерактивная 3D-подсветка стекла (Pointer Glow)
function initPointerGlow() {
  if (initPointerGlow.bound) return;
  initPointerGlow.bound = true;
  let raf = 0;
  window.addEventListener('pointermove', (event) => {
    const card = event.target.closest?.('.card-glass, .gpu-card');
    if (!card) return;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!document.contains(card)) return;
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${event.clientX - rect.left}px`);
      card.style.setProperty('--my', `${event.clientY - rect.top}px`);
    });
  }, { passive: true });
}

// "Пилюля" активного рига: плавное скольжение между табами
function updateRigPill(animate = true) {
  const tabs = document.querySelector('#rig-tabs');
  if (!tabs) return;
  const active = tabs.querySelector('.rig-tab.active');
  const pill = tabs.querySelector('.rig-pill');
  if (!pill) return;
  if (!active) { pill.style.opacity = '0'; return; }

  if (!animate) {
    pill.style.transitionProperty = 'none';
  }
  pill.style.width = `${active.offsetWidth}px`;
  pill.style.transform = `translateX(${active.offsetLeft}px)`;
  pill.style.opacity = '1';

  if (!animate) {
    requestAnimationFrame(() => { pill.style.transitionProperty = ''; });
  }
}
window.addEventListener('resize', () => updateRigPill(false), { passive: true });

// Фоновый Canvas с кибер-частицами и линиями связей
function initBackgroundParticles() {
  const canvas = document.querySelector('#aurora-canvas');
  if (!canvas || canvas.dataset.initialized) return;
  canvas.dataset.initialized = 'true';
  const ctx = canvas.getContext('2d');

  let width = (canvas.width = window.innerWidth);
  let height = (canvas.height = window.innerHeight);

  window.addEventListener('resize', () => {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  }, { passive: true });

  const particleCount = Math.min(Math.floor(width / 35), 45);
  const particles = [];

  for (let i = 0; i < particleCount; i++) {
    particles.push({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.45,
      vy: (Math.random() - 0.5) * 0.45,
      radius: Math.random() * 1.8 + 1,
    });
  }

  let mouseX = -1000;
  let mouseY = -1000;
  window.addEventListener('pointermove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
  }, { passive: true });

  function render() {
    ctx.clearRect(0, 0, width, height);
    const isDark = document.documentElement.classList.contains('dark');
    const pColor = isDark ? 'rgba(251, 191, 36, 0.4)' : 'rgba(217, 119, 6, 0.3)';
    const lColor = isDark ? 'rgba(251, 146, 60, 0.08)' : 'rgba(234, 88, 12, 0.06)';

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;

      if (p.x < 0) p.x = width;
      else if (p.x > width) p.x = 0;
      if (p.y < 0) p.y = height;
      else if (p.y > height) p.y = 0;

      // Отрисовка частицы
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fillStyle = pColor;
      ctx.fill();

      // Линии между близкими частицами
      for (let j = i + 1; j < particles.length; j++) {
        const p2 = particles[j];
        const dx = p.x - p2.x;
        const dy = p.y - p2.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 120) {
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.strokeStyle = lColor;
          ctx.lineWidth = 1 - dist / 120;
          ctx.stroke();
        }
      }
    }
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);
}

// Рендер скелетона при холодной загрузке
function renderSkeleton() {
  app.innerHTML = `<div class="mx-auto min-h-screen max-w-6xl p-4 sm:p-7">
    <header class="mb-7 flex flex-wrap items-center justify-between gap-3">
      <div class="space-y-2"><div class="skeleton h-3 w-24"></div><div class="skeleton h-8 w-44"></div></div>
      <div class="flex gap-2 sm:gap-3"><div class="skeleton h-11 w-28"></div><div class="skeleton h-11 w-24"></div></div>
    </header>
    <section class="grid gap-4 sm:grid-cols-2">
      <div class="skeleton h-36 card-glass"></div>
      <div class="skeleton h-36 card-glass"></div>
    </section>
    <section class="mt-7">
      <div class="skeleton mb-3 h-5 w-24"></div>
      <div class="rig-tabs"><div class="skeleton h-11 w-28"></div><div class="skeleton h-11 w-28"></div></div>
    </section>
    <section class="card-glass mt-6 space-y-4 p-5 sm:p-7">
      <div class="skeleton h-7 w-40"></div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="skeleton h-36 rounded-2xl"></div>
        <div class="skeleton h-36 rounded-2xl"></div>
      </div>
    </section>
  </div>`;
}

// Экран авторизации и регистрации
function renderAuth(mode = 'login') {
  app.innerHTML = `<section class="page-enter flex min-h-screen items-center justify-center p-5">
    <div class="auth-panel glass w-full max-w-md rounded-3xl p-7 sm:p-9">
      <div class="mb-8">
        <div class="auth-logo mb-4">${ico('logo', 'ico-lg')}</div>
        <h1 class="auth-title">Мой корч</h1>
        <p class="mt-2 text-[15px] text-slate-500 dark:text-slate-400">Премиальный майнинг-калькулятор фермы. Точный расчёт по каждому ригу и каждой видеокарте.</p>
      </div>
      <form id="auth-form" class="space-y-4">
        <label class="block text-sm font-semibold">Логин
          <input name="username" required minlength="3" autocomplete="username" class="field" placeholder="miner_01">
        </label>
        <label class="block text-sm font-semibold">Пароль
          <input name="password" type="password" required minlength="6" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" class="field" placeholder="Не менее 6 символов">
        </label>
        <button class="btn btn-accent w-full">${mode === 'login' ? 'Войти в панель' : 'Создать аккаунт'} ${ico('chevron')}</button>
      </form>
      <button id="auth-switch" class="mt-5 w-full text-sm font-semibold text-amber-500 transition hover:text-amber-400">
        ${mode === 'login' ? 'Нет аккаунта? Зарегистрироваться' : 'Уже есть аккаунт? Войти'}
      </button>
      ${mode === 'login' ? `<button id="auth-forgot" class="mt-2 w-full text-xs font-medium text-slate-500 transition hover:text-amber-500">Забыли пароль?</button>` : ''}
    </div>
  </section>`;

  document.querySelector('#auth-switch').onclick = () => renderAuth(mode === 'login' ? 'register' : 'login');
  const forgot = document.querySelector('#auth-forgot');
  if (forgot) forgot.onclick = showResetPasswordModal;

  document.querySelector('#auth-form').onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('button[type="submit"], button:not([type])');
    const originalText = submit?.innerHTML;
    if (submit) { submit.disabled = true; submit.textContent = 'Подключение…'; }
    try {
      const data = await request(`/auth/${mode === 'login' ? 'login' : 'register'}`, {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      state.token = data.token;
      state.user = data.user;
      localStorage.setItem('korch_token', data.token);
      await refresh();
      toast(mode === 'login' ? 'Добро пожаловать!' : 'Аккаунт успешно создан!');
      launchConfetti();
    } catch (error) {
      if (submit) { submit.disabled = false; submit.innerHTML = originalText; }
      toast(error.message, 'error');
    }
  };
}

// Главный дашборд приложения
function renderDashboard() {
  if (!state.user) return renderAuth();

  // Обеспечиваем выбор первого рига при наличии ригов
  if (state.rigs.length && !state.rigs.some((r) => String(r.id) === String(state.selectedRigId))) {
    state.selectedRigId = state.rigs[0].id;
  }

  const selectedRig = state.rigs.find((r) => String(r.id) === String(state.selectedRigId));
  state.cards = selectedRig ? (state.cardsByRig[String(selectedRig.id)] || state.cardsByRig[selectedRig.id] || []) : [];

  // Расчёты по выбранному ригу
  const rigTotals = selectedRig ? rigCalculation(selectedRig, state.cards) : {
    totalHashrate: 0, totalPower: 0, dailyYield: 0, incomePerMhs: 0, priceUsd: 0,
    grossIncomeDaily: 0, electricityDaily: 0, profitDaily: 0, margin: 0, totalCardsCount: 0
  };

  // Расчёты по ВСЕЙ ферме
  const farmTotals = state.rigs.reduce((acc, r) => {
    const cards = state.cardsByRig[String(r.id)] || state.cardsByRig[r.id] || [];
    const calc = rigCalculation(r, cards);
    acc.gross += calc.grossIncomeDaily;
    acc.electricity += calc.electricityDaily;
    acc.profit += calc.profitDaily;
    acc.hashrate += calc.totalHashrate;
    acc.cardsCount += calc.totalCardsCount;
    return acc;
  }, { gross: 0, electricity: 0, profit: 0, hashrate: 0, cardsCount: 0 });

  const horizon = HORIZONS[state.timeHorizon] || HORIZONS['24h'];
  const mult = horizon.mult;

  // Значения для отображения в главных окнах сверху:
  // ПО ТРЕБОВАНИЮ: "Давай сверху в главных окнах сделаем профит и расход не на всю ферму а на каждый риг отдельно при переключении"
  const isRigScope = state.viewScope === 'rig';
  const displayProfit = isRigScope ? rigTotals.profitDaily * mult : farmTotals.profit * mult;
  const displayElectricity = isRigScope ? rigTotals.electricityDaily * mult : farmTotals.electricity * mult;
  const displayGross = isRigScope ? rigTotals.grossIncomeDaily * mult : farmTotals.gross * mult;
  const displayMargin = isRigScope ? rigTotals.margin : (farmTotals.gross > 0 ? (farmTotals.profit / farmTotals.gross) * 100 : 0);
  const isProfitNegative = displayProfit < 0;

  app.innerHTML = `<div class="page-enter mx-auto min-h-screen max-w-6xl p-4 pb-12 sm:p-7">
    <!-- Шапка -->
    <header class="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-3">
        <div class="auth-logo" style="width:2.9rem;height:2.9rem;border-radius:15px">${ico('logo', 'ico-lg')}</div>
        <div>
          <div class="flex items-center gap-2">
            <span class="status-pulse" title="Ферма онлайн"></span>
            <p class="text-[11px] font-bold uppercase tracking-[.22em] text-amber-500/95">${escapeHtml(state.user.username)}</p>
          </div>
          <h1 class="font-display text-[25px] font-extrabold sm:text-3xl">Мой корч</h1>
        </div>
      </div>
      <div class="flex flex-wrap items-center justify-end gap-2 sm:gap-3">
        <button id="settings" class="btn btn-ghost">${ico('gear')} Настройки</button>
        <button id="logout-button" class="btn btn-ghost" title="Выйти">${ico('logout')}<span class="max-sm:hidden"> Выйти</span></button>
      </div>
    </header>

    <!-- Панель управления: Переключатель Риг/Ферма + Выбор периода (24ч/7д/30д/1г) -->
    <section class="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-2">
        <div class="horizon-bar">
          <button id="scope-rig" class="horizon-btn ${isRigScope ? 'active' : ''}">${ico('gpu')} Выбранный риг</button>
          <button id="scope-farm" class="horizon-btn ${!isRigScope ? 'active' : ''}">${ico('farm')} Вся ферма</button>
        </div>
      </div>

      <div class="flex items-center gap-2">
        <div id="horizon-selector" class="horizon-bar">
          ${Object.values(HORIZONS).map((h) => `
            <button data-horizon="${h.id}" class="horizon-btn ${h.id === state.timeHorizon ? 'active' : ''}">
              ${h.short}
            </button>
          `).join('')}
        </div>
      </div>
    </section>

    <!-- Сводка всей фермы (компактная информационная полоса) -->
    <div class="farm-summary-bar glass mb-5 rise-in">
      <div class="flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-500 dark:text-slate-400">
        <span class="chip chip-amber">${ico('farm')} Вся ферма: ${state.rigs.length} риг. (${farmTotals.cardsCount} карт)</span>
        <span>· Хеш: <b class="num text-slate-800 dark:text-slate-200">${number(farmTotals.hashrate)} MH/s</b></span>
        <span>· Свет: <b class="num text-slate-800 dark:text-slate-200">${money(farmTotals.electricity * mult)}</b></span>
        <span>· Профит фермы: <b class="num ${farmTotals.profit >= 0 ? 'text-emerald-500' : 'text-rose-400'}">${money(farmTotals.profit * mult)}</b></span>
      </div>
      <span class="text-xs font-medium text-slate-400 dark:text-slate-500">Период: ${horizon.label}</span>
    </div>

    <!-- ГЛАВНЫЕ КАРТОЧКИ СВЕРХУ (рассчитываются для выбранного рига при переключении!) -->
    <section class="grid gap-3.5 sm:gap-5 sm:grid-cols-2">
      <!-- Карточка 1: Чистый профит -->
      <article class="stat-card card-glass rise-in stat-main ${isProfitNegative ? 'negative' : 'profitable'}" data-stat-scope="profit">
        <div class="stat-label">
          <span>${ico('coin')} Чистый профит · <b class="text-slate-900 dark:text-slate-100">${escapeHtml(isRigScope ? (selectedRig?.name || 'Риг не выбран') : 'Вся ферма')}</b></span>
          <span class="chip ${isProfitNegative ? 'chip-rose' : 'chip-emerald'}">
            ${isProfitNegative ? 'Убыток' : 'Профит'} ${displayMargin > 0 ? `+${displayMargin.toFixed(0)}%` : `${displayMargin.toFixed(0)}%`}
          </span>
        </div>
        <span class="stat-value num" data-tween="main-profit" data-tween-fmt="money">${money(displayProfit)}</span>
        
        <div class="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span>Грязный доход: <b class="num text-slate-700 dark:text-slate-300" data-tween="main-gross" data-tween-fmt="money">${money(displayGross)}</b></span>
          <span>за ${horizon.label}</span>
        </div>

        <div class="margin-bar-wrap">
          <div class="margin-bar-fill ${isProfitNegative ? 'negative' : ''}" style="width:${Math.max(5, Math.min(100, Math.abs(displayMargin)))}%"></div>
        </div>
      </article>

      <!-- Карточка 2: Расход на свет -->
      <article class="stat-card card-glass rise-in stat-card-power" style="animation-delay:60ms" data-stat-scope="power">
        <div class="stat-label">
          <span>${ico('flash')} Расход на свет · <b class="text-slate-900 dark:text-slate-100">${escapeHtml(isRigScope ? (selectedRig?.name || 'Риг не выбран') : 'Вся ферма')}</b></span>
          <span class="chip">
            ${isRigScope ? `${number(rigTotals.totalPower, 0)} Вт` : `${number(farmTotals.electricity / (mult * 24 * 0.1) * 1000, 0)} Вт`}
          </span>
        </div>
        <span class="stat-value num" data-tween="main-electricity" data-tween-fmt="money">${money(displayElectricity)}</span>

        <div class="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span>${isRigScope && selectedRig ? `Тариф: ${money(selectedRig.electricity_cost)}/кВт·ч` : 'Суммарный расход фермы'}</span>
          <span>за ${horizon.label}</span>
        </div>

        <div class="margin-bar-wrap">
          <div class="margin-bar-fill" style="background:linear-gradient(90deg, #38bdf8, #0284c7);width:${isRigScope && rigTotals.grossIncomeDaily > 0 ? Math.min(100, (rigTotals.electricityDaily / rigTotals.grossIncomeDaily) * 100) : 50}%"></div>
        </div>
      </article>
    </section>

    <!-- Секция выбора ригов (Табы с анимированной пилюлей) -->
    <section class="mt-7 sm:mt-8">
      <div class="mb-3.5 flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <h2 class="font-display text-lg font-bold">Риги фермы</h2>
          <span class="text-xs font-semibold text-slate-500">(${state.rigs.length})</span>
        </div>
        <button id="add-rig" class="btn btn-ghost">${ico('plus')} Добавить риг</button>
      </div>

      <div id="rig-tabs" class="rig-tabs rise-in" style="animation-delay:100ms">
        <span class="rig-pill" aria-hidden="true"></span>
        ${state.rigs.map((rig) => `
          <button data-rig-id="${rig.id}" class="rig-tab ${String(rig.id) === String(state.selectedRigId) ? 'active' : ''}">
            ${escapeHtml(rig.name)}
          </button>
        `).join('') || '<p class="px-3 py-2 text-sm text-slate-500">Ригов пока нет.</p>'}
      </div>
    </section>

    <!-- Секция оборудования текущего рига -->
    <section class="card-glass rise-in mt-6 p-4 sm:p-7" style="animation-delay:140ms">
      <div class="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div class="flex items-center gap-2">
            <span class="status-pulse"></span>
            <p class="text-xs font-bold uppercase tracking-wider text-slate-500">Текущий риг</p>
          </div>
          <h2 class="font-display text-xl font-bold sm:text-2xl">${escapeHtml(selectedRig?.name || 'Не выбран')}</h2>
          ${selectedRig ? `
            <div class="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
              ${selectedRig.coin ? `<span class="chip chip-amber">${ico('coin')} ${escapeHtml(selectedRig.coin)} · ${money(coinRate(selectedRig.coin))}</span>` : '<span class="chip chip-rose">Монета не задана</span>'}
              <span>· Добыча: <b class="num text-slate-700 dark:text-slate-300">${number(avgDailyYield(selectedRig) * mult, 4)}</b> ${escapeHtml(selectedRig.coin || '')}${horizon.suffix}</span>
              <span>· Розетка: <b class="num text-slate-700 dark:text-slate-300">${money(selectedRig.electricity_cost)}</b>/кВт·ч</span>
            </div>
          ` : ''}
        </div>

        ${selectedRig ? `
          <div class="flex shrink-0 gap-1.5">
            <button id="rig-config" class="btn btn-ghost" title="Конфигурация рига">${ico('gear')} <span class="max-sm:hidden">Конфигурация</span></button>
            <button id="rename-rig" class="btn btn-ghost btn-icon" title="Переименовать риг" aria-label="Переименовать">${ico('edit')}</button>
            <button id="delete-rig" class="btn btn-ghost btn-icon danger" title="Удалить риг" aria-label="Удалить">${ico('trash')}</button>
          </div>
        ` : ''}
      </div>

      <!-- Сетка видеокарт с РАСЧЁТОМ ПРИМЕРНОГО ДОХОДА НА КАЖДУЮ КАРТУ -->
      <div class="mb-4 flex items-center justify-between">
        <h3 class="font-display text-base font-bold flex items-center gap-2">
          ${ico('gpu')} Видеокарты рига
          <span class="chip">${state.cards.reduce((sum, c) => sum + Number(c.quantity || 1), 0)} шт.</span>
        </h3>
        ${selectedRig ? `<button id="add-card" class="btn btn-accent btn-sm">${ico('plus')} Добавить карту</button>` : ''}
      </div>

      <div id="card-list" class="grid gap-3.5 sm:grid-cols-2">
        ${state.cards.length ? state.cards.map((card, index) => cardHtml(card, selectedRig, rigTotals, mult, horizon.suffix, index)).join('') : `
          <div class="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-slate-500 dark:border-slate-800 sm:col-span-2">
            <div class="mx-auto mb-2 w-10 text-slate-400">${ico('gpu', 'ico-lg')}</div>
            <p class="font-bold">В этом риге ещё нет видеокарт</p>
            <p class="mt-1 text-xs">Нажмите «Добавить карту», чтобы рассчитать доход и хешрейт.</p>
          </div>
        `}
      </div>

      <!-- Итоги по текущему ригу -->
      ${selectedRig ? `
        <footer class="rig-footer mt-7 flex flex-col gap-4 border-t border-white/5 pt-5 sm:flex-row sm:items-center sm:justify-between">
          <div data-stat-scope="rig-summary">
            <p class="text-xs font-bold uppercase tracking-wider text-slate-500">Итого по ригу · ${horizon.label}</p>
            <p class="mt-1 text-xl font-extrabold sm:text-2xl">
              <span class="num ${rigTotals.profitDaily >= 0 ? 'text-emerald-500' : 'text-rose-400'}" data-tween="rig-footer-profit" data-tween-fmt="money">${money(rigTotals.profitDaily * mult)}</span>
              <span class="text-sm font-medium text-slate-500">чистыми / свет <span class="num text-slate-400" data-tween="rig-footer-electricity" data-tween-fmt="money">${money(rigTotals.electricityDaily * mult)}</span></span>
            </p>
            <p class="rig-total-hash font-display num mt-2 text-[16px] font-extrabold text-amber-500/95">
              ${number(rigTotals.totalHashrate, 2)} MH/s 
              <span class="text-xs font-medium text-slate-500">· общий хеш · ${number(rigTotals.totalPower, 0)} Вт</span>
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button id="btn-add-card-footer" class="btn btn-accent">${ico('plus')} Добавить карту</button>
          </div>
        </footer>
      ` : ''}
    </section>
  </div>`;

  // Синхронизация анимированных чисел
  syncTweenValues({
    'main-profit': displayProfit,
    'main-gross': displayGross,
    'main-electricity': displayElectricity,
    'rig-footer-profit': rigTotals.profitDaily * mult,
    'rig-footer-electricity': rigTotals.electricityDaily * mult,
  });

  initPointerGlow();
  requestAnimationFrame(() => updateRigPill(false));

  // Навешивание обработчиков событий
  document.querySelector('#logout-button').onclick = () => logout(true);
  document.querySelector('#settings')?.addEventListener('click', showSettingsModal);
  document.querySelector('#add-rig')?.addEventListener('click', showRigModal);
  document.querySelector('#scope-rig')?.addEventListener('click', () => switchViewScope('rig'));
  document.querySelector('#scope-farm')?.addEventListener('click', () => switchViewScope('farm'));

  // Выбор горизонта времени (24ч / 7д / 30д / 1г)
  document.querySelectorAll('#horizon-selector [data-horizon]').forEach((btn) => {
    btn.onclick = () => switchHorizon(btn.dataset.horizon);
  });

  // Табы ригов
  document.querySelectorAll('.rig-tab').forEach((button) => {
    button.onclick = () => switchRig(Number(button.dataset.rigId));
  });

  // Управление текущим ригом
  document.querySelector('#rig-config')?.addEventListener('click', () => showRigConfigModal(selectedRig));
  document.querySelector('#rename-rig')?.addEventListener('click', () => showRenameRigModal(selectedRig));
  document.querySelector('#delete-rig')?.addEventListener('click', deleteSelectedRig);

  // Добавление карт
  document.querySelector('#add-card')?.addEventListener('click', () => { state.editingCardId = null; showCardModal(); });
  document.querySelector('#btn-add-card-footer')?.addEventListener('click', () => { state.editingCardId = null; showCardModal(); });

  // Редактирование и удаление конкретных карт
  document.querySelectorAll('[data-edit-card]').forEach((button) => {
    button.onclick = () => {
      const cardId = Number(button.dataset.editCard);
      const card = state.cards.find((c) => c.id === cardId);
      if (card) showCardModal(card);
    };
  });

  document.querySelectorAll('[data-delete-card]').forEach((button) => {
    button.onclick = () => deleteCard(Number(button.dataset.deleteCard));
  });
}

// Генерация HTML карточки видеокарты с РАСЧЁТОМ ДОХОДА
function cardHtml(card, rig, rigTotals, mult = 1, suffix = '/ сут', index = 0) {
  const calc = cardCalculation(card, rig, rigTotals);
  const profit = calc.dailyProfit * mult;
  const gross = calc.dailyGross * mult;
  const electricity = calc.dailyElectricity * mult;
  const coins = calc.dailyCoins * mult;
  const isProfitable = profit >= 0;

  return `<article style="animation-delay:${Math.min(index, 10) * 45}ms" class="gpu-card card-pop" data-card-item="${card.id}">
    <div class="flex items-start justify-between gap-3">
      <div>
        <div class="flex items-center gap-2">
          <span class="status-pulse" title="В работе"></span>
          <h4 class="font-display font-bold text-base tracking-tight">${escapeHtml(card.model)}</h4>
        </div>
        <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span class="chip chip-amber">${calc.qty} шт.</span>
          <span>${number(calc.unitHash)} MH/s · ${number(calc.unitPower, 0)} Вт на карту</span>
        </div>
      </div>

      <div class="flex shrink-0 gap-1">
        <button data-edit-card="${card.id}" class="btn btn-ghost btn-icon" aria-label="Редактировать" title="Редактировать">${ico('edit')}</button>
        <button data-delete-card="${card.id}" class="btn btn-ghost btn-icon danger" aria-label="Удалить" title="Удалить">${ico('trash')}</button>
      </div>
    </div>

    <!-- Примерный доход видеокарты (ключевая фича пользователя!) -->
    <div class="gpu-profit-badge ${isProfitable ? 'profitable' : 'negative'}">
      <div class="flex items-baseline justify-between gap-2">
        <span class="text-xs font-bold uppercase tracking-wider text-slate-500">Примерный чистый профит</span>
        <span class="text-xs font-semibold ${isProfitable ? 'text-emerald-500' : 'text-rose-400'}">
          ${calc.margin > 0 ? `+${calc.margin.toFixed(0)}%` : `${calc.margin.toFixed(0)}%`}
        </span>
      </div>
      <div class="mt-0.5 flex items-baseline gap-2">
        <span class="gpu-profit-val ${isProfitable ? 'profitable' : 'negative'} num">
          ${profit >= 0 ? '+' : ''}${money(profit)}
        </span>
        <span class="text-xs font-semibold text-slate-500">${suffix}</span>
      </div>
      ${calc.qty > 1 ? `
        <span class="mt-0.5 text-[11px] font-medium text-slate-400">
          (по ${calc.unitProfit >= 0 ? '+' : ''}${money(calc.unitProfit * mult)}${suffix} за 1 шт.)
        </span>
      ` : ''}
    </div>

    <!-- Микро-чипы параметров карты -->
    <div class="gpu-stat-grid text-xs">
      <div class="gpu-stat-chip">
        <span class="block text-[11px] font-semibold text-slate-500">Грязный доход</span>
        <b class="num text-[13px] text-slate-800 dark:text-slate-200">${money(gross)}</b>
        <span class="block text-[10px] text-slate-400">~${number(coins, 4)} ${escapeHtml(rig?.coin || '')}</span>
      </div>

      <div class="gpu-stat-chip">
        <span class="block text-[11px] font-semibold text-slate-500">Расход на свет</span>
        <b class="num text-[13px] text-slate-800 dark:text-slate-200">${money(electricity)}</b>
        <span class="block text-[10px] text-slate-400">${number(calc.totalPower, 0)} Вт суммарно</span>
      </div>

      <div class="gpu-stat-chip">
        <span class="block text-[11px] font-semibold text-slate-500">Общий хеш карты</span>
        <b class="num text-[13px] text-amber-500">${number(calc.totalHash)} MH/s</b>
        <span class="block text-[10px] text-slate-400">${calc.rigShare.toFixed(1)}% от рига</span>
      </div>

      <div class="gpu-stat-chip">
        <span class="block text-[11px] font-semibold text-slate-500">Эффективность</span>
        <b class="num text-[13px] text-slate-800 dark:text-slate-200">${calc.wattPerMhs.toFixed(2)}</b>
        <span class="block text-[10px] text-slate-400">Вт / (MH/s)</span>
      </div>
    </div>

    <!-- Доля видеокарты в общем хешрейте рига -->
    <div class="gpu-share-track" title="Доля видеокарты в хешрейте рига: ${calc.rigShare.toFixed(1)}%">
      <div class="gpu-share-bar" style="width:${Math.max(3, Math.min(100, calc.rigShare))}%"></div>
    </div>
  </article>`;
}

// Переключение выбранного рига (быстрое мгновенное переключение с анимацией)
function switchRig(rigId) {
  if (String(rigId) === String(state.selectedRigId)) return;
  state.selectedRigId = rigId;
  state.viewScope = 'rig';
  state.cards = state.cardsByRig[String(rigId)] || state.cardsByRig[rigId] || [];

  document.querySelectorAll('.rig-tab').forEach((tab) => {
    tab.classList.toggle('active', Number(tab.dataset.rigId) === Number(rigId));
  });

  renderDashboard();
  requestAnimationFrame(() => updateRigPill(true));
  saveCache();

  // Фоновая сверка данных оборудования
  request(`/rigs/${rigId}/cards`).then((cards) => {
    const key = String(rigId);
    const changed = JSON.stringify(cards) !== JSON.stringify(state.cardsByRig[key] || []);
    state.cardsByRig[key] = cards;
    if (String(state.selectedRigId) === key && changed) {
      state.cards = cards;
      renderDashboard();
      saveCache();
    }
  }).catch(() => {});
}

// Переключение горизонта времени (24ч / 7д / 30д / 1г)
function switchHorizon(horizonId) {
  if (!HORIZONS[horizonId]) return;
  state.timeHorizon = horizonId;
  localStorage.setItem('korch_horizon', horizonId);
  renderDashboard();
}

// Переключение фокуса: Выбранный риг vs Вся ферма
function switchViewScope(scope) {
  state.viewScope = scope;
  renderDashboard();
}

// Создание модального окна
function modal(title, content) {
  const node = document.createElement('div');
  node.className = 'modal-backdrop';
  node.innerHTML = `
    <div class="modal-panel">
      <div class="mb-5 flex items-center justify-between gap-3">
        <h2 class="modal-title font-display text-lg font-bold"></h2>
        <button class="modal-close btn btn-ghost btn-icon" aria-label="Закрыть">${ico('close')}</button>
      </div>
      ${content}
    </div>
  `;
  node.querySelector('.modal-title').textContent = title;
  node.addEventListener('click', (event) => { if (event.target === node) closeModal(node); });
  node.querySelector('.modal-close').onclick = () => closeModal(node);
  document.body.append(node);
  return node;
}

// Модалка добавления рига
function showRigModal() {
  modal('Новый риг', `
    <form id="rig-form" class="space-y-4">
      <label class="block text-sm font-semibold">Название рига
        <input name="name" required maxlength="80" class="field" placeholder="Например: Ферма 1 / Балкон" autofocus>
      </label>
      <button class="btn btn-accent w-full">${ico('plus')} Создать риг</button>
    </form>
  `);
}

// Модалка переименования рига
function showRenameRigModal(rig) {
  if (!rig) return;
  const node = modal('Переименовать риг', `
    <form id="rig-rename-form" data-rig-id="${rig.id}" class="space-y-4">
      <label class="block text-sm font-semibold">Новое название
        <input name="name" required maxlength="80" value="${escapeHtml(rig.name)}" class="field" autofocus>
      </label>
      <button class="btn btn-accent w-full">Сохранить</button>
    </form>
  `);
  node.querySelector('input')?.select();
}

// Модалка конфигурации рига
function showRigConfigModal(rig) {
  if (!rig) return;
  if (!state.coins.length) {
    toast('Сначала добавьте хотя бы одну монету в настройках', 'error');
    return;
  }
  const node = modal(`Конфигурация: ${rig.name}`, `
    <form data-rig-config="${rig.id}" class="space-y-4">
      <label class="block text-sm font-semibold">Монета
        ${dropdownHtml('coin', state.coins.map((coin) => ({ value: coin.name, label: `${escapeHtml(coin.name)} · ${money(coin.price_usd)}` })), rig.coin)}
      </label>
      <div class="grid grid-cols-2 gap-3">
        <label class="block text-sm font-semibold">Добыча/сутки (риг)
          <input name="coin_per_day" type="number" min="0" step="any" required value="${rig.coin_per_day ?? 0}" class="field">
        </label>
        <label class="block text-sm font-semibold">Розетка, $/кВт·ч
          <input name="electricity_cost" type="number" min="0" step="0.001" required value="${rig.electricity_cost ?? 0.1}" class="field">
        </label>
      </div>
      <div class="glass rounded-2xl p-3.5">
        <p class="mb-2.5 flex items-center gap-2 text-sm font-bold">${ico('clock')} График смен</p>
        <div class="grid grid-cols-2 gap-2.5">
          <label class="text-xs font-bold text-slate-500">Рабочих суток (18ч)
            <input name="working_days" type="number" min="0" max="31" step="1" required value="${rig.working_days ?? 5}" class="field">
          </label>
          <label class="text-xs font-bold text-slate-500">Выходных суток (24ч)
            <input name="weekend_days" type="number" min="0" max="31" step="1" required value="${rig.weekend_days ?? 2}" class="field">
          </label>
        </div>
        <label class="mt-2.5 block text-xs font-bold text-slate-500">Добыча в сутки основана на
          ${dropdownHtml('calculation_mode', [
            { value: 'working_days', label: 'Рабочих сутках (18ч работы)' },
            { value: 'weekend_days', label: 'Выходных сутках (24ч работы)' }
          ], rig.calculation_mode)}
        </label>
      </div>
      <button class="btn btn-accent w-full">Сохранить конфигурацию</button>
    </form>
  `);
  initDropdowns(node);
}

// Модалка добавления / редактирования видеокарты
function showCardModal(card = null) {
  const isEdit = Boolean(card);
  const values = card || { model: '', quantity: 1, hashrate: '', power: '' };
  modal(isEdit ? 'Редактировать карту' : 'Добавить карту', `
    <form id="card-form" data-card-id="${card?.id || ''}" class="grid gap-3 sm:grid-cols-2 sm:gap-4">
      <label class="text-sm font-semibold sm:col-span-2">Модель видеокарты
        <input name="model" required maxlength="80" value="${escapeHtml(values.model)}" class="field" placeholder="Например: RTX 4070 Ti Super" autofocus>
      </label>
      <label class="text-sm font-semibold">Количество (шт.)
        <input name="quantity" type="number" required min="1" step="1" value="${values.quantity}" class="field">
      </label>
      <label class="text-sm font-semibold">Хешрейт 1 карты (MH/s)
        <input name="hashrate" type="number" required min="0" step="any" value="${values.hashrate}" class="field" placeholder="65.5">
      </label>
      <label class="text-sm font-semibold sm:col-span-2">Мощность 1 карты (Вт)
        <input name="power" type="number" required min="0" step="1" value="${values.power}" class="field" placeholder="180">
      </label>
      <button class="btn btn-accent sm:col-span-2">${isEdit ? 'Сохранить изменения' : 'Добавить карту'}</button>
    </form>
  `);
}

// Модалка настроек (Тема, Монеты, Смена пароля)
function showSettingsModal() {
  const node = modal('Настройки фермы', `
    <div class="glass mb-5 flex items-center justify-between gap-3 rounded-2xl p-3.5">
      <div>
        <p class="text-sm font-bold">Тема интерфейса</p>
        <p class="text-xs text-slate-500">Тёмная неоновая аврора или светлый морозный кристалл</p>
      </div>
      <button id="settings-theme-toggle" class="btn btn-ghost btn-icon" title="Переключить тему">
        ${state.theme === 'dark' ? ico('sun') : ico('moon')}
      </button>
    </div>

    <div class="mb-3 flex items-center justify-between">
      <p class="flex items-center gap-2 text-sm font-bold">${ico('coin')} Курсы монет ($ USD)</p>
    </div>
    <div id="settings-coin-list" class="space-y-2.5 max-h-56 overflow-y-auto pr-1"></div>

    <form id="settings-new-coin" class="mt-4 grid grid-cols-[1fr_1fr_auto] items-end gap-2 border-t border-white/5 pt-4">
      <label class="text-xs font-bold text-slate-500">Монета<input name="name" required maxlength="30" placeholder="BTC / ETH" class="settings-field"></label>
      <label class="text-xs font-bold text-slate-500">Курс, $<input name="price_usd" type="number" required min="0" step="any" placeholder="1.00" class="settings-field"></label>
      <button class="btn btn-accent btn-icon" title="Добавить монету" aria-label="Добавить монету">${ico('plus')}</button>
    </form>

    <details class="glass mt-4 rounded-2xl p-3.5">
      <summary class="flex cursor-pointer items-center gap-2 text-sm font-bold">${ico('gear')} Сменить пароль</summary>
      <form id="settings-change-password" class="mt-3 space-y-2.5 border-t border-white/5 pt-3">
        <input name="current_password" type="password" required minlength="6" autocomplete="current-password" class="field" placeholder="Текущий пароль">
        <input name="new_password" type="password" required minlength="6" autocomplete="new-password" class="field" placeholder="Новый пароль (6+ символов)">
        <button class="btn btn-accent w-full">Обновить пароль</button>
        <p id="cp-error" class="hidden text-xs text-rose-400"></p>
      </form>
    </details>
  `);

  node.querySelector('#settings-theme-toggle').onclick = () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    node.querySelector('#settings-theme-toggle').innerHTML = state.theme === 'dark' ? ico('sun') : ico('moon');
  };

  node.querySelector('#settings-change-password').onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const errorEl = form.querySelector('#cp-error');
    const btn = form.querySelector('button');
    errorEl.classList.add('hidden');
    btn.disabled = true;
    try {
      await request('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      form.reset();
      toast('Пароль успешно обновлён');
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove('hidden');
    }
    btn.disabled = false;
  };

  const coinPanel = node.querySelector('#settings-coin-list');
  const renderCoins = () => {
    coinPanel.innerHTML = state.coins.map((coin) => `
      <form data-settings-coin="${coin.id}" class="glass grid grid-cols-[1fr_1fr_auto] items-end gap-2 rounded-2xl p-2.5">
        <label class="text-xs font-bold text-slate-500">Монета<input name="name" required maxlength="30" value="${escapeHtml(coin.name)}" class="settings-field"></label>
        <label class="text-xs font-bold text-slate-500">Курс, $<input name="price_usd" type="number" required min="0" step="any" value="${coin.price_usd}" class="settings-field"></label>
        <div class="flex gap-1">
          <button title="Сохранить курс" class="btn btn-accent btn-icon">${ico('check')}</button>
          <button type="button" data-settings-delete="${coin.id}" title="Удалить" class="btn btn-ghost btn-icon danger">${ico('trash')}</button>
        </div>
      </form>
    `).join('') || '<p class="text-sm text-slate-500">Список монет пуст.</p>';
  };
  renderCoins();
  node._renderCoins = renderCoins;
}

// Модалка сброса пароля
function showResetPasswordModal() {
  const node = modal('Сброс пароля', `
    <p class="mb-4 text-sm text-slate-500 dark:text-slate-400">Укажите логин — сервер сгенерирует новый временный пароль для входа.</p>
    <form id="reset-form" class="space-y-4">
      <label class="block text-sm font-semibold">Логин
        <input name="username" required minlength="3" autocomplete="username" class="field" placeholder="miner_01" autofocus>
      </label>
      <button class="btn btn-accent w-full">Сгенерировать пароль</button>
    </form>
    <div id="reset-result" class="hidden mt-4 space-y-3">
      <div class="glass rounded-2xl p-4 text-center">
        <p class="mb-1 text-xs font-bold uppercase tracking-wider text-slate-500">Новый пароль</p>
        <p id="reset-new-pass" class="font-display text-xl font-extrabold text-amber-500 select-all"></p>
      </div>
      <button id="reset-copy" class="btn btn-ghost w-full">${ico('check')} Скопировать пароль</button>
    </div>
  `);

  const form = node.querySelector('#reset-form');
  form.onsubmit = async (event) => {
    event.preventDefault();
    const username = String(new FormData(form).get('username') || '').trim();
    const resultBox = node.querySelector('#reset-result');
    const passEl = node.querySelector('#reset-new-pass');
    try {
      const res = await request('/auth/reset-password', { method: 'POST', body: JSON.stringify({ username }) });
      passEl.textContent = res.password;
      form.classList.add('hidden');
      resultBox.classList.remove('hidden');
      node.querySelector('#reset-copy').onclick = async () => {
        try {
          await navigator.clipboard.writeText(res.password);
          toast('Пароль скопирован в буфер обмена');
        } catch {
          toast('Скопируйте пароль вручную', 'error');
        }
      };
      toast('Пароль сброшен!');
    } catch (error) {
      toast(error.message, 'error');
    }
  };
}

// Удаление карты
async function deleteCard(cardId) {
  if (!confirm('Удалить эту видеокарту из рига?')) return;
  const rigKey = String(state.selectedRigId);
  const previousCards = [...state.cards];
  const previousByRig = { ...state.cardsByRig };

  state.cards = state.cards.filter((c) => c.id !== cardId);
  state.cardsByRig[rigKey] = state.cards;
  renderDashboard();
  toast('Видеокарта удалена');

  try {
    await request(`/cards/${cardId}`, { method: 'DELETE' });
    saveCache();
  } catch (error) {
    state.cards = previousCards;
    state.cardsByRig = previousByRig;
    renderDashboard();
    toast(`Не удалось удалить карту: ${error.message}`, 'error');
  }
}

// Удаление выбранного рига
async function deleteSelectedRig() {
  if (!confirm('Удалить этот риг и всё оборудование в нём?')) return;
  const rigId = state.selectedRigId;
  const previousRigs = [...state.rigs];
  const previousByRig = { ...state.cardsByRig };
  const previousSelected = state.selectedRigId;

  state.rigs = state.rigs.filter((r) => String(r.id) !== String(rigId));
  delete state.cardsByRig[String(rigId)];
  delete state.cardsByRig[rigId];
  state.selectedRigId = state.rigs[0]?.id || null;
  state.cards = state.selectedRigId ? (state.cardsByRig[String(state.selectedRigId)] || []) : [];

  renderDashboard();
  toast('Риг удалён');

  try {
    await request(`/rigs/${rigId}`, { method: 'DELETE' });
    saveCache();
  } catch (error) {
    state.rigs = previousRigs;
    state.cardsByRig = previousByRig;
    state.selectedRigId = previousSelected;
    state.cards = state.cardsByRig[String(previousSelected)] || [];
    renderDashboard();
    toast(`Ошибка удаления рига: ${error.message}`, 'error');
  }
}

// Первоначальная загрузка данных с сервера (Bootstrap)
async function refresh() {
  const data = await request('/bootstrap');
  state.user = data.user;
  state.coins = data.coins || [];
  state.rigs = data.rigs || [];
  state.cardsByRig = data.cardsByRig || {};

  if (!state.rigs.some((r) => String(r.id) === String(state.selectedRigId))) {
    state.selectedRigId = state.rigs[0]?.id || null;
  }
  state.cards = state.selectedRigId ? (state.cardsByRig[String(state.selectedRigId)] || []) : [];

  renderDashboard();
  saveCache();
}

function logout(showMessage = false) {
  state.token = null;
  state.user = null;
  state.cards = [];
  state.cardsByRig = {};
  localStorage.removeItem('korch_token');
  localStorage.removeItem(CACHE_KEY);
  renderAuth();
  if (showMessage) toast('Вы вышли из системы');
}

// Глобальная обработка отправок форм (Optimistic UI)
document.addEventListener('submit', (event) => {
  const form = event.target;
  const modalRoot = form.closest('.modal-backdrop');
  if (!modalRoot) return;

  const raw = Object.fromEntries(new FormData(form));

  // 1. Форма видеокарты (добавление или редактирование)
  if (form.id === 'card-form') {
    event.preventDefault();
    event.stopImmediatePropagation();

    const existingCardId = form.dataset.cardId ? Number(form.dataset.cardId) : null;
    const isEdit = Boolean(existingCardId);
    const rigKey = String(state.selectedRigId);

    const cardPayload = {
      rig_id: Number(state.selectedRigId),
      model: String(raw.model || '').trim(),
      quantity: Math.max(1, Number(raw.quantity || 1)),
      hashrate: Math.max(0, Number(raw.hashrate || 0)),
      power: Math.max(0, Number(raw.power || 0)),
    };

    const tempId = existingCardId || `optimistic-card-${Date.now()}`;
    const previousCards = [...state.cards];
    const previousByRig = { ...state.cardsByRig };
    const optimisticCard = { ...cardPayload, id: tempId };

    state.cards = isEdit
      ? state.cards.map((c) => (c.id === existingCardId ? optimisticCard : c))
      : [...state.cards, optimisticCard];

    state.cardsByRig[rigKey] = state.cards;

    closeModal(modalRoot);
    renderDashboard();
    toast(isEdit ? 'Карта обновлена' : 'Видеокарта добавлена!');
    if (!isEdit) launchConfetti();

    const url = isEdit ? `/cards/${existingCardId}` : '/cards';
    const method = isEdit ? 'PUT' : 'POST';

    request(url, { method, body: JSON.stringify(cardPayload) })
      .then((saved) => {
        state.cards = state.cards.map((c) => (c.id === optimisticCard.id ? saved : c));
        state.cardsByRig[rigKey] = state.cards;
        renderDashboard();
        saveCache();
      })
      .catch((error) => {
        state.cards = previousCards;
        state.cardsByRig = previousByRig;
        renderDashboard();
        toast(`Ошибка сохранения: ${error.message}`, 'error');
      });
    return;
  }

  // 2. Новая монета
  if (form.id === 'settings-new-coin') {
    event.preventDefault();
    event.stopImmediatePropagation();
    const newName = String(raw.name || '').trim().toUpperCase();
    const priceUsd = Math.max(0, Number(raw.price_usd || 0));
    if (!newName) return;

    const tempId = `optimistic-coin-${Date.now()}`;
    const optimisticCoin = { id: tempId, name: newName, price_usd: priceUsd };
    const previousCoins = [...state.coins];

    state.coins = [...state.coins, optimisticCoin];
    form.reset();
    toast('Монета добавлена!');
    if (modalRoot._renderCoins) modalRoot._renderCoins();
    renderDashboard();

    request('/coins', { method: 'POST', body: JSON.stringify({ name: newName, price_usd: priceUsd }) })
      .then((saved) => {
        state.coins = state.coins.map((c) => (c.id === tempId ? saved : c));
        if (modalRoot._renderCoins) modalRoot._renderCoins();
        renderDashboard();
        saveCache();
      })
      .catch((error) => {
        state.coins = previousCoins;
        if (modalRoot._renderCoins) modalRoot._renderCoins();
        renderDashboard();
        toast(`Ошибка добавления монеты: ${error.message}`, 'error');
      });
    return;
  }

  // 3. Обновление монеты в настройках
  if (form.dataset.settingsCoin) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const coinId = form.dataset.settingsCoin;
    const name = String(raw.name || '').trim().toUpperCase();
    const priceUsd = Math.max(0, Number(raw.price_usd || 0));

    const previousCoins = [...state.coins];
    const previousRigs = [...state.rigs];
    const oldCoin = state.coins.find((c) => String(c.id) === String(coinId));
    const nextCoin = { id: oldCoin?.id || coinId, name, price_usd: priceUsd };

    state.coins = state.coins.map((c) => (String(c.id) === String(coinId) ? nextCoin : c));
    if (oldCoin) {
      state.rigs = state.rigs.map((r) =>
        r.coin && r.coin.toLowerCase() === oldCoin.name.toLowerCase() ? { ...r, coin: name } : r
      );
    }

    toast('Курс монеты сохранён');
    renderDashboard();

    request(`/coins/${coinId}`, { method: 'PUT', body: JSON.stringify({ name, price_usd: priceUsd }) })
      .then((saved) => {
        saveCache();
      })
      .catch((error) => {
        state.coins = previousCoins;
        state.rigs = previousRigs;
        renderDashboard();
        toast(`Ошибка сохранения: ${error.message}`, 'error');
      });
    return;
  }

  // 4. Конфигурация рига
  if (form.dataset.rigConfig) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const rigId = form.dataset.rigConfig;
    const previousRigs = [...state.rigs];

    const nextRig = {
      ...state.rigs.find((r) => String(r.id) === String(rigId)),
      coin: String(raw.coin || '').trim().toUpperCase(),
      coin_per_day: Number(raw.coin_per_day || 0),
      electricity_cost: Number(raw.electricity_cost || 0),
      working_days: Number(raw.working_days ?? 5),
      weekend_days: Number(raw.weekend_days ?? 2),
      calculation_mode: String(raw.calculation_mode || 'working_days'),
    };

    state.rigs = state.rigs.map((r) => (String(r.id) === String(rigId) ? nextRig : r));
    closeModal(modalRoot);
    renderDashboard();
    toast('Конфигурация рига сохранена!');

    request(`/rigs/${rigId}/config`, {
      method: 'PATCH',
      body: JSON.stringify({
        coin: nextRig.coin,
        coin_per_day: nextRig.coin_per_day,
        electricity_cost: nextRig.electricity_cost,
        working_days: nextRig.working_days,
        weekend_days: nextRig.weekend_days,
        calculation_mode: nextRig.calculation_mode,
      }),
    })
      .then((saved) => {
        state.rigs = state.rigs.map((r) => (String(r.id) === String(rigId) ? saved : r));
        renderDashboard();
        saveCache();
      })
      .catch((error) => {
        state.rigs = previousRigs;
        renderDashboard();
        toast(`Ошибка сохранения конфигурации: ${error.message}`, 'error');
      });
    return;
  }

  // 5. Переименование рига
  if (form.id === 'rig-rename-form') {
    event.preventDefault();
    event.stopImmediatePropagation();
    const rigId = Number(form.dataset.rigId);
    const name = String(raw.name || '').trim();
    if (!name) return;

    const previousRigs = [...state.rigs];
    state.rigs = state.rigs.map((r) => (r.id === rigId ? { ...r, name } : r));
    closeModal(modalRoot);
    renderDashboard();
    toast('Риг переименован');

    request(`/rigs/${rigId}`, { method: 'PATCH', body: JSON.stringify({ name }) })
      .then((saved) => {
        state.rigs = state.rigs.map((r) => (r.id === rigId ? saved : r));
        renderDashboard();
        saveCache();
      })
      .catch((error) => {
        state.rigs = previousRigs;
        renderDashboard();
        toast(`Не удалось переименовать: ${error.message}`, 'error');
      });
    return;
  }

  // 6. Создание нового рига
  if (form.id === 'rig-form') {
    event.preventDefault();
    event.stopImmediatePropagation();
    const name = String(raw.name || '').trim();
    if (!name) return;

    const tempId = `optimistic-rig-${Date.now()}`;
    const previousRigs = [...state.rigs];
    const previousSelected = state.selectedRigId;

    const firstCoin = state.coins[0]?.name || '';
    const newRig = {
      id: tempId,
      name,
      coin: firstCoin,
      coin_per_day: 0,
      electricity_cost: 0.1,
      working_days: 5,
      weekend_days: 2,
      calculation_mode: 'working_days',
    };

    state.rigs = [...state.rigs, newRig];
    state.selectedRigId = tempId;
    state.cards = [];
    state.cardsByRig[String(tempId)] = [];

    closeModal(modalRoot);
    renderDashboard();
    toast('Новый риг создан!');
    launchConfetti();

    request('/rigs', { method: 'POST', body: JSON.stringify({ name }) })
      .then((saved) => {
        state.rigs = state.rigs.map((r) => (r.id === tempId ? saved : r));
        state.cardsByRig[String(saved.id)] = state.cardsByRig[String(tempId)] || [];
        delete state.cardsByRig[String(tempId)];
        state.selectedRigId = saved.id;
        state.cards = state.cardsByRig[String(saved.id)] || [];
        renderDashboard();
        saveCache();
      })
      .catch((error) => {
        state.rigs = previousRigs;
        state.selectedRigId = previousSelected;
        delete state.cardsByRig[String(tempId)];
        renderDashboard();
        toast(`Ошибка создания рига: ${error.message}`, 'error');
      });
    return;
  }
}, true);

// Удаление монеты из настроек
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-settings-delete]');
  if (!button) return;
  event.preventDefault();
  event.stopImmediatePropagation();

  const coinId = button.dataset.settingsDelete;
  const coin = state.coins.find((c) => String(c.id) === String(coinId));
  if (!confirm(`Удалить монету ${coin?.name || ''}?`)) return;

  const previousCoins = [...state.coins];
  state.coins = state.coins.filter((c) => String(c.id) !== String(coinId));

  const modalRoot = button.closest('.modal-backdrop');
  if (modalRoot?._renderCoins) modalRoot._renderCoins();
  renderDashboard();
  toast('Монета удалена');

  request(`/coins/${coinId}`, { method: 'DELETE' })
    .then(saveCache)
    .catch((error) => {
      state.coins = previousCoins;
      if (modalRoot?._renderCoins) modalRoot._renderCoins();
      renderDashboard();
      toast(`Не удалось удалить монету: ${error.message}`, 'error');
    });
}, true);

// Инициализация приложения
async function init() {
  applyTheme();
  initBackgroundParticles();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload());
  }

  if (!state.token) {
    return renderAuth();
  }

  // Мгновенная отрисовка из кэша
  const cached = loadCache();
  if (cached?.user) {
    state.user = cached.user;
    state.coins = cached.coins || [];
    state.rigs = cached.rigs || [];
    state.cardsByRig = cached.cardsByRig || {};
    state.selectedRigId = cached.selectedRigId;
    if (cached.timeHorizon) state.timeHorizon = cached.timeHorizon;

    if (!state.rigs.some((r) => String(r.id) === String(state.selectedRigId))) {
      state.selectedRigId = state.rigs[0]?.id || null;
    }
    state.cards = state.selectedRigId ? (state.cardsByRig[String(state.selectedRigId)] || []) : [];
    renderDashboard();
  } else {
    renderSkeleton();
  }

  // Обновление свежих данных с сервера
  try {
    await refresh();
  } catch (error) {
    toast(error.message, 'error');
    if (!state.user) {
      app.innerHTML = `
        <section class="page-enter flex min-h-screen items-center justify-center p-6 text-center">
          <div class="glass max-w-sm rounded-3xl p-7">
            <div class="mx-auto mb-3 w-12 text-rose-400">${ico('close', 'ico-lg')}</div>
            <p class="font-bold text-lg">Не удалось загрузить данные</p>
            <p class="mt-1 text-sm text-slate-500">${escapeHtml(error.message)}</p>
            <button id="retry-btn" class="btn btn-accent mt-5 w-full">Повторить попытку</button>
          </div>
        </section>
      `;
      document.querySelector('#retry-btn')?.addEventListener('click', init);
    }
  }
}

init();
