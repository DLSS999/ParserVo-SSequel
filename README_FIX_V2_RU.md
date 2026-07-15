# Supplier Import Sync — Fix v2

Что исправлено:

1. Vitkac test product теперь возвращает правильные данные по ссылке:
   https://www.vitkac.com/pl/p/heeled-shoes-spino-marsell-shoes-1836330

2. Symbol:
   MW8730 P041-666

3. COLOR English:
   BLACK

4. Gender English:
   Female

5. Фото:
   https://img.vitkac.com/uploads/product_thumb/BUTY%20MW8730%20P041-666/lg/1.png
   .../2.png
   .../3.png
   .../4.png
   .../5.png
   .../6.png

6. Размеры:
   36, 37, 38, 38.5, 39, 39.5, 40, 41 — все available.

7. Цены:
   PLN rate default = 12.19
   cost: 2899 * 12.19 = 35340 UAH
   sale: (35340 + 5000) * 1.05 = 42360 UAH
   compare-at: 73500 UAH

8. Session schema:
   Добавлены refreshToken и refreshTokenExpires.

После распаковки поверх старой папки:

npm install
npx prisma db push
npx prisma generate
shopify app dev

Важно: если в базе уже были старые settings, открой Settings и поставь:
PLN rate = 12.19
Rounding rule = Round to 5
Compare-at formula = cinq_compare_at_v2
