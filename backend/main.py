"""Мой корч API — FastAPI + PostgreSQL, совместимый с Vercel Functions."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Generator

import psycopg
from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from psycopg.rows import dict_row

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
DATABASE_URL = os.getenv("DATABASE_URL") or os.getenv("POSTGRES_URL")
JWT_SECRET = os.getenv("KORCH_JWT_SECRET", "change-this-secret-before-public-deployment")
JWT_TTL_SECONDS = 60 * 60 * 24 * 14

if not DATABASE_URL:
    # Fail at request/startup time with an actionable message instead of silently
    # creating a local database that would disappear between Vercel invocations.
    DATABASE_URL = ""


@contextmanager
def database() -> Generator[psycopg.Connection[Any], None, None]:
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL не задан. Добавьте строку подключения PostgreSQL в переменные окружения Vercel.")
    connection = psycopg.connect(DATABASE_URL, row_factory=dict_row)
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def initialize_database() -> None:
    with database() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id BIGSERIAL PRIMARY KEY,
                username TEXT NOT NULL UNIQUE,
                hashed_password TEXT NOT NULL,
                electricity_cost DOUBLE PRECISION NOT NULL DEFAULT 0.1 CHECK (electricity_cost >= 0)
            );
            CREATE TABLE IF NOT EXISTS rigs (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL
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
                coin TEXT NOT NULL,
                income_per_mhs DOUBLE PRECISION NOT NULL CHECK (income_per_mhs >= 0),
                quantity INTEGER NOT NULL CHECK (quantity > 0),
                hashrate DOUBLE PRECISION NOT NULL CHECK (hashrate >= 0),
                power INTEGER NOT NULL CHECK (power >= 0)
            );
            CREATE INDEX IF NOT EXISTS idx_rigs_user ON rigs(user_id);
            CREATE INDEX IF NOT EXISTS idx_coins_user ON coins(user_id);
            CREATE INDEX IF NOT EXISTS idx_cards_user_rig ON cards(user_id, rig_id);
            """
        )


def password_hash(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    iterations = 210_000
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    return f"pbkdf2_sha256${iterations}${base64.urlsafe_b64encode(salt).decode()}${base64.urlsafe_b64encode(digest).decode()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, raw_iterations, raw_salt, raw_digest = encoded.split("$")
        if algorithm != "pbkdf2_sha256":
            return False
        salt = base64.urlsafe_b64decode(raw_salt)
        expected = base64.urlsafe_b64decode(raw_digest)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, int(raw_iterations))
        return hmac.compare_digest(actual, expected)
    except (TypeError, ValueError):
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


class ElectricityUpdate(BaseModel):
    electricity_cost: float = Field(ge=0, le=100)


class RigInput(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class CoinInput(BaseModel):
    name: str = Field(min_length=1, max_length=30)
    price_usd: float = Field(ge=0, le=1000000000)


class CardInput(BaseModel):
    rig_id: int
    model: str = Field(min_length=1, max_length=80)
    coin: str = Field(min_length=1, max_length=30)
    income_per_mhs: float = Field(ge=0, le=1000000)
    quantity: int = Field(ge=1, le=100000)
    hashrate: float = Field(ge=0, le=100000000)
    power: int = Field(ge=0, le=10000000)


app = FastAPI(title="Мой корч API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False, allow_methods=["*"], allow_headers=["*"])


@app.on_event("startup")
def startup() -> None:
    if DATABASE_URL:
        initialize_database()


def authorized_user(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Требуется авторизация")
    claims = decode_token(authorization[7:])
    with database() as connection:
        user = connection.execute("SELECT id, username, electricity_cost FROM users WHERE id = %s", (claims["sub"],)).fetchone()
    if user is None:
        raise HTTPException(status_code=401, detail="Пользователь не найден")
    return user


def user_payload(user: dict[str, Any]) -> dict[str, Any]:
    return {"id": user["id"], "username": user["username"], "electricity_cost": user["electricity_cost"]}


@app.post("/api/auth/register", status_code=status.HTTP_201_CREATED)
def register(credentials: Credentials) -> dict[str, Any]:
    username = credentials.username.strip()
    try:
        with database() as connection:
            user = connection.execute("INSERT INTO users(username, hashed_password) VALUES (%s, %s) RETURNING id, username, electricity_cost", (username, password_hash(credentials.password))).fetchone()
            connection.execute("INSERT INTO rigs(user_id, name) VALUES (%s, %s)", (user["id"], "Мой риг"))
            connection.execute("INSERT INTO coins(user_id, name, price_usd) VALUES (%s, %s, %s)", (user["id"], "QTC", 0.39))
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="Этот логин уже занят")
    return {"token": create_token(user["id"], user["username"]), "user": user_payload(user)}


@app.post("/api/auth/login")
def login(credentials: Credentials) -> dict[str, Any]:
    with database() as connection:
        user = connection.execute("SELECT * FROM users WHERE username = %s", (credentials.username.strip(),)).fetchone()
    if user is None or not verify_password(credentials.password, user["hashed_password"]):
        raise HTTPException(status_code=401, detail="Неверный логин или пароль")
    return {"token": create_token(user["id"], user["username"]), "user": user_payload(user)}


@app.get("/api/me")
def get_me(user: dict[str, Any] = Depends(authorized_user)) -> dict[str, Any]:
    return user_payload(user)


@app.patch("/api/me/electricity")
def set_electricity(payload: ElectricityUpdate, user: dict[str, Any] = Depends(authorized_user)) -> dict[str, Any]:
    with database() as connection:
        connection.execute("UPDATE users SET electricity_cost = %s WHERE id = %s", (payload.electricity_cost, user["id"]))
    return {"electricity_cost": payload.electricity_cost}


@app.get("/api/rigs")
def list_rigs(user: dict[str, Any] = Depends(authorized_user)) -> list[dict[str, Any]]:
    with database() as connection:
        return list(connection.execute("SELECT id, name FROM rigs WHERE user_id = %s ORDER BY id", (user["id"],)).fetchall())


@app.post("/api/rigs", status_code=status.HTTP_201_CREATED)
def create_rig(payload: RigInput, user: dict[str, Any] = Depends(authorized_user)) -> dict[str, Any]:
    with database() as connection:
        return connection.execute("INSERT INTO rigs(user_id, name) VALUES (%s, %s) RETURNING id, name", (user["id"], payload.name.strip())).fetchone()


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
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="Такая монета уже добавлена")


@app.put("/api/coins/{coin_id}")
def update_coin(coin_id: int, payload: CoinInput, user: dict[str, Any] = Depends(authorized_user)) -> dict[str, Any]:
    name = payload.name.strip().upper()
    try:
        with database() as connection:
            old = connection.execute("SELECT name FROM coins WHERE id = %s AND user_id = %s", (coin_id, user["id"])).fetchone()
            if old is None:
                raise HTTPException(status_code=404, detail="Монета не найдена")
            row = connection.execute("UPDATE coins SET name = %s, price_usd = %s WHERE id = %s AND user_id = %s RETURNING id, name, price_usd", (name, payload.price_usd, coin_id, user["id"])).fetchone()
            connection.execute("UPDATE cards SET coin = %s WHERE user_id = %s AND LOWER(coin) = LOWER(%s)", (name, user["id"], old["name"]))
            return row
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail="Такая монета уже добавлена")


@app.delete("/api/coins/{coin_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_coin(coin_id: int, user: dict[str, Any] = Depends(authorized_user)) -> None:
    with database() as connection:
        coin = connection.execute("SELECT name FROM coins WHERE id = %s AND user_id = %s", (coin_id, user["id"])).fetchone()
        if coin is None:
            raise HTTPException(status_code=404, detail="Монета не найдена")
        if connection.execute("SELECT 1 FROM cards WHERE user_id = %s AND LOWER(coin) = LOWER(%s) LIMIT 1", (user["id"], coin["name"])).fetchone():
            raise HTTPException(status_code=409, detail="Нельзя удалить монету, пока она используется в картах")
        connection.execute("DELETE FROM coins WHERE id = %s AND user_id = %s", (coin_id, user["id"]))


def validate_ownership(connection: psycopg.Connection[Any], rig_id: int, coin: str, user_id: int) -> None:
    if connection.execute("SELECT 1 FROM rigs WHERE id = %s AND user_id = %s", (rig_id, user_id)).fetchone() is None:
        raise HTTPException(status_code=404, detail="Риг не найден")
    if connection.execute("SELECT 1 FROM coins WHERE user_id = %s AND LOWER(name) = LOWER(%s)", (user_id, coin.strip())).fetchone() is None:
        raise HTTPException(status_code=422, detail="Сначала добавьте эту монету в настройках")


CARD_FIELDS = "id, rig_id, model, coin, income_per_mhs, quantity, hashrate, power"


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
        validate_ownership(connection, data["rig_id"], data["coin"], user["id"])
        return connection.execute(f"INSERT INTO cards(user_id, rig_id, model, coin, income_per_mhs, quantity, hashrate, power) VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING {CARD_FIELDS}", (user["id"], data["rig_id"], data["model"], data["coin"].strip().upper(), data["income_per_mhs"], data["quantity"], data["hashrate"], data["power"])).fetchone()


@app.put("/api/cards/{card_id}")
def update_card(card_id: int, payload: CardInput, user: dict[str, Any] = Depends(authorized_user)) -> dict[str, Any]:
    data = payload.model_dump()
    with database() as connection:
        validate_ownership(connection, data["rig_id"], data["coin"], user["id"])
        row = connection.execute(f"UPDATE cards SET rig_id=%s, model=%s, coin=%s, income_per_mhs=%s, quantity=%s, hashrate=%s, power=%s WHERE id=%s AND user_id=%s RETURNING {CARD_FIELDS}", (data["rig_id"], data["model"], data["coin"].strip().upper(), data["income_per_mhs"], data["quantity"], data["hashrate"], data["power"], card_id, user["id"])).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Карта не найдена")
        return row


@app.delete("/api/cards/{card_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_card(card_id: int, user: dict[str, Any] = Depends(authorized_user)) -> None:
    with database() as connection:
        if connection.execute("DELETE FROM cards WHERE id = %s AND user_id = %s", (card_id, user["id"])).rowcount == 0:
            raise HTTPException(status_code=404, detail="Карта не найдена")


app.mount("/assets", StaticFiles(directory=FRONTEND_DIR), name="assets")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/{file_name}")
def frontend_file(file_name: str) -> FileResponse:
    allowed = {"index.html", "app.js", "styles.css", "manifest.json", "sw.js", "icon.svg"}
    if file_name not in allowed:
        raise HTTPException(status_code=404, detail="Файл не найден")
    return FileResponse(FRONTEND_DIR / file_name)
