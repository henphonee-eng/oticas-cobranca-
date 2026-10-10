@echo off
chcp 65001 >nul
set "PASTA=%~dp0"
set "DEST=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\conector-whatsapp-otica.vbs"
> "%DEST%" echo Set sh = CreateObject("WScript.Shell")
>> "%DEST%" echo sh.CurrentDirectory = "%PASTA%"
>> "%DEST%" echo sh.Run "cmd /c iniciar.bat", 7, False
echo Pronto! O conector vai abrir sozinho, minimizado, quando o Windows ligar.
echo Atencao: nao mova nem apague esta pasta depois disso.
pause
