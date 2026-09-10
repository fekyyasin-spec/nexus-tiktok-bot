# TikTok Stats Scraper + ربط بوت دسكورد

استخراج **المشاهدات / اللايكات / التعليقات / المشاركات** من رابط فيديو TikTok
بدون استخدام TikTok API الرسمية — عن طريق فتح صفحة الفيديو بمتصفح حقيقي (Playwright)
وقراءة البيانات المدمجة في الصفحة.

---

## 1) التثبيت

```bash
npm install
```

أمر `npm install` سينفّذ تلقائياً `playwright install chromium` لتنزيل المتصفح.
لو لم يحدث، شغّله يدوياً:

```bash
npx playwright install chromium
```

---

## 2) التشغيل كـ CLI (يرجع JSON)

```bash
node src/cli.js "https://www.tiktok.com/@username/video/123456789"
```

المخرجات (سطر JSON واحد على stdout):

```json
{"views":12345,"likes":678,"comments":90,"shares":12,"source":"json","url":"...","error":null}
```

- **`source`**: `"json"` يعني أن الأرقام دقيقة (من JSON المدمج)، `"dom"` يعني من العناصر المرئية (مختصرة أحياناً).
- **رمز الخروج**: `0` عند النجاح، `1` عند وجود خطأ.
- لإظهار المتصفح أثناء التصحيح: أضف `--no-headless`.

---

## 3) الاستخدام داخل كود (الدالة getTikTokStats)

```js
const { getTikTokStats } = require("./src/tiktokStats");

const stats = await getTikTokStats("https://www.tiktok.com/@user/video/123");
// stats = { views, likes, comments, shares, source, url, error }
```

أو مناداة السكربت كعملية منفصلة (CLI) ثم قراءة JSON:

```js
const { execFile } = require("child_process");
function getTikTokStats(url) {
  return new Promise((resolve, reject) => {
    execFile("node", ["src/cli.js", url], (err, stdout) => {
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
  });
}
```

---

## 4) أين تُختار عناصر الصفحة (للتعديل لاحقاً)

كل منطق الاستخراج في ملف `src/tiktokStats.js`:

### أ) المصدر الأساسي — JSON المدمج (الأدق)
- الدالة: **`extractFromEmbeddedJson()`** — القسم (3) في الملف.
- TikTok يضع البيانات داخل وسم `<script>` بالـ id:
  - `__UNIVERSAL_DATA_FOR_REHYDRATION__` (الأحدث) أو `SIGI_STATE` (قديم).
- داخل الـ JSON يوجد الكائن `stats`:
  - `playCount` → **المشاهدات**
  - `diggCount` → **اللايكات**
  - `commentCount` → **التعليقات**
  - `shareCount` → **المشاركات**
- لو غيّرت TikTok مسار البيانات، عدّل الدالة **`findStatsObject()`** التي تبحث عن `stats` بشكل تلقائي عميق.

### ب) المصدر الاحتياطي — عناصر DOM المرئية
- الدالة: **`extractFromDom()`** — القسم (4) في الملف.
- نستخدم سمة `data-e2e` (أثبت من أسماء الـ class). عدّل `SELECTOR_MAP`:

```js
const SELECTOR_MAP = {
  likes:    ["like-count", "browse-like-count"],
  comments: ["comment-count", "browse-comment-count"],
  shares:   ["share-count", "browse-share-count"],
};
```

> **لتحديث المحددات:** افتح صفحة فيديو TikTok في المتصفح ← Inspect على رقم اللايكات ←
> ابحث عن أقرب عنصر فيه `data-e2e="..."` وضع قيمته في `SELECTOR_MAP`.

---

## 5) ربط بوت دسكورد

1. انسخ `.env.example` إلى `.env` واملأ القيم:
   - `DISCORD_TOKEN` (التوكن — سترسله لي/تضعه هنا)
   - `DISCORD_CLIENT_ID` (لتسجيل أوامر slash)
   - `LOG_CHANNEL_ID` (اختياري — قناة اللوق)
   - `MIN_VIEWS` (الحد الأدنى للمشاهدات)

2. شغّل البوت:

```bash
node bot.js
```

3. الأوامر المتاحة:
   - **أوامر الأعضاء العامة:**
     - `/stats url:<tiktok-url>` أو `!stats <url>`: فحص إحصائيات الفيديو وكشف المشاهدات الوهمية.
   
   - **أوامر الإدارة والتحكم (Admins Only):**
     - `/control-panel` أو `!control-panel`: إرسال لوحة التحكم التفاعلية للجوائز والمخزون والتكوين.
     - `/deliver user:<user> type:<manual|stock> count:<number>`: تسليم فوري للجائزة.
     - `/set-log-channel channel:<#channel>`: تحديد/تغيير قناة السجلات برمجياً وبشكل دائم.
     - `/set-min-views views:<number>`: تحديد/تغيير الحد الأدنى للمشاهدات المطلوبة للتحقق بشكل دائم.

تم حفظ هذه الإعدادات بالكامل داخل قاعدة البيانات المحلية `database.json` لضمان ثباتها وبقائها حتى في حال إعادة تشغيل البوت. كما ستُعرض القيم الحالية للإعدادات (المخزون، شرط المشاهدات، قناة اللوغ الحالية) بشكل مباشر وبصري رائع داخل **لوحة تحكم إدارة الجوائز (Control Panel)** لتسهيل متابعتها.

---

## 6) معالجة الأخطاء

الدالة لا ترمي استثناءات — دائماً ترجع كائناً. عند الفشل يكون `error` نصاً واضحاً
وكل القيم `null`. أمثلة على الأخطاء المعالَجة:
- رابط غير صالح (لا يحتوي `tiktok.com`).
- فيديو خاص/محذوف أو ظهور صفحة تحقق (CAPTCHA).
- تغيّر بنية الصفحة (لم يُعثر على JSON ولا على عناصر DOM).

---

## ملاحظات مهمة

- الـ scraping قد يتأثر بتغييرات TikTok أو بظهور CAPTCHA عند كثرة الطلبات.
  للاستخدام المكثّف فكّر في تقليل معدل الطلبات أو استخدام بروكسي.
- احترم شروط استخدام TikTok والقوانين المعمول بها.
