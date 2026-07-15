@echo off
chcp 65001 >nul
setlocal

echo =========================================
echo ParserVo Browser Capture setup helper
echo =========================================
echo.

set PROJECT_DIR=%~dp0
set EXT_DIR=%PROJECT_DIR%chrome-extension

if not exist "%EXT_DIR%" (
  echo ERROR: Папка chrome-extension не найдена рядом с этим файлом.
  echo.
  echo Положи этот файл в корень проекта:
  echo C:\Users\user\ParserVo\supplier-import-sync
  echo.
  pause
  exit /b 1
)

echo 1. Открываю папку расширения:
echo %EXT_DIR%
start "" explorer "%EXT_DIR%"

echo.
echo 2. Открываю Chrome Extensions:
start "" chrome "chrome://extensions/"

echo.
echo 3. Что сделать в Chrome:
echo    - Включи Developer mode справа сверху
echo    - Нажми Load unpacked
echo    - Выбери папку chrome-extension, которая открылась
echo.
echo 4. Потом запусти Shopify app dev в отдельном PowerShell:
echo    shopify app dev
echo.
echo 5. В PowerShell найди строку Local, например:
echo    Local: http://localhost:51220
echo.
echo 6. В расширение вставь:
echo    Local API Base URL = значение Local из PowerShell
echo    Shop = parservo.myshopify.com
echo    Browser capture token = скопировать на странице Import Product
echo.
pause
