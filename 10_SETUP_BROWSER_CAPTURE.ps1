$ErrorActionPreference = "Stop"
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "ParserVo Browser Capture setup helper" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ExtDir = Join-Path $ProjectDir "chrome-extension"

if (!(Test-Path $ExtDir)) {
    Write-Host "ERROR: Папка chrome-extension не найдена рядом с этим файлом." -ForegroundColor Red
    Write-Host "Положи этот файл в корень проекта: C:\Users\user\ParserVo\supplier-import-sync" -ForegroundColor Yellow
    Read-Host "Нажми Enter для выхода"
    exit 1
}

Write-Host "Открываю папку расширения:" -ForegroundColor Green
Write-Host $ExtDir
Start-Process explorer.exe $ExtDir

Write-Host "Открываю chrome://extensions/" -ForegroundColor Green
Start-Process chrome.exe "chrome://extensions/"

Write-Host ""
Write-Host "Дальше в Chrome:" -ForegroundColor Yellow
Write-Host "1. Включи Developer mode справа сверху"
Write-Host "2. Нажми Load unpacked"
Write-Host "3. Выбери папку chrome-extension, которая открылась"
Write-Host ""
Write-Host "Потом в отдельном PowerShell запусти:" -ForegroundColor Yellow
Write-Host "shopify app dev"
Write-Host ""
Write-Host "В расширение вставь:" -ForegroundColor Yellow
Write-Host "Local API Base URL = строка Local из PowerShell, например http://localhost:51220"
Write-Host "Shop = parservo.myshopify.com"
Write-Host "Browser capture token = скопировать со страницы Import Product"
Write-Host ""
Read-Host "Нажми Enter, когда закончишь"
