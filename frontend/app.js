/* Математика перенесена из исходной таблицы:
 * общий хэш = hashrate × quantity; мощность = power × quantity;
 * доход = общий хэш × добыча монеты на MH/s × курс; электричество = мощность / 1000 × 24 × тариф;
 * профит = доход − электричество.
 */
const configuredApi = window.localStorage.getItem('korch_api_url') || new URLSearchParams(window.location.search).get('api');
const sameOriginBackend = !window.location.port || window.location.port === '8000';
const API = (configuredApi || (sameOriginBackend ? '/api' : `${window.location.protocol}//${window.location.hostname}:8000/api`)).replace(/\/$/, '');
const EXCEL_DEFAULT_COIN_PER_MHS = 2.8 / 3620;
const state = { token: localStorage.getItem('korch_token'), user: null, rigs: [], coins: [], selectedRigId: null, cards: [], theme: localStorage.getItem('korch_theme') || 'dark' };
const app = document.querySelector('#app');

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[char]));
const money = (value) => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'USD', minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(value || 0);
const number = (value, digits = 2) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(value || 0);

function coinRate(coinName) {
  return Number(state.coins.find((coin) => coin.name.toLowerCase() === String(coinName).toLowerCase())?.price_usd || 0);
}

function calculation(card, electricityCost = state.user?.electricity_cost || 0) {
  const totalHashrate = Number(card.hashrate) * Number(card.quantity);
  const totalPower = Number(card.power) * Number(card.quantity);
  const grossIncome = totalHashrate * Number(card.income_per_mhs) * coinRate(card.coin);
  const electricityExpense = (totalPower / 1000) * 24 * electricityCost;
  return { totalHashrate, totalPower, grossIncome, electricityExpense, profit: grossIncome - electricityExpense };
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
  setTimeout(() => node.remove(), 3500);
}

function applyTheme() {
  document.documentElement.classList.toggle('dark', state.theme === 'dark');
  localStorage.setItem('korch_theme', state.theme);
}

function renderAuth(mode = 'login') {
  app.innerHTML = `<section class="flex min-h-screen items-center justify-center p-5"><div class="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-7 shadow-2xl dark:border-slate-800 dark:bg-slate-900 sm:p-9"><div class="mb-8"><div class="mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500 text-3xl">⛏️</div><h1 class="text-3xl font-black tracking-tight">Мой корч</h1><p class="mt-2 text-slate-500 dark:text-slate-400">Личный майнинг-калькулятор без лишнего шума.</p></div><form id="auth-form" class="space-y-4"><label class="block text-sm font-semibold">Логин<input name="username" required minlength="3" autocomplete="username" class="mt-1.5 w-full rounded-xl border border-slate-300 bg-transparent px-4 py-3 outline-none ring-emerald-500 focus:ring-2 dark:border-slate-700" placeholder="miner_01"></label><label class="block text-sm font-semibold">Пароль<input name="password" type="password" required minlength="6" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" class="mt-1.5 w-full rounded-xl border border-slate-300 bg-transparent px-4 py-3 outline-none ring-emerald-500 focus:ring-2 dark:border-slate-700" placeholder="Не менее 6 символов"></label><button class="w-full rounded-xl bg-emerald-500 px-4 py-3 font-bold text-slate-950 transition hover:bg-emerald-400">${mode === 'login' ? 'Войти' : 'Создать аккаунт'}</button></form><button id="auth-switch" class="mt-5 w-full text-sm font-semibold text-emerald-600 dark:text-emerald-400">${mode === 'login' ? 'Нет аккаунта? Зарегистрироваться' : 'Уже есть аккаунт? Войти'}</button></div></section>`;
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
  const all = state.cards; // cards of current rig are replaced below, global totals are loaded separately in refresh.
  const farm = state.farmCards || all;
  const farmTotals = farm.reduce((sum, card) => { const item = calculation(card); sum.profit += item.profit; sum.electricityExpense += item.electricityExpense; return sum; }, { profit: 0, electricityExpense: 0 });
  const rigTotals = state.cards.reduce((sum, card) => { const item = calculation(card); sum.profit += item.profit; sum.electricityExpense += item.electricityExpense; return sum; }, { profit: 0, electricityExpense: 0 });
  const selectedRig = state.rigs.find((rig) => rig.id === state.selectedRigId);
  app.innerHTML = `<div class="mx-auto min-h-screen max-w-6xl p-4 sm:p-7"><header class="mb-7 flex items-center justify-between gap-4"><div><p class="text-xs font-bold uppercase tracking-[.2em] text-emerald-500">${escapeHtml(state.user.username)}</p><h1 class="text-2xl font-black sm:text-3xl">Мой корч</h1></div><div class="flex flex-wrap justify-end gap-2"><button id="settings" class="rounded-xl border border-slate-300 px-3 py-2 text-sm font-bold dark:border-slate-700">⚙️ Настройки</button><button id="theme-button" aria-label="Сменить тему" class="rounded-xl border border-slate-300 px-3 py-2 text-lg dark:border-slate-700">${state.theme === 'dark' ? '☀️' : '🌙'}</button><button id="logout-button" class="rounded-xl border border-slate-300 px-3 py-2 text-sm font-bold dark:border-slate-700">Выйти</button></div></header><section class="grid gap-4 sm:grid-cols-2"><article class="stat-card rounded-2xl bg-emerald-500 p-5 text-slate-950 shadow-lg"><p class="text-sm font-bold opacity-75">Чистый профит · вся ферма</p><p class="mt-2 text-3xl font-black">${money(farmTotals.profit)}</p><p class="mt-1 text-sm font-medium">за 24 часа</p></article><article class="stat-card rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900"><p class="text-sm font-bold text-slate-500 dark:text-slate-400">Расходы на свет · вся ферма</p><p class="mt-2 text-3xl font-black">${money(farmTotals.electricityExpense)}</p><p class="mt-1 text-sm text-slate-500">за 24 часа</p></article></section><section class="mt-8"><div class="mb-3 flex items-center justify-between"><h2 class="font-bold">Риги</h2><button id="add-rig" class="rounded-xl bg-slate-900 px-3 py-2 text-sm font-bold text-white dark:bg-slate-100 dark:text-slate-950">＋ Добавить риг</button></div><div class="scroll-row flex gap-2 overflow-x-auto pb-2">${state.rigs.map((rig) => `<button data-rig-id="${rig.id}" class="rig-tab shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold ${rig.id === state.selectedRigId ? 'bg-emerald-500 text-slate-950' : 'border border-slate-300 dark:border-slate-700'}">${escapeHtml(rig.name)}</button>`).join('') || '<p class="text-slate-500">Ригов пока нет.</p>'}</div></section><section class="mt-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-6"><div class="mb-5 flex flex-wrap items-center justify-between gap-3"><div><p class="text-xs font-bold uppercase tracking-wider text-slate-500">Текущий риг</p><h2 class="text-xl font-black">${escapeHtml(selectedRig?.name || 'Не выбран')}</h2></div>${selectedRig ? `<button id="delete-rig" class="text-sm font-semibold text-rose-500">Удалить риг</button>` : ''}</div><div id="card-list" class="space-y-3">${state.cards.length ? state.cards.map(cardHtml).join('') : `<div class="rounded-xl border border-dashed border-slate-300 p-8 text-center text-slate-500 dark:border-slate-700">В этом риге ещё нет оборудования.</div>`}</div>${selectedRig ? `<footer class="mt-6 flex flex-col justify-between gap-4 border-t border-slate-200 pt-5 dark:border-slate-800 sm:flex-row sm:items-center"><div><p class="text-sm text-slate-500">Итого по ригу · 24 часа</p><p class="text-xl font-black text-emerald-500">${money(rigTotals.profit)} <span class="text-sm font-medium text-slate-500">/ свет ${money(rigTotals.electricityExpense)}</span></p></div><button id="add-card" class="w-fit rounded-xl bg-emerald-500 px-3 py-2 text-sm font-bold text-slate-950">＋ Добавить карту</button></footer>` : ''}</section></div>`;
  document.querySelector('#theme-button').onclick = () => { state.theme = state.theme === 'dark' ? 'light' : 'dark'; applyTheme(); renderDashboard(); };
  document.querySelector('#logout-button').onclick = () => logout(true);
  document.querySelector('#add-rig').onclick = () => showRigModal();
  document.querySelectorAll('.rig-tab').forEach((button) => button.onclick = async () => { state.selectedRigId = Number(button.dataset.rigId); await loadSelectedRig(); renderDashboard(); });
  document.querySelector('#add-card')?.addEventListener('click', () => showCardModal());
  document.querySelector('#settings')?.addEventListener('click', showSettingsModal);
  document.querySelector('#delete-rig')?.addEventListener('click', deleteSelectedRig);
  document.querySelectorAll('[data-edit-card]').forEach((button) => button.onclick = () => showCardModal(state.cards.find((card) => card.id === Number(button.dataset.editCard))));
  document.querySelectorAll('[data-delete-card]').forEach((button) => button.onclick = () => deleteCard(Number(button.dataset.deleteCard)));
}

function cardHtml(card) {
  const result = calculation(card);
  return `<article class="rounded-xl bg-slate-50 p-4 dark:bg-slate-800/70"><div class="flex justify-between gap-3"><div><h3 class="font-black">${escapeHtml(card.model)} <span class="ml-1 rounded-md bg-amber-400 px-1.5 py-0.5 text-xs text-slate-950">${escapeHtml(card.coin)}</span></h3><p class="mt-1 text-sm text-slate-500">${number(card.quantity, 0)} шт. · ${number(card.hashrate)} MH/s на карту · ${number(card.power, 0)} W на карту</p></div><div class="flex h-fit gap-1"><button data-edit-card="${card.id}" class="rounded-lg p-2 hover:bg-slate-200 dark:hover:bg-slate-700" aria-label="Редактировать">✏️</button><button data-delete-card="${card.id}" class="rounded-lg p-2 hover:bg-rose-100 dark:hover:bg-rose-950" aria-label="Удалить">❌</button></div></div><div class="mt-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4"><p><span class="block text-xs text-slate-500">Общий хэш</span><b>${number(result.totalHashrate)} MH/s</b></p><p><span class="block text-xs text-slate-500">Мощность</span><b>${number(result.totalPower, 0)} W</b></p><p><span class="block text-xs text-slate-500">Доход</span><b>${money(result.grossIncome)}</b></p><p><span class="block text-xs text-slate-500">Профит 24</span><b class="${result.profit >= 0 ? 'text-emerald-500' : 'text-rose-500'}">${money(result.profit)}</b></p></div></article>`;
}

function modal(title, content) {
  const node = document.createElement('div'); node.className = 'modal-backdrop fixed inset-0 z-40 flex items-end justify-center bg-slate-950/60 p-3 sm:items-center';
  node.innerHTML = `<div class="modal-panel w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl dark:bg-slate-900"><div class="mb-5 flex items-center justify-between"><h2 class="text-xl font-black">${title}</h2><button class="modal-close rounded-lg p-2 text-lg" aria-label="Закрыть">✕</button></div>${content}</div>`;
  node.addEventListener('click', (event) => { if (event.target === node) node.remove(); }); node.querySelector('.modal-close').onclick = () => node.remove(); document.body.append(node); return node;
}

function showRigModal() {
  const node = modal('Новый риг', `<form class="space-y-4"><label class="block text-sm font-semibold">Название<input name="name" required maxlength="80" class="mt-1.5 w-full rounded-xl border border-slate-300 bg-transparent px-3 py-2.5 dark:border-slate-700" placeholder="Например, Балкон"></label><button class="w-full rounded-xl bg-emerald-500 py-3 font-bold text-slate-950">Создать риг</button></form>`);
  node.querySelector('form').onsubmit = async (event) => { event.preventDefault(); try { const rig = await request('/rigs', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); state.selectedRigId = rig.id; node.remove(); await refresh(); toast('Риг создан'); } catch (error) { toast(error.message, 'error'); } };
}

function showElectricityModal() {
  const node = modal('Настройки розетки', `<form class="space-y-4"><p class="text-sm text-slate-500">Тариф применяется ко всем картам и ригам.</p><label class="block text-sm font-semibold">Стоимость, $ за кВт·ч<input name="electricity_cost" type="number" min="0" step="0.001" required value="${state.user.electricity_cost}" class="mt-1.5 w-full rounded-xl border border-slate-300 bg-transparent px-3 py-2.5 dark:border-slate-700"></label><button class="w-full rounded-xl bg-emerald-500 py-3 font-bold text-slate-950">Сохранить</button></form>`);
  node.querySelector('form').onsubmit = async (event) => { event.preventDefault(); try { const data = await request('/me/electricity', { method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); state.user.electricity_cost = data.electricity_cost; node.remove(); renderDashboard(); toast('Тариф обновлён'); } catch (error) { toast(error.message, 'error'); } };
}

function showCoinsModal() {
  const rows = state.coins.map((coin) => `<form data-coin-id="${coin.id}" class="grid grid-cols-[1fr_1fr_auto] items-end gap-2 rounded-xl bg-slate-100 p-3 dark:bg-slate-800"><label class="text-xs font-bold text-slate-500">Монета<input name="name" required maxlength="30" value="${escapeHtml(coin.name)}" class="coin-field"></label><label class="text-xs font-bold text-slate-500">Курс, $<input name="price_usd" type="number" required min="0" step="any" value="${coin.price_usd}" class="coin-field"></label><div class="flex gap-1"><button title="Сохранить" class="rounded-lg bg-emerald-500 px-2 py-2 text-sm font-black text-slate-950">✓</button><button type="button" data-delete-coin="${coin.id}" title="Удалить" class="rounded-lg px-2 py-2 text-sm">🗑️</button></div></form>`).join('');
  const node = modal('Монеты и курсы', `<p class="mb-4 text-sm text-slate-500">Курс в USD применяется ко всем картам с этой монетой сразу.</p><div class="space-y-2">${rows || '<p class="text-sm text-slate-500">Добавьте первую монету.</p>'}</div><form id="new-coin-form" class="mt-4 grid grid-cols-2 gap-2 border-t border-slate-200 pt-4 dark:border-slate-700"><label class="text-xs font-bold text-slate-500">Название<input name="name" required maxlength="30" placeholder="BTC" class="coin-field"></label><label class="text-xs font-bold text-slate-500">Курс, $<input name="price_usd" type="number" required min="0" step="any" placeholder="0.00" class="coin-field"></label><button class="col-span-2 rounded-xl bg-emerald-500 py-2.5 font-bold text-slate-950">＋ Добавить монету</button></form>`);
  node.querySelectorAll('.coin-field').forEach((input) => input.className = 'coin-field mt-1 w-full rounded-lg border border-slate-300 bg-transparent px-2 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-emerald-500 dark:border-slate-600 dark:text-slate-100');
  node.querySelectorAll('[data-coin-id]').forEach((form) => form.onsubmit = async (event) => { event.preventDefault(); try { await request(`/coins/${form.dataset.coinId}`, { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(form))) }); node.remove(); await refresh(); toast('Курс обновлён'); } catch (error) { toast(error.message, 'error'); } });
  node.querySelectorAll('[data-delete-coin]').forEach((button) => button.onclick = async () => { if (!confirm('Удалить монету?')) return; try { await request(`/coins/${button.dataset.deleteCoin}`, { method: 'DELETE' }); node.remove(); await refresh(); toast('Монета удалена'); } catch (error) { toast(error.message, 'error'); } });
  node.querySelector('#new-coin-form').onsubmit = async (event) => { event.preventDefault(); try { await request('/coins', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); node.remove(); await refresh(); toast('Монета добавлена'); } catch (error) { toast(error.message, 'error'); } };
}

function showSettingsModal() {
  const node = modal('Настройки', `<div class="settings-tabs mb-5 grid grid-cols-2 rounded-xl bg-slate-100 p-1 dark:bg-slate-800"><button type="button" data-settings-tab="power" class="settings-tab rounded-lg bg-white px-3 py-2 text-sm font-bold shadow-sm dark:bg-slate-700">⚡ Электричество</button><button type="button" data-settings-tab="coins" class="settings-tab rounded-lg px-3 py-2 text-sm font-bold text-slate-500">🪙 Монеты</button></div><section data-settings-panel="power"><form id="settings-power-form" class="space-y-4"><p class="text-sm text-slate-500">Тариф применяется ко всем картам и ригам.</p><label class="block text-sm font-semibold">Стоимость, $ за кВт·ч<input name="electricity_cost" type="number" min="0" step="0.001" required value="${state.user.electricity_cost}" class="settings-field"></label><button class="w-full rounded-xl bg-emerald-500 py-3 font-bold text-slate-950">Сохранить тариф</button></form></section><section data-settings-panel="coins" class="hidden"><p class="mb-4 text-sm text-slate-500">Курс в USD применяется ко всем картам с этой монетой сразу.</p><div id="settings-coin-list" class="space-y-2"></div><form id="settings-new-coin" class="mt-4 grid grid-cols-2 gap-2 border-t border-slate-200 pt-4 dark:border-slate-700"><label class="text-xs font-bold text-slate-500">Название<input name="name" required maxlength="30" placeholder="BTC" class="settings-field"></label><label class="text-xs font-bold text-slate-500">Курс, $<input name="price_usd" type="number" required min="0" step="any" placeholder="0.00" class="settings-field"></label><button class="col-span-2 rounded-xl bg-emerald-500 py-2.5 font-bold text-slate-950">＋ Добавить монету</button></form></section>`);
  node.querySelectorAll('.settings-field').forEach((input) => input.className = 'settings-field mt-1.5 w-full rounded-xl border border-slate-300 bg-transparent px-3 py-2.5 outline-none focus:ring-2 focus:ring-emerald-500 dark:border-slate-700');
  const coinPanel = node.querySelector('#settings-coin-list');
  const renderCoins = () => { coinPanel.innerHTML = state.coins.map((coin) => `<form data-settings-coin="${coin.id}" class="grid grid-cols-[1fr_1fr_auto] items-end gap-2 rounded-xl bg-slate-100 p-3 dark:bg-slate-800"><label class="text-xs font-bold text-slate-500">Монета<input name="name" required maxlength="30" value="${escapeHtml(coin.name)}" class="settings-field"></label><label class="text-xs font-bold text-slate-500">Курс, $<input name="price_usd" type="number" required min="0" step="any" value="${coin.price_usd}" class="settings-field"></label><div class="flex gap-1"><button title="Сохранить" class="rounded-lg bg-emerald-500 px-2 py-2 text-sm font-black text-slate-950">✓</button><button type="button" data-settings-delete="${coin.id}" title="Удалить" class="rounded-lg px-2 py-2 text-sm">🗑️</button></div></form>`).join('') || '<p class="text-sm text-slate-500">Добавьте первую монету.</p>'; coinPanel.querySelectorAll('.settings-field').forEach((input) => input.className = 'settings-field mt-1 w-full rounded-lg border border-slate-300 bg-transparent px-2 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-emerald-500 dark:border-slate-600 dark:text-slate-100'); coinPanel.querySelectorAll('[data-settings-coin]').forEach((form) => form.onsubmit = async (event) => { event.preventDefault(); try { await request(`/coins/${form.dataset.settingsCoin}`, { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(form))) }); await refresh(); renderCoins(); toast('Курс обновлён'); } catch (error) { toast(error.message, 'error'); } }); coinPanel.querySelectorAll('[data-settings-delete]').forEach((button) => button.onclick = async () => { if (!confirm('Удалить монету?')) return; try { await request(`/coins/${button.dataset.settingsDelete}`, { method: 'DELETE' }); await refresh(); renderCoins(); toast('Монета удалена'); } catch (error) { toast(error.message, 'error'); } }); };
  renderCoins();
  node.querySelectorAll('[data-settings-tab]').forEach((tab) => tab.onclick = () => { node.querySelectorAll('[data-settings-tab]').forEach((item) => item.classList.toggle('bg-white', item === tab)); node.querySelectorAll('[data-settings-panel]').forEach((panel) => panel.classList.toggle('hidden', panel.dataset.settingsPanel !== tab.dataset.settingsTab)); });
  node.querySelector('#settings-power-form').onsubmit = async (event) => { event.preventDefault(); try { const data = await request('/me/electricity', { method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); state.user.electricity_cost = data.electricity_cost; renderDashboard(); node.remove(); toast('Тариф обновлён'); } catch (error) { toast(error.message, 'error'); } };
  node.querySelector('#settings-new-coin').onsubmit = async (event) => { event.preventDefault(); try { await request('/coins', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); await refresh(); event.currentTarget.reset(); renderCoins(); toast('Монета добавлена'); } catch (error) { toast(error.message, 'error'); } };
}

function showCardModal(card = null) {
  if (!state.coins.length) return toast('Сначала добавьте хотя бы одну монету в настройках', 'error');
  const isEdit = Boolean(card); const values = card || { model: '', coin: state.coins[0].name, quantity: 1, hashrate: '', power: '', income_per_mhs: EXCEL_DEFAULT_COIN_PER_MHS };
  const coinOptions = state.coins.map((coin) => `<option value="${escapeHtml(coin.name)}" ${coin.name.toLowerCase() === String(values.coin).toLowerCase() ? 'selected' : ''}>${escapeHtml(coin.name)} · ${money(coin.price_usd)}</option>`).join('');
  const node = modal(isEdit ? 'Редактировать карту' : 'Добавить карту', `<form class="grid gap-3 sm:grid-cols-2"><label class="text-sm font-semibold">Модель<input name="model" required maxlength="80" value="${escapeHtml(values.model)}" class="field"></label><label class="text-sm font-semibold">Монета<select name="coin" required class="field">${coinOptions}</select></label><label class="text-sm font-semibold">Количество<input name="quantity" type="number" required min="1" step="1" value="${values.quantity}" class="field"></label><label class="text-sm font-semibold">Хэш на 1 карту, MH/s<input name="hashrate" type="number" required min="0" step="any" value="${values.hashrate}" class="field"></label><label class="text-sm font-semibold">Мощность на 1 карту, W<input name="power" type="number" required min="0" step="1" value="${values.power}" class="field"></label><label class="text-sm font-semibold">Добыча на 1 MH/s, монет/сутки<input name="income_per_mhs" type="number" required min="0" step="any" value="${values.income_per_mhs}" class="field"></label><p class="sm:col-span-2 rounded-xl bg-slate-100 p-3 text-xs text-slate-500 dark:bg-slate-800">Доход: общий хэш × добыча на 1 MH/s × курс монеты. Excel-значение QTC: 2.8 ÷ 3620 = ${EXCEL_DEFAULT_COIN_PER_MHS.toFixed(9)} QTC/MH/s.</p><button class="sm:col-span-2 rounded-xl bg-emerald-500 py-3 font-bold text-slate-950">${isEdit ? 'Сохранить изменения' : 'Добавить карту'}</button></form>`);
  node.querySelectorAll('.field').forEach((input) => input.className = 'field mt-1.5 w-full rounded-xl border border-slate-300 bg-transparent px-3 py-2.5 outline-none focus:ring-2 focus:ring-emerald-500 dark:border-slate-700');
  node.querySelector('form').onsubmit = async (event) => { event.preventDefault(); const raw = Object.fromEntries(new FormData(event.currentTarget)); const payload = { ...raw, rig_id: state.selectedRigId, quantity: Number(raw.quantity), hashrate: Number(raw.hashrate), power: Number(raw.power), income_per_mhs: Number(raw.income_per_mhs) }; try { await request(isEdit ? `/cards/${card.id}` : '/cards', { method: isEdit ? 'PUT' : 'POST', body: JSON.stringify(payload) }); node.remove(); await refresh(); toast(isEdit ? 'Карта обновлена' : 'Карта добавлена'); } catch (error) { toast(error.message, 'error'); } };
}

async function deleteCard(cardId) { if (!confirm('Удалить эту карту из рига?')) return; try { await request(`/cards/${cardId}`, { method: 'DELETE' }); await refresh(); toast('Карта удалена'); } catch (error) { toast(error.message, 'error'); } }
async function deleteSelectedRig() { if (!confirm('Удалить риг и всё оборудование в нём?')) return; try { await request(`/rigs/${state.selectedRigId}`, { method: 'DELETE' }); state.selectedRigId = null; await refresh(); toast('Риг удалён'); } catch (error) { toast(error.message, 'error'); } }
async function loadSelectedRig() { state.cards = state.selectedRigId ? await request(`/rigs/${state.selectedRigId}/cards`) : []; }
async function refresh() { state.user = await request('/me'); state.coins = await request('/coins'); state.rigs = await request('/rigs'); if (!state.rigs.some((rig) => rig.id === state.selectedRigId)) state.selectedRigId = state.rigs[0]?.id || null; state.farmCards = (await Promise.all(state.rigs.map((rig) => request(`/rigs/${rig.id}/cards`)))).flat(); await loadSelectedRig(); renderDashboard(); }
function logout(showMessage) { state.token = null; state.user = null; state.cards = []; localStorage.removeItem('korch_token'); renderAuth(); if (showMessage) toast('Вы вышли из аккаунта'); }

async function init() { applyTheme(); if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {}); if (!state.token) return renderAuth(); try { await refresh(); } catch (error) { toast(error.message, 'error'); } }
init();
