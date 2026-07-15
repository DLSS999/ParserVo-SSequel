@echo off
title ParserVo - Reset deleted Shopify dev store
cls
echo ParserVo: reset old/deleted dev store link
echo Target live store for installation: 2szizg-0m.myshopify.com
echo.
echo This script removes only local Shopify CLI cache. It does NOT delete your ParserVo database.
echo.
if exist ".shopify" (
  echo Removing .shopify local CLI cache...
  rmdir /s /q ".shopify"
)
echo.
echo Re-linking app configuration. Choose app: ParserVo
echo If asked for a preview/development store, choose/create any DEVELOPMENT store, not the live store.
echo.
shopify app config link --reset
if errorlevel 1 pause && exit /b 1

echo.
echo Pulling app environment...
shopify app env pull

echo.
echo Installing dependencies and preparing database...
npm install
if errorlevel 1 pause && exit /b 1
npm run setup
if errorlevel 1 pause && exit /b 1

echo.
echo Starting Shopify app dev with reset. Choose a DEVELOPMENT store for CLI preview.
echo Do NOT use deleted checkvo-import-test.myshopify.com.
echo.
shopify app dev --reset
pause
