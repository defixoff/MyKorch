/* Математика:
 * общий хэш рига = сумма (hashrate × quantity) по всем картам рига;
 * общая мощность рига = сумма (power × quantity) по всем картам рига;
 * добыча на 1 MH/s = avg_daily_yield (см. ниже) ÷ общий хэш рига — считается автоматически,
 * а не берётся из готовых Excel-значений;
 *
 * Раздел конфигурации "Время": working_days/weekend_days — сколько рабочих и выходных суток
 * в цикле (по умолчанию 5 и 2); working_day_duration = 18ч и weekend_day_duration = 24ч —
 * фиксированные константы (см. TIME ниже); calculation_mode — какой режим расчёта
 * avg_daily_yield использовать.
 *
 * 1) Базовая добыча по рабочим суткам (yield_working): coin_per_day — ставка за 24 часа
 *    непрерывной работы; в рабочие сутки риг реально работает working_day_duration из 24
 *    часов, поэтому добыча в такие сутки урезается — coin_per_day ÷ 24 × working_day_duration,
 *    в выходные — берётся as is (риг работает все weekend_day_duration = 24 часа).
 *    yield_working = ((coin_per_day ÷ 24 × working_day_duration × working_days)
 *                      + (coin_per_day × weekend_days)) ÷ (working_days + weekend_days)
 *
 * 2) Итоговая средняя добыча в сутки (avg_daily_yield) зависит от calculation_mode:
 *    - 'working_days': avg_daily_yield = yield_working — как есть, coin_per_day уже привязан
 *      к рабочим суткам;
 *    - 'weekend_days': yield_working пересчитывается вверх до полной 24-часовой (выходной)
 *      ставки и снова усредняется по циклу —
 *      avg_daily_yield = ((yield_working × working_days)
 *                          + (yield_working ÷ working_day_duration × weekend_day_duration × weekend_days))
 *                         ÷ (working_days + weekend_days)
 *
 * avg_daily_yield — именно оно, а не "сырой" coin_per_day, идёт в формулы дохода/профита ниже.
 *
 * доход рига (грязный) = avg_daily_yield × курс монеты; электричество = общая мощность / 1000 × 24 × цена за розетку;
 * профит рига (чистый) = доход − электричество. Профит фермы — сумма профитов всех ригов.
 */
const TIME = { workingDayDuration: 18, weekendDayDuration: 24 };

// Средняя добыча монеты в сутки с учётом графика работы рига (см. комментарий выше).
function avgDailyYield(rig) {
  const coinsPerDay = Number(rig?.coin_per_day || 0);
  const workingDays = Number(rig?.working_days ?? 5);
  const weekendDays = Number(rig?.weekend_days ?? 2);
  const totalDays = workingDays + weekendDays;
  if (totalDays <= 0) return coinsPerDay;
  const yieldWorking = ((coinsPerDay / 24 * TIME.workingDayDuration * workingDays) + (coinsPerDay * weekendDays)) / totalDays;
  if (rig?.calculation_mode === 'weekend_days') {
    return ((coinsPerDay / TIME.workingDayDuration * TIME.weekendDayDuration * workingDays) + (coinsPerDay * weekendDays)) / totalDays;
  }
  return yieldWorking;
}
const configuredApi = window.localStorage.getItem('korch_api_url') || new URLSearchParams(window.location.search).get('api');
const sameOriginBackend = !window.location.port || window.location.port === '8000';
const API = (configuredApi || (sameOriginBackend ? '/api' : `${window.location.protocol}//${window.location.hostname}:8000/api`)).replace(/\/$/, '');
const CACHE_KEY = 'korch_cache_v1';
const state = { token: localStorage.getItem('korch_token'), user: null, rigs: [], coins: [], selectedRigId: null, cards: [], cardsByRig: {}, theme: localStorage.getItem('korch_theme') || 'dark' };
const app = document.querySelector('#app');

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[char]));
const money = (value) => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'USD', minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(value || 0);
const number = (value, digits = 2) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(value || 0);

// Кэш последнего известного состояния — чтобы при следующем открытии сайта интерфейс
// отрисовался мгновенно, а не показывал пустой фон, пока идёт запрос к серверу.
function saveCache() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ user: state.user, coins: state.coins, rigs: state.rigs, cardsByRig: state.cardsByRig, selectedRigId: state.selectedRigId })); } catch (error) { /* хранилище недоступно — не критично */ }
}
function loadCache() {
  try { const raw = localStorage.getItem(CACHE_KEY); return raw ? JSON.parse(raw) : null; } catch (error) { return null; }
}

function coinRate(coinName) {
  return Number(state.coins.find((coin) => coin.name.toLowerCase() === String(coinName || '').toLowerCase())?.price_usd || 0);
}

function rigCalculation(rig, cards) {
  const totalHashrate = cards.reduce((sum, card) => sum + Number(card.hashrate) * Number(card.quantity), 0);
  const totalPower = cards.reduce((sum, card) => sum + Number(card.power) * Number(card.quantity), 0);
  const dailyYield = avgDailyYield(rig);
  const incomePerMhs = totalHashrate > 0 ? dailyYield / totalHashrate : 0;
  const grossIncome = totalHashrate * incomePerMhs * coinRate(rig?.coin);
  const electricityExpense = (totalPower / 1000) * 24 * Number(rig?.electricity_cost || 0);
  return { totalHashrate, totalPower, dailyYield, incomePerMhs, grossIncome, electricityExpense, profit: grossIncome - electricityExpense };
}

async function request(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  let response;
  try {
    response = await fetch(`${API}${path}`, { ...options, headers });
  } catch (error) {
    throw new Error(`Не удалось подключиться к API (${API}). Проверьте адрес, порт и запуск сервера с host 0.0.0.0.`);
  }
  if (response.status === 401) {
    logout(false);
    throw new Error('Сессия истекла. Войдите снова.');
  }
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof payload.detail === 'string' ? payload.detail : 'Не удалось выполнить запрос');
  return payload;
}

function toast(message, type = 'success') {
  const node = document.createElement('div');
  node.className = `toast rounded-xl px-4 py-3 text-sm font-medium shadow-xl ${type === 'error' ? 'bg-rose-600 text-white' : 'bg-emerald-500 text-slate-950'}`;
  node.textContent = message;
  document.querySelector('#toast-region').append(node);
  setTimeout(() => { node.classList.add('toast-out'); node.addEventListener('animationend', () => node.remove(), { once: true }); setTimeout(() => node.remove(), 300); }, 3200);
}

function applyTheme() {
  document.documentElement.classList.toggle('dark', state.theme === 'dark');
  localStorage.setItem('korch_theme', state.theme);
}

// Плавное закрытие модалки: проигрываем обратную анимацию и убираем узел из DOM
// только после неё (со страховкой по таймеру на случай prefers-reduced-motion).
function closeModal(node) {
  if (!node || node.classList.contains('closing')) return;
  node.classList.add('closing');
  node.querySelector('.modal-panel')?.classList.add('closing');
  let done = false;
  const finish = () => { if (done) return; done = true; node.remove(); };
  node.addEventListener('animationend', finish, { once: true });
  setTimeout(finish, 220);
}

function renderSkeleton() {
  app.innerHTML = `<div class="mx-auto min-h-screen max-w-6xl p-4 sm:p-7"><header class="mb-7 flex flex-wrap items-center justify-between gap-3"><div class="space-y-2"><div class="skeleton h-3 w-24 rounded-md"></div><div class="skeleton h-7 w-40 rounded-lg"></div></div><div class="flex gap-2 sm:gap-3"><div class="skeleton h-10 w-28 rounded-xl"></div><div class="skeleton h-10 w-20 rounded-xl"></div></div></header><section class="grid gap-3 sm:gap-4 sm:grid-cols-2"><div class="skeleton h-28 rounded-2xl"></div><div class="skeleton h-28 rounded-2xl"></div></section><section class="mt-7 sm:mt-8"><div class="skeleton mb-3 h-5 w-16 rounded-md"></div><div class="flex gap-2.5"><div class="skeleton h-10 w-24 rounded-xl"></div><div class="skeleton h-10 w-24 rounded-xl"></div></div></section><section class="mt-6 space-y-3 rounded-2xl border border-slate-200 p-4 dark:border-slate-800 sm:p-6"><div class="skeleton h-6 w-32 rounded-md"></div><div class="skeleton h-16 rounded-xl"></div><div class="skeleton h-16 rounded-xl"></div></section></div>`;
}

function renderAuth(mode = 'login') {
  app.innerHTML = `<section class="page-enter flex min-h-screen items-center justify-center p-5"><div class="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-7 shadow-2xl dark:border-slate-800 dark:bg-slate-900 sm:p-9"><div class="mb-8"><div class="mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500 text-3xl">⛏️</div><h1 class="text-3xl font-black tracking-tight">Мой корч</h1><p class="mt-2 text-slate-500 dark:text-slate-400">Личный майнинг-калькулятор без лишнего шума.</p></div><form id="auth-form" class="space-y-4"><label class="block text-sm font-semibold">Логин<input name="username" required minlength="3" autocomplete="username" class="mt-1.5 w-full rounded-xl border border-slate-300 bg-transparent px-4 py-3 outline-none ring-emerald-500 focus:ring-2 dark:border-slate-700" placeholder="miner_01"></label><label class="block text-sm font-semibold">Пароль<input name="password" type="password" required minlength="6" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" class="mt-1.5 w-full rounded-xl border border-slate-300 bg-transparent px-4 py-3 outline-none ring-emerald-500 focus:ring-2 dark:border-slate-700" placeholder="Не менее 6 символов"></label><button class="w-full rounded-xl bg-emerald-500 px-4 py-3 font-bold text-slate-950 transition hover:bg-emerald-400">${mode === 'login' ? 'Войти' : 'Создать аккаунт'}</button></form><button id="auth-switch" class="mt-5 w-full text-sm font-semibold text-emerald-600 dark:text-emerald-400">${mode === 'login' ? 'Нет аккаунта? Зарегистрироваться' : 'Уже есть аккаунт? Войти'}</button></div></section>`;
  document.querySelector('#auth-switch').onclick = () => renderAuth(mode === 'login' ? 'register' : 'login');
  document.querySelector('#auth-form').onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const data = await request(`/auth/${mode === 'login' ? 'login' : 'register'}`, { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) });
      state.token = data.token; state.user = data.user; localStorage.setItem('korch_token', data.token);
      await refresh(); toast(mode === 'login' ? 'С возвращением!' : 'Аккаунт создан');
    } catch (error) { toast(error.message, 'error'); }
  };
}

function renderDashboard() {
  const farmTotals = state.rigs.reduce((sum, rig) => { const result = rigCalculation(rig, state.cardsByRig[rig.id] || []); sum.profit += result.profit; sum.electricityExpense += result.electricityExpense; return sum; }, { profit: 0, electricityExpense: 0 });
  const selectedRig = state.rigs.find((rig) => rig.id === state.selectedRigId);
  const rigTotals = selectedRig ? rigCalculation(selectedRig, state.cards) : { profit: 0, electricityExpense: 0, incomePerMhs: 0 };
  const rigSubtitle = selectedRig ? (selectedRig.coin ? `${escapeHtml(selectedRig.coin)} · ${money(rigTotals.profit)} чистыми · ${number(avgDailyYield(selectedRig), 6)}/сутки в среднем · ⚡ ${money(selectedRig.electricity_cost)}/кВт·ч` : 'Конфигурация не задана — нажмите «Конфигурация»') : '';
  const bannerClass = farmTotals.profit > 0 ? 'bg-emerald-500 text-slate-950' : farmTotals.profit < 0 ? 'bg-rose-600 text-white' : 'bg-slate-500 text-white';
  app.innerHTML = `<div class="page-enter mx-auto min-h-screen max-w-6xl p-4 sm:p-7"><header class="mb-7 flex flex-wrap items-center justify-between gap-3"><div><p class="text-xs font-bold uppercase tracking-[.2em] text-emerald-500">${escapeHtml(state.user.username)}</p><h1 class="text-2xl font-black sm:text-3xl">Мой корч</h1></div><div class="flex flex-wrap justify-end gap-2 sm:gap-3"><button id="settings" class="rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm font-bold dark:border-slate-700">⚙️ Настройки</button><button id="logout-button" class="rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm font-bold dark:border-slate-700">Выйти</button></div></header><section class="grid gap-3 sm:gap-4 sm:grid-cols-2"><article class="stat-card rise-in rounded-2xl ${bannerClass} p-5 shadow-lg"><p class="text-sm font-bold opacity-95">Чистый профит · вся ферма</p><p class="mt-2 text-3xl font-black">${money(farmTotals.profit)}</p><p class="mt-1 text-sm font-medium opacity-90">за 24 часа</p></article><article class="stat-card rise-in rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900" style="animation-delay:40ms"><p class="text-sm font-bold text-slate-500 dark:text-slate-400">Расходы на свет · вся ферма</p><p class="mt-2 text-3xl font-black">${money(farmTotals.electricityExpense)}</p><p class="mt-1 text-sm text-slate-500">за 24 часа</p></article></section><section class="mt-7 sm:mt-8"><div class="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 class="font-bold">Риги</h2><button id="add-rig" class="rounded-xl bg-slate-900 px-3.5 py-2.5 text-sm font-bold text-white dark:bg-slate-100 dark:text-slate-950">＋ Добавить риг</button></div><div class="scroll-row flex gap-2.5 overflow-x-auto pb-2">${state.rigs.map((rig) => `<button data-rig-id="${rig.id}" class="rig-tab shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold ${rig.id === state.selectedRigId ? 'bg-emerald-500 text-slate-950 tab-pop' : 'border border-slate-300 dark:border-slate-700'}">${escapeHtml(rig.name)}</button>`).join('') || '<p class="text-slate-500">Ригов пока нет.</p>'}</div></section><section class="mt-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-6"><div class="mb-5 flex flex-wrap items-start justify-between gap-3"><div><p class="text-xs font-bold uppercase tracking-wider text-slate-500">Текущий риг</p><h2 class="text-xl font-black">${escapeHtml(selectedRig?.name || 'Не выбран')}</h2>${selectedRig ? `<p class="mt-1 text-sm text-slate-500">${rigSubtitle}</p>` : ''}</div>${selectedRig ? `<button id="delete-rig" class="shrink-0 rounded-lg px-2.5 py-1.5 text-sm font-semibold text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40">Удалить риг</button>` : ''}</div><div id="card-list" class="space-y-3">${state.cards.length ? state.cards.map((card, index) => cardHtml(card, index)).join('') : `<div class="rounded-xl border border-dashed border-slate-300 p-8 text-center text-slate-500 dark:border-slate-700">В этом риге ещё нет оборудования.</div>`}</div>${selectedRig ? `<footer class="mt-6 flex flex-col gap-4 border-t border-slate-200 pt-5 dark:border-slate-800 sm:flex-row sm:items-center sm:justify-between"><div><p class="text-sm text-slate-500">Итого по ригу · 24 часа</p><p class="text-xl font-black text-emerald-500">${money(rigTotals.profit)} <span class="text-sm font-medium text-slate-500">/ свет ${money(rigTotals.electricityExpense)}</span></p></div><div class="flex flex-wrap gap-2 sm:gap-3"><button id="rig-config" class="rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm font-bold dark:border-slate-700">⚙️ Конфигурация</button><button id="add-card" class="rounded-xl bg-emerald-500 px-3.5 py-2.5 text-sm font-bold text-slate-950">＋ Добавить карту</button></div></footer>` : ''}</section></div>`;
  document.querySelector('#logout-button').onclick = () => logout(true);
  document.querySelector('#add-rig').onclick = () => showRigModal();
  document.querySelectorAll('.rig-tab').forEach((button) => button.onclick = () => switchRig(Number(button.dataset.rigId)));
  document.querySelector('#add-card')?.addEventListener('click', () => { state.editingCardId = null; showCardModal(); });
  document.querySelector('#settings')?.addEventListener('click', showSettingsModal);
  document.querySelector('#delete-rig')?.addEventListener('click', deleteSelectedRig);
  document.querySelector('#rig-config')?.addEventListener('click', () => showRigConfigModal(selectedRig));
  document.querySelectorAll('[data-edit-card]').forEach((button) => button.onclick = () => { state.editingCardId = Number(button.dataset.editCard); showCardModal(state.cards.find((card) => card.id === Number(button.dataset.editCard))); });
  document.querySelectorAll('[data-delete-card]').forEach((button) => button.onclick = () => deleteCard(Number(button.dataset.deleteCard)));
  saveCache();
}

function cardHtml(card, index = 0) {
  const totalHashrate = Number(card.hashrate) * Number(card.quantity);
  const totalPower = Number(card.power) * Number(card.quantity);
  return `<article style="animation-delay:${Math.min(index, 6) * 35}ms" class="rise-in rounded-xl bg-slate-50 p-4 dark:bg-slate-800/70"><div class="flex flex-wrap items-start justify-between gap-3"><div><h3 class="font-black">${escapeHtml(card.model)}</h3><p class="mt-1 text-sm text-slate-500">${number(card.quantity, 0)} шт. · ${number(card.hashrate)} MH/s на карту · ${number(card.power, 0)} W на карту</p></div><div class="flex h-fit shrink-0 gap-1.5"><button data-edit-card="${card.id}" class="rounded-lg p-2.5 hover:bg-slate-200 dark:hover:bg-slate-700" aria-label="Редактировать">✏️</button><button data-delete-card="${card.id}" class="rounded-lg p-2.5 hover:bg-rose-100 dark:hover:bg-rose-950" aria-label="Удалить">❌</button></div></div><div class="mt-4 grid grid-cols-2 gap-2 text-sm"><p><span class="block text-xs text-slate-500">Общий хэш</span><b>${number(totalHashrate)} MH/s</b></p><p><span class="block text-xs text-slate-500">Мощность</span><b>${number(totalPower, 0)} W</b></p></div></article>`;
}

function modal(title, content) {
  const node = document.createElement('div'); node.className = 'modal-backdrop fixed inset-0 z-40 flex items-end justify-center bg-slate-950/60 p-3 sm:items-center';
  node.innerHTML = `<div class="modal-panel w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl dark:bg-slate-900"><div class="mb-5 flex items-center justify-between gap-3"><h2 class="text-xl font-black">${title}</h2><button class="modal-close rounded-lg p-2.5 text-lg hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Закрыть">✕</button></div>${content}</div>`;
  node.addEventListener('click', (event) => { if (event.target === node) closeModal(node); }); node.querySelector('.modal-close').onclick = () => closeModal(node); document.body.append(node); return node;
}

function showRigModal() {
  // Отправку формы полностью обрабатывает глобальный оптимистичный listener (см. ниже).
  modal('Новый риг', `<form id="rig-form" class="space-y-4"><label class="block text-sm font-semibold">Название<input name="name" required maxlength="80" class="mt-1.5 w-full rounded-xl border border-slate-300 bg-transparent px-3 py-2.5 dark:border-slate-700" placeholder="Например, Балкон"></label><button class="w-full rounded-xl bg-emerald-500 py-3 font-bold text-slate-950">Создать риг</button></form>`);
}

function showRigConfigModal(rig) {
  if (!rig) return;
  if (!state.coins.length) return toast('Сначала добавьте хотя бы одну монету в настройках', 'error');
  const coinOptions = state.coins.map((coin) => `<option value="${escapeHtml(coin.name)}" ${coin.name.toLowerCase() === String(rig.coin || '').toLowerCase() ? 'selected' : ''}>${escapeHtml(coin.name)} · ${money(coin.price_usd)}</option>`).join('');
  const node = modal(`Конфигурация: ${escapeHtml(rig.name)}`, `<form data-rig-config="${rig.id}" class="space-y-4"><label class="block text-sm font-semibold">Монета<select name="coin" required class="field">${coinOptions}</select></label><label class="block text-sm font-semibold">Добыча монет в сутки, весь риг<input name="coin_per_day" type="number" min="0" step="any" required value="${rig.coin_per_day ?? 0}" class="field"></label><label class="block text-sm font-semibold">Цена за розетку, $ за кВт·ч<input name="electricity_cost" type="number" min="0" step="0.001" required value="${rig.electricity_cost ?? 0}" class="field"></label><div class="rounded-xl bg-slate-100 p-3.5 dark:bg-slate-800"><p class="mb-3 text-sm font-bold">⏱️ Время</p><div class="grid grid-cols-2 gap-2.5"><label class="text-xs font-bold text-slate-500">Рабочих суток в цикле · 18ч<input name="working_days" type="number" min="0" max="31" step="1" required value="${rig.working_days ?? 5}" class="field mt-1"></label><label class="text-xs font-bold text-slate-500">Выходных суток в цикле · 24ч<input name="weekend_days" type="number" min="0" max="31" step="1" required value="${rig.weekend_days ?? 2}" class="field mt-1"></label></div><label class="mt-2.5 block text-xs font-bold text-slate-500">Введённая добыча в сутки основана на<select name="calculation_mode" required class="field mt-1"><option value="working_days" ${rig.calculation_mode !== 'weekend_days' ? 'selected' : ''}>Рабочих сутках (18ч)</option><option value="weekend_days" ${rig.calculation_mode === 'weekend_days' ? 'selected' : ''}>Выходных сутках (24ч)</option></select></label></div><p class="rounded-xl bg-slate-100 p-3 text-xs text-slate-500 dark:bg-slate-800">Средняя добыча в сутки считается автоматически по графику работы рига, а доход на 1 MH/s — от неё ÷ суммарный хешрейт всех карт этого рига. Значения в код не зашиты.</p><button class="w-full rounded-xl bg-emerald-500 py-3 font-bold text-slate-950">Сохранить конфигурацию</button></form>`);
  node.querySelectorAll('.field').forEach((input) => input.className = 'field mt-1.5 w-full rounded-xl border border-slate-300 bg-transparent px-3 py-2.5 outline-none focus:ring-2 focus:ring-emerald-500 dark:border-slate-700');
  // Отправку формы полностью обрабатывает глобальный оптимистичный listener (см. ниже).
}

function showSettingsModal() {
  const node = modal('Настройки', `<div class="mb-5 flex items-center justify-between gap-3 rounded-xl bg-slate-100 p-3 dark:bg-slate-800"><div><p class="text-sm font-bold">Тема оформления</p><p class="text-xs text-slate-500">Тёмная или светлая</p></div><button id="settings-theme-toggle" class="rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-lg dark:border-slate-700 dark:bg-slate-900">${state.theme === 'dark' ? '☀️' : '🌙'}</button></div><p class="mb-2 text-sm font-bold">🪙 Монеты</p><p class="mb-4 text-sm text-slate-500">Курс в USD применяется сразу везде, где используется эта монета.</p><div id="settings-coin-list" class="space-y-2.5"></div><form id="settings-new-coin" class="mt-4 grid grid-cols-2 gap-2.5 border-t border-slate-200 pt-4 dark:border-slate-700"><label class="text-xs font-bold text-slate-500">Название<input name="name" required maxlength="30" placeholder="BTC" class="settings-field"></label><label class="text-xs font-bold text-slate-500">Курс, $<input name="price_usd" type="number" required min="0" step="any" placeholder="0.00" class="settings-field"></label><button class="col-span-2 rounded-xl bg-emerald-500 py-2.5 font-bold text-slate-950">＋ Добавить монету</button></form>`);
  node.querySelectorAll('.settings-field').forEach((input) => input.className = 'settings-field mt-1.5 w-full rounded-xl border border-slate-300 bg-transparent px-3 py-2.5 outline-none focus:ring-2 focus:ring-emerald-500 dark:border-slate-700');
  node.querySelector('#settings-theme-toggle').onclick = () => {
    // Тему переключаем без renderDashboard(): DOM дашборда за модалкой не пересоздаётся,
    // поэтому смена dark-класса на <html> проходит плавным переходом (см. styles.css),
    // а не мгновенной пересборкой всего экрана.
    state.theme = state.theme === 'dark' ? 'light' : 'dark'; applyTheme();
    node.querySelector('#settings-theme-toggle').textContent = state.theme === 'dark' ? '☀️' : '🌙';
  };
  const coinPanel = node.querySelector('#settings-coin-list');
  const renderCoins = () => { coinPanel.innerHTML = state.coins.map((coin) => `<form data-settings-coin="${coin.id}" class="grid grid-cols-[1fr_1fr_auto] items-end gap-2.5 rounded-xl bg-slate-100 p-3 dark:bg-slate-800"><label class="text-xs font-bold text-slate-500">Монета<input name="name" required maxlength="30" value="${escapeHtml(coin.name)}" class="settings-field"></label><label class="text-xs font-bold text-slate-500">Курс, $<input name="price_usd" type="number" required min="0" step="any" value="${coin.price_usd}" class="settings-field"></label><div class="flex gap-1.5"><button title="Сохранить" class="rounded-lg bg-emerald-500 px-2.5 py-2.5 text-sm font-black text-slate-950">✓</button><button type="button" data-settings-delete="${coin.id}" title="Удалить" class="rounded-lg px-2.5 py-2.5 text-sm hover:bg-rose-100 dark:hover:bg-rose-950/40">🗑️</button></div></form>`).join('') || '<p class="text-sm text-slate-500">Добавьте первую монету.</p>'; coinPanel.querySelectorAll('.settings-field').forEach((input) => input.className = 'settings-field mt-1 w-full rounded-lg border border-slate-300 bg-transparent px-2 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-emerald-500 dark:border-slate-600 dark:text-slate-100'); };
  renderCoins();
}

function showCardModal(card = null) {
  const isEdit = Boolean(card); const values = card || { model: '', quantity: 1, hashrate: '', power: '' };
  const node = modal(isEdit ? 'Редактировать карту' : 'Добавить карту', `<form id="card-form" class="grid gap-3 sm:grid-cols-2 sm:gap-4"><label class="text-sm font-semibold sm:col-span-2">Модель<input name="model" required maxlength="80" value="${escapeHtml(values.model)}" class="field"></label><label class="text-sm font-semibold">Количество<input name="quantity" type="number" required min="1" step="1" value="${values.quantity}" class="field"></label><label class="text-sm font-semibold">Хэш на 1 карту, MH/s<input name="hashrate" type="number" required min="0" step="any" value="${values.hashrate}" class="field"></label><label class="text-sm font-semibold sm:col-span-2">Мощность на 1 карту, W<input name="power" type="number" required min="0" step="1" value="${values.power}" class="field"></label><button class="sm:col-span-2 rounded-xl bg-emerald-500 py-3 font-bold text-slate-950">${isEdit ? 'Сохранить изменения' : 'Добавить карту'}</button></form>`);
  node.querySelectorAll('.field').forEach((input) => input.className = 'field mt-1.5 w-full rounded-xl border border-slate-300 bg-transparent px-3 py-2.5 outline-none focus:ring-2 focus:ring-emerald-500 dark:border-slate-700');
  // Отправку формы полностью обрабатывает глобальный оптимистичный listener (см. ниже).
}

// Мгновенное переключение рига: карты уже загружены и лежат в кэше state.cardsByRig
// (см. refresh()), поэтому сети ждать не нужно — рендерим сразу, а сверяем в фоне.
function switchRig(rigId) {
  if (rigId === state.selectedRigId) return;
  state.selectedRigId = rigId;
  state.cards = state.cardsByRig[rigId] || [];
  renderDashboard();
  request(`/rigs/${rigId}/cards`).then((cards) => {
    const changed = JSON.stringify(cards) !== JSON.stringify(state.cardsByRig[rigId] || []);
    state.cardsByRig[rigId] = cards;
    if (state.selectedRigId === rigId && changed) { state.cards = cards; renderDashboard(); }
  }).catch(() => { /* тихая сверка — не мешаем тостом при обычном переключении */ });
}

async function deleteCard(cardId) {
  if (!confirm('Удалить эту карту из рига?')) return;
  const previousCards = [...state.cards]; const previousByRig = { ...state.cardsByRig };
  state.cards = state.cards.filter((card) => card.id !== cardId); state.cardsByRig[state.selectedRigId] = state.cards;
  renderDashboard(); toast('Карта удалена');
  try { await request(`/cards/${cardId}`, { method: 'DELETE' }); } catch (error) { state.cards = previousCards; state.cardsByRig = previousByRig; renderDashboard(); toast(`Не удалось удалить карту: ${error.message}`, 'error'); }
}
async function deleteSelectedRig() {
  if (!confirm('Удалить риг и всё оборудование в нём?')) return;
  const rigId = state.selectedRigId; const previousRigs = [...state.rigs]; const previousByRig = { ...state.cardsByRig }; const previousCards = [...state.cards]; const previousSelected = state.selectedRigId;
  state.rigs = state.rigs.filter((rig) => rig.id !== rigId); delete state.cardsByRig[rigId];
  state.selectedRigId = state.rigs[0]?.id || null; state.cards = state.cardsByRig[state.selectedRigId] || [];
  renderDashboard(); toast('Риг удалён');
  try { await request(`/rigs/${rigId}`, { method: 'DELETE' }); } catch (error) { state.rigs = previousRigs; state.cardsByRig = previousByRig; state.cards = previousCards; state.selectedRigId = previousSelected; renderDashboard(); toast(`Не удалось удалить риг: ${error.message}`, 'error'); }
}
async function refresh() {
  // /me, /coins и /rigs независимы — запускаем параллельно вместо последовательных await.
  const [user, coins, rigs] = await Promise.all([request('/me'), request('/coins'), request('/rigs')]);
  state.user = user; state.coins = coins; state.rigs = rigs;
  if (!state.rigs.some((rig) => rig.id === state.selectedRigId)) state.selectedRigId = state.rigs[0]?.id || null;
  // Карты каждого рига запрашиваются параллельно и группируются по id рига —
  // это нужно и для показа текущего рига, и для мгновенного переключения между ригами.
  const cardLists = await Promise.all(state.rigs.map((rig) => request(`/rigs/${rig.id}/cards`)));
  state.cardsByRig = {};
  state.rigs.forEach((rig, index) => { state.cardsByRig[rig.id] = cardLists[index]; });
  state.cards = state.cardsByRig[state.selectedRigId] || [];
  renderDashboard();
}
function logout(showMessage) { state.token = null; state.user = null; state.cards = []; state.cardsByRig = {}; localStorage.removeItem('korch_token'); localStorage.removeItem(CACHE_KEY); renderAuth(); if (showMessage) toast('Вы вышли из аккаунта'); }

/* Optimistic UI: modal mutations render immediately and reconcile in background. */
document.addEventListener('submit', (event) => {
  const form = event.target;
  const modalRoot = form.closest('.modal-backdrop');
  if (!modalRoot) {
    if (form.id === 'auth-form') {
      const submit = form.querySelector('button[type="submit"], button:not([type])');
      if (submit) { submit.disabled = true; submit.dataset.originalText = submit.textContent; submit.textContent = 'Подключаемся…'; }
    }
    return;
  }
  const raw = Object.fromEntries(new FormData(form));
  if (form.id === 'card-form') {
    event.preventDefault(); event.stopImmediatePropagation();
    const title = form.closest('.modal-panel')?.querySelector('h2')?.textContent || '';
    const isEdit = /редакт/i.test(title);
    const values = { rig_id: state.selectedRigId, model: raw.model, quantity: Number(raw.quantity), hashrate: Number(raw.hashrate), power: Number(raw.power) };
    const existing = isEdit ? state.cards.find((card) => card.id === state.editingCardId) : null;
    const tempId = `optimistic-card-${Date.now()}`;
    const previousCards = [...state.cards]; const previousByRig = { ...state.cardsByRig };
    const optimistic = { ...values, id: existing?.id || tempId };
    state.cards = existing ? state.cards.map((card) => card.id === existing.id ? optimistic : card) : [...state.cards, optimistic];
    state.cardsByRig[state.selectedRigId] = state.cards;
    closeModal(modalRoot); renderDashboard(); toast(existing ? 'Карта обновлена' : 'Карта добавлена');
    const path = existing ? `/cards/${existing.id}` : '/cards'; state.editingCardId = null;
    request(path, { method: existing ? 'PUT' : 'POST', body: JSON.stringify(values) }).then((saved) => {
      state.cards = state.cards.map((card) => card.id === optimistic.id ? saved : card);
      state.cardsByRig[state.selectedRigId] = state.cards;
      renderDashboard();
    }).catch((error) => { state.cards = previousCards; state.cardsByRig = previousByRig; renderDashboard(); toast(`Изменения карты отменены: ${error.message}`, 'error'); });
    return;
  }
  if (form.id === 'settings-new-coin') {
    event.preventDefault(); event.stopImmediatePropagation();
    const optimisticId = `optimistic-coin-${Date.now()}`; const optimisticCoin = { id: optimisticId, name: String(raw.name).trim().toUpperCase(), price_usd: Number(raw.price_usd) }; const previousCoins = [...state.coins];
    state.coins = [...state.coins, optimisticCoin]; closeModal(modalRoot); renderDashboard(); toast('Монета добавлена');
    request('/coins', { method: 'POST', body: JSON.stringify({ name: optimisticCoin.name, price_usd: optimisticCoin.price_usd }) }).then((saved) => { state.coins = state.coins.map((coin) => coin.id === optimisticId ? saved : coin); }).catch((error) => { state.coins = previousCoins; renderDashboard(); toast(`Монета не сохранена: ${error.message}`, 'error'); });
    return;
  }
  if (form.dataset.settingsCoin) {
    event.preventDefault(); event.stopImmediatePropagation();
    const coinId = form.dataset.settingsCoin; const previousCoins = [...state.coins]; const previousRigs = [...state.rigs]; const oldCoin = state.coins.find((coin) => String(coin.id) === String(coinId)); const nextCoin = { ...oldCoin, name: String(raw.name).trim().toUpperCase(), price_usd: Number(raw.price_usd) };
    state.coins = state.coins.map((coin) => String(coin.id) === String(coinId) ? nextCoin : coin); state.rigs = state.rigs.map((rig) => rig.coin && rig.coin.toLowerCase() === oldCoin.name.toLowerCase() ? { ...rig, coin: nextCoin.name } : rig);
    closeModal(modalRoot); renderDashboard(); toast('Курс обновлён');
    request(`/coins/${coinId}`, { method: 'PUT', body: JSON.stringify({ name: nextCoin.name, price_usd: nextCoin.price_usd }) }).catch((error) => { state.coins = previousCoins; state.rigs = previousRigs; renderDashboard(); toast(`Курс не сохранён: ${error.message}`, 'error'); });
    return;
  }
  if (form.dataset.rigConfig) {
    event.preventDefault(); event.stopImmediatePropagation();
    const rigId = form.dataset.rigConfig; const previousRigs = [...state.rigs];
    const nextRig = { ...state.rigs.find((rig) => String(rig.id) === String(rigId)), coin: String(raw.coin).trim().toUpperCase(), coin_per_day: Number(raw.coin_per_day), electricity_cost: Number(raw.electricity_cost), working_days: Number(raw.working_days), weekend_days: Number(raw.weekend_days), calculation_mode: String(raw.calculation_mode) };
    state.rigs = state.rigs.map((rig) => String(rig.id) === String(rigId) ? nextRig : rig);
    closeModal(modalRoot); renderDashboard(); toast('Конфигурация сохранена');
    request(`/rigs/${rigId}/config`, { method: 'PATCH', body: JSON.stringify({ coin: nextRig.coin, coin_per_day: nextRig.coin_per_day, electricity_cost: nextRig.electricity_cost, working_days: nextRig.working_days, weekend_days: nextRig.weekend_days, calculation_mode: nextRig.calculation_mode }) }).then((saved) => {
      state.rigs = state.rigs.map((rig) => String(rig.id) === String(rigId) ? saved : rig); renderDashboard();
    }).catch((error) => { state.rigs = previousRigs; renderDashboard(); toast(`Конфигурация не сохранена: ${error.message}`, 'error'); });
    return;
  }
  if (form.id === 'rig-form') {
    event.preventDefault(); event.stopImmediatePropagation();
    const name = String(raw.name || '').trim(); if (!name) return;
    const tempId = `optimistic-rig-${Date.now()}`; const previousRigs = [...state.rigs]; const previousSelected = state.selectedRigId;
    state.rigs = [...state.rigs, { id: tempId, name, coin: '', coin_per_day: 0, electricity_cost: 0.1, working_days: 5, weekend_days: 2, calculation_mode: 'working_days' }]; state.selectedRigId = tempId; state.cards = []; state.cardsByRig[tempId] = [];
    closeModal(modalRoot); renderDashboard(); toast('Риг добавлен');
    request('/rigs', { method: 'POST', body: JSON.stringify({ name }) }).then((saved) => {
      state.rigs = state.rigs.map((rig) => rig.id === tempId ? saved : rig);
      state.cardsByRig[saved.id] = state.cardsByRig[tempId] || []; delete state.cardsByRig[tempId];
      state.selectedRigId = saved.id; state.cards = state.cardsByRig[saved.id]; renderDashboard();
    }).catch((error) => { state.rigs = previousRigs; state.selectedRigId = previousSelected; delete state.cardsByRig[tempId]; renderDashboard(); toast(`Риг не сохранён: ${error.message}`, 'error'); });
    return;
  }
}, true);

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-settings-delete]');
  if (!button) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (!confirm('Удалить монету?')) return;
  const coinId = button.dataset.settingsDelete; const previousCoins = [...state.coins];
  state.coins = state.coins.filter((coin) => String(coin.id) !== String(coinId));
  const modalRoot = button.closest('.modal-backdrop'); closeModal(modalRoot); renderDashboard(); toast('Монета удалена');
  request(`/coins/${coinId}`, { method: 'DELETE' }).catch((error) => { state.coins = previousCoins; renderDashboard(); toast(`Монета не удалена: ${error.message}`, 'error'); });
}, true);

async function init() {
  applyTheme();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    // Когда новый воркер после деплоя забирает контроль над уже открытыми
    // вкладками — перезагружаем страницу, иначе в памяти останется старый JS.
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload());
  }
  if (!state.token) return renderAuth();
  const cached = loadCache();
  if (cached?.user) { Object.assign(state, cached); renderDashboard(); } else { renderSkeleton(); }
  try {
    await refresh();
  } catch (error) {
    toast(error.message, 'error');
    if (!state.user) {
      app.innerHTML = `<section class="page-enter flex min-h-screen items-center justify-center p-6 text-center"><div><p class="mb-4 text-slate-500">Не удалось загрузить данные.</p><button id="retry" class="rounded-xl bg-emerald-500 px-4 py-2.5 font-bold text-slate-950">Повторить</button></div></section>`;
      document.querySelector('#retry').onclick = init;
    }
  }
}
init();