# Мой корч

Личный PWA-калькулятор майнинг-фермы. Считает добычу, расходы на свет и чистый профит по каждому ригу с учётом графика работы (рабочие/выходные сутки). Устанавливается на телефон и десктоп, работает оффлайн благодаря service worker.

**Стек:** FastAPI · PostgreSQL · vanilla JS · Tailwind (через CDN) · PWA.

---

## Возможности

- 👤 Аккаунты с PBKDF2-хэшами и JWT (HS256, TTL 14 дней)
- 🖥️ Несколько ригов на аккаунт, переименование одной кнопкой
- 🎛️ Конфигурация рига: монета, добыча/сутки, тариф за кВт·ч, длительность рабочей/выходной смены, режим расчёта
- 🪙 Свой справочник монет с курсом в USD
- 📊 Итоги по ферме и по ригу: dirty income, розетка, чистый профит за 24 ч
- ⚡ Optimistic UI — все правки видны мгновенно, фоновая сверка с сервером
- 🌗 Тёмная/светлая тема без пересборки экрана
- 📴 Оффлайн-кэш последнего известного состояния (localStorage + Cache Storage)

## Запуск

### Песочница: локально / в локальной сети, **без Postgres** (SQLite)

Для тестов и доступа с телефона в домашней сети backend поддерживает SQLite-режим. Запустите один из скриптов:

```bat
:: Windows — двойной клик по start-lan.bat или из консоли:
start-lan.bat

:: Linux / macOS / Git Bash:
bash start-lan.sh
```

Скрипт:
- создаёт `.venv` и один раз ставит зависимости (нужен интернет);
- автоматически определяет IP этой машины в локальной сети;
- (Windows) первым запуском добавляет правило firewall для порта 8000;
- запускает `uvicorn --host 0.0.0.0:8000` с `DATABASE_URL=sqlite:///korch-local.db`.

В консоли будут два адреса:
- `http://127.0.0.1:8000` — открыть на этом ПК;
- `http://192.168.x.x:8000` — открыть с телефона/планшета в той же Wi-Fi.

Остановить — `Ctrl+C`. Чтобы вместо SQLite использовать свой Postgres локально — в `start-lan.bat`/`start-lan.sh` замените `DATABASE_URL` на свой URL.

> **Прод / Vercel:** SQLite-ветка активируется **только** если `DATABASE_URL` явно начинается с `sqlite:///`. Оставьте `DATABASE_URL` пустым/`postgresql://...` и прод работает через PostgreSQL как раньше.

### Классический запуск (через ваш Postgres)

```bash
docker compose up -d    # Postgres + backend, порт 8000
# или
uvicorn backend.main:app --reload   # DATABASE_URL=postgresql://... (через .env или переменную окружения)
```

## Деплой на Vercel + облачный Postgres

1. Заведите Postgres на Neon/Supabase и скопируйте `DATABASE_URL` (с `sslmode=require`).
2. Запушьте репозиторий в GitHub и импортируйте его в Vercel — он сам подцепит `vercel.json` и `api/index.py`.
3. В **Environment Variables** задайте:
   - `DATABASE_URL`
   - `KORCH_JWT_SECRET` — длинная случайная строка (`openssl rand -hex 32`). Без неё в логах будет предупреждение, а токены подпишутся публичным секретом из кода.
4. Deploy. Таблицы создаются при старте, миграции из старых схем выполняются автоматически.

## Деплой на VPS (Docker Compose)

```bash
git clone <repo> korch && cd korch
openssl rand -hex 32          # подставьте в KORCH_JWT_SECRET внутри docker-compose.yml
docker compose up -d --build
```

Compose поднимает `korch` (FastAPI + статика, порт 8000) и `postgres:16-alpine`. Откройте наружу только 8000, Postgres оставьте внутренним. Для HTTPS и PWA поставьте Caddy/Nginx и проксируйте домен на `127.0.0.1:8000`.

## Формулы

- `total_hashrate = Σ (hashrate × quantity)` по всем картам рига
- `total_power    = Σ (power × quantity)`
- `income_per_mhs = avg_daily_yield ÷ total_hashrate` — считается автоматически
- `gross          = total_hashrate × income_per_mhs × coin_price`
- `electricity    = total_power / 1000 × 24 × tariff`
- `profit         = gross − electricity`

Раздел «Время»: рабочая смена **18 ч**, выходная **24 ч**. `avg_daily_yield` считается по циклу `working_days + weekend_days` с учётом выбранного `calculation_mode` (подробности с формулами — в шапке `frontend/app.js`).

## Безопасность

- Пароли — PBKDF2-SHA256, 210 000 итераций, соль на пользователя
- JWT — явный `alg=HS256`, проверка подписи и `exp` на каждый запрос
- Rate-limit: 10 попыток за 5 минут на пару (IP, логин) для `/auth/login` и `/auth/register`
- Все SQL-запросы параметризованы через psycopg
- HTML-экранирование всех пользовательских строк в шаблонах; заголовки модалок вставляются через `textContent`

## Структура

```
.
├── api/index.py          # Точка входа для Vercel Functions
├── backend/main.py       # FastAPI: auth, rigs, coins, cards
├── frontend/
│   ├── index.html
│   ├── app.js            # SPA + optimistic UI + формулы
│   ├── styles.css        # Анимации, тосты, модалки, тема
│   ├── sw.js             # Network-first service worker
│   ├── manifest.json     # PWA
│   └── icon.svg
├── Dockerfile            # python:3.12-slim + uvicorn
├── docker-compose.yml    # app + postgres
├── requirements.txt
└── vercel.json           # rewrites /api/* → serverless, остальное → frontend
```
