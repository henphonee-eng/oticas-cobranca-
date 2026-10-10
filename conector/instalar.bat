@echo off
chcp 65001 >nul
title Instalar conector do WhatsApp
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo O Node.js nao esta instalado.
  echo Abra https://nodejs.org , baixe a versao LTS, instale e rode este arquivo de novo.
  pause
  exit /b 1
)
echo Instalando... isso pode levar alguns minutos.
call npm install --omit=dev
if errorlevel 1 (
  echo Houve um erro na instalacao. Confira a internet e tente de novo.
  pause
  exit /b 1
)
echo.
echo Pronto! Agora abra o arquivo "iniciar.bat".
pause
