"""API and static host for the 'Мой корч' mining calculator."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Generator

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
DATABASE_PATH = Path(os.getenv("KORCH_DATABASE", BASE_DIR / "backend" / "korch.db"))
JWT_SECRET = os.getenv("KORCH_JWT_SECRET", "change-this-secret-before-public-deployment")
JWT_TTL_SECONDS = 60 * 60 * 24 * 14
DEFAULT_ELECTRICITY_COST = 0.1


@contextmanager
def database() -> Generator[sqlite3.Connection, None, None]:
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
        connection.commit()
    finally:
        connection.close()


def initialize_database() -> None:
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with database() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                hashed_password TEXT NOT NULL,
                electricity_cost REAL NOT NULL DEFAULT 0.1 CHECK(electricity_cost >= 0)
            );
            CREATE TABLE IF NOT EXISTS rigs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS cards (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                rig_id INTEGER NOT NULL,
                model TEXT NOT NULL,
                coin TEXT NOT NULL,
                income_per_mhs REAL NOT NULL CHECK(income_per_mhs >= 0),
                quantity INTEGER NOT NULL CHECK(quantity > 0),
                hashrate REAL NOT NULL CHECK(hashrate >= 0),
                power INTEGER NOT NULL CHECK(power >= 0),
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY(rig_id) REFERENCES rigs(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS coins (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                price_usd REAL NOT NULL CHECK(price_usd >= 0),
                UNIQUE(user_id, name COLLATE NOCASE),
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS app_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_rigs_user ON rigs(user_id);
            CREATE INDEX IF NOT EXISTS idx_cards_user_rig ON cards(user_id, rig_id);
            CREATE INDEX IF NOT EXISTS idx_coins_user ON coins(user_id);
            """
        )
        # Existing accounts receive the QTC rate from the supplied worksheet.
        connection.execute("INSERT OR IGNORE INTO coins(user_id, name, price_usd) SELECT id, 'QTC', 0.39 FROM users")
        # Version 1 stored USD/MH/s in cards. The new model stores coins/MH/s,
        # with the USD rate owned by the coin itself; migrate existing QTC rows once.
        if connection.execute("SELECT 1 FROM app_meta WHERE key = 'coin_rate_model_v2'").fetchone() is None:
            connection.execute("UPDATE cards SET income_per_mhs = income_per_mhs / 0.39 WHERE coin = 'QTC' COLLATE NOCASE")
            connection.execute("INSERT INTO app_meta(key, value) VALUES ('coin_rate_model_v2', '1')")


def password_hash(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    iterations = 210_000
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return f"pbkdf2_sha256${iterations}${base64.urlsafe_b64encode(salt).decode()}${base64.urlsafe_b64encode(digest).decode()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, raw_iterations, raw_salt, raw_digest = encoded.split("$")
        if algorithm != "pbkdf2_sha256":
            return False
        salt = base64.urlsafe_b64decode(raw_salt.encode())
        expected = base64.urlsafe_b64decode(raw_digest.encode())
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(raw_iterations))
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


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
            raise ValueError("Bad signature")
        claims = json.loads(b64url_decode(payload))
        if not isinstance(claims.get("sub"), int) or claims.get("exp", 0) < time.time():
            raise ValueError("Expired or invalid token")
        return claims
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Недействительный или истёкший токен")


class Credentials(BaseModel):
    username: str = Field(min_length=3, max_length=32, pattern=r"^[\w.-]+$")
    password: str = Field(min_length=6, max_length=128)


class ElectricityUpdate(BaseModel):
    electricity_cost: float = Field(ge=0, le=100)


class RigInput(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class CardInput(BaseModel):
    rig_id: int
    model: str = Field(min_length=1, max_length=80)
    coin: str = Field(min_length=1, max_length=30)
    income_per_mhs: float = Field(ge=0, le=1000000)
    quantity: int = Field(ge=1, le=100000)
    hashrate: float = Field(ge=0, le=100000000)
    power: int = Field(ge=0, le=10000000)


class CoinInput(BaseModel):
    name: str = Field(min_length=1, max_length=30)
    price_usd: float = Field(ge=0, le=1000000000)


app = FastAPI(title="Мой корч API")
# Вместо allow_origin_regex используем точный список разрешенных адресов
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5500",
        "http://127.0.0.1:5500",
        "http://192.168.0.100:5500"  # Добавьте сюда IP вашего компьютера
    ],
    allow_credentials=True,          # Оставляем True, это важно для токенов
    allow_methods=["*"],
    allow_headers=["*"],
)



@app.on_event("startup")
def startup() -> None:
    initialize_database()


from fastapi import Header  # noqa: E402


def authorized_user(authorization: str | None = Header(default=None)) -> sqlite3.Row:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Требуется авторизация")
    claims = decode_token(authorization[7:])
    with database() as connection:
        user = connection.execute("SELECT id, username, electricity_cost FROM users WHERE id = ?", (claims["sub"],)).fetchone()
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Пользователь не найден")
    return user


def user_payload(user: sqlite3.Row) -> dict[str, Any]:
    return {"id": user["id"], "username": user["username"], "electricity_cost": user["electricity_cost"]}


@app.post("/api/auth/register", status_code=status.HTTP_201_CREATED)
def register(credentials: Credentials) -> dict[str, Any]:
    username = credentials.username.strip()
    if len(username) < 3:
        raise HTTPException(status_code=422, detail="Логин должен содержать не менее 3 символов")
    try:
        with database() as connection:
            cursor = connection.execute("INSERT INTO users(username, hashed_password) VALUES (?, ?)", (username, password_hash(credentials.password)))
            user_id = cursor.lastrowid
            connection.execute("INSERT INTO rigs(user_id, name) VALUES (?, ?)", (user_id, "Мой риг"))
            connection.execute("INSERT INTO coins(user_id, name, price_usd) VALUES (?, ?, ?)", (user_id, "QTC", 0.39))
            user = connection.execute("SELECT id, username, electricity_cost FROM users WHERE id = ?", (user_id,)).fetchone()
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="Этот логин уже занят")
    return {"token": create_token(user_id, username), "user": user_payload(user)}


@app.post("/api/auth/login")
def login(credentials: Credentials) -> dict[str, Any]:
    with database() as connection:
        user = connection.execute("SELECT * FROM users WHERE username = ?", (credentials.username.strip(),)).fetchone()
    if user is None or not verify_password(credentials.password, user["hashed_password"]):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Неверный логин или пароль")
    return {"token": create_token(user["id"], user["username"]), "user": user_payload(user)}


@app.get("/api/me")
def get_me(user: sqlite3.Row = Depends(authorized_user)) -> dict[str, Any]:
    return user_payload(user)


@app.patch("/api/me/electricity")
def set_electricity(payload: ElectricityUpdate, user: sqlite3.Row = Depends(authorized_user)) -> dict[str, Any]:
    with database() as connection:
        connection.execute("UPDATE users SET electricity_cost = ? WHERE id = ?", (payload.electricity_cost, user["id"]))
    return {"electricity_cost": payload.electricity_cost}


@app.get("/api/rigs")
def list_rigs(user: sqlite3.Row = Depends(authorized_user)) -> list[dict[str, Any]]:
    with database() as connection:
        rows = connection.execute("SELECT id, name FROM rigs WHERE user_id = ? ORDER BY id", (user["id"],)).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/rigs", status_code=status.HTTP_201_CREATED)
def create_rig(payload: RigInput, user: sqlite3.Row = Depends(authorized_user)) -> dict[str, Any]:
    with database() as connection:
        cursor = connection.execute("INSERT INTO rigs(user_id, name) VALUES (?, ?)", (user["id"], payload.name.strip()))
    return {"id": cursor.lastrowid, "name": payload.name.strip()}


@app.get("/api/coins")
def list_coins(user: sqlite3.Row = Depends(authorized_user)) -> list[dict[str, Any]]:
    with database() as connection:
        rows = connection.execute("SELECT id, name, price_usd FROM coins WHERE user_id = ? ORDER BY name COLLATE NOCASE", (user["id"],)).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/coins", status_code=status.HTTP_201_CREATED)
def create_coin(payload: CoinInput, user: sqlite3.Row = Depends(authorized_user)) -> dict[str, Any]:
    name = payload.name.strip().upper()
    try:
        with database() as connection:
            cursor = connection.execute("INSERT INTO coins(user_id, name, price_usd) VALUES (?, ?, ?)", (user["id"], name, payload.price_usd))
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="Такая монета уже добавлена")
    return {"id": cursor.lastrowid, "name": name, "price_usd": payload.price_usd}


@app.put("/api/coins/{coin_id}")
def update_coin(coin_id: int, payload: CoinInput, user: sqlite3.Row = Depends(authorized_user)) -> dict[str, Any]:
    name = payload.name.strip().upper()
    try:
        with database() as connection:
            old_coin = connection.execute("SELECT name FROM coins WHERE id = ? AND user_id = ?", (coin_id, user["id"])).fetchone()
            if old_coin is None:
                raise HTTPException(status_code=404, detail="Монета не найдена")
            connection.execute("UPDATE coins SET name = ?, price_usd = ? WHERE id = ? AND user_id = ?", (name, payload.price_usd, coin_id, user["id"]))
            connection.execute("UPDATE cards SET coin = ? WHERE user_id = ? AND coin = ? COLLATE NOCASE", (name, user["id"], old_coin["name"]))
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="Такая монета уже добавлена")
    return {"id": coin_id, "name": name, "price_usd": payload.price_usd}


@app.delete("/api/coins/{coin_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_coin(coin_id: int, user: sqlite3.Row = Depends(authorized_user)) -> None:
    with database() as connection:
        coin = connection.execute("SELECT name FROM coins WHERE id = ? AND user_id = ?", (coin_id, user["id"])).fetchone()
        if coin is None:
            raise HTTPException(status_code=404, detail="Монета не найдена")
        in_use = connection.execute("SELECT 1 FROM cards WHERE user_id = ? AND coin = ? COLLATE NOCASE LIMIT 1", (user["id"], coin["name"])).fetchone()
        if in_use:
            raise HTTPException(status_code=409, detail="Нельзя удалить монету, пока она используется в картах")
        connection.execute("DELETE FROM coins WHERE id = ? AND user_id = ?", (coin_id, user["id"]))


@app.delete("/api/rigs/{rig_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_rig(rig_id: int, user: sqlite3.Row = Depends(authorized_user)) -> None:
    with database() as connection:
        cursor = connection.execute("DELETE FROM rigs WHERE id = ? AND user_id = ?", (rig_id, user["id"]))
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Риг не найден")


def validate_rig(connection: sqlite3.Connection, rig_id: int, user_id: int) -> None:
    if connection.execute("SELECT 1 FROM rigs WHERE id = ? AND user_id = ?", (rig_id, user_id)).fetchone() is None:
        raise HTTPException(status_code=404, detail="Риг не найден")


def validate_coin(connection: sqlite3.Connection, coin: str, user_id: int) -> None:
    if connection.execute("SELECT 1 FROM coins WHERE user_id = ? AND name = ? COLLATE NOCASE", (user_id, coin.strip())).fetchone() is None:
        raise HTTPException(status_code=422, detail="Сначала добавьте эту монету в настройках")


@app.get("/api/rigs/{rig_id}/cards")
def list_cards(rig_id: int, user: sqlite3.Row = Depends(authorized_user)) -> list[dict[str, Any]]:
    with database() as connection:
        validate_rig(connection, rig_id, user["id"])
        rows = connection.execute("SELECT id, rig_id, model, coin, income_per_mhs, quantity, hashrate, power FROM cards WHERE rig_id = ? AND user_id = ? ORDER BY id", (rig_id, user["id"])).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/cards", status_code=status.HTTP_201_CREATED)
def create_card(payload: CardInput, user: sqlite3.Row = Depends(authorized_user)) -> dict[str, Any]:
    data = payload.model_dump()
    with database() as connection:
        validate_rig(connection, data["rig_id"], user["id"])
        validate_coin(connection, data["coin"], user["id"])
        cursor = connection.execute("INSERT INTO cards(user_id, rig_id, model, coin, income_per_mhs, quantity, hashrate, power) VALUES (:user_id, :rig_id, :model, :coin, :income_per_mhs, :quantity, :hashrate, :power)", {**data, "user_id": user["id"]})
        row = connection.execute("SELECT id, rig_id, model, coin, income_per_mhs, quantity, hashrate, power FROM cards WHERE id = ? AND user_id = ?", (cursor.lastrowid, user["id"])).fetchone()
    return dict(row)


@app.put("/api/cards/{card_id}")
def update_card(card_id: int, payload: CardInput, user: sqlite3.Row = Depends(authorized_user)) -> dict[str, Any]:
    data = payload.model_dump()
    with database() as connection:
        validate_rig(connection, data["rig_id"], user["id"])
        validate_coin(connection, data["coin"], user["id"])
        cursor = connection.execute("UPDATE cards SET rig_id=:rig_id, model=:model, coin=:coin, income_per_mhs=:income_per_mhs, quantity=:quantity, hashrate=:hashrate, power=:power WHERE id=:id AND user_id=:user_id", {**data, "id": card_id, "user_id": user["id"]})
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Карта не найдена")
        row = connection.execute("SELECT id, rig_id, model, coin, income_per_mhs, quantity, hashrate, power FROM cards WHERE id = ? AND user_id = ?", (card_id, user["id"])).fetchone()
    return dict(row)


@app.delete("/api/cards/{card_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_card(card_id: int, user: sqlite3.Row = Depends(authorized_user)) -> None:
    with database() as connection:
        cursor = connection.execute("DELETE FROM cards WHERE id = ? AND user_id = ?", (card_id, user["id"]))
    if cursor.rowcount == 0:
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
