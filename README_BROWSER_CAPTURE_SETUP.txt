ParserVo — Browser Capture setup

Зачем это нужно:
Vitkac блокирует автоматический серверный парсер HTTP 403. Поэтому для импорта большого количества товаров используем Chrome extension: страница открыта в твоем обычном Chrome, расширение забирает HTML и отправляет его в Shopify App.

Как установить:
1. Скопируй файлы 10_SETUP_BROWSER_CAPTURE.bat и 10_SETUP_BROWSER_CAPTURE.ps1 в корень проекта:
   C:\Users\user\ParserVo\supplier-import-sync

2. Запусти 10_SETUP_BROWSER_CAPTURE.bat

3. В Chrome откроется chrome://extensions/
   - включи Developer mode
   - нажми Load unpacked
   - выбери папку:
     C:\Users\user\ParserVo\supplier-import-sync\chrome-extension

4. Запусти приложение:
   shopify app dev

5. В PowerShell найди строку Local, например:
   Local: http://localhost:51220

6. На странице Import Product скопируй:
   Shop
   Browser capture token

7. В расширении укажи:
   Local API Base URL = http://localhost:xxxxx
   Shop = parservo.myshopify.com
   Browser capture token = токен из Import Product
   PLN → UAH = нужный курс
   EUR → UAH = нужный курс

8. Открой товары Vitkac во вкладках и нажми в расширении:
   Capture all open Vitkac tabs

Важно:
Это режим импорта. Автоматическое обновление остатков через серверный Vitkac parser сейчас будет упираться в HTTP 403. Для полностью автоматического sync нужен официальный feed/API/CSV/XML от поставщика.
