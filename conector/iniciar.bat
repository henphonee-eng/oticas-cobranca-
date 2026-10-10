@echo off
chcp 65001 >nul
title Conector do WhatsApp da otica - pode minimizar
cd /d "%~dp0"
if not exist "node_modules\qrcode" (
  echo Os componentes ainda nao foram instalados. Abra primeiro o arquivo instalar.bat.
  pause
  exit /b 1
)
:inicio
node src\index.js
echo.
echo O programa parou. Reiniciando em 15 segundos... (feche a janela para sair)
timeout /t 15 >nul
goto inicio
