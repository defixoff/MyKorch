#!/usr/bin/env bash
# Мой корч — запуск в локальной сети (Linux/macOS/Git Bash на Windows).
set -e
cd "$(dirname "$0")"

echo "============================================"
echo "  Мой корч — сервер в локальной сети"
echo "============================================"
echo

PY=python3; command -v "$PY" >/dev/null 2>&1 || PY=python
command -v "$PY" >/dev/null 2>&1 || { echo "[ОШИБКА] Python 3.11+ не найден"; exit 1; }

# venv в Windows (Git Bash) кладёт бинарники в Scripts/, в Linux — в bin/
if   [ -f ".venv/Scripts/python.exe" ]; then VENV_PY=".venv/Scripts/python.exe"
elif [ -f ".venv/bin/python" ];        then VENV_PY=".venv/bin/python"
else
  echo "[..] Создаю .venv ..."
  "$PY" -m venv .venv
  VENV_PY=$([ -f ".venv/Scripts/python.exe" ] && echo ".venv/Scripts/python.exe" || echo ".venv/bin/python")
fi

"$VENV_PY" -c "import fastapi, uvicorn" 2>/dev/null || {
  echo "[..] Устанавливаю зависимости (один раз, нужен интернет) ..."
  "$VENV_PY" -m pip install -q -r requirements.txt
}

# БАЗА ДАННЫХ: по умолчанию — локальная SQLite. Для «настоящей» PostgreSQL задайте URL ниже (удалив эту строку).
export DATABASE_URL="sqlite:///korch-local.db"

LAN_IP=$("$VENV_PY" -c "import socket;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.connect(('8.8.8.8',80));print(s.getsockname()[0]);s.close()" 2>/dev/null || echo "127.0.0.1")

echo
echo "  Сервер запущен. Адреса:"
echo "    На этом ПК :  http://127.0.0.1:8000"
echo "    В локалке  :  http://$LAN_IP:8000        <- открывайте с телефона/планшета"
echo
echo "  Телефон должен быть в той же Wi-Fi сети. Остановить — Ctrl+C."
echo "============================================"
echo

exec "$VENV_PY" -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
