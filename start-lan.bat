@echo off
setlocal EnableDelayedExpansion
title Moй korч - server v lokаl'noj seti
cd /d "%~dp0"

echo ============================================
echo   Moj korch ^- server v lokal'noj seti
echo ============================================
echo.

:: --- 1. Python ------------------------------------------------------------
where python >nul 2>nul
if errorlevel 1 (
  echo [OSHIbKA] Python ne najden v PATH. Ustanovite Python 3.11+ i povtorite.
  echo           ^(pri ustanovke postav'te galochku "Add python.exe to PATH"^)
  pause & exit /b 1
)

:: --- 2. Virt. okruzhenie i zavisimosti -----------------------------------
if not exist ".venv\Scripts\python.exe" (
  echo [..] Sozdayu .venv ...
  python -m venv .venv || (echo [OSHIbKA] ne udalos' sozdat' venv & pause & exit /b 1)
)
".venv\Scripts\python.exe" -c "import fastapi, uvicorn" >nul 2>nul
if errorlevel 1 (
  echo [..] Ustanavlivayu zavisimosti ^(odin raz, nuzen internet^) ...
  ".venv\Scripts\python.exe" -m pip install -q -r requirements.txt || (echo [OSHIbKA] pip install ne proshel & pause & exit /b 1)
)

:: --- 3. БАЗА ДАННЫХ -------------------------------------------------------
:: По умолчанию — локальная SQLite. На проде (Vercel) PostgreSQL через свою DATABASE_URL.
:: Для своего Postgres локально замените строку ниже на свой URL.
set "DATABASE_URL=sqlite:///korch-local.db"

:: --- 4. IP v lokal'noj seti ----------------------------------------------
set "LAN_IP=127.0.0.1"
for /f "usebackq delims=" %%I in (`".venv\Scripts\python.exe" -c "import socket;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.connect(('8.8.8.8',80));print(s.getsockname()[0]);s.close()" 2^>nul`) do set "LAN_IP=%%I"

:: --- 5. Firewall: odin раз razreshit' port 8000 ---------------------------
netsh advfirewall firewall show rule name="Korch LAN 8000" >nul 2>nul
if errorlevel 1 (
  echo [..] Dobavlyayu pravilo firewall ^(Korch LAN 8000^) ... mogu poprosit' prava administratora
  netsh advfirewall firewall add rule name="Korch LAN 8000" dir=in action=allow protocol=TCP localport=8000 >nul 2>nul
)

echo.
echo   Server zapushen. Adresa:
echo     Na e\tom PK   :  http://127.0.0.1:8000
echo     V lokal'noj   :  http://%LAN_IP%:8000          ^<- otkryvayte s telefona^/plancheta
echo.
echo   Telefon dolzhen byt' v toj zhe Wi-Fi seti. Ostanovit' - Ctrl+C.
echo ============================================
echo.

".venv\Scripts\python.exe" -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
pause
