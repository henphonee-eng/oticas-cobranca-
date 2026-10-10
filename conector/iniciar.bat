@echo off
chcp 65001 >nul
title Conector do WhatsApp da otica - pode minimizar
cd /d "%~dp0"
:inicio
node src\index.js
echo.
echo O programa parou. Reiniciando em 15 segundos... (feche a janela para sair)
timeout /t 15 >nul
goto inicio
