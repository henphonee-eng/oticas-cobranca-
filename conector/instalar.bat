@echo off
chcp 65001 >nul
title Instalar conector do WhatsApp
cd /d "%~dp0"
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo O Node.js nao esta instalado. Instale em https://nodejs.org e reinicie o computador.
  pause
  exit /b 1
)
set "NODEMAJ=0"
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set "NODEMAJ=%%v"
if %NODEMAJ% LSS 20 (
  echo O Node.js deste computador e muito antigo. Instale a versao LTS em https://nodejs.org e reinicie o computador.
  pause
  exit /b 1
)
echo %CD% | findstr /i "OneDrive" >nul
if not errorlevel 1 (
  echo ATENCAO: esta pasta esta dentro do OneDrive. Isso costuma dar problema.
  echo Mova a pasta conector-whatsapp para C:\ e abra este arquivo de novo.
  pause
  exit /b 1
)
echo Instalando... isso pode levar alguns minutos.
call npm install --omit=dev
if not exist "node_modules\qrcode" (
  echo.
  echo A INSTALACAO FALHOU. Tire uma foto desta tela e envie para o suporte.
  pause
  exit /b 1
)
if not exist "node_modules\@whiskeysockets\baileys" (
  echo.
  echo A INSTALACAO FALHOU. Tire uma foto desta tela e envie para o suporte.
  pause
  exit /b 1
)
echo.
echo Pronto! Agora abra o arquivo "iniciar.bat".
pause
