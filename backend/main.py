"""Мой корч API — FastAPI + PostgreSQL, совместимый с Vercel Functions."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Generator

import psycopg
from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from psycopg.rows import dict_row

logger = logging.getLogger("korch")


def run(connection, sql: str, params=()):
    """В sqlite-режиме sqlite3 не знает %s-плейсхолдеры psycopg — меняем на ?."""
    if SQLITE_FALLBACK:
        sql = sql.replace("%s", "?")
    return connection.execute(sql, params)


def translate_integrity_error(error: Exception) -> bool:
    """True, если ошибка — нарушение UNIQUE (psycopg или sqlite)."""
    if isinstance(error, psycopg.errors.UniqueViolation):
        return True
    return SQLITE_FALLBACK and "UNIQUE constraint" in str(error)

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
DATABASE_URL = os.getenv("DATABASE_URL") or os.getenv("POSTGRES_URL")
# sqlite:///... включает локальную SQLite-песочницу (игнорирует Postgres). Без DATABASE_URL —
# жёсткая ошибка, чтобы не тратить запросы на проде на битую эфемерную БД.
SQLITE_FALLBACK = DATABASE_URL.startswith("sqlite")
if SQLITE_FALLBACK:
    import sqlite3
    DATABASE_URL = DATABASE_URL.removeprefix("sqlite:///")
else:
    DATABASE_URL = DATABASE_URL or ""
_DEFAULT_JWT_SECRET = "change-this-secret-before-public-deployment"
JWT_SECRET = os.getenv("KORCH_JWT_SECRET", _DEFAULT_JWT_SECRET)
JWT_TTL_SECONDS = 60 * 60 * 24 * 14

if JWT_SECRET == _DEFAULT_JWT_SECRET:
    logger.warning(
        "KORCH_JWT_SECRET не задан — используется встроенный секрет. "
        "Любой, кто видел исходники, может подписать токен за любого пользователя. "
        "Задайте случайный KORCH_JWT_SECRET в переменных окружения."
    )

if not SQLITE_FALLBACK and not DATABASE_URL:
    # Fail at request/startup time with an actionable message instead of silently
    # creating a local database that would disappear between Vercel invocations.
    DATABASE_URL = ""


# Пул вместо нового TCP-коннекта на каждый запрос: без него каждый из вызовов
# database() ниже платил handshake + auth к PostgreSQL, что и давало заметную
# задержку "ответ дб" на каждый клик. Idle-коннекты чистит max_lifetime.
# На Vercel инстансов мало и они живут недолго, поэтому max_size скромный.
from psycopg_pool import ConnectionPool

if SQLITE_FALLBACK:
    _pool = None

    class _Row(dict):
        """dict, который отвечает и по ключу, и по индексу (как psycopg dict_row)."""
        def __init__(self, row: "sqlite3.Row"):
            super().__init__({k: row[k] for k in row.keys()})

        def __getitem__(self, key):
            if isinstance(key, int):
                return list(self.values())[key]
            return super().__getitem__(key)

    class _SqliteCursorWrapper:
        def __init__(self, cursor: "sqlite3.Cursor"):
            self._cursor = cursor

        def fetchone(self):
            row = self._cursor.fetchone()
            return _Row(row) if row else None

        def fetchall(self):
            return [_Row(r) for r in self._cursor.fetchall()]

        @property
        def rowcount(self):
            return self._cursor.rowcount

        @property
        def lastrowid(self):
            return self._cursor.lastrowid

    class _SqliteConnectionWrapper:
        def __init__(self, raw: "sqlite3.Connection"):
            self._raw = raw

        def execute(self, sql: str, params=()):
            return _SqliteCursorWrapper(self._raw.execute(sql.replace("%s", "?"), tuple(params)))

        def commit(self):
            self._raw.commit()

        def rollback(self):
            self._raw.rollback()

        def close(self):
            self._raw.close()

    @contextmanager
    def database():
        raw = sqlite3.connect(DATABASE_URL, check_same_thread=False)
        raw.row_factory = sqlite3.Row
        connection = _SqliteConnectionWrapper(raw)
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()
else:
    _pool: ConnectionPool | None = None

    def connection_pool() -> ConnectionPool:
        global _pool
        if _pool is None:
            if not DATABASE_URL:
                raise RuntimeError("DATABASE_URL не задан. Добавьте строку подключения PostgreSQL в переменные окружения Vercel.")
            _pool = ConnectionPool(DATABASE_URL, min_size=0, max_size=5, max_lifetime=300, kwargs={"row_factory": dict_row})
        return _pool

    @contextmanager
    def database() -> Generator[psycopg.Connection[Any], None, None]:
        with connection_pool().connection() as connection:
            try:
                yield connection
                connection.commit()
            except Exception:
                connection.rollback()
                raise


def initialize_database() -> None:
    with database() as connection:
        if SQLITE_FALLBACK:
            # SQLite не умеет точную схему Postgres — под песочницу свой DDL.
            for ddl in (
                "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, hashed_password TEXT NOT NULL)",
                """CREATE TABLE IF NOT EXISTS rigs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    coin TEXT NOT NULL DEFAULT '',
                    coin_per_day REAL NOT NULL DEFAULT 0 CHECK (coin_per_day >= 0),
                    electricity_cost REAL NOT NULL DEFAULT 0.1 CHECK (electricity_cost >= 0),
                    working_days INTEGER NOT NULL DEFAULT 5,
                    weekend_days INTEGER NOT NULL DEFAULT 2,
                    calculation_mode TEXT NOT NULL DEFAULT 'working_days'
                )""",
                "CREATE TABLE IF NOT EXISTS coins (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, price_usd REAL NOT NULL CHECK (price_usd >= 0), UNIQUE (user_id, name))",
                "CREATE TABLE IF NOT EXISTS cards (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, rig_id INTEGER NOT NULL REFERENCES rigs(id) ON DELETE CASCADE, model TEXT NOT NULL, quantity INTEGER NOT NULL CHECK (quantity > 0), hashrate REAL NOT NULL CHECK (hashrate >= 0), power INTEGER NOT NULL CHECK (power >= 0))",
                "PRAGMA foreign_keys = ON",
            ):
                connection.execute(ddl.replace("%s", "?"))
            return
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id BIGSERIAL PRIMARY KEY,
                username TEXT NOT NULL UNIQUE,
                hashed_password TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS rigs (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                coin TEXT NOT NULL DEFAULT '',
                coin_per_day DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (coin_per_day >= 0),
                electricity_cost DOUBLE PRECISION NOT NULL DEFAULT 0.1 CHECK (electricity_cost >= 0)
            );
            CREATE TABLE IF NOT EXISTS coins (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                price_usd DOUBLE PRECISION NOT NULL CHECK (price_usd >= 0),
                UNIQUE (user_id, name)
            );
            CREATE TABLE IF NOT EXISTS cards (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                rig_id BIGINT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
                model TEXT NOT NULL,
                quantity INTEGER NOT NULL CHECK (quantity > 0),
                hashrate DOUBLE PRECISION NOT NULL CHECK (hashrate >= 0),
                power INTEGER NOT NULL CHECK (power >= 0)
            );
            CREATE INDEX IF NOT EXISTS idx_rigs_user ON rigs(user_id);
            CREATE INDEX IF NOT EXISTS idx_coins_user ON coins(user_id);
            CREATE INDEX IF NOT EXISTS idx_cards_user_rig ON cards(user_id, rig_id);

            -- Миграция со старой схемы: тариф на свет был общим для юзера, монета и
            -- добыча/MHs были полями карты. Теперь это конфигурация рига целиком.
            ALTER TABLE rigs ADD COLUMN IF NOT EXISTS coin TEXT NOT NULL DEFAULT '';
            ALTER TABLE rigs ADD COLUMN IF NOT EXISTS coin_per_day DOUBLE PRECISION NOT NULL DEFAULT 0;
            ALTER TABLE rigs ADD COLUMN IF NOT EXISTS electricity_cost DOUBLE PRECISION NOT NULL DEFAULT 0.1;
            -- Раздел конфигурации "Время": сколько рабочих суток (working_day_duration = 18ч
            -- каждая) и выходных суток (weekend_day_duration = 24ч каждая) в цикле, и какой
            -- calculation_mode использовать — итоговое avg_daily_yield (средняя добыча монеты
            -- в сутки) считается в app.js (см. avgDailyYield) и используется во всех формулах
            -- дохода/профита вместо "сырого" coin_per_day.
            ALTER TABLE rigs ADD COLUMN IF NOT EXISTS working_days INTEGER NOT NULL DEFAULT 5;
            ALTER TABLE rigs ADD COLUMN IF NOT EXISTS weekend_days INTEGER NOT NULL DEFAULT 2;
            ALTER TABLE rigs ADD COLUMN IF NOT EXISTS calculation_mode TEXT NOT NULL DEFAULT 'working_days';
            -- Миграция со старой схемы work_days/rest_days/time_basis на новую (см. выше).
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'rigs' AND column_name = 'work_days') THEN
                    UPDATE rigs SET working_days = work_days, weekend_days = rest_days,
                        calculation_mode = CASE WHEN time_basis = 'rest' THEN 'weekend_days' ELSE 'working_days' END;
                    ALTER TABLE rigs DROP COLUMN work_days;
                    ALTER TABLE rigs DROP COLUMN rest_days;
                    ALTER TABLE rigs DROP COLUMN time_basis;
                END IF;
            END $$;
            ALTER TABLE cards DROP COLUMN IF EXISTS coin;
            ALTER TABLE cards DROP COLUMN IF EXISTS income_per_mhs;
            ALTER TABLE users DROP COLUMN IF EXISTS electricity_cost;
            """
        )


def password_hash(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    iterations = 210_000
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    return f"pbkdf2_sha256${iterations}${base64.urlsafe_b64encode(salt).decode()}${base64.urlsafe_b64encode(digest).decode()}"


def verify_password(password: str, encoded: str) -> bool:
    # Любая ошибка разбора (включая binascii.Error от b64decode на мусорных
    # данных) трактуется как «пароль не совпал», а не падает с 500.
    try:
        algorithm, raw_iterations, raw_salt, raw_digest = encoded.split("$")
        if algorithm != "pbkdf2_sha256":
            return False
        salt = base64.urlsafe_b64decode(raw_salt)
        expected = base64.urlsafe_b64decode(raw_digest)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, int(raw_iterations))
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


def b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def create_token(user_id: int, username: str) -> str:
    header = b64url_encode(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = b64url_encode(json.dumps({"sub": user_id, "username": username, "exp": int(time.time()) + JWT_TTL_SECONDS}, separators=(",", ":")).encode())
    signature = b64url_encode(hmac.new(JWT_SECRET.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest())
    return f"{header}.{payload}.{signature}"


def decode_token(token: str) -> dict[str, Any]:
    try:
        header, payload, signature = token.split(".")
        # Явно проверяем alg: токены с другим алгоритмом отвергаем сразу,
        # чтобы проверка подписи не зависела от содержимого заголовка.
        header_claims = json.loads(b64url_decode(header))
        if header_claims.get("alg") != "HS256":
            raise ValueError("alg")
        expected = b64url_encode(hmac.new(JWT_SECRET.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(signature, expected):
            raise ValueError("signature")
        claims = json.loads(b64url_decode(payload))
        if not isinstance(claims.get("sub"), int) or claims.get("exp", 0) < time.time():
            raise ValueError("expired")
        return claims
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        raise HTTPException(status_code=401, detail="Недействительный или истёкший токен")


class Credentials(BaseModel):
    username: str = Field(min_length=3, max_length=32, pattern=r"^[\w.-]+$")
    password: str = Field(min_length=6, max_length=128)


class ChangePasswordInput(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=6, max_length=128)


class ResetPasswordInput(BaseModel):
    username: str = Field(min_length=3, max_length=32, pattern=r"^[\w.-]+$")


class RigInput(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class RigConfigInput(BaseModel):
    coin: str = Field(min_length=1, max_length=30)
    coin_per_day: float = Field(ge=0, le=1000000)
    electricity_cost: float = Field(ge=0, le=100)
    # Раздел "Время": working_day_duration = 18ч, weekend_day_duration = 24ч (фиксированные
    # константы, см. app.js). working_days/weekend_days — сколько таких суток в цикле;
    # calculation_mode — какой режим расчёта avg_daily_yield использовать.
    working_days: int = Field(ge=0, le=31)
    weekend_days: int = Field(ge=0, le=31)
    calculation_mode: str = Field(pattern=r"^(working_days|weekend_days)$")


class CoinInput(BaseModel):
    name: str = Field(min_length=1, max_length=30)
    price_usd: float = Field(ge=0, le=1000000000)


class CardInput(BaseModel):
    rig_id: int
    model: str = Field(min_length=1, max_length=80)
    quantity: int = Field(ge=1, le=100000)
    hashrate: float = Field(ge=0, le=100000000)
    power: int = Field(ge=0, le=10000000)


app = FastAPI(title="Мой корч API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False, allow_methods=["*"], allow_headers=["*"])


# --- Простой rate-limiting для auth-эндпоинтов ---------------------------------
# In-memory скользящее окно по (IP, логин): смягчает онлайн-брутфорс пароля.
# На Vercel каждый инстанс считает своё — это допустимо: лимит тут защита от
# наивного перебора, а не строгая квота.
_AUTH_WINDOW_SECONDS = 300
_AUTH_MAX_ATTEMPTS = 10
_auth_attempts: dict[tuple[str, str], list[float]] = {}
_auth_lock = threading.Lock()


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def enforce_auth_rate_limit(request: Request, username: str) -> None:
    key = (_client_ip(request), username.lower())
    now = time.time()
    with _auth_lock:
        attempts = [t for t in _auth_attempts.get(key, []) if now - t < _AUTH_WINDOW_SECONDS]
        if len(attempts) >= _AUTH_MAX_ATTEMPTS:
            raise HTTPException(status_code=429, detail="Слишком много попыток. Попробуйте через несколько минут.")
        attempts.append(now)
        _auth_attempts[key] = attempts
        # Не даём словарю расти бесконечно.
        if len(_auth_attempts) > 10_000:
            _auth_attempts.clear()


@app.on_event("startup")
def startup() -> None:
    if DATABASE_URL:  # и postgres, и sqlite — инициализация только при явном указании
        initialize_database()


def authorized_user(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Требуется авторизация")
    claims = decode_token(authorization[7:])
    with database() as connection:
        row = run(connection, "SELECT id, username FROM users WHERE id = %s", (claims["sub"],)).fetchone()
        user = dict(row) if row else None
    if user is None:
        raise HTTPException(status_code=401, detail="Пользователь не найден")
    return user


def user_payload(user: dict[str, Any]) -> dict[str, Any]:
    return {"id": user["id"], "username": user["username"]}


@app.post("/api/auth/register", status_code=status.HTTP_201_CREATED)
def register(credentials: Credentials, request: Request) -> dict[str, Any]:
    username = credentials.username.strip()
    enforce_auth_rate_limit(request, username)
    try:
        with database() as connection:
            user = run(connection, "INSERT INTO users(username, hashed_password) VALUES (%s, %s) RETURNING id, username", (username, password_hash(credentials.password))).fetchone()
            run(connection, "INSERT INTO coins(user_id, name, price_usd) VALUES (%s, %s, %s)", (user["id"], "QTC", 0.39))
            # Дефолтные значения повторяют старый пример из Excel: 2.8 монеты в сутки на риг.
            run(connection, "INSERT INTO rigs(user_id, name, coin, coin_per_day, electricity_cost) VALUES (%s, %s, %s, %s, %s)", (user["id"], "Мой риг", "QTC", 2.8, 0.1))
    except Exception as error:
        if translate_integrity_error(error):
            raise HTTPException(status_code=409, detail="Этот логин уже занят")
        raise
    return {"token": create_token(user["id"], user["username"]), "user": user_payload(user)}


@app.post("/api/auth/login")
def login(credentials: Credentials, request: Request) -> dict[str, Any]:
    enforce_auth_rate_limit(request, credentials.username.strip())
    with database() as connection:
        row = run(connection, "SELECT * FROM users WHERE username = %s", (credentials.username.strip(),)).fetchone()
        user = dict(row) if row else None
    if user is None or not verify_password(credentials.password, user["hashed_password"]):
        raise HTTPException(status_code=401, detail="Неверный логин или пароль")
    return {"token": create_token(user["id"], user["username"]), "user": user_payload(user)}


@app.post("/api/auth/change-password")
def change_password(payload: ChangePasswordInput, user: dict[str, Any] = Depends(authorized_user)) -> dict[str, Any]:
    with database() as connection:
        row = run(connection, "SELECT hashed_password FROM users WHERE id = %s", (user["id"],)).fetchone()
        if not row or not verify_password(payload.current_password, row["hashed_password"]):
            raise HTTPException(status_code=401, detail="Текущий пароль неверный")
        run(connection, "UPDATE users SET hashed_password = %s WHERE id = %s", (password_hash(payload.new_password), user["id"]))
    return {"ok": True}


@app.post("/api/auth/reset-password")
def reset_password(payload: ResetPasswordInput, request: Request) -> dict[str, Any]:
    enforce_auth_rate_limit(request, payload.username.strip())
    with database() as connection:
        row = run(connection, "SELECT id FROM users WHERE username = %s", (payload.username.strip(),)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Пользователь с таким логином не найден")
        new_password = secrets.token_urlsafe(9)
        run(connection, "UPDATE users SET hashed_password = %s WHERE id = %s", (password_hash(new_password), row["id"]))
    # Внимание: возвращаем пароль в ответе. Для локального калькулятора это приемлемо,
    # учётка самописная, сброс без email/PIN.
    return {"ok": True, "password": new_password, "username": payload.username.strip()}


@app.get("/api/me")
def get_me(user: dict[str, Any] = Depends(authorized_user)) -> dict[str, Any]:
    return user_payload(user)


RIG_FIELDS = "id, name, coin, coin_per_day, electricity_cost, working_days, weekend_days, calculation_mode"
CARD_FIELDS = "id, rig_id, model, quantity, hashrate, power"


@app.get("/api/bootstrap")
def bootstrap(user: dict[str, Any] = Depends(authorized_user)) -> dict[str, Any]:
    # Всё что нужно дашборду за один round trip: профиль, монеты, риги и карты
    # ВСЕХ ригов одним запросом (раньше фронт делал 3 + N запросов и ждал
    # холодный коннект к БД на каждый). Карты группируются по rig_id на месте.
    with database() as connection:
        coins = [dict(r) for r in run(connection, "SELECT id, name, price_usd FROM coins WHERE user_id = %s ORDER BY name", (user["id"],)).fetchall()]
        rigs = [dict(r) for r in run(connection, f"SELECT {RIG_FIELDS} FROM rigs WHERE user_id = %s ORDER BY id", (user["id"],)).fetchall()]
        cards_by_rig: dict[int, list[dict[str, Any]]] = {}
        if rigs:
            rows = [dict(r) for r in run(
                connection,
                f"SELECT {CARD_FIELDS} FROM cards WHERE user_id = %s ORDER BY id",
                (user["id"],),
            ).fetchall()]
            for card in rows:
                cards_by_rig.setdefault(card["rig_id"], []).append(card)
    return {"user": user_payload(user), "coins": coins, "rigs": rigs, "cardsByRig": {str(rig_id): cards for rig_id, cards in cards_by_rig.items()}}


@app.get("/api/rigs")
def list_rigs(user: dict[str, Any] = Depends(authorized_user)) -> list[dict[str, Any]]:
    with database() as connection:
        return list(connection.execute(f"SELECT {RIG_FIELDS} FROM rigs WHERE user_id = %s ORDER BY id", (user["id"],)).fetchall())


@app.post("/api/rigs", status_code=status.HTTP_201_CREATED)
def create_rig(payload: RigInput, user: dict[str, Any] = Depends(authorized_user)) -> dict[str, Any]:
    with database() as connection:
        return connection.execute(f"INSERT INTO rigs(user_id, name) VALUES (%s, %s) RETURNING {RIG_FIELDS}", (user["id"], payload.name.strip())).fetchone()


@app.patch("/api/rigs/{rig_id}")
def rename_rig(rig_id: int, payload: RigInput, user: dict[str, Any] = Depends(authorized_user)) -> dict[str, Any]:
    with database() as connection:
        row = connection.execute(
            f"UPDATE rigs SET name = %s WHERE id = %s AND user_id = %s RETURNING {RIG_FIELDS}",
            (payload.name.strip(), rig_id, user["id"]),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Риг не найден")
        return row


def validate_coin_ownership(connection: psycopg.Connection[Any], coin: str, user_id: int) -> None:
    if connection.execute("SELECT 1 FROM coins WHERE user_id = %s AND LOWER(name) = LOWER(%s)", (user_id, coin.strip())).fetchone() is None:
        raise HTTPException(status_code=422, detail="Сначала добавьте эту монету в настройках")


@app.patch("/api/rigs/{rig_id}/config")
def update_rig_config(rig_id: int, payload: RigConfigInput, user: dict[str, Any] = Depends(authorized_user)) -> dict[str, Any]:
    coin = payload.coin.strip().upper()
    with database() as connection:
        validate_coin_ownership(connection, coin, user["id"])
        row = connection.execute(
            f"UPDATE rigs SET coin=%s, coin_per_day=%s, electricity_cost=%s, working_days=%s, weekend_days=%s, calculation_mode=%s WHERE id=%s AND user_id=%s RETURNING {RIG_FIELDS}",
            (coin, payload.coin_per_day, payload.electricity_cost, payload.working_days, payload.weekend_days, payload.calculation_mode, rig_id, user["id"]),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Риг не найден")
        return row


@app.delete("/api/rigs/{rig_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_rig(rig_id: int, user: dict[str, Any] = Depends(authorized_user)) -> None:
    with database() as connection:
        result = connection.execute("DELETE FROM rigs WHERE id = %s AND user_id = %s", (rig_id, user["id"]))
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Риг не найден")


@app.get("/api/coins")
def list_coins(user: dict[str, Any] = Depends(authorized_user)) -> list[dict[str, Any]]:
    with database() as connection:
        return list(connection.execute("SELECT id, name, price_usd FROM coins WHERE user_id = %s ORDER BY name", (user["id"],)).fetchall())


@app.post("/api/coins", status_code=status.HTTP_201_CREATED)
def create_coin(payload: CoinInput, user: dict[str, Any] = Depends(authorized_user)) -> dict[str, Any]:
    try:
        with database() as connection:
            return connection.execute("INSERT INTO coins(user_id, name, price_usd) VALUES (%s, %s, %s) RETURNING id, name, price_usd", (user["id"], payload.name.strip().upper(), payload.price_usd)).fetchone()
    except Exception as error:
        if translate_integrity_error(error):
            raise HTTPException(status_code=409, detail="Такая монета уже добавлена")
        raise


@app.put("/api/coins/{coin_id}")
def update_coin(coin_id: int, payload: CoinInput, user: dict[str, Any] = Depends(authorized_user)) -> dict[str, Any]:
    name = payload.name.strip().upper()
    try:
        with database() as connection:
            old = connection.execute("SELECT name FROM coins WHERE id = %s AND user_id = %s", (coin_id, user["id"])).fetchone()
            if old is None:
                raise HTTPException(status_code=404, detail="Монета не найдена")
            row = connection.execute("UPDATE coins SET name = %s, price_usd = %s WHERE id = %s AND user_id = %s RETURNING id, name, price_usd", (name, payload.price_usd, coin_id, user["id"])).fetchone()
            # Курс переименовали — переносим новое имя в риги, которые майнят эту монету.
            connection.execute("UPDATE rigs SET coin = %s WHERE user_id = %s AND LOWER(coin) = LOWER(%s)", (name, user["id"], old["name"]))
            return row
    except Exception as error:
        if translate_integrity_error(error):
            raise HTTPException(status_code=409, detail="Такая монета уже добавлена")
        raise


@app.delete("/api/coins/{coin_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_coin(coin_id: int, user: dict[str, Any] = Depends(authorized_user)) -> None:
    with database() as connection:
        coin = connection.execute("SELECT name FROM coins WHERE id = %s AND user_id = %s", (coin_id, user["id"])).fetchone()
        if coin is None:
            raise HTTPException(status_code=404, detail="Монета не найдена")
        if connection.execute("SELECT 1 FROM rigs WHERE user_id = %s AND LOWER(coin) = LOWER(%s) LIMIT 1", (user["id"], coin["name"])).fetchone():
            raise HTTPException(status_code=409, detail="Нельзя удалить монету, пока она используется в конфигурации рига")
        connection.execute("DELETE FROM coins WHERE id = %s AND user_id = %s", (coin_id, user["id"]))


def validate_rig_ownership(connection: psycopg.Connection[Any], rig_id: int, user_id: int) -> None:
    if connection.execute("SELECT 1 FROM rigs WHERE id = %s AND user_id = %s", (rig_id, user_id)).fetchone() is None:
        raise HTTPException(status_code=404, detail="Риг не найден")


@app.get("/api/rigs/{rig_id}/cards")
def list_cards(rig_id: int, user: dict[str, Any] = Depends(authorized_user)) -> list[dict[str, Any]]:
    with database() as connection:
        if connection.execute("SELECT 1 FROM rigs WHERE id = %s AND user_id = %s", (rig_id, user["id"])).fetchone() is None:
            raise HTTPException(status_code=404, detail="Риг не найден")
        return list(connection.execute(f"SELECT {CARD_FIELDS} FROM cards WHERE rig_id = %s AND user_id = %s ORDER BY id", (rig_id, user["id"])).fetchall())


@app.post("/api/cards", status_code=status.HTTP_201_CREATED)
def create_card(payload: CardInput, user: dict[str, Any] = Depends(authorized_user)) -> dict[str, Any]:
    data = payload.model_dump()
    with database() as connection:
        validate_rig_ownership(connection, data["rig_id"], user["id"])
        return connection.execute(f"INSERT INTO cards(user_id, rig_id, model, quantity, hashrate, power) VALUES (%s, %s, %s, %s, %s, %s) RETURNING {CARD_FIELDS}", (user["id"], data["rig_id"], data["model"], data["quantity"], data["hashrate"], data["power"])).fetchone()


@app.put("/api/cards/{card_id}")
def update_card(card_id: int, payload: CardInput, user: dict[str, Any] = Depends(authorized_user)) -> dict[str, Any]:
    data = payload.model_dump()
    with database() as connection:
        validate_rig_ownership(connection, data["rig_id"], user["id"])
        row = connection.execute(f"UPDATE cards SET rig_id=%s, model=%s, quantity=%s, hashrate=%s, power=%s WHERE id=%s AND user_id=%s RETURNING {CARD_FIELDS}", (data["rig_id"], data["model"], data["quantity"], data["hashrate"], data["power"], card_id, user["id"])).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Карта не найдена")
        return row


@app.delete("/api/cards/{card_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_card(card_id: int, user: dict[str, Any] = Depends(authorized_user)) -> None:
    with database() as connection:
        if connection.execute("DELETE FROM cards WHERE id = %s AND user_id = %s", (card_id, user["id"])).rowcount == 0:
            raise HTTPException(status_code=404, detail="Карта не найдена")


app.mount("/assets", StaticFiles(directory=FRONTEND_DIR), name="assets")


@app.get("/fonts/{file_name}")
def font_file(file_name: str) -> FileResponse:
    """Кастомные шрифты лежат в frontend/fonts — чтобы они грузились и с локального
    FastAPI, и с Vercel (там frontend/ — корень статики)."""
    # Безопасность: блокируем path traversal вида /fonts/../../backend/main.py.
    safe_name = Path(file_name).name
    if safe_name != file_name:
        raise HTTPException(status_code=404, detail="Файл не найден")
    if not file_name.endswith((".ttf", ".woff2", ".otf")):
        raise HTTPException(status_code=404, detail="Файл не найден")
    path = FRONTEND_DIR / "fonts" / file_name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Файл не найден")
    return FileResponse(path)


@app.get("/")
def index() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/{file_name}")
def frontend_file(file_name: str) -> FileResponse:
    allowed = {"index.html", "app.js", "styles.css", "manifest.json", "sw.js", "icon.svg"}
    if file_name not in allowed:
        raise HTTPException(status_code=404, detail="Файл не найден")
    return FileResponse(FRONTEND_DIR / file_name)