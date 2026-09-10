#!/usr/bin/env node
"use strict";

/**
 * cli.js
 * ----------------------------------------------------------------------------
 * تشغيل السكربت من سطر الأوامر (CLI) ليعيد JSON على stdout.
 *
 * الاستخدام:
 *   node src/cli.js "https://www.tiktok.com/@user/video/123..."
 *   node src/cli.js "<url>" --no-headless     # لإظهار المتصفح (تصحيح)
 *
 * الإخراج: سطر واحد JSON على stdout مثل:
 *   {"views":12345,"likes":678,"comments":90,"shares":12,"source":"json","url":"...","error":null}
 *
 * رمز الخروج (exit code):
 *   0 = نجاح،  1 = خطأ (يكون error != null)
 *
 * هذا يسهّل مناداته من بوت دسكورد عبر child_process ثم JSON.parse للمخرجات.
 * ----------------------------------------------------------------------------
 */

const { getTikTokStats } = require("./tiktokStats");

(async () => {
  const args = process.argv.slice(2);
  const url = args.find((a) => !a.startsWith("--"));
  const headless = !args.includes("--no-headless");

  if (!url) {
    process.stdout.write(
      JSON.stringify({
        views: null,
        likes: null,
        comments: null,
        shares: null,
        source: null,
        url: null,
        error: "لم يتم تمرير رابط. الاستخدام: node src/cli.js <tiktok-url>",
      })
    );
    process.exit(1);
  }

  const result = await getTikTokStats(url, { headless });
  process.stdout.write(JSON.stringify(result));
  process.exit(result.error ? 1 : 0);
})();
