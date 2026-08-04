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
  const yieldWorking = (coinsPerDay * workingDays + coinsPerDay / TIME.workingDayDuration * TIME.weekendDayDuration * weekendDays) / totalDays;
  if (rig?.calculation_mode === 'weekend_days') {
    return (coinsPerDay / TIME.weekendDayDuration * TIME.workingDayDuration * workingDays + coinsPerDay * weekendDays) / totalDays;
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
const money = (value) => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value || 0);
// Для tween-анимации денежные суммы форматируем ЧИСЛОМ (знак добавляем сами).
const moneyFmt = (value) => new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(Number(value) || 0));
const number = (value, digits = 2) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(value || 0);

/* Иконки: ico('gear') → <svg><use #i-gear></svg>. Спрайт объявлен в index.html. */
const ico = (name, extra = '') => `<svg class="ico ${extra}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

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
  node.className = `toast ${type === 'error' ? 'error' : 'ok'}`;
  node.innerHTML = `${ico(type === 'error' ? 'close' : 'check')}<span>${escapeHtml(message)}</span>`;
  document.querySelector('#toast-region').append(node);
  setTimeout(() => { node.classList.add('toast-out'); node.addEventListener('animationend', () => node.remove(), { once: true }); setTimeout(() => node.remove(), 300); }, 3200);
}

function applyTheme() {
  const dark = state.theme === 'dark';
  document.documentElement.classList.toggle('dark', dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#05070d' : '#eef1f8');
  localStorage.setItem('korch_theme', state.theme);
}

// Плавное закрытие модалки: проигрываем обратную анимацию и убираем узел из DOM
// только после неё (со страховкой по таймеру на случай prefers-reduced-motion).
function closeModal(node) {
  if (!node || node.classList.contains('closing')) return;
  node.classList.add('closing');
  let done = false;
  const finish = () => { if (done) return; done = true; node.remove(); };
  node.addEventListener('animationend', finish, { once: true });
  setTimeout(finish, 260);
}

// Кэш пишем только после серверного подтверждения состояния: иначе в него
// улетали optimistic-объекты с временными id, и после F5 карточки "висели"
// с id вида optimistic-card-... до следующего refresh().
function renderAndCache() {
  renderDashboard();
  saveCache();
}

/* --- Tween чисел: значения "подъезжают" к новым, дельта подсвечивается ----- */
// ВАЖНО: renderDashboard() полностью пересобирает DOM, поэтому tween можно делать
// только на тот узел, который продолжает существовать. Мы делаем tween ПЕРЕД рендером
// маленьких "живых" узлов (см. syncTweenDashboard), либо ставим значение сразу.
const displayedNumbers = new Map(); // id -> последнее число, показанное на экране

// Форматируем ЦЕЛЕВОЕ значение (деньги/число), одинаково для tween и финала,
// чтобы не было скачка между промежуточным кадром и итогом.
function fmtTween(node, value) {
  return node.dataset.tweenFmt === 'money' ? money(value) : number(value, 2);
}

function triggerFlash(scope, direction) {
  scope.querySelectorAll('[data-tween]').forEach((el) => {
    el.classList.remove('flash-up', 'flash-down');
    void el.offsetWidth; // reflow, чтобы анимация перезапустилась
    el.classList.add(direction === 'up' ? 'flash-up' : 'flash-down');
  });
}

// rAF-интерполяция старого → нового значения в data-tween-узле.
function tweenNode(node, from, to) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || Math.abs(to - from) < 1e-9) {
    node.textContent = fmtTween(node, to);
    return;
  }
  const start = performance.now(); const duration = 420; const delta = to - from;
  const step = (now) => {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
    node.textContent = fmtTween(node, from + delta * eased);
    if (t < 1 && document.contains(node)) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Сверить "что на экране" с "что посчитали" и запустить tween/flash для изменившихся.
// Вызывается после каждого renderDashboard(): если значение изменилось — анимируем
// УЖЕ новый DOM-узел от предыдущего запомненного значения к текущему.
function syncTweenDashboard(farmTotals, rigTotals) {
  const map = { 'farm-profit': farmTotals.profit, 'farm-electricity': farmTotals.electricityExpense, 'rig-profit': rigTotals.profit, 'rig-electricity': rigTotals.electricityExpense };
  for (const [id, next] of Object.entries(map)) {
    const node = document.querySelector(`[data-tween="${id}"]`);
    if (!node) continue;
    const prev = displayedNumbers.get(id);
    if (prev !== undefined && Number.isFinite(prev) && Math.abs(prev - next) > 1e-9) {
      tweenNode(node, prev, next);
      triggerFlash(node.closest('.stat-card, [data-stat-scope]') || node, next > prev ? 'up' : 'down');
    } else {
      node.textContent = fmtTween(node, next);
    }
    displayedNumbers.set(id, next);
  }
}

function renderSkeleton() {
  app.innerHTML = `<div class="mx-auto min-h-screen max-w-6xl p-4 sm:p-7">
    <header class="mb-7 flex flex-wrap items-center justify-between gap-3">
      <div class="space-y-2"><div class="skeleton h-3 w-24"></div><div class="skeleton h-8 w-44"></div></div>
      <div class="flex gap-2 sm:gap-3"><div class="skeleton h-11 w-28"></div><div class="skeleton h-11 w-24"></div></div>
    </header>
    <section class="grid gap-3 sm:gap-4 sm:grid-cols-2">
      <div class="skeleton h-32" style="border-radius:22px"></div>
      <div class="skeleton h-32" style="border-radius:22px"></div>
    </section>
    <section class="mt-7 sm:mt-8">
      <div class="skeleton mb-3 h-5 w-16"></div>
      <div class="rig-tabs"><div class="skeleton h-11 w-24"></div><div class="skeleton h-11 w-24"></div></div>
    </section>
    <section class="card-glass mt-6 space-y-3 p-4 sm:p-6">
      <div class="skeleton h-6 w-32"></div>
      <div class="skeleton h-20"></div>
      <div class="skeleton h-20"></div>
    </section>
  </div>`;
}

function renderAuth(mode = 'login') {
  app.innerHTML = `<section class="page-enter flex min-h-screen items-center justify-center p-5">
    <div class="auth-panel glass w-full max-w-md rounded-3xl p-7 sm:p-9">
      <div class="mb-8">
        <div class="auth-logo mb-4">${ico('logo', 'ico-lg')}</div>
        <h1 class="auth-title">Мой корч</h1>
        <p class="mt-2 text-[15px] text-slate-500 dark:text-slate-400">Личный майнинг-калькулятор без лишнего шума. Стекло, аврора и точные цифры.</p>
      </div>
      <form id="auth-form" class="space-y-4">
        <label class="block text-sm font-semibold">Логин
          <input name="username" required minlength="3" autocomplete="username" class="field" placeholder="miner_01">
        </label>
        <label class="block text-sm font-semibold">Пароль
          <input name="password" type="password" required minlength="6" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" class="field" placeholder="Не менее 6 символов">
        </label>
        <button class="btn btn-accent w-full">${mode === 'login' ? 'Войти' : 'Создать аккаунт'} ${ico('chevron')}</button>
      </form>
      <button id="auth-switch" class="mt-5 w-full text-sm font-semibold text-amber-500 transition hover:text-amber-400">
        ${mode === 'login' ? 'Нет аккаунта? Зарегистрироваться' : 'Уже есть аккаунт? Войти'}
      </button>
    </div>
  </section>`;
  document.querySelector('#auth-switch').onclick = () => renderAuth(mode === 'login' ? 'register' : 'login');
  document.querySelector('#auth-form').onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('button[type="submit"], button:not([type])');
    const originalText = submit?.innerHTML;
    if (submit) { submit.disabled = true; submit.textContent = 'Подключаемся…'; }
    try {
      const data = await request(`/auth/${mode === 'login' ? 'login' : 'register'}`, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      state.token = data.token; state.user = data.user; localStorage.setItem('korch_token', data.token);
      await refresh(); toast(mode === 'login' ? 'С возвращением!' : 'Аккаунт создан — QTC и первый риг уже ждут');
    } catch (error) {
      // Раньше здесь не было finally/reenable — после первой ошибки кнопка навсегда
      // оставалась "Подключаемся…" и приходилось перезагружать страницу.
      if (submit) { submit.disabled = false; submit.innerHTML = originalText; }
      toast(error.message, 'error');
    }
  };
}

/* Sparkline removed: бары выглядели как «яичные» овалы под картами на всех карточках. */

function renderDashboard() {
  const farmTotals = state.rigs.reduce((sum, rig) => { const result = rigCalculation(rig, state.cardsByRig[rig.id] || []); sum.profit += result.profit; sum.electricityExpense += result.electricityExpense; return sum; }, { profit: 0, electricityExpense: 0 });
  const selectedRig = state.rigs.find((rig) => String(rig.id) === String(state.selectedRigId));
  const rigTotals = selectedRig ? rigCalculation(selectedRig, state.cards) : { profit: 0, electricityExpense: 0, incomePerMhs: 0 };
  const rigSubtitle = selectedRig ? (selectedRig.coin ? `<span class="chip">${escapeHtml(selectedRig.coin)}</span> <b class="num ${rigTotals.profit >= 0 ? 'text-amber-500' : 'text-rose-400'}">${money(rigTotals.profit)}</b> чистыми · ${number(avgDailyYield(selectedRig), 6)}/сутки в среднем · <span class="chip">${ico('flash')} ${money(selectedRig.electricity_cost)}/кВт·ч</span>` : 'Конфигурация не задана — нажмите «Конфигурация»') : '';
  const isNegative = farmTotals.profit < 0;
  app.innerHTML = `<div class="page-enter mx-auto min-h-screen max-w-6xl p-4 pb-10 sm:p-7">
    <header class="mb-7 flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-3">
        <div class="auth-logo" style="width:2.9rem;height:2.9rem;border-radius:15px">${ico('logo', 'ico-lg')}</div>
        <div>
          <p class="text-[11px] font-bold uppercase tracking-[.22em] text-amber-500/90">${escapeHtml(state.user.username)}</p>
          <h1 class="font-display text-[26px] font-extrabold sm:text-3xl">Мой корч</h1>
        </div>
      </div>
      <div class="flex flex-wrap justify-end gap-2 sm:gap-3">
        <button id="settings" class="btn btn-ghost">${ico('gear')} Настройки</button>
        <button id="logout-button" class="btn btn-ghost" title="Выйти">${ico('logout')}<span class="max-sm:hidden"> Выйти</span></button>
      </div>
    </header>

    <section class="grid gap-3 sm:gap-4 sm:grid-cols-2">
      <article class="stat-card card-glass rise-in stat-main ${isNegative ? 'negative' : ''}" data-stat-scope="farm">
        <p class="stat-label">${ico('coin')} Чистый профит · вся ферма</p>
        <span class="stat-value num" data-tween="farm-profit" data-tween-fmt="money">${money(farmTotals.profit)}</span>
        <p class="stat-hint">за 24 часа</p>
      </article>
      <article class="stat-card card-glass rise-in" style="animation-delay:55ms" data-stat-scope="farm-power">
        <p class="stat-label">${ico('flash')} Расходы на свет · вся ферма</p>
        <span class="stat-value num" data-tween="farm-electricity" data-tween-fmt="money">${money(farmTotals.electricityExpense)}</span>
        <p class="stat-hint">за 24 часа</p>
      </article>
    </section>

    <section class="mt-7 sm:mt-8">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 class="font-bold">Риги</h2>
        <button id="add-rig" class="btn btn-ghost">${ico('plus')} Добавить риг</button>
      </div>
      <div id="rig-tabs" class="rig-tabs rise-in" style="animation-delay:100ms">
        <span class="rig-pill" aria-hidden="true"></span>
        ${state.rigs.map((rig) => `<button data-rig-id="${rig.id}" class="rig-tab ${String(rig.id) === String(state.selectedRigId) ? 'active' : ''}">${escapeHtml(rig.name)}</button>`).join('') || '<p class="px-3 py-2 text-sm text-slate-500">Ригов пока нет.</p>'}
      </div>
    </section>

    <section class="card-glass rise-in mt-6 p-4 sm:p-6" style="animation-delay:150ms">
      <div class="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p class="text-xs font-bold uppercase tracking-wider text-slate-500">Текущий риг</p>
          <h2 class="font-display text-xl font-bold">${escapeHtml(selectedRig?.name || 'Не выбран')}</h2>
          ${selectedRig ? `<p class="mt-1 text-sm text-slate-500 dark:text-slate-400">${rigSubtitle}</p>` : ''}
        </div>
        ${selectedRig ? `<div class="flex shrink-0 gap-1.5">
          <button id="rename-rig" class="btn btn-ghost btn-icon" title="Переименовать риг" aria-label="Переименовать риг">${ico('edit')}</button>
          <button id="delete-rig" class="btn btn-ghost btn-icon danger" title="Удалить риг" aria-label="Удалить риг">${ico('trash')}</button>
        </div>` : ''}
      </div>

      <div id="card-list" class="grid gap-3 sm:grid-cols-2">
        ${state.cards.length ? state.cards.map((card, index) => cardHtml(card, index)).join('') : `<div class="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-slate-500 dark:border-slate-700 sm:col-span-2">В этом риге ещё нет оборудования.<br><span class="text-xs">Добавьте первую карту кнопкой ниже.</span></div>`}
      </div>

      ${selectedRig ? `<footer class="rig-footer mt-6 flex flex-col gap-4 border-t border-white/5 pt-5 sm:flex-row sm:items-center sm:justify-between">
        <div data-stat-scope="rig">
          <p class="text-sm text-slate-500">Итого по ригу · 24 часа</p>
          <p class="mt-0.5 text-xl font-extrabold">
            <span class="num ${rigTotals.profit >= 0 ? 'text-amber-500' : 'text-rose-400'}" data-tween="rig-profit" data-tween-fmt="money">${money(rigTotals.profit)}</span>
            <span class="text-sm font-medium text-slate-500">/ свет <span class="num" data-tween="rig-electricity" data-tween-fmt="money">${money(rigTotals.electricityExpense)}</span></span>
          </p>
          <p class="rig-total-hash font-display num mt-2 text-[17px] font-extrabold text-amber-500/95">${number(rigTotals.totalHashrate, 2)} MH/s <span class="text-[12px] font-medium text-slate-500">· общий хэш рига</span></p>
        </div>
        <div class="flex flex-wrap gap-2 sm:gap-3">
          <button id="rig-config" class="btn btn-ghost">${ico('gear')} Конфигурация</button>
          <button id="add-card" class="btn btn-accent">${ico('plus')} Добавить карту</button>
        </div>
      </footer>` : ''}
    </section>
  </div>`;

  syncTweenDashboard(farmTotals, rigTotals);
  initPointerGlow();
  requestAnimationFrame(() => updateRigPill(false));

  document.querySelector('#logout-button').onclick = () => logout(true);
  document.querySelector('#add-rig').onclick = () => showRigModal();
  document.querySelectorAll('.rig-tab').forEach((button) => button.onclick = () => switchRig(Number(button.dataset.rigId)));
  document.querySelector('#add-card')?.addEventListener('click', () => { state.editingCardId = null; showCardModal(); });
  document.querySelector('#settings')?.addEventListener('click', showSettingsModal);
  document.querySelector('#delete-rig')?.addEventListener('click', deleteSelectedRig);
  document.querySelector('#rename-rig')?.addEventListener('click', () => showRenameRigModal(selectedRig));
  document.querySelector('#rig-config')?.addEventListener('click', () => showRigConfigModal(selectedRig));
  document.querySelectorAll('[data-edit-card]').forEach((button) => button.onclick = () => { state.editingCardId = Number(button.dataset.editCard); showCardModal(state.cards.find((card) => card.id === Number(button.dataset.editCard))); });
  document.querySelectorAll('[data-delete-card]').forEach((button) => button.onclick = () => deleteCard(Number(button.dataset.deleteCard)));
}

// Слушатель ресайза/скролла один раз на приложение — пилюля перевыполняет геометрию.
window.addEventListener('resize', () => updateRigPill(false), { passive: true });
document.addEventListener('scroll', (event) => {
  if (event.target?.id === 'rig-tabs') updateRigPill(false);
}, true);

// Подсветка "стекла" за курсором — делегирует одним слушателем на все .card-glass.
function initPointerGlow() {
  if (initPointerGlow.bound) return;
  initPointerGlow.bound = true;
  let raf = 0;
  window.addEventListener('pointermove', (event) => {
    const card = event.target.closest?.('.card-glass');
    if (!card) return;
    if (raf) return; // не плодим лишние рендер-кадры: один на кадр
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!document.contains(card)) return;
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${event.clientX - rect.left}px`);
      card.style.setProperty('--my', `${event.clientY - rect.top}px`);
    });
  }, { passive: true });
}

// "Пилюля" активного рига: измеряем выбранный таб и скользим к нему.
function updateRigPill(animate = true) {
  const tabs = document.querySelector('#rig-tabs');
  if (!tabs) return;
  const active = tabs.querySelector('.rig-tab.active');
  const pill = tabs.querySelector('.rig-pill');
  if (!pill) return;
  if (!active) { pill.style.opacity = '0'; return; }
  if (!animate) { pill.style.transitionProperty = 'none'; pill.classList.remove('moving'); }
  else {
    pill.classList.add('moving');
    setTimeout(() => pill.classList.remove('moving'), 500);
  }
  pill.style.width = `${active.offsetWidth}px`;
  pill.style.transform = `translateX(${active.offsetLeft}px)`;
  pill.style.opacity = '1';
  if (!animate) requestAnimationFrame(() => { pill.style.transitionProperty = ''; });
}

function cardHtml(card, index = 0) {
  const totalHashrate = Number(card.hashrate) * Number(card.quantity);
  const totalPower = Number(card.power) * Number(card.quantity);
  return `<article style="animation-delay:${Math.min(index, 8) * 45}ms" class="rise-in glass rounded-2xl p-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 class="font-bold">${escapeHtml(card.model)}</h3>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">${number(card.quantity, 0)} шт. · ${number(card.hashrate)} MH/s · ${number(card.power, 0)} W на карту</p>
      </div>
      <div class="flex h-fit shrink-0 gap-1.5">
        <button data-edit-card="${card.id}" class="btn btn-ghost btn-icon" aria-label="Редактировать" title="Редактировать">${ico('edit')}</button>
        <button data-delete-card="${card.id}" class="btn btn-ghost btn-icon danger" aria-label="Удалить" title="Удалить">${ico('trash')}</button>
      </div>
    </div>
    <div class="mt-4 grid grid-cols-2 gap-2 text-sm">
      <p><span class="block text-xs text-slate-500">Общий хэш</span><b class="num text-[15px]">${number(totalHashrate)}</b> <span class="text-xs text-slate-500">MH/s</span></p>
      <p><span class="block text-xs text-slate-500">Мощность</span><b class="num text-[15px]">${number(totalPower, 0)}</b> <span class="text-xs text-slate-500">W</span></p>
    </div>
  </article>`;
}

function modal(title, content) {
  const node = document.createElement('div');
  node.className = 'modal-backdrop';
  // title вставляется через textContent через h2 — чтобы исключить XSS даже если
  // вызывающий забывает экранировать имя рига/монеты. Поэтому все вызовы ниже
  // передают «сырую» строку и не экранируют сами.
  node.innerHTML = `<div class="modal-panel"><div class="mb-5 flex items-center justify-between gap-3"><h2 class="modal-title font-display text-lg font-bold"></h2><button class="modal-close btn btn-ghost btn-icon" aria-label="Закрыть">${ico('close')}</button></div>${content}</div>`;
  node.querySelector('.modal-title').textContent = title;
  node.addEventListener('click', (event) => { if (event.target === node) closeModal(node); });
  node.querySelector('.modal-close').onclick = () => closeModal(node);
  document.body.append(node);
  return node;
}

function showRigModal() {
  // Отправку формы полностью обрабатывает глобальный оптимистичный listener (см. ниже).
  modal('Новый риг', `<form id="rig-form" class="space-y-4">
    <label class="block text-sm font-semibold">Название
      <input name="name" required maxlength="80" class="field" placeholder="Например, Балкон">
    </label>
    <button class="btn btn-accent w-full">${ico('plus')} Создать риг</button>
  </form>`);
}

function showRenameRigModal(rig) {
  if (!rig) return;
  const node = modal(`Переименовать риг`, `<form id="rig-rename-form" data-rig-id="${rig.id}" class="space-y-4">
    <label class="block text-sm font-semibold">Новое название
      <input name="name" required maxlength="80" value="${escapeHtml(rig.name)}" class="field" placeholder="Например, Балкон">
    </label>
    <button class="btn btn-accent w-full">Сохранить</button>
  </form>`);
  node.querySelector('input').select();
}

function showRigConfigModal(rig) {
  if (!rig) return;
  if (!state.coins.length) return toast('Сначала добавьте хотя бы одну монету в настройках', 'error');
  const coinOptions = state.coins.map((coin) => `<option value="${escapeHtml(coin.name)}" ${coin.name.toLowerCase() === String(rig.coin || '').toLowerCase() ? 'selected' : ''}>${escapeHtml(coin.name)} · ${money(coin.price_usd)}</option>`).join('');
  modal(`Конфигурация: ${rig.name}`, `<form data-rig-config="${rig.id}" class="space-y-4">
    <label class="block text-sm font-semibold">Монета
      <select name="coin" required class="field">${coinOptions}</select>
    </label>
    <label class="block text-sm font-semibold">Добыча монет в сутки, весь риг
      <input name="coin_per_day" type="number" min="0" step="any" required value="${rig.coin_per_day ?? 0}" class="field">
    </label>
    <label class="block text-sm font-semibold">Цена за розетку, $ за кВт·ч
      <input name="electricity_cost" type="number" min="0" step="0.001" required value="${rig.electricity_cost ?? 0}" class="field">
    </label>
    <div class="glass rounded-2xl p-3.5">
      <p class="mb-3 flex items-center gap-2 text-sm font-bold">${ico('flash')} Время</p>
      <div class="grid grid-cols-2 gap-2.5">
        <label class="text-xs font-bold text-slate-500">Рабочих суток в цикле · 18ч<input name="working_days" type="number" min="0" max="31" step="1" required value="${rig.working_days ?? 5}" class="field"></label>
        <label class="text-xs font-bold text-slate-500">Выходных суток в цикле · 24ч<input name="weekend_days" type="number" min="0" max="31" step="1" required value="${rig.weekend_days ?? 2}" class="field"></label>
      </div>
      <label class="mt-2.5 block text-xs font-bold text-slate-500">Введённая добыча в сутки основана на
        <select name="calculation_mode" required class="field">
          <option value="working_days" ${rig.calculation_mode !== 'weekend_days' ? 'selected' : ''}>Рабочих сутках (18ч)</option>
          <option value="weekend_days" ${rig.calculation_mode === 'weekend_days' ? 'selected' : ''}>Выходных сутках (24ч)</option>
        </select>
      </label>
    </div>
    <p class="rounded-xl p-3 text-xs text-slate-500 glass">Средняя добыча в сутки считается автоматически по графику работы рига, а доход на 1 MH/s — от неё ÷ суммарный хешрейт всех карт этого рига. Значения в код не зашиты.</p>
    <button class="btn btn-accent w-full">Сохранить конфигурацию</button>
  </form>`);
  // Отправку формы полностью обрабатывает глобальный оптимистичный listener (см. ниже).
}

function showSettingsModal() {
  const node = modal('Настройки', `
    <div class="glass mb-5 flex items-center justify-between gap-3 rounded-2xl p-3">
      <div>
        <p class="text-sm font-bold">Тема оформления</p>
        <p class="text-xs text-slate-500">Аврора гаснет — стекло остаётся</p>
      </div>
      <button id="settings-theme-toggle" class="btn btn-ghost btn-icon" title="Переключить тему">${state.theme === 'dark' ? ico('sun') : ico('moon')}</button>
    </div>
    <p class="mb-2 flex items-center gap-2 text-sm font-bold">${ico('coin')} Монеты</p>
    <p class="mb-4 text-sm text-slate-500">Курс в USD применяется сразу везде, где используется эта монета.</p>
    <div id="settings-coin-list" class="space-y-2.5"></div>
    <form id="settings-new-coin" class="mt-4 grid grid-cols-2 gap-2.5 border-t border-white/5 pt-4">
      <label class="text-xs font-bold text-slate-500">Название<input name="name" required maxlength="30" placeholder="BTC" class="settings-field"></label>
      <label class="text-xs font-bold text-slate-500">Курс, $<input name="price_usd" type="number" required min="0" step="any" placeholder="0.00" class="settings-field"></label>
      <button class="btn btn-accent col-span-2">${ico('plus')} Добавить монету</button>
    </form>`);
  node.querySelector('#settings-theme-toggle').onclick = () => {
    // Тему переключаем без renderDashboard(): DOM дашборда за модалкой не пересоздаётся,
    // поэтому смена dark-класса на <html> проходит плавным переходом (см. styles.css),
    // а не мгновенной пересборкой всего экрана.
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    node.querySelector('#settings-theme-toggle').innerHTML = state.theme === 'dark' ? ico('sun') : ico('moon');
  };
  const coinPanel = node.querySelector('#settings-coin-list');
  const renderCoins = () => {
    coinPanel.innerHTML = state.coins.map((coin) => `<form data-settings-coin="${coin.id}" class="glass grid grid-cols-[1fr_1fr_auto] items-end gap-2.5 rounded-2xl p-3">
      <label class="text-xs font-bold text-slate-500">Монета<input name="name" required maxlength="30" value="${escapeHtml(coin.name)}" class="settings-field"></label>
      <label class="text-xs font-bold text-slate-500">Курс, $<input name="price_usd" type="number" required min="0" step="any" value="${coin.price_usd}" class="settings-field"></label>
      <div class="flex gap-1.5">
        <button title="Сохранить" class="btn btn-accent btn-icon">${ico('check')}</button>
        <button type="button" data-settings-delete="${coin.id}" title="Удалить" class="btn btn-ghost btn-icon danger">${ico('trash')}</button>
      </div>
    </form>`).join('') || '<p class="text-sm text-slate-500">Добавьте первую монету.</p>';
  };
  renderCoins();
}

function showCardModal(card = null) {
  const isEdit = Boolean(card); const values = card || { model: '', quantity: 1, hashrate: '', power: '' };
  modal(isEdit ? 'Редактировать карту' : 'Добавить карту', `<form id="card-form" class="grid gap-3 sm:grid-cols-2 sm:gap-4">
    <label class="text-sm font-semibold sm:col-span-2">Модель<input name="model" required maxlength="80" value="${escapeHtml(values.model)}" class="field" placeholder="RTX 3070"></label>
    <label class="text-sm font-semibold">Количество<input name="quantity" type="number" required min="1" step="1" value="${values.quantity}" class="field"></label>
    <label class="text-sm font-semibold">Хэш на 1 карту, MH/s<input name="hashrate" type="number" required min="0" step="any" value="${values.hashrate}" class="field"></label>
    <label class="text-sm font-semibold sm:col-span-2">Мощность на 1 карту, W<input name="power" type="number" required min="0" step="1" value="${values.power}" class="field"></label>
    <button class="btn btn-accent sm:col-span-2">${isEdit ? 'Сохранить изменения' : 'Добавить карту'}</button>
  </form>`);
  // Отправку формы полностью обрабатывает глобальный оптимистичный listener (см. ниже).
}

// Мгновенное переключение рига: карты уже загружены и лежат в кэше state.cardsByRig
// (см. refresh()), поэтому сети ждать не нужно — рендерим сразу, а сверяем в фоне.
function switchRig(rigId) {
  if (String(rigId) === String(state.selectedRigId)) return;
  state.selectedRigId = rigId;
  state.cards = state.cardsByRig[rigId] || [];
  // Переносим .active на новый таб — пилюля плавно скользнёт (см. switchRig finalize)
  document.querySelectorAll('.rig-tab').forEach((tab) => tab.classList.toggle('active', Number(tab.dataset.rigId) === Number(rigId)));
  renderDashboard();
  requestAnimationFrame(() => updateRigPill(true));
  saveCache(); // выбор рига — не optimistic-данные, кэшировать безопасно сразу
  request(`/rigs/${rigId}/cards`).then((cards) => {
    const changed = JSON.stringify(cards) !== JSON.stringify(state.cardsByRig[rigId] || []);
    state.cardsByRig[rigId] = cards;
    if (String(state.selectedRigId) === String(rigId) && changed) { state.cards = cards; renderAndCache(); }
  }).catch(() => { /* тихая сверка — не мешаем тостом при обычном переключении */ });
}

async function deleteCard(cardId) {
  if (!confirm('Удалить эту карту из рига?')) return;
  const previousCards = [...state.cards]; const previousByRig = { ...state.cardsByRig };
  state.cards = state.cards.filter((card) => card.id !== cardId); state.cardsByRig[state.selectedRigId] = state.cards;
  renderDashboard(); toast('Карта удалена');
  try { await request(`/cards/${cardId}`, { method: 'DELETE' }); saveCache(); } catch (error) { state.cards = previousCards; state.cardsByRig = previousByRig; renderDashboard(); toast(`Не удалось удалить карту: ${error.message}`, 'error'); }
}
async function deleteSelectedRig() {
  if (!confirm('Удалить риг и всё оборудование в нём?')) return;
  const rigId = state.selectedRigId; const previousRigs = [...state.rigs]; const previousByRig = { ...state.cardsByRig }; const previousCards = [...state.cards]; const previousSelected = state.selectedRigId;
  state.rigs = state.rigs.filter((rig) => String(rig.id) !== String(rigId)); delete state.cardsByRig[rigId];
  state.selectedRigId = state.rigs[0]?.id || null; state.cards = state.cardsByRig[state.selectedRigId] || [];
  renderDashboard(); toast('Риг удалён');
  try { await request(`/rigs/${rigId}`, { method: 'DELETE' }); saveCache(); } catch (error) { state.rigs = previousRigs; state.cardsByRig = previousByRig; state.cards = previousCards; state.selectedRigId = previousSelected; renderDashboard(); toast(`Не удалось удалить риг: ${error.message}`, 'error'); }
}
async function refresh() {
  // Один round trip вместо 3 + N: профиль, монеты, риги и карты всех ригов
  // приезжают из /bootstrap вместе. Это главный фикс скорости загрузки.
  const data = await request('/bootstrap');
  state.user = data.user; state.coins = data.coins; state.rigs = data.rigs;
  state.cardsByRig = data.cardsByRig || {};
  if (!state.rigs.some((rig) => String(rig.id) === String(state.selectedRigId))) state.selectedRigId = state.rigs[0]?.id || null;
  state.cards = state.cardsByRig[state.selectedRigId] || [];
  renderDashboard();
  saveCache();
}
function logout(showMessage) { state.token = null; state.user = null; state.cards = []; state.cardsByRig = {}; localStorage.removeItem('korch_token'); localStorage.removeItem(CACHE_KEY); renderAuth(); if (showMessage) toast('Вы вышли из аккаунта'); }

/* Optimistic UI: modal mutations render immediately and reconcile in background. */
document.addEventListener('submit', (event) => {
  const form = event.target;
  const modalRoot = form.closest('.modal-backdrop');
  if (!modalRoot) {
    // Форма входа/регистрации живёт вне модалок — её auth-submitting слушатель
    // в renderAuth сам ставит/снимает disabled на кнопке.
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
      renderAndCache();
    }).catch((error) => { state.cards = previousCards; state.cardsByRig = previousByRig; renderDashboard(); toast(`Изменения карты отменены: ${error.message}`, 'error'); });
    return;
  }
  if (form.id === 'settings-new-coin') {
    event.preventDefault(); event.stopImmediatePropagation();
    const optimisticId = `optimistic-coin-${Date.now()}`; const optimisticCoin = { id: optimisticId, name: String(raw.name).trim().toUpperCase(), price_usd: Number(raw.price_usd) }; const previousCoins = [...state.coins];
    state.coins = [...state.coins, optimisticCoin]; closeModal(modalRoot); renderDashboard(); toast('Монета добавлена');
    request('/coins', { method: 'POST', body: JSON.stringify({ name: optimisticCoin.name, price_usd: optimisticCoin.price_usd }) }).then((saved) => { state.coins = state.coins.map((coin) => coin.id === optimisticId ? saved : coin); saveCache(); }).catch((error) => { state.coins = previousCoins; renderDashboard(); toast(`Монета не сохранена: ${error.message}`, 'error'); });
    return;
  }
  if (form.dataset.settingsCoin) {
    event.preventDefault(); event.stopImmediatePropagation();
    const coinId = form.dataset.settingsCoin; const previousCoins = [...state.coins]; const previousRigs = [...state.rigs]; const oldCoin = state.coins.find((coin) => String(coin.id) === String(coinId)); const nextCoin = { ...oldCoin, name: String(raw.name).trim().toUpperCase(), price_usd: Number(raw.price_usd) };
    state.coins = state.coins.map((coin) => String(coin.id) === String(coinId) ? nextCoin : coin); state.rigs = state.rigs.map((rig) => rig.coin && rig.coin.toLowerCase() === oldCoin.name.toLowerCase() ? { ...rig, coin: nextCoin.name } : rig);
    closeModal(modalRoot); renderDashboard(); toast('Курс обновлён');
    request(`/coins/${coinId}`, { method: 'PUT', body: JSON.stringify({ name: nextCoin.name, price_usd: nextCoin.price_usd }) }).then(saveCache).catch((error) => { state.coins = previousCoins; state.rigs = previousRigs; renderDashboard(); toast(`Курс не сохранён: ${error.message}`, 'error'); });
    return;
  }
  if (form.dataset.rigConfig) {
    event.preventDefault(); event.stopImmediatePropagation();
    const rigId = form.dataset.rigConfig; const previousRigs = [...state.rigs];
    const nextRig = { ...state.rigs.find((rig) => String(rig.id) === String(rigId)), coin: String(raw.coin).trim().toUpperCase(), coin_per_day: Number(raw.coin_per_day), electricity_cost: Number(raw.electricity_cost), working_days: Number(raw.working_days), weekend_days: Number(raw.weekend_days), calculation_mode: String(raw.calculation_mode) };
    state.rigs = state.rigs.map((rig) => String(rig.id) === String(rigId) ? nextRig : rig);
    closeModal(modalRoot); renderDashboard(); toast('Конфигурация сохранена');
    request(`/rigs/${rigId}/config`, { method: 'PATCH', body: JSON.stringify({ coin: nextRig.coin, coin_per_day: nextRig.coin_per_day, electricity_cost: nextRig.electricity_cost, working_days: nextRig.working_days, weekend_days: nextRig.weekend_days, calculation_mode: nextRig.calculation_mode }) }).then((saved) => {
      state.rigs = state.rigs.map((rig) => String(rig.id) === String(rigId) ? saved : rig); renderAndCache();
    }).catch((error) => { state.rigs = previousRigs; renderDashboard(); toast(`Конфигурация не сохранена: ${error.message}`, 'error'); });
    return;
  }
  if (form.id === 'rig-rename-form') {
    event.preventDefault(); event.stopImmediatePropagation();
    const rigId = Number(form.dataset.rigId); const name = String(raw.name || '').trim(); if (!name) return;
    const previousRigs = [...state.rigs];
    state.rigs = state.rigs.map((rig) => rig.id === rigId ? { ...rig, name } : rig);
    closeModal(modalRoot); renderDashboard(); toast('Риг переименован');
    request(`/rigs/${rigId}`, { method: 'PATCH', body: JSON.stringify({ name }) }).then((saved) => {
      state.rigs = state.rigs.map((rig) => rig.id === rigId ? saved : rig); renderAndCache();
    }).catch((error) => { state.rigs = previousRigs; renderDashboard(); toast(`Не удалось переименовать: ${error.message}`, 'error'); });
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
      state.selectedRigId = saved.id; state.cards = state.cardsByRig[saved.id]; renderAndCache();
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
  request(`/coins/${coinId}`, { method: 'DELETE' }).then(saveCache).catch((error) => { state.coins = previousCoins; renderDashboard(); toast(`Монета не удалена: ${error.message}`, 'error'); });
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
  if (cached?.user) {
    // Восстанавливаем только пользовательские данные — token/theme не трогаем:
    // они могли обновиться с момента сохранения кэша.
    state.user = cached.user; state.coins = cached.coins || []; state.rigs = cached.rigs || [];
    state.cardsByRig = cached.cardsByRig || {};
    state.selectedRigId = cached.selectedRigId;
    if (!state.rigs.some((rig) => String(rig.id) === String(state.selectedRigId))) state.selectedRigId = state.rigs[0]?.id || null;
    // КЛЮЧЕВАЯ правка: без этого state.cards оставался [] и GPU пропадали из
    // выбранного рига до следующего refresh()/переключения рига.
    state.cards = state.cardsByRig[state.selectedRigId] || [];
    renderDashboard();
  } else { renderSkeleton(); }
  try {
    await refresh();
  } catch (error) {
    toast(error.message, 'error');
    if (!state.user) {
      app.innerHTML = `<section class="page-enter flex min-h-screen items-center justify-center p-6 text-center"><div><p class="mb-4 text-slate-500">Не удалось загрузить данные.</p><button id="retry" class="btn btn-accent">Повторить</button></div></section>`;
      document.querySelector('#retry').onclick = init;
    }
  }
}
init();
