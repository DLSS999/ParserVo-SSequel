@echo off
echo Searching for deleted store references...
findstr /S /I /N "checkvo-import-test dev_store_url" shopify.app*.toml .shopify\* 2>nul
if errorlevel 1 echo OK: no old store reference found in visible config files.
pause
