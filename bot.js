"use strict";

/**
 * bot.js — بوت تيك توك التفاعلي المتكامل
 * ----------------------------------------------------------------------------
 * المميزات المضمنة:
 *   1. لوحة تحكم الإدارة (Control Panel) وأوامر Slash لإدارة المخزون والتسليم.
 *   2. زر إضافة حسابات للمخزون: يفتح Modal فوري "ارسل الحسابات كل سطر = حساب".
 *   3. زر إرسال جائزة:
 *        - اختيار العضو عبر قائمة منسدلة خاصة بالأعضاء (User Select Menu).
 *        - قائمة منسدلة لاختيار طريقة التسليم (يدوي أو من المخزون).
 *        - إذا يدوي: يفتح Modal لكتابة الجائزة يدوياً.
 *        - إذا مخزون: قائمة منسدلة (حساب واحد أو عدد معين).
 *        - إذا عدد معين: يفتح Modal لإدخال العدد المطلق وسحبها تلقائياً.
 *   4. كشف متكامل للمشاهدات الوهمية (Fake Views) مدعوم بنسب مئوية دقيقة وتوصية فنية.
 *   5. لوق (Log) تفصيلي يرسل لقناة اللوج ويُحفظ محلياً ببيانات المسلم، المستلم، الجوائز بالتحديد.
 *   6. رسالة استلام مصححة إملائياً وتنسيق جذاب مع دعم الإيموجيات المخصصة.
 * ----------------------------------------------------------------------------
 */

require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  UserSelectMenuBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SectionBuilder,
  SeparatorBuilder,
  MediaGalleryBuilder,
  FileUploadBuilder,
  LabelBuilder,
} = require("discord.js");

const { getTikTokStats } = require("./src/tiktokStats");
const db = require("./src/db");
const { connectMongo, saveSentAccount, getSentAccounts, getBotConfig: mongoGetBotConfig, setBotConfig: mongoSetBotConfig, getStockCount: mongoGetStockCount, addStock: mongoAddStock, isBanned, banUser, unbanUser } = require("./src/mongo");

const OWNER_ID = process.env.OWNER_ID || "1475835571258523741";

/* ============================================================================
 *  (1) الإعدادات والتحقق
 * ==========================================================================*/
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;

if (!TOKEN) {
  console.error("[ERROR] DISCORD_TOKEN not set in .env");
  process.exit(1);
}

function getDefaultConfig() {
  return {
    minViews: parseInt(process.env.MIN_VIEWS || "1000", 10),
    logChannelId: process.env.LOG_CHANNEL_ID || null
  };
}

// تخزين مؤقت للإعدادات حسب السيرفر
const botConfigCache = {
  global: getDefaultConfig()
};

/**
 * دالة مساعدة لجلب الإعدادات الحالية من MongoDB أو ملف JSON أو env
 */
async function loadBotConfig() {
  await getBotConfig("global");
  console.log("[OK] Bot config loaded");
}

async function getBotConfig(guildId) {
  if (!guildId) guildId = "global";
  if (botConfigCache[guildId]) return botConfigCache[guildId];

  const data = db.readDb();
  const target = guildId === "global" ? data : (data.guilds && data.guilds[guildId]) || {};
  let cfg = { ...getDefaultConfig(), ...(target.config || {}) };

  if (mongoGetBotConfig) {
    const mongoCfg = await mongoGetBotConfig(guildId).catch((err) => {
      console.warn("[WARN] Failed to load config from MongoDB:", err.message);
      return null;
    });
    if (mongoCfg) cfg = { ...cfg, ...mongoCfg };
  }

  botConfigCache[guildId] = cfg;
  return cfg;
}

async function updateBotConfig(updates, guildId) {
  if (!guildId) guildId = "global";
  const current = await getBotConfig(guildId);
  const newCfg = { ...current, ...updates };
  botConfigCache[guildId] = newCfg;
  if (mongoSetBotConfig) {
    await mongoSetBotConfig(updates, guildId).catch((err) => console.warn("[WARN] Failed to save config to MongoDB:", err.message));
  }
  // "global" في db.js يعني البيانات العامة (null)، وليس سيرفر باسم "global"
  db.updateConfig(updates, guildId === "global" ? null : guildId);
}

/**
 * التحقق مما إذا كان العضو مسموح له بإرسال حسابات في الخاص
 * الأدمن مسموح لهم دائماً إلا إذا كان محظوراً، أما الرتبة المحددة فيخضعون للحد اليومي.
 */
async function canSendAccounts(member, requestedCount = 1, guildId = null) {
  if (await isBanned(member.id)) {
    return { allowed: false, reason: "أنت محظور من استخدام أوامر الإرسال." };
  }

  if (member.permissions.has("Administrator")) {
    return { allowed: true, isAdmin: true, remaining: Number.MAX_SAFE_INTEGER };
  }

  const gid = guildId || member?.guild?.id || null;
  const { allowedToSendRoleId, allowedToSendDailyLimit } = db.getSendAccConfig(gid);
  if (!allowedToSendRoleId) {
    return { allowed: false, reason: "لم يتم ضبط رتبة مسموح لها بإرسال الحسابات." };
  }

  if (!member.roles.cache.has(allowedToSendRoleId)) {
    return { allowed: false, reason: "لا تمتلك الرتبة المسموح لها بإرسال الحسابات." };
  }

  const sentToday = db.getDailyAccSendCount(member.id, gid);
  const limit = allowedToSendDailyLimit;
  if (limit > 0 && sentToday + requestedCount > limit) {
    const remaining = Math.max(0, limit - sentToday);
    return { allowed: false, reason: `وصلت للحد اليومي: ${sentToday}/${limit}. المتبقي: ${remaining}.` };
  }

  return { allowed: true, isAdmin: false, remaining: limit > 0 ? limit - sentToday : Number.MAX_SAFE_INTEGER };
}

/**
 * نقل الحسابات المخزنة في database.json إلى MongoDB عند أول تشغيل
 */
async function migrateStockToMongo() {
  const data = db.readDb();
  if (!mongoGetStockCount || !mongoAddStock) return;
  try {
    // Migrate legacy top-level stock
    const jsonStock = data.stock || [];
    if (jsonStock.length > 0) {
      const globalCount = await mongoGetStockCount();
      if (globalCount === null) {
        console.log("[OK] MongoDB not connected, keeping stock in database.json");
      } else if (globalCount > 0) {
        data.stock = [];
        console.log("[OK] MongoDB already has global stock; cleared local legacy stock to avoid duplicates");
      } else {
        console.log(`[OK] Migrating ${jsonStock.length} legacy stock item(s) to MongoDB...`);
        const added = await mongoAddStock(jsonStock, null);
        if (added !== null && added > 0) {
          data.stock = [];
          console.log(`[OK] Migrated ${added} legacy stock item(s) to MongoDB`);
        }
      }
    }

    // Migrate per-guild stock
    for (const [gid, guildData] of Object.entries(data.guilds || {})) {
      if (!guildData.stock || guildData.stock.length === 0) continue;
      const guildCount = await mongoGetStockCount(gid);
      if (guildCount === null) continue;
      if (guildCount > 0) {
        guildData.stock = [];
        console.log(`[OK] MongoDB already has stock for guild ${gid}; cleared local to avoid duplicates`);
      } else {
        console.log(`[OK] Migrating ${guildData.stock.length} stock item(s) for guild ${gid} to MongoDB...`);
        const added = await mongoAddStock(guildData.stock, gid);
        if (added !== null && added > 0) {
          guildData.stock = [];
          console.log(`[OK] Migrated ${added} stock item(s) for guild ${gid} to MongoDB`);
        }
      }
    }

    db.writeDb(data);
  } catch (err) {
    console.warn("[WARN] Stock migration failed:", err.message);
  }
}

// تخزين مؤقت لعمليات التسليم الجارية لتتبع الخطوات (In-Memory State Machine)
// الهيكل: [interactionId] -> { targetUserId, deliveryType }
const activeDeliveries = new Map();

/* ============================================================================
 *  (2) منطق فحص المشاهدات الوهمية (Fake Views)
 * ==========================================================================*/
function analyzeTikTokEngagement(stats) {
  const views = stats.views || 0;
  const likes = stats.likes || 0;
  const comments = stats.comments || 0;
  const shares = stats.shares || 0;

  if (views < 3000) {
    return {
      score: "سليم (عينة غير كافية)",
      suspicious: false,
      color: 0x57f287,
      details: "عدد المشاهدات قليل جداً لتحديد التفاعل الوهمي بدقة. يبدو طبيعياً.",
      ratioText: "—"
    };
  }

  // النسب الطبيعية المتعارف عليها:
  // اللايكات للمشاهدات: بين 1% إلى 15% (0.01 إلى 0.15)
  // التعليقات للمشاهدات: بين 0.05% إلى 1% (0.0005 إلى 0.01)
  const likeRatio = likes / views;
  const commentRatio = comments / views;
  const totalEngagementRatio = (likes + comments + shares) / views;

  let score = "تم طبيعي ممتاز";
  let suspicious = false;
  let color = 0x57f287;
  let details = [];

  // 1. فحص انخفاض اللايكات الشديد مقارنة بالمشاهدات العالية
  if (views >= 10000 && likeRatio < 0.004) {
    suspicious = true;
    details.push("خطأ: لايكات منخفضة جداً بشكل غير طبيعي بالنسبة للمشاهدات (أقل من 0.4%)");
  } else if (views >= 50000 && likeRatio < 0.008) {
    suspicious = true;
    details.push("تنبيه: نسبة تفاعل اللايكات منخفضة (أقل من 0.8%)");
  }

  // 2. فحص نسبة التعليقات
  if (views >= 10000 && commentRatio < 0.0001 && likes > 1000) {
    suspicious = true;
    details.push("تنبيه: انعدام شبه تام للتعليقات رغم وجود لايكات ومشاهدات عالية");
  }

  // 3. فحص التفاعل الإجمالي المنتفخ أو الميت
  if (totalEngagementRatio < 0.005) {
    suspicious = true;
    score = "تحذير: مشبوه جداً (احتمال وهمي عالي)";
    color = 0xed4245;
  } else if (suspicious) {
    score = "تنبيه: مشكوك فيه";
    color = 0xfee75c;
  }

  if (details.length === 0) {
    details.push("تم نسب التفاعل واللايكات متناسقة مع عدد المشاهدات.");
  }

  const ratioPct = (likeRatio * 100).toFixed(2);
  const commentPct = (commentRatio * 100).toFixed(2);

  return {
    score,
    suspicious,
    color,
    details: details.join("\n"),
    ratioText: `اللايكات: ${ratioPct}% | التعليقات: ${commentPct}%`
  };
}

/* ============================================================================
 *  (3) لوق التسليم وقناة اللوج
 * ==========================================================================*/
async function sendDeliveryLog(client, { admin, recipient, type, prizeContent, source, count, guildId }) {
  // حفظ في قاعدة البيانات المحلية أولاً
  db.addLog("delivery", {
    adminId: admin.id,
    adminTag: admin.tag,
    recipientId: recipient.id,
    recipientTag: recipient.tag,
    type,
    count: count || 1,
    source
  }, guildId);

  const { logChannelId } = await getBotConfig(guildId);

  if (!logChannelId) {
    console.warn("[WARN] No log channel configured. Set one with /set-log-channel or LOG_CHANNEL_ID in .env");
    return;
  }
  const channel = await client.channels.fetch(logChannelId).catch((err) => {
    console.warn("[WARN] Failed to fetch log channel:", err.message);
    return null;
  });
  if (!channel) {
    console.warn("[WARN] Log channel not found or bot cannot access it. ID:", logChannelId);
    return;
  }
  if (!channel.isTextBased()) {
    console.warn("[WARN] Log channel is not a text channel. ID:", logChannelId);
    return;
  }

  const prizeDisplay = Array.isArray(prizeContent)
    ? prizeContent.map((p, idx) => `[${idx + 1}] ${p}`).join("\n")
    : prizeContent;

  let prizeText = prizeDisplay;
  if (prizeText.length > 2000) prizeText = prizeText.substring(0, 2000) + "\n... (مقطوع)";

  const container = new ContainerBuilder()
    .setAccentColor(0x57f287)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("## سجل تسليم جديد")
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**من الإدارة:** ${admin}\nID: \`${admin.id}\`\n` +
        `**استلمها:** ${recipient}\nID: \`${recipient.id}\``
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**نوع التسليم:** ${type === "manual" ? "يدوي" : "من المخزون"}\n` +
        `**الكمية:** ${count || 1}\n` +
        `**المصدر:** ${source || "—"}`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**الحسابات:**\n\`\`\`\n${prizeText}\n\`\`\``)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`${new Date().toLocaleString("en-US")}\nنظام إدارة الجوائز`)
    );

  try {
    await channel.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
  } catch (v2Err) {
    console.warn("[WARN] V2 log failed:", v2Err.message);
    const fallback =
      `**سجل تسليم جديد**\n` +
      `من: ${admin} (${admin.tag})\n` +
      `إلى: ${recipient} (${recipient.tag})\n` +
      `النوع: ${type === "manual" ? "يدوي" : "من المخزون"}\n` +
      `الكمية: ${count || 1}\n` +
      `الحسابات:\n\`\`\`\n${prizeText}\n\`\`\`\n` +
      `${new Date().toLocaleString("en-US")}`;
    try {
      await channel.send({ content: fallback });
    } catch (plainErr) {
      console.error("[ERROR] Plain fallback log also failed:", plainErr.message);
    }
  }
}

/* ============================================================================
 *  (4) تشغيل وتجهيز البوت
 * ==========================================================================*/
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
  ],
});

/* ============================================================================
 *  معالجة الأخطاء العامة لمنع توقف البوت (Global Error Handlers)
 * ==========================================================================*/
// التقاط الأخطاء غير المعالجة في الوعود (Promises) — مثل Unknown interaction
process.on("unhandledRejection", (reason, promise) => {
  // 10062 = Unknown interaction (انتهت الصلاحية) / 40060 = تم الرد مسبقاً — أخطاء شائعة وغير خطيرة
  if (reason && (reason.code === 10062 || reason.code === 40060)) {
    console.warn("[WARN] تفاعل منتهي الصلاحية أو مردود عليه مسبقاً — تم تجاهله.");
    return;
  }
  console.error("[FATAL] unhandledRejection:", reason);
});

// التقاط الأخطاء المتزامنة غير المعالجة
process.on("uncaughtException", (err, origin) => {
  if (err && (err.code === 10062 || err.code === 40060)) {
    console.warn("[WARN] تفاعل منتهي الصلاحية أو مردود عليه مسبقاً — تم تجاهله.");
    return;
  }
  console.error("[FATAL] uncaughtException:", err, "origin:", origin);
});

// أخطاء عميل ديسكورد نفسه
client.on("error", (error) => {
  console.error("[ERROR] Discord client error:", error);
});

// مساعد آمن للرد على التفاعلات حتى لو انتهت صلاحيتها
async function safeReply(interaction, options) {
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply(options).catch(() => null);
    }
    return await interaction.reply(options).catch(() => null);
  } catch (e) {
    if (e && e.code === 10062) {
      console.warn("[WARN] لم يتم الرد على تفاعل منتهي الصلاحية.");
    } else {
      console.error("[ERROR] فشل الرد على التفاعل:", e);
    }
    return null;
  }
}

// مساعد آمن لإظهار المودال — يتجاهل التفاعلات المنتهية أو المردود عليها مسبقاً
async function safeShowModal(interaction, modal) {
  try {
    if (interaction.deferred || interaction.replied) {
      console.warn("[WARN] تم تجاهل showModal: التفاعل مردود عليه مسبقاً.");
      return null;
    }
    return await interaction.showModal(modal);
  } catch (e) {
    if (e && (e.code === 10062 || e.code === 40060)) {
      console.warn("[WARN] تفاعل منتهي الصلاحية أو مردود عليه مسبقاً — تم تجاهل showModal.");
    } else {
      console.error("[ERROR] فشل إظهار المودال:", e);
    }
    return null;
  }
}

// مساعد لتقسيم النص الطيف على أجزاء لا تتجاوز الحد الأقصى
function chunkText(text, maxLen = 1800) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  const lines = text.split("\n");
  let current = "";
  for (const line of lines) {
    if ((current + line + "\n").length > maxLen) {
      if (current) chunks.push(current.trimEnd());
      current = line + "\n";
    } else {
      current += line + "\n";
    }
  }
  if (current) chunks.push(current.trimEnd());
  return chunks;
}

// مساعد لحساب إجمالي حجم النص في Container
function estimateContainerTextSize(container) {
  try {
    const json = container.toJSON();
    let total = 0;
    function countText(obj) {
      if (typeof obj === "string") { total += obj.length; return; }
      if (Array.isArray(obj)) { for (const item of obj) countText(item); return; }
      if (obj && typeof obj === "object") {
        for (const v of Object.values(obj)) countText(v);
      }
    }
    countText(json);
    return total;
  } catch {
    return 0;
  }
}

// مساعد لتحليل المدة الزمنية (مثال: 3d, 72h, 1w, 30m, 15s أو 3d/72h)
function parseDuration(input) {
  if (!input) return null;
  const str = String(input).trim().toLowerCase().replace(/\s+/g, "");
  if (!str) return null;

  const multipliers = {
    w: 7 * 24 * 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    h: 60 * 60 * 1000,
    m: 60 * 1000,
    s: 1000
  };

  const parts = str.split(/[\/,]/);
  for (const part of parts) {
    const match = part.match(/^(\d+(?:\.\d+)?)([wdhms])$/);
    if (match) {
      const value = parseFloat(match[1]);
      const unit = match[2];
      const ms = value * multipliers[unit];
      if (ms > 0) return Math.round(ms);
    }
  }
  return null;
}

// تسجيل أوامر السلاش
async function registerSlashCommands() {
  if (!CLIENT_ID) return;

  const commands = [
    // 1. أمر فحص الفيديو
    new SlashCommandBuilder()
      .setName("stats")
      .setDescription("استخراج إحصائيات فيديو TikTok وفحص المشاهدات الوهمية")
      .addStringOption((o) =>
        o.setName("url").setDescription("رابط فيديو TikTok").setRequired(true)
      )
      .toJSON(),

    // 2. لوحة التحكم للإدارة
    new SlashCommandBuilder()
      .setName("control-panel")
      .setDescription("إرسال لوحة التحكم الخاصة بالجوائز وإدارة المخزون (للإدارة فقط)")
      .toJSON(),

    // 3. أمر تسليم مباشر
    new SlashCommandBuilder()
      .setName("deliver")
      .setDescription("تسليم جائزة لعضو بشكل مباشر")
      .addUserOption((o) => o.setName("user").setDescription("العضو المستلم").setRequired(true))
      .addStringOption((o) =>
        o.setName("type")
          .setDescription("طريقة التسليم")
          .setRequired(true)
          .addChoices(
            { name: "يدوي (اكتب الجائزة الآن)", value: "manual" },
            { name: "من المخزون (تلقائي)", value: "stock" }
          )
      )
      .addIntegerOption((o) => o.setName("count").setDescription("العدد المطلوب من المخزون (افتراضي 1)").setRequired(false))
      .toJSON(),

    // 4. أمر تحديد قناة اللوج
    new SlashCommandBuilder()
      .setName("set-log-channel")
      .setDescription("تحديد قناة إرسال سجلات تسليم الجوائز (للإدارة)")
      .addChannelOption((o) =>
        o.setName("channel")
          .setDescription("القناة النصية المخصصة للوجات")
          .setRequired(true)
      )
      .toJSON(),

    // 5. أمر تحديد الحد الأدنى للمشاهدات
    new SlashCommandBuilder()
      .setName("set-min-views")
      .setDescription("تحديد الحد الأدنى للمشاهدات المطلوب للتحقق من الفيديوهات (للإدارة)")
      .addIntegerOption((o) =>
        o.setName("views")
          .setDescription("عدد المشاهدات المطلوب (مثال: 1000)")
          .setRequired(true)
          .setMinValue(0)
      )
      .toJSON(),

    // 6. أمر إضافة زر مخصص للوحة التحكم
    new SlashCommandBuilder()
      .setName("add-button")
      .setDescription("إضافة زر مخصص للوحة التحكم (للإدارة)")
      .addStringOption((o) =>
        o.setName("name")
          .setDescription("اسم الزر")
          .setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("emoji")
          .setDescription("إيموجي الزر")
          .setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("color")
          .setDescription("لون الزر")
          .setRequired(true)
          .addChoices(
            { name: "أخضر", value: "green" },
            { name: "رمادي", value: "gray" },
            { name: "أزرق", value: "blue" },
            { name: "أحمر", value: "red" }
          )
      )
      .addStringOption((o) =>
        o.setName("response")
          .setDescription("الرد المخفي عند الضغط على الزر")
          .setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("terms")
          .setDescription("شروط الاستخدام (اختياري - إذا وضعت شروط سيظهر سؤال الموافقة)")
          .setRequired(false)
      )
      .toJSON(),

    // 7. أمر حذف زر مخصص
    new SlashCommandBuilder()
      .setName("delete-button")
      .setDescription("حذف زر مخصص من لوحة التحكم (للإدارة)")
      .addStringOption((o) =>
        o.setName("button-id")
          .setDescription("معرف الزر المراد حذفه")
          .setRequired(true)
          .setAutocomplete(true)
      )
      .toJSON(),

    // 8. أمر قائمة الأزرار المخصصة
    new SlashCommandBuilder()
      .setName("list-buttons")
      .setDescription("عرض جميع الأزرار المخصصة في لوحة التحكم (للإدارة)")
      .toJSON(),

    // 9. أمر عرض المخزون
    new SlashCommandBuilder()
      .setName("عرض-المخزون")
      .setDescription("عرض جميع الحسابات الموجودة في المخزون (للإدارة)")
      .toJSON(),

    // 10. أمر إزالة حساب من المخزون
    new SlashCommandBuilder()
      .setName("ازالة-مخزون")
      .setDescription("حذف حساب محدد من المخزون (للإدارة)")
      .addStringOption((o) =>
        o.setName("account")
          .setDescription("الحساب الموجود في المخزون المراد حذفه")
          .setRequired(true)
      )
      .toJSON(),

    // 11. أمر حذف المخزون كامل
    new SlashCommandBuilder()
      .setName("حذف-مخزون-كامل")
      .setDescription("حذف كل المخزون وإرساله للوق (للإدارة)")
      .toJSON(),

    // 12. أمر إضافة حسابات للمخزون
    new SlashCommandBuilder()
      .setName("add-accounts")
      .setDescription("إضافة حسابات للمخزون (كل سطر = حساب) (للإدارة)")
      .addStringOption((o) =>
        o.setName("accounts")
          .setDescription("الحسابات المراد إضافتها (كل سطر = حساب)")
          .setRequired(true)
      )
      .toJSON(),

    // 13. أمر إنشاء لوحة مقاطع TikTok
    new SlashCommandBuilder()
      .setName("create-panel")
      .setDescription("إنشاء لوحة جديدة لاستقبال روابط TikTok (للإدارة)")
      .addStringOption((o) =>
        o.setName("description")
          .setDescription("وصف اللوحة (النص اللي يظهر فوق)")
          .setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("button-name")
          .setDescription("اسم الزر اللي يضغطه العضو")
          .setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("button-color")
          .setDescription("لون الزر")
          .setRequired(true)
          .addChoices(
            { name: "أخضر", value: "green" },
            { name: "أحمر", value: "red" },
            { name: "أزرق", value: "blue" },
            { name: "رمادي", value: "gray" }
          )
      )
      .addStringOption((o) =>
        o.setName("image")
          .setDescription("رابط صورة اللوحة (اختياري)")
          .setRequired(false)
      )
      .addChannelOption((o) =>
        o.setName("log-channel")
          .setDescription("قناة اللوجات (القبول/الرفض) - افتراضياً قناة اللوج العامة")
          .setRequired(false)
      )
      .toJSON(),

    // 14. أمر حذف لوحة
    new SlashCommandBuilder()
      .setName("delete-panel")
      .setDescription("حذف لوحة مقاطع TikTok (للإدارة)")
      .addStringOption((o) =>
        o.setName("panel-id")
          .setDescription("معرف اللوحة المراد حذفها")
          .setRequired(true)
          .setAutocomplete(true)
      )
      .toJSON(),

    // 15. أمر قائمة اللوحات
    new SlashCommandBuilder()
      .setName("list-panels")
      .setDescription("عرض جميع لوحات TikTok (للإدارة)")
      .toJSON(),

    // 15.5 أمر تحديد مهلة استلام المقاطع للوحة
    new SlashCommandBuilder()
      .setName("set-deadline")
      .setDescription("تحديد مدة صلاحية استلام المقاطع للوحة (مثال: 3d, 72h, 1w)")
      .addStringOption((o) =>
        o.setName("panel-id")
          .setDescription("معرف اللوحة")
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption((o) =>
        o.setName("duration")
          .setDescription("المدة: d=يوم، h=ساعة، w=أسبوع، m=دقيقة، s=ثانية (مثال: 3d أو 72h)")
          .setRequired(true)
      )
      .toJSON(),

    // 16. أمر فحص حسابات الخاص
    new SlashCommandBuilder()
      .setName("check-dm")
      .setDescription("إعادة إرسال الحسابات التي أرسلها البوت في الخاص")
      .addUserOption((o) =>
        o.setName("user").setDescription("العضو - اتركه لنفسك").setRequired(false)
      )
      .toJSON(),

    // 17. أمر باند
    new SlashCommandBuilder()
      .setName("ban")
      .setDescription("منع عضو من استلام الحسابات (للأونر فقط)")
      .addUserOption((o) =>
        o.setName("user").setDescription("العضو").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("reason").setDescription("السبب").setRequired(false)
      )
      .toJSON(),

    // 18. أمر فك باند
    new SlashCommandBuilder()
      .setName("unban")
      .setDescription("رفع الباند عن عضو (للأونر فقط)")
      .addUserOption((o) =>
        o.setName("user").setDescription("العضو").setRequired(true)
      )
      .toJSON(),

    // 19. أمر تحديد رتبة مسموح لها بإرسال الحسابات
    new SlashCommandBuilder()
      .setName("allowed-to-send-accs")
      .setDescription("تحديد رتبة مسموح لها بإرسال حسابات في الخاص مع حد يومي (للإدارة)")
      .addRoleOption((o) =>
        o.setName("role").setDescription("الرتبة المسموح لها بإرسال الحسابات").setRequired(true)
      )
      .addIntegerOption((o) =>
        o.setName("daily-limit").setDescription("أقصى عدد حسابات يسمح بإرسالها يومياً (0 = بدون حد)").setRequired(true).setMinValue(0)
      )
      .toJSON(),
  ];

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("[OK] Slash commands registered.");
  } catch (err) {
    console.error("[ERROR] Failed to register slash commands:", err.message);
    if (err && err.code === 50001) {
      console.error("[HINT] البوت غير مخوّل بتسجيل أوامر — تأكد أنه مدعو بسكوب applications.commands، وأن DISCORD_CLIENT_ID يطابق التوكن.");
    }
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`[OK] Bot is online as ${c.user.tag}`);
  await loadBotConfig();
  await migrateStockToMongo();
  startAutoUpdateSystem();
});

/* ============================================================================
 *  (5) التعامل مع الأوامر (Slash Commands)
 * ==========================================================================*/
client.on(Events.InteractionCreate, async (interaction) => {
  try {
  // معالجة Autocomplete
  if (interaction.isAutocomplete()) {
    const { commandName } = interaction;
    const guildId = interaction.guildId || null;

    if (commandName === "delete-button") {
      const focusedValue = interaction.options.getFocused();
      const buttons = db.getButtons(guildId);

      const filtered = buttons
        .filter(btn => btn.name.toLowerCase().includes(focusedValue.toLowerCase()))
        .map(btn => ({
          name: `${btn.emoji} ${btn.name} (${btn.id})`,
          value: btn.id
        }))
        .slice(0, 25); // Discord limit

      await interaction.respond(filtered).catch(() => {});
    }

    if (commandName === "delete-panel" || commandName === "set-deadline") {
      const focusedValue = interaction.options.getFocused();
      const panels = db.getPanels(guildId);

      const filtered = panels
        .filter(p => p.name.toLowerCase().includes(focusedValue.toLowerCase()))
        .map(p => ({
          name: `${p.name} (${p.id})`,
          value: p.id
        }))
        .slice(0, 25);

      await interaction.respond(filtered).catch(() => {});
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;
  const guildId = interaction.guildId || null;

  // أ) أمر فحص التيك توك وفحص الوهمي
  if (commandName === "stats") {
    await interaction.deferReply();
    const url = interaction.options.getString("url", true);
    const stats = await getTikTokStats(url);

    if (stats.error) {
      const errContainer = new ContainerBuilder()
        .setAccentColor(0xed4245)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent("## خطأ: فشل الفحص"),
          new TextDisplayBuilder().setContent(stats.error)
        );
      return interaction.editReply({ components: [errContainer], flags: MessageFlags.IsComponentsV2 });
    }

    const { minViews } = await getBotConfig(guildId);
    const analysis = analyzeTikTokEngagement(stats);
    const passedMin = (stats.views || 0) >= minViews;

    let detailsText = analysis.details || "";
    if (detailsText.length > 1500) detailsText = detailsText.substring(0, 1500) + "...";

    const container = new ContainerBuilder()
      .setAccentColor(analysis.color)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`## إحصائيات فيديو TikTok وتحليل التفاعل\n[${url}](${url})`)
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `المشاهدات: **${(stats.views ?? 0).toLocaleString("en-US")}**\n` +
          `اللايكات: **${(stats.likes ?? 0).toLocaleString("en-US")}**\n` +
          `التعليقات: **${(stats.comments ?? 0).toLocaleString("en-US")}**\n` +
          `المشاركات: **${(stats.shares ?? 0).toLocaleString("en-US")}**`
        )
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**شرط الحد الأدنى**\n` +
          `الحد المطلوب: **${minViews.toLocaleString("en-US")}**\n` +
          `الحالة: ${passedMin ? "متجاوز للشرط" : "أقل من المطلوب"}`
        ),
        new TextDisplayBuilder().setContent(
          `**فحص المشاهدات الوهمية**\n` +
          `الحالة: **${analysis.score}**\n` +
          `نسب التفاعل: \`${analysis.ratioText}\`\n\n` +
          `**التقرير الفني:**\n${detailsText}`
        )
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `${new Date().toLocaleString("en-US")}\n` +
          `طريقة جلب البيانات: ${stats.source === "json" ? "سحب دقيق (JSON)" : "تحليل واجهة (DOM)"}`
        )
      );

    return interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
  }

  // ب) لوحة التحكم بالإدارة
  if (commandName === "control-panel") {
    // التحقق من صلاحيات الآدمن
    if (!interaction.member?.permissions.has("Administrator")) {
      return interaction.reply({ content: "خطأ: هذا الأمر مخصص لمدراء النظام فقط.", flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();
    const currentStock = await db.getStockCount(guildId);
    const { minViews, logChannelId } = await getBotConfig(guildId);
    const customButtons = db.getButtons(guildId).filter(btn => btn.enabled);

    const container = new ContainerBuilder()
      .setAccentColor(0x5865f2)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('## لوحة تحكم إدارة الجوائز والتسليم')
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "مرحباً بك في نظام تسليم الجوائز التلقائي والمخزون.\n\n" +
          "استخدم الأزرار أدناه للتحكم في المخزون أو بدء عملية تسليم مباشرة لأي عضو."
        )
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`** المخزون الحالي:** \`${currentStock}\` حساب متوفر حالياً.`),
        new TextDisplayBuilder().setContent(`** الحد الأدنى للمشاهدات:** \`${minViews.toLocaleString("en-US")}\` مشاهدة.`),
        new TextDisplayBuilder().setContent(`** قناة السجلات (Logs):** ${logChannelId ? `<#${logChannelId}>` : "`غير محددة`"}`)
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`\`${new Date().toLocaleString("en-US")}\` · لوحة تحكم الإدارة`)
      );

    // الصف الأول: الأزرار الأساسية
    const firstRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("btn_add_stock")
        .setLabel(" إضافة حسابات للمخزون")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("btn_send_prize")
        .setLabel(" إرسال جائزة لعضو")
        .setStyle(ButtonStyle.Success)
    );

    const components = [firstRow];

    // إضافة الأزرار المخصصة (5 أزرار في كل صف)
    if (customButtons.length > 0) {
      const colorMap = {
        green: ButtonStyle.Success,
        gray: ButtonStyle.Secondary,
        blue: ButtonStyle.Primary,
        red: ButtonStyle.Danger
      };

      for (let i = 0; i < customButtons.length; i += 5) {
        const rowButtons = customButtons.slice(i, i + 5);
        const actionRow = new ActionRowBuilder();

        rowButtons.forEach(btn => {
          actionRow.addComponents(
            new ButtonBuilder()
              .setCustomId(`custom_btn_${btn.id}`)
              .setLabel(`${btn.emoji} ${btn.name}`)
              .setStyle(colorMap[btn.color] || ButtonStyle.Primary)
          );
        });

        components.push(actionRow);
      }
    }

    container.addActionRowComponents(...components);
    return interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
  }

  // ج) أمر تسليم مباشر (/deliver)
  if (commandName === "deliver") {
    const targetUser = interaction.options.getUser("user", true);
    const type = interaction.options.getString("type", true);
    const count = interaction.options.getInteger("count") || 1;

    // لا يمكن إظهار مودال بعد deferReply — نؤجل الرد فقط لفرع المخزون
    if (type === "stock") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
    const permission = await canSendAccounts(interaction.member, type === "stock" ? count : 1, guildId);
    if (!permission.allowed) {
      if (type === "stock") {
        return interaction.editReply({ content: `خطأ: ${permission.reason}` });
      }
      return interaction.reply({ content: `خطأ: ${permission.reason}`, flags: MessageFlags.Ephemeral });
    }

    if (type === "stock") {
      const available = await db.getStockCount(guildId);
      if (available === 0) {
        return interaction.editReply({ content: "خطأ: المخزون فارغ تماماً حالياً! قم بإضافة حسابات أولاً." });
      }
      if (available < count) {
        return interaction.editReply({ content: `خطأ: لا يوجد سوى **${available}** حسابات فقط في المخزون حالياً. لا يمكنك سحب **${count}**.` });
      }

      const pulled = await db.pullStock(count, guildId);
      
      // إرسال للعضو
      const dmSent = await sendPrizeToUser(targetUser, pulled, "dm", guildId);
      if (!dmSent) {
        // لو الخاص مغلق، نرجع الحسابات للمخزون
        await db.addStock(pulled, guildId);
        return await interaction.editReply({ content: `خطأ: تعذر إرسال الجائزة إلى ${targetUser} لأن حسابه مغلق الخاص! تمت إعادة الحسابات للمخزون.` });
      }

      // إرسال اللوق
      await sendDeliveryLog(client, {
        admin: interaction.user,
        recipient: targetUser,
        type: "stock",
        prizeContent: pulled,
        count: count,
        source: "direct_slash",
        guildId
      });

      if (!permission.isAdmin) db.recordAccSends(interaction.user.id, count, guildId);

      return await interaction.editReply({ content: `تم تم تسليم **${count}** حساب بنجاح إلى الخاص للعضو ${targetUser}. تم تسجيل العملية في اللوج.` });
    } else {
      // يدوي: نفتح Modal فوري لكتابة الجائزة يدوياً
      const deliveryId = `del_${Date.now()}`;
      activeDeliveries.set(deliveryId, { targetUserId: targetUser.id, deliveryType: "manual", source: "deliver" });

      const modal = new ModalBuilder()
        .setCustomId(`modal_manual_delivery_${deliveryId}`)
        .setTitle("️ تسليم يدوي للجائزة");

      const prizeInput = new TextInputBuilder()
        .setCustomId("prize_text")
        .setLabel("اكتب الجائزة هنا بالتفصيل")
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder("مثال: حساب تيك توك، كود نيترو، إلخ...")
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(prizeInput));
      await safeShowModal(interaction, modal);
    }
  }

  // د) أمر تحديد قناة اللوج (/set-log-channel)
  if (commandName === "set-log-channel") {
    if (!interaction.member?.permissions.has("Administrator")) {
      return interaction.reply({ content: "خطأ: هذا الأمر مخصص لمدراء النظام فقط.", flags: MessageFlags.Ephemeral });
    }

    const channel = interaction.options.getChannel("channel", true);
    if (!channel.isTextBased()) {
      return interaction.reply({ content: "خطأ: يجب اختيار قناة نصية لإرسال السجلات إليها.", flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await updateBotConfig({ logChannelId: channel.id }, guildId);

    // اختبار إرسال رسالة للقناة للتأكد من صلاحيات البوت
    let testMessage = `تم تم بنجاح ضبط قناة السجلات لتكون: ${channel}`;
    const fetchedChannel = await client.channels.fetch(channel.id).catch((err) => {
      console.warn("[WARN] Failed to fetch selected log channel:", err.message);
      testMessage += `\nتنبيه: لم يتم العثور على القناة أو البوت لا يصلها: ${err.message}`;
      return null;
    });
    if (fetchedChannel) {
      await fetchedChannel.send({ content: "تم تفعيل قناة اللوق بنجاح." }).catch((err) => {
        console.warn("[WARN] Failed to send test log:", err.message);
        testMessage += `\nتنبيه: البوت لا يستطيع الإرسال لهذه القناة: ${err.message}`;
      });
    } else {
      testMessage += "\nتنبيه: تأكد من أن البوت موجود في القناة ويملك صلاحية الإرسال.";
    }

    const container = new ContainerBuilder()
      .setAccentColor(0x57f287)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('##  تحديث قناة السجلات')
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(testMessage)
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(new Date().toLocaleString('en-US'))
      );

    return interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
  }

  // هـ) أمر تحديد الحد الأدنى للمشاهدات (/set-min-views)
  if (commandName === "set-min-views") {
    if (!interaction.member?.permissions.has("Administrator")) {
      return interaction.reply({ content: "خطأ: هذا الأمر مخصص لمدراء النظام فقط.", flags: MessageFlags.Ephemeral });
    }

    const views = interaction.options.getInteger("views", true);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await updateBotConfig({ minViews: views }, guildId);

    const container = new ContainerBuilder()
      .setAccentColor(0x57f287)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('##  تحديث شرط المشاهدات')
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('تم تم بنجاح تحديد الحد الأدنى للمشاهدات ليكون: **`' + views.toLocaleString('en-US') + '`** مشاهدة.')
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(new Date().toLocaleString('en-US'))
      );

    return interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
  }

  // و) أمر إضافة زر مخصص (/add-button)
  if (commandName === "add-button") {
    if (!interaction.member?.permissions.has("Administrator")) {
      return interaction.reply({ content: "خطأ: هذا الأمر مخصص لمدراء النظام فقط.", flags: MessageFlags.Ephemeral });
    }

    const name = interaction.options.getString("name", true);
    const emoji = interaction.options.getString("emoji", true);
    const color = interaction.options.getString("color", true);
    const response = interaction.options.getString("response", true);
    const terms = interaction.options.getString("terms");

    const button = db.addButton({
      name,
      emoji,
      color,
      response,
      terms
    }, guildId);

    const container = new ContainerBuilder()
      .setAccentColor(0x57f287)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('## تم تم إضافة الزر بنجاح')
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`تم إضافة زر جديد للوحة التحكم بالبيانات التالية:\n\n**الاسم:** ${name}\n**الإيموجي:** ${emoji}\n**اللون:** ${color}\n**الرد:** ${response.substring(0, 50)}...\n**الشروط:** ${terms ? 'تم مفعل' : 'خطأ: غير مفعل'}`)
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('**معرف الزر:** `' + button.id + '`')
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(new Date().toLocaleString('en-US'))
      );

    return interaction.reply({ components: [container], flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
  }

  // ز) أمر حذف زر مخصص (/delete-button)
  if (commandName === "delete-button") {
    if (!interaction.member?.permissions.has("Administrator")) {
      return interaction.reply({ content: "خطأ: هذا الأمر مخصص لمدراء النظام فقط.", flags: MessageFlags.Ephemeral });
    }

    const buttonId = interaction.options.getString("button-id", true);
    const deleted = db.deleteButton(buttonId, guildId);

    if (deleted) {
      return interaction.reply({ content: "تم تم حذف الزر بنجاح من لوحة التحكم.", flags: MessageFlags.Ephemeral });
    } else {
      return interaction.reply({ content: "خطأ: لم يتم العثور على الزر المحدد.", flags: MessageFlags.Ephemeral });
    }
  }

  // ح) أمر قائمة الأزرار المخصصة (/list-buttons)
  if (commandName === "list-buttons") {
    if (!interaction.member?.permissions.has("Administrator")) {
      return interaction.reply({ content: "خطأ: هذا الأمر مخصص لمدراء النظام فقط.", flags: MessageFlags.Ephemeral });
    }

    const buttons = db.getButtons(guildId);

    if (buttons.length === 0) {
      return interaction.reply({ content: "خطأ: لا توجد أزرار مخصصة حالياً. استخدم `/add-button` لإضافة زر جديد.", flags: MessageFlags.Ephemeral });
    }

    const container = new ContainerBuilder()
      .setAccentColor(0x5865f2)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('## قائمة الأزرار المخصصة')
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`يوجد **${buttons.length}** زر مخصص في لوحة التحكم.`)
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(new Date().toLocaleString('en-US'))
      );

    buttons.forEach((btn, index) => {
      const btnText = `**${index + 1}. ${btn.emoji} ${btn.name}**\n**المعرف:** \`${btn.id}\`\n**اللون:** ${btn.color}\n**الشروط:** ${btn.terms ? "مفعل" : "غير مفعل"}\n**الحالة:** ${btn.enabled ? "مفعل" : "معطل"}`;
      if (estimateContainerTextSize(container) + btnText.length < 3800) {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(btnText)
        );
      }
    });

    return interaction.reply({ components: [container], flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
  }

  // ط) أمر عرض المخزون (/عرض-المخزون)
  if (commandName === "عرض-المخزون") {
    if (!interaction.member?.permissions.has("Administrator")) {
      return interaction.reply({ content: "خطأ: هذا الأمر مخصص لمدراء النظام فقط.", flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const stock = await db.getStockList(guildId);

    if (stock.length === 0) {
      return interaction.editReply({ content: "خطأ: المخزون فارغ حالياً." });
    }

    const container = new ContainerBuilder()
      .setAccentColor(0x5865f2)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('## الحسابات في المخزون')
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`يوجد حالياً **${stock.length}** حساب في المخزون.`)
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(new Date().toLocaleString('en-US'))
      );

    // تقسيم الحسابات على عدة أجزاء (كل جزء 1800 حرف كحد أقصى)
    let currentValue = "";
    let fieldCount = 1;
    stock.forEach((account, index) => {
      const line = `${index + 1}. ${account}\n`;
      if ((currentValue + line).length > 1800) {
        const chunk = `**الحسابات (${fieldCount})**\n\`\`\`\n${currentValue}\`\`\``;
        if (estimateContainerTextSize(container) + chunk.length < 3800) {
          container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(chunk)
          );
        }
        currentValue = line;
        fieldCount++;
      } else {
        currentValue += line;
      }
    });

    if (currentValue.length > 0) {
      const chunk = `**الحسابات (${fieldCount})**\n\`\`\`\n${currentValue}\`\`\``;
      if (estimateContainerTextSize(container) + chunk.length < 3800) {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(chunk)
        );
      }
    }

    return interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
  }

  // ي) أمر إزالة حساب من المخزون (/ازالة-مخزون)
  if (commandName === "ازالة-مخزون") {
    if (!interaction.member?.permissions.has("Administrator")) {
      return interaction.reply({ content: "خطأ: هذا الأمر مخصص لمدراء النظام فقط.", flags: MessageFlags.Ephemeral });
    }

    const account = interaction.options.getString("account", true);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const removed = await db.removeStock(account, guildId);

    if (removed) {
      // إرسال للوق
      await sendDeliveryLog(client, {
        admin: interaction.user,
        recipient: { id: "N/A", tag: "إزالة من المخزون" },
        type: "manual",
        prizeContent: `تم إزالة الحساب التالي من المخزون: ${account}`,
        count: 1,
        source: "remove_stock",
        guildId
      });

      return interaction.editReply({
        content: `تم تم حذف الحساب من المخزون بنجاح:\n\`\`\`\n${account}\n\`\`\``
      });
    } else {
      return interaction.editReply({ content: "خطأ: لم يتم العثور على هذا الحساب في المخزون." });
    }
  }

  // ك) أمر حذف المخزون كامل (/حذف-مخزون-كامل)
  if (commandName === "حذف-مخزون-كامل") {
    if (!interaction.member?.permissions.has("Administrator")) {
      return interaction.reply({ content: "خطأ: هذا الأمر مخصص لمدراء النظام فقط.", flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const stock = await db.getStockList(guildId);

    if (stock.length === 0) {
      return interaction.editReply({ content: "خطأ: المخزون فارغ بالفعل." });
    }

    const interactionId = `clear_${Date.now()}`;

    const container = new ContainerBuilder()
      .setAccentColor(0xed4245)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('## تنبيه: تأكيد حذف المخزون')
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`أنت على وشك حذف **${stock.length}** حساب من المخزون.\n\nهل أنت متأكد؟`)
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(new Date().toLocaleString('en-US'))
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`confirm_clear_stock_${interactionId}`)
        .setLabel("تم نعم، احذف المخزون")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`cancel_clear_stock_${interactionId}`)
        .setLabel("خطأ: إلغاء")
        .setStyle(ButtonStyle.Secondary)
    );

    container.addActionRowComponents(row);
    return interaction.editReply({
      components: [container],
      flags: MessageFlags.IsComponentsV2
    });
  }

  // 12. أمر إضافة حسابات للمخزون
  if (commandName === "add-accounts") {
    if (!interaction.member?.permissions.has("Administrator")) {
      return interaction.reply({ content: "خطأ: هذا الأمر مخصص لمدراء النظام فقط.", flags: MessageFlags.Ephemeral });
    }

    const accountsInput = interaction.options.getString("accounts", true);
    const lines = accountsInput.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

    if (lines.length === 0) {
      return interaction.reply({ content: "خطأ: لم يتم إدخال أي حسابات صحيحة.", flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const addedCount = await db.addStock(lines, guildId);

    if (addedCount > 0) {
      await sendDeliveryLog(client, {
        admin: interaction.user,
        recipient: { id: "N/A", tag: "إضافة للمخزون" },
        type: "manual",
        prizeContent: lines,
        count: addedCount,
        source: "add_stock",
        guildId
      });
    }

    const container = new ContainerBuilder()
      .setAccentColor(0x57f287)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent("## تحديث المخزون")
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`تم بنجاح إضافة **${addedCount}** حساب إلى المخزون.`)
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`إجمالي المخزون الآن: **\`${await db.getStockCount(guildId)}\`** حساب.`)
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(new Date().toLocaleString("en-US"))
      );

    return interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
  }

  // 13. أمر إنشاء لوحة مقاطع TikTok
  if (commandName === "create-panel") {
    if (!interaction.member?.permissions.has("Administrator")) {
      return interaction.reply({ content: "خطأ: هذا الأمر مخصص لمدراء النظام فقط.", flags: MessageFlags.Ephemeral });
    }

    const description = interaction.options.getString("description", true);
    const buttonName = interaction.options.getString("button-name", true);
    const buttonColor = interaction.options.getString("button-color", true);
    const image = interaction.options.getString("image") || null;
    const logChannel = interaction.options.getChannel("log-channel");

    const colorMap = {
      green: ButtonStyle.Success,
      red: ButtonStyle.Danger,
      blue: ButtonStyle.Primary,
      gray: ButtonStyle.Secondary
    };

    const panel = db.addPanel({
      name: buttonName,
      description,
      image,
      buttonColor,
      buttonName,
      logChannelId: logChannel ? logChannel.id : null
    }, guildId);

    const container = new ContainerBuilder()
      .setAccentColor(0x5865f2)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent("## " + buttonName)
      );

    if (image) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`![صورة اللوحة](${image})`)
      );
    }

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(description)
      )
      .addSeparatorComponents(new SeparatorBuilder());

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`panel_btn_${panel.id}`)
        .setLabel(buttonName)
        .setStyle(colorMap[buttonColor] || ButtonStyle.Primary)
    );

    container.addActionRowComponents(row);

    // إرسال اللوحة في القناة الحالية (بدون معلومات إدارية)
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const sentMessage = await interaction.channel.send({
      components: [container],
      flags: MessageFlags.IsComponentsV2
    });

    db.updatePanel(panel.id, { messageId: sentMessage.id, channelId: sentMessage.channelId }, guildId);

    return interaction.editReply({
      content: `تم إنشاء اللوحة بنجاح. المعرف: \`${panel.id}\``
    });
  }

  // 14. أمر حذف لوحة
  if (commandName === "delete-panel") {
    if (!interaction.member?.permissions.has("Administrator")) {
      return interaction.reply({ content: "خطأ: هذا الأمر مخصص لمدراء النظام فقط.", flags: MessageFlags.Ephemeral });
    }

    const panelId = interaction.options.getString("panel-id", true);
    const panel = db.getPanel(panelId, guildId);

    if (!panel) {
      return interaction.reply({ content: "خطأ: اللوحة غير موجودة.", flags: MessageFlags.Ephemeral });
    }

    db.deletePanel(panelId, guildId);
    return interaction.reply({
      content: `تم حذف اللوحة \`${panel.name}\` بنجاح.`,
      flags: MessageFlags.Ephemeral
    });
  }

  // 15. أمر عرض اللوحات
  if (commandName === "list-panels") {
    if (!interaction.member?.permissions.has("Administrator")) {
      return interaction.reply({ content: "خطأ: هذا الأمر مخصص لمدراء النظام فقط.", flags: MessageFlags.Ephemeral });
    }

    const panels = db.getPanels(guildId);

    if (panels.length === 0) {
      return interaction.reply({ content: "لا توجد لوحات حالياً.", flags: MessageFlags.Ephemeral });
    }

    const container = new ContainerBuilder()
      .setAccentColor(0x5865f2)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent("## قائمة اللوحات")
      );

    for (const p of panels) {
      const deadlineText = p.deadlineDuration ? formatDuration(p.deadlineDuration) : "لا توجد";
      const panelText = `**${p.name}** — \`${p.id}\` — اللون: ${p.buttonColor} — المهلة: ${deadlineText} — قناة اللوج: ${p.logChannelId ? `<#${p.logChannelId}>` : "الافتراضية"}`;
      if (estimateContainerTextSize(container) + panelText.length < 3800) {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(panelText)
        );
      }
    }

    return interaction.reply({ components: [container], flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
  }

  // 15.5 أمر تحديد مهلة اللوحة (/set-deadline)
  if (commandName === "set-deadline") {
    if (!interaction.member?.permissions.has("Administrator")) {
      return interaction.reply({ content: "خطأ: هذا الأمر مخصص لمدراء النظام فقط.", flags: MessageFlags.Ephemeral });
    }

    const panelId = interaction.options.getString("panel-id", true);
    const durationInput = interaction.options.getString("duration", true);
    const panel = db.getPanel(panelId, guildId);

    if (!panel) {
      return interaction.reply({ content: "خطأ: اللوحة غير موجودة.", flags: MessageFlags.Ephemeral });
    }

    const durationMs = parseDuration(durationInput);
    if (!durationMs) {
      return interaction.reply({
        content: "خطأ: صيغة المدة غير صحيحة. استخدم مثل: `3d`، `72h`، `1w`، `30m`، `15s` أو `3d/72h`.",
        flags: MessageFlags.Ephemeral
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    db.setPanelDeadline(panelId, durationMs, guildId);

    const display = formatDuration(durationMs);

    return interaction.editReply({
      content: `تم تحديد مهلة استلام اللوحة **${panel.name}** إلى **${display}**.\nأي مقطع يُرسل عبرها يجب أن يُستلم خلال هذه المدة، وإذا تأخّر سيظهر للعضو: "وقتك خلص".`
    });
  }

  // 16. أمر فحص حسابات الخاص (/check-dm)
  if (commandName === "check-dm") {
    const targetUser = interaction.options.getUser("user") || interaction.user;

    if (targetUser.id !== interaction.user.id && !interaction.member?.permissions.has("Administrator")) {
      return interaction.reply({ content: "خطأ: لا يمكنك فحص حسابات عضو آخر.", flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const sentAccounts = await getSentAccounts(targetUser.id, guildId);

    if (sentAccounts.length === 0) {
      return interaction.editReply({ content: `ما في حسابات مسجلة لـ ${targetUser}.` });
    }

    const dm = await targetUser.createDM().catch(() => null);
    if (!dm) {
      return interaction.editReply({ content: "خطأ: تعذر فتح الخاص. تأكد أن الخاص مفتوح." });
    }

    for (const account of sentAccounts) {
      await dm.send({
        content: `إعادة إرسال الحساب\n\n**الجائزة:**\n\`\`\`\n${account.prize}\n\`\`\``
      }).catch(() => {});
    }

    return interaction.editReply({ content: `تم إعادة إرسال ${sentAccounts.length} سجل إلى خاص ${targetUser}.` });
  }

  // 17. أمر الباند (/ban)
  if (commandName === "ban") {
    if (interaction.user.id !== OWNER_ID) {
      return interaction.reply({ content: "خطأ: هذا الأمر مخصص للأونر فقط.", flags: MessageFlags.Ephemeral });
    }

    const targetUser = interaction.options.getUser("user", true);
    const reason = interaction.options.getString("reason") || "بدون سبب";

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await banUser(targetUser.id, targetUser.tag || targetUser.username, interaction.user.id, reason);
    if (result.success) {
      return interaction.editReply({ content: `تم حظر ${targetUser} من استلام الحسابات.\nالسبب: ${reason}` });
    } else {
      return interaction.editReply({ content: `خطأ: فشل الحظر — ${result.error || "غير معروف"}` });
    }
  }

  // 18. أمر فك الباند (/unban)
  if (commandName === "unban") {
    if (interaction.user.id !== OWNER_ID) {
      return interaction.reply({ content: "خطأ: هذا الأمر مخصص للأونر فقط.", flags: MessageFlags.Ephemeral });
    }

    const targetUser = interaction.options.getUser("user", true);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const removed = await unbanUser(targetUser.id);

    if (removed) {
      return interaction.editReply({ content: `تم رفع الحظر عن ${targetUser}.` });
    } else {
      return interaction.editReply({ content: `${targetUser} مو محظور أصلاً.` });
    }
  }

  // 19. أمر تحديد رتبة مسموح لها بإرسال الحسابات
  if (commandName === "allowed-to-send-accs") {
    if (!interaction.member?.permissions.has("Administrator")) {
      return interaction.reply({ content: "خطأ: هذا الأمر مخصص لمدراء النظام فقط.", flags: MessageFlags.Ephemeral });
    }

    const role = interaction.options.getRole("role", true);
    const dailyLimit = interaction.options.getInteger("daily-limit", true);

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await db.setSendAccConfig(role.id, dailyLimit, guildId);

    return interaction.editReply({
      content: `تم تحديث صلاحيات إرسال الحسابات:\n**الرتبة:** ${role} \u2014 ${role.name}\n**الحد اليومي:** ${dailyLimit} حساب${dailyLimit === 1 ? "" : "ات"}${dailyLimit === 0 ? " (بدون حد)" : ""}.`
    });
  }
  } catch (err) {
    if (err && err.code === 10062) {
      console.warn("[WARN] انتهت صلاحية تفاعل سلاش (Unknown interaction) — تم تجاهله.");
      return;
    }
    console.error("[ERROR] فشل في معالجة أمر السلاش:", err);
    await safeReply(interaction, { content: "حدث خطأ غير متوقع أثناء تنفيذ الأمر.", flags: MessageFlags.Ephemeral });
  }
});

/* ============================================================================
 *  (6) وظيفة إرسال الجائزة للعضو وتصحيح الرسالة الإملائية
 * ==========================================================================*/
async function sendPrizeToUser(user, prizeData, source = "dm", guildId = null) {
  if (!user) {
    console.warn("[WARN] Cannot send prize: user is null");
    return false;
  }

  const prizeDisplay = Array.isArray(prizeData) ? prizeData.join("\n") : prizeData;

  if (await isBanned(user.id)) {
    console.warn(`[WARN] Refused to send prize to banned user ${user.id}`);
    return false;
  }

  // الرسالة إملائياً وتنسيقها الرائع بناءً على طلبك
  const messageContent =
    `تم تسليمك الجائزة\n\n` +
    `**الجائزة:**\n` +
    `\`\`\`\n${prizeDisplay}\n\`\`\``;

  try {
    const dm = await user.createDM().catch(() => null);
    if (!dm) {
      console.warn(`[WARN] Failed to create DM for ${user.tag || user.id}`);
      return false;
    }
    await dm.send({ content: messageContent });
    await saveSentAccount(user.id, user.tag || user.username, prizeDisplay, source, guildId);
    return true;
  } catch (err) {
    console.warn(`[WARN] Failed to send DM to ${user.tag || user.id}:`, err.message);
    return false;
  }
}

// مساعد لمعرفة ما إذا انتهت مهلة المقطع
function isSubmissionExpired(submission) {
  if (!submission || !submission.deadlineAt) return false;
  return new Date(submission.deadlineAt).getTime() < Date.now();
}

// إرسال رسالة "وقتك خلص" للعضو
async function notifyDeadlineExpired(user) {
  if (!user) return;
  try {
    const dm = await user.createDM().catch(() => null);
    if (!dm) return;
    await dm.send({ content: "وقتك خلص" });
  } catch {
    // تجاهل خطأ الخاص المغلق
  }
}

// مساعد لتنسيق المدة الزمنية باللغة العربية
function formatDuration(ms) {
  if (!ms || ms <= 0) return "بدون مهلة";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} ثانية`;
  const minutes = Math.round(ms / (60 * 1000));
  if (minutes < 60) return `${minutes} دقيقة`;
  const hours = Math.round(ms / (60 * 60 * 1000));
  if (hours < 24) return `${hours} ساعة`;
  const days = Math.round(ms / (24 * 60 * 60 * 1000));
  return `${days} يوم`;
}

/* ============================================================================
 *  (7) التعامل مع التفاعلات (Buttons, Menus, Modals)
 * ==========================================================================*/
client.on(Events.InteractionCreate, async (interaction) => {
  try {
  const guildId = interaction.guildId || null;

  // --- أولاُ: التعامل مع الأزرار ---
  if (interaction.isButton()) {
    const { customId } = interaction;

    // 0) زر لوحة TikTok (العضو يرسل رابط المقطع)
    if (customId.startsWith("panel_btn_")) {
      const panelId = customId.replace("panel_btn_", "");
      const panel = db.getPanel(panelId, guildId);

      if (!panel || !panel.enabled) {
        return interaction.reply({ content: "خطأ: هذه اللوحة غير موجودة أو معطلة.", flags: MessageFlags.Ephemeral });
      }

      const modal = new ModalBuilder()
        .setCustomId(`modal_panel_video_${panelId}`)
        .setTitle("إرسال رابط مقطع TikTok");

      const linkInput = new TextInputBuilder()
        .setCustomId("video_link")
        .setLabel("أدخل رابط مقطع TikTok")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("https://www.tiktok.com/@user/video/...")
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(linkInput));
      return safeShowModal(interaction, modal);
    }

    // 0.1) أزرار مراجعة المقاطع من قناة اللوج
    if (customId.startsWith("panel_accept_auto_")) {
      const submissionId = customId.replace("panel_accept_auto_", "");
      const submission = db.getSubmission(submissionId, guildId);

      if (!submission || submission.status !== "pending") {
        return interaction.reply({ content: "خطأ: الطلب غير موجود أو تمت معالجته مسبقاً.", flags: MessageFlags.Ephemeral });
      }

      if (!interaction.member?.permissions.has("Administrator")) {
        return interaction.reply({ content: "خطأ: لا تملك صلاحية القبول.", flags: MessageFlags.Ephemeral });
      }

      const targetUser = await client.users.fetch(submission.userId).catch(() => null);
      if (!targetUser) {
        return interaction.reply({ content: "خطأ: تعذر العثور على العضو المُرسل.", flags: MessageFlags.Ephemeral });
      }

      // منع استلام نفس المقطع مرتين
      if (db.hasDeliveredVideo(submission.userId, submission.videoLink, guildId)) {
        return interaction.reply({ content: "خطأ: هذا المقطع سبق وتم استلامه من قبل لنفس العضو.", flags: MessageFlags.Ephemeral });
      }

      // التحقق من مهلة الاستلام
      if (isSubmissionExpired(submission)) {
        await notifyDeadlineExpired(targetUser);
        db.updateSubmission(submissionId, { status: "expired" }, guildId);
        return interaction.reply({ content: "خطأ: انتهت مهلة استلام هذا المقطع (وقتك خلص).", flags: MessageFlags.Ephemeral });
      }

      const currentStock = await db.getStockCount(guildId);
      if (currentStock === 0) {
        return interaction.reply({ content: "خطأ: المخزون فارغ.", flags: MessageFlags.Ephemeral });
      }

      // نسأل الأدمن كم حساب يريد تسليمه
      const deliveryId = `del_auto_${Date.now()}`;
      activeDeliveries.set(deliveryId, {
        targetUserId: submission.userId,
        submissionId,
        panelId: submission.panelId
      });

      const modal = new ModalBuilder()
        .setCustomId(`modal_panel_auto_qty_${deliveryId}`)
        .setTitle("عدد الحسابات");

      const qtyInput = new TextInputBuilder()
        .setCustomId("quantity_number")
        .setLabel(`كم حساب تبي تسلم؟ (المتوفر: ${currentStock})`)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("1")
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(qtyInput));
      return safeShowModal(interaction, modal);
    }

    if (customId.startsWith("panel_accept_manual_")) {
      const submissionId = customId.replace("panel_accept_manual_", "");
      const submission = db.getSubmission(submissionId, guildId);

      if (!submission || submission.status !== "pending") {
        return interaction.reply({ content: "خطأ: الطلب غير موجود أو تمت معالجته مسبقاً.", flags: MessageFlags.Ephemeral });
      }

      if (!interaction.member?.permissions.has("Administrator")) {
        return interaction.reply({ content: "خطأ: لا تملك صلاحية القبول.", flags: MessageFlags.Ephemeral });
      }

      const targetUser = await client.users.fetch(submission.userId).catch(() => null);
      if (!targetUser) {
        return interaction.reply({ content: "خطأ: تعذر العثور على العضو المُرسل.", flags: MessageFlags.Ephemeral });
      }

      // منع استلام نفس المقطع مرتين
      if (db.hasDeliveredVideo(submission.userId, submission.videoLink, guildId)) {
        return interaction.reply({ content: "خطأ: هذا المقطع سبق وتم استلامه من قبل لنفس العضو.", flags: MessageFlags.Ephemeral });
      }

      // التحقق من مهلة الاستلام
      if (isSubmissionExpired(submission)) {
        await notifyDeadlineExpired(targetUser);
        db.updateSubmission(submissionId, { status: "expired" }, guildId);
        return interaction.reply({ content: "خطأ: انتهت مهلة استلام هذا المقطع (وقتك خلص).", flags: MessageFlags.Ephemeral });
      }

      const deliveryId = `del_manual_${Date.now()}`;
      activeDeliveries.set(deliveryId, {
        targetUserId: submission.userId,
        submissionId,
        panelId: submission.panelId
      });

      const modal = new ModalBuilder()
        .setCustomId(`modal_panel_manual_delivery_${deliveryId}`)
        .setTitle("تسليم يدوي للمقطع");

      const prizeInput = new TextInputBuilder()
        .setCustomId("prize_text")
        .setLabel("اكتب الجائزة هنا بالتفصيل")
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder("مثال: حساب تيك توك...")
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(prizeInput));
      return safeShowModal(interaction, modal);
    }

    if (customId.startsWith("panel_reject_start_")) {
      const submissionId = customId.replace("panel_reject_start_", "");
      const submission = db.getSubmission(submissionId, guildId);

      if (!submission || submission.status !== "pending") {
        return interaction.reply({ content: "خطأ: الطلب غير موجود أو تمت معالجته مسبقاً.", flags: MessageFlags.Ephemeral });
      }

      if (!interaction.member?.permissions.has("Administrator")) {
        return interaction.reply({ content: "خطأ: لا تملك صلاحية الرفض.", flags: MessageFlags.Ephemeral });
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`panel_reject_with_reason_${submissionId}`)
          .setLabel("نعم، أرسل سبب")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`panel_reject_no_reason_${submissionId}`)
          .setLabel("لا، لا يوجد سبب")
          .setStyle(ButtonStyle.Secondary)
      );

      return interaction.reply({
        content: "هل تبي ترسل سبب الرفض للشخص؟",
        components: [row],
        flags: MessageFlags.Ephemeral
      });
    }

    if (customId.startsWith("panel_reject_with_reason_")) {
      const submissionId = customId.replace("panel_reject_with_reason_", "");

      const modal = new ModalBuilder()
        .setCustomId(`modal_panel_reject_reason_${submissionId}`)
        .setTitle("سبب الرفض");

      const reasonInput = new TextInputBuilder()
        .setCustomId("reject_reason")
        .setLabel("اكتب سبب الرفض")
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder("...")
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
      return safeShowModal(interaction, modal);
    }

    if (customId.startsWith("panel_reject_no_reason_")) {
      const submissionId = customId.replace("panel_reject_no_reason_", "");
      const submission = db.getSubmission(submissionId, guildId);

      if (!submission) {
        return interaction.reply({ content: "خطأ: الطلب غير موجود.", flags: MessageFlags.Ephemeral });
      }

      const targetUser = await client.users.fetch(submission.userId).catch(() => null);
      if (targetUser) {
        await targetUser.send({ content: "تم رفض مقطع TikTok الذي أرسلته." }).catch(() => {});
      }

      db.updateSubmission(submissionId, {
        status: "rejected",
        adminId: interaction.user.id,
        adminTag: interaction.user.tag
      }, guildId);

      return interaction.update({
        content: `تم رفض الطلب بدون سبب من ${interaction.user.tag}`,
        components: []
      });
    }

    // أ) زر إضافة حسابات للمخزون
    if (customId === "btn_add_stock") {
      if (!interaction.member?.permissions.has("Administrator")) {
        return interaction.reply({ content: "خطأ: لا تملك صلاحية تعديل المخزون.", flags: MessageFlags.Ephemeral });
      }

      const modal = new ModalBuilder()
        .setCustomId("modal_add_stock")
        .setTitle(" إضافة حسابات للمخزون");

      // خيار 1: لصق الحسابات نصياً (اختياري — يمكن استخدام رفع الملف بدلاً منه)
      const stockInput = new TextInputBuilder()
        .setCustomId("stock_accounts")
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder("user:pass1\nuser:pass2\nuser:pass3")
        .setRequired(false);

      const stockLabel = new LabelBuilder()
        .setLabel("لصق الحسابات (كل سطر = حساب)")
        .setDescription("اختياري: الصق الحسابات هنا، أو استخدم خيار رفع الملف بالأسفل.")
        .setTextInputComponent(stockInput);

      // خيار 2: رفع ملف نصي يحتوي الحسابات (كل سطر = حساب)
      const fileUpload = new FileUploadBuilder()
        .setCustomId("stock_file")
        .setMinValues(0)
        .setMaxValues(1)
        .setRequired(false);

      const fileLabel = new LabelBuilder()
        .setLabel("رفع ملف الحسابات (.txt)")
        .setDescription("اختياري: ارفع ملف نصي يحتوي الحسابات (كل سطر = حساب). يمكن الجمع بين اللصق والملف.")
        .setFileUploadComponent(fileUpload);

      modal.addLabelComponents(stockLabel, fileLabel);
      return safeShowModal(interaction, modal);
    }

    // ب) زر إرسال جائزة (يفتح قائمة منسدلة لاختيار العضو)
    if (customId === "btn_send_prize") {
      if (!interaction.member?.permissions.has("Administrator")) {
        return interaction.reply({ content: "خطأ: هذا الزر مخصص للأدمن فقط.", flags: MessageFlags.Ephemeral });
      }

      const userSelect = new UserSelectMenuBuilder()
        .setCustomId("select_recipient")
        .setPlaceholder("اختر العضو المراد تسليمه الجائزة ")
        .setMinValues(1)
        .setMaxValues(1);

      const row = new ActionRowBuilder().addComponents(userSelect);

      return interaction.reply({
        content: " الرجاء اختيار العضو المستلم من القائمة أدناه لتحديد طريقة التسليم:",
        components: [row],
        flags: MessageFlags.Ephemeral
      });
    }

    // ج) معالجة الأزرار المخصصة
    if (customId.startsWith("custom_btn_")) {
      const buttonId = customId.replace("custom_btn_", "");
      const button = db.getButton(buttonId, guildId);

      if (!button || !button.enabled) {
        return interaction.reply({ content: "خطأ: هذا الزر غير موجود أو معطل.", flags: MessageFlags.Ephemeral });
      }

      // التحقق من وجود شروط
      if (button.terms) {
        // عرض سؤال الموافقة على الشروط
        const container = new ContainerBuilder()
          .setAccentColor(0x5865f2)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("## شروط الاستخدام")
          )
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(button.terms)
          )
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(new Date().toLocaleString("en-US"))
          );

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`terms_accept_${buttonId}`)
            .setLabel("أوافق")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`terms_decline_${buttonId}`)
            .setLabel("لا أوافق")
            .setStyle(ButtonStyle.Danger)
        );

        container.addActionRowComponents(row);
        return interaction.reply({ components: [container], flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
      } else {
        // لا توجد شروط، إرسال الرد مباشرة
        return interaction.reply({ content: button.response, flags: MessageFlags.Ephemeral });
      }
    }

    // د) معالجة استجابة الموافقة على الشروط
    if (customId.startsWith("terms_accept_")) {
      const buttonId = customId.replace("terms_accept_", "");
      const button = db.getButton(buttonId, guildId);

      if (!button) {
        return interaction.update({ content: "خطأ: حدث خطأ في العملية.", components: [] });
      }

      // فتح Modal لإدخال رابط المقطع
      const modal = new ModalBuilder()
        .setCustomId(`modal_video_link_${buttonId}`)
        .setTitle(" إرسال رابط المقطع");

      const linkInput = new TextInputBuilder()
        .setCustomId("video_link")
        .setLabel("أدخل رابط مقطع TikTok")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("https://www.tiktok.com/@user/video/...")
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(linkInput));
      return safeShowModal(interaction, modal);
    }

    // هـ) معالجة رفض الشروط
    if (customId.startsWith("terms_decline_")) {
      return interaction.update({ 
        content: "خطأ: تم إلغاء العملية لأنك لم توافق على الشروط.", 
        components: [] 
      });
    }

    // و) تأكيد حذف المخزون كامل
    if (customId.startsWith("confirm_clear_stock_")) {
      if (!interaction.member?.permissions.has("Administrator")) {
        return interaction.reply({ content: "خطأ: لا تملك صلاحية حذف المخزون.", flags: MessageFlags.Ephemeral });
      }

      const stock = await db.getStockList(guildId);

      if (stock.length === 0) {
        return interaction.update({ content: "خطأ: المخزون فارغ بالفعل.", components: [] });
      }

      await interaction.deferUpdate();

      // إرسال اللوق قبل الحذف
      await sendDeliveryLog(client, {
        admin: interaction.user,
        recipient: { id: "N/A", tag: "حذف مخزون كامل" },
        type: "manual",
        prizeContent: stock,
        count: stock.length,
        source: "clear_stock",
        guildId
      });

      // حذف كل المخزون
      const removed = await db.clearStock(guildId);

      const container = new ContainerBuilder()
        .setAccentColor(0x57f287)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent("## تم الحذف")
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`تم حذف المخزون كاملاً.\nعدد الحسابات المحذوفة: **${removed.length}**\nتم تسجيل كل الحسابات في اللوق.`)
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(new Date().toLocaleString("en-US"))
        );

      return await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2
      });
    }

    // ز) إلغاء حذف المخزون كامل
    if (customId.startsWith("cancel_clear_stock_")) {
      return interaction.update({ 
        content: "خطأ: تم إلغاء حذف المخزون.", 
        components: [] 
      });
    }
  }

  // --- ثانياً: التعامل مع قوائم الاختيار (Select Menus) ---
  if (interaction.isUserSelectMenu() && interaction.customId === "select_recipient") {
    const targetUserId = interaction.values[0];
    const interactionId = `flow_${Date.now()}`;
    
    // حفظ العضو المستهدف في الذاكرة المؤقتة لمتابعة العملية
    activeDeliveries.set(interactionId, { targetUserId, source: "control_panel" });

    const deliveryTypeSelect = new StringSelectMenuBuilder()
      .setCustomId(`select_delivery_type_${interactionId}`)
      .setPlaceholder("اختر طريقة التسليم ")
      .addOptions([
        {
          label: "️ تسليم يدوي",
          description: "كتابة الجائزة الآن يدوياً لإرسالها للعضو",
          value: "manual"
        },
        {
          label: " من المخزون",
          description: "سحب حسابات تلقائياً من المخزون الحالي المضاف للبوت",
          value: "stock"
        }
      ]);

    const row = new ActionRowBuilder().addComponents(deliveryTypeSelect);

    return interaction.update({
      content: ` تم اختيار العضو: <@${targetUserId}>\nالآن، يرجى اختيار طريقة التسليم:`,
      components: [row]
    });
  }

  if (interaction.isStringSelectMenu()) {
    const { customId } = interaction;

    // أ) بعد اختيار طريقة التسليم (يدوي أو مخزون)
    if (customId.startsWith("select_delivery_type_")) {
      const interactionId = customId.replace("select_delivery_type_", "");
      const flow = activeDeliveries.get(interactionId);

      if (!flow) {
        return interaction.update({ content: "خطأ: انتهت صلاحية هذه العملية الموقرة. يرجى البدء من جديد.", components: [] });
      }

      const deliveryType = interaction.values[0];
      flow.deliveryType = deliveryType;
      activeDeliveries.set(interactionId, flow);

      const targetUser = await client.users.fetch(flow.targetUserId).catch(() => null);
      if (!targetUser) {
        return interaction.update({ content: "خطأ: تعذر العثور على العضو المختار في الخادم.", components: [] });
      }

      if (deliveryType === "manual") {
        // يفتح المودال فوراً للكتابة اليدوية
        const modal = new ModalBuilder()
          .setCustomId(`modal_manual_delivery_${interactionId}`)
          .setTitle("️ تسليم يدوي للجائزة");

        const prizeInput = new TextInputBuilder()
          .setCustomId("prize_text")
          .setLabel("اكتب الجائزة هنا بالتفصيل")
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder("مثال: حساب تيك توك، كود نيترو، إلخ...")
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(prizeInput));
        return safeShowModal(interaction, modal);
      } else {
        // من المخزون: نسأله عدد الحسابات مباشرة
        const currentStock = await db.getStockCount(guildId);
        if (currentStock === 0) {
          return interaction.update({
            content: `خطأ: المخزون فارغ تماماً حالياً! الرجاء تعبئته أولاً قبل السحب منه.`,
            components: []
          });
        }

        const modal = new ModalBuilder()
          .setCustomId(`modal_custom_quantity_${interactionId}`)
          .setTitle(" عدد الحسابات");

        const qtyInput = new TextInputBuilder()
          .setCustomId("quantity_number")
          .setLabel(`كم حساب تبي تسلم من المخزون؟ (المتوفر: ${currentStock})`)
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("مثال: 1")
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(qtyInput));
        return safeShowModal(interaction, modal);
      }
    }

    // ب) قديم: لم يعد يُستخدم
    if (customId.startsWith("select_stock_quantity_")) {
      return interaction.update({ 
        content: "خطأ: انتهت صلاحية هذه العملية. الرجاء البدء من جديد باستخدام زر إرسال جائزة.", 
        components: [] 
      });
    }
  }

  // --- ثالثاً: التعامل مع المودالات (Modals) ---
  if (interaction.isModalSubmit()) {
    const { customId } = interaction;

    // أ) مودال إضافة الحسابات للمخزون (لصق نصي +/أو رفع ملف)
    if (customId === "modal_add_stock") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      // دالة فرز ذكية: تقسم النص على الأسطر أولاً، وإذا لم يوجد أسطر
      // تحاول الفصل على فواصل بديلة (فاصلة، تبويب، مسافة متعددة).
      // كل سطر/عنصر = حساب واحد. تُزال المسافات الزائدة والأسطر الفارغة.
      const parseAccounts = (text) => {
        if (!text || !text.trim()) return [];
        // تقسيم على أي نوع من نهايات الأسطر
        let parts = text.split(/\r\n|\r|\n/);
        // إذا كان النص سطراً واحداً بدون نهايات أسطر، جرّب فواصل بديلة
        if (parts.length === 1) {
          // فصل على فاصلة أو تبويب أو مسافة متعددة (للملفات التي تستخدمها كفواصل)
          const alt = parts[0].split(/[\t,;]+|\s{2,}/);
          if (alt.length > 1) parts = alt;
        }
        // تنظيف: إزالة المسافات الزائدة، BOM، والأسطر الفارغة
        return parts
          .map(l => l.replace(/^\uFEFF/, "").trim())
          .filter(l => l.length > 0);
      };

      let pasteAccounts = [];
      let fileAccounts = [];
      let fileNames = [];

      // 1) الحسابات الملصقة نصياً (اختياري — قد لا تُملأ إذا رفع المستخدم ملفاً)
      let inputAccounts = "";
      try {
        inputAccounts = interaction.fields.getTextInputValue("stock_accounts") || "";
      } catch {
        inputAccounts = "";
      }
      pasteAccounts = parseAccounts(inputAccounts);

      // 2) الحسابات من الملف المرفوع
      const uploadedFiles = interaction.fields.getUploadedFiles("stock_file", false);
      if (uploadedFiles && uploadedFiles.size > 0) {
        for (const attachment of uploadedFiles.values()) {
          try {
            const res = await fetch(attachment.url);
            if (!res.ok) {
              return await interaction.editReply({ content: `خطأ: تعذر تنزيل الملف \`${attachment.name}\` (HTTP ${res.status}).` });
            }
            const text = await res.text();
            const parsed = parseAccounts(text);
            fileAccounts.push(...parsed);
            fileNames.push(`${attachment.name} (${parsed.length} حساب)`);
          } catch (e) {
            return await interaction.editReply({ content: `خطأ: فشل قراءة الملف \`${attachment.name}\`: ${e.message}` });
          }
        }
      }

      // دمج كل الحسابات وإزالة التكرارات داخل نفس الدفعة
      const allRaw = [...pasteAccounts, ...fileAccounts];
      const seen = new Set();
      const cleanLines = [];
      let duplicatesInBatch = 0;
      for (const acc of allRaw) {
        const lower = acc.toLowerCase();
        if (seen.has(lower)) {
          duplicatesInBatch++;
          continue;
        }
        seen.add(lower);
        cleanLines.push(acc);
      }

      if (cleanLines.length === 0) {
        return await interaction.editReply({ content: "خطأ: لم يتم إدخال أي حسابات. الصق الحسابات أو ارفع ملف يحتويها (كل سطر = حساب)." });
      }

      const totalBefore = await db.getStockCount(guildId);
      const addedCount = await db.addStock(cleanLines, guildId);
      const totalAfter = await db.getStockCount(guildId);
      const skippedDuplicates = cleanLines.length - addedCount; // المكرر في المخزون

      if (addedCount > 0) {
        await sendDeliveryLog(client, {
          admin: interaction.user,
          recipient: { id: "N/A", tag: "إضافة للمخزون" },
          type: "manual",
          prizeContent: cleanLines,
          count: addedCount,
          source: "add_stock_modal",
          guildId
        });
      }

      // بناء تفاصيل المصادر
      const sourceDetails = [];
      if (pasteAccounts.length > 0) sourceDetails.push(`لصق نصي: **${pasteAccounts.length}** حساب`);
      if (fileAccounts.length > 0) sourceDetails.push(`ملف مرفوع: **${fileAccounts.length}** حساب\n- ${fileNames.join("\n- ")}`);

      const container = new ContainerBuilder()
        .setAccentColor(0x57f287)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent("## تحديث المخزون")
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`تم بنجاح إضافة **${addedCount}** حساب جديد إلى المخزون.`)
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`**المصادر:**\n- ${sourceDetails.join("\n- ")}`)
        )
        .addSeparatorComponents(new SeparatorBuilder());

      const statsLines = [
        `إجمالي الحسابات المُدخلة: **${allRaw.length}**`,
        `تكرارات داخل الدفعة (تم دمجها): **${duplicatesInBatch}**`,
        `حسابات فريدة أُرسلت للإضافة: **${cleanLines.length}**`,
        `مكرر موجود مسبقاً في المخزون (تم تخطيه): **${skippedDuplicates}**`,
        `تمت إضافته فعلياً: **${addedCount}**`,
        `إجمالي المخزون الآن: **\`${totalAfter}\`** حساب (كان \`${totalBefore}\`).`,
      ];
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(statsLines.join("\n"))
      );

      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(new Date().toLocaleString("en-US"))
        );

      return await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
    }

    // ب) مودال التسليم اليدوي (سواءً من الزر أو من أمر السلاش)
    if (customId.startsWith("modal_manual_delivery_")) {
      const interactionId = customId.replace("modal_manual_delivery_", "");
      const flow = activeDeliveries.get(interactionId);

      if (!flow) {
        return interaction.reply({ content: "خطأ: انتهت صلاحية هذه العملية. يرجى البدء من جديد.", flags: MessageFlags.Ephemeral });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const targetUser = await client.users.fetch(flow.targetUserId).catch(() => null);
      if (!targetUser) {
        return await interaction.editReply({ content: "خطأ: تعذر العثور على العضو." });
      }

      let permission;
      if (flow.source === "deliver") {
        permission = await canSendAccounts(interaction.member, 1, guildId);
      } else {
        permission = { allowed: interaction.member?.permissions.has("Administrator"), isAdmin: true, reason: "هذا الإرسال مخصص للأدمن فقط." };
      }
      if (!permission.allowed) {
        activeDeliveries.delete(interactionId);
        return await interaction.editReply({ content: `خطأ: ${permission.reason}` });
      }

      const prizeText = interaction.fields.getTextInputValue("prize_text");
      const dmSent = await sendPrizeToUser(targetUser, prizeText, "dm", guildId);

      if (!dmSent) {
        return await interaction.editReply({ content: `خطأ: فشل تسليم الجائزة لـ ${targetUser} لأن الخاص لديه مغلق! تأكد من فتح الخاص أولاً.` });
      }

      await sendDeliveryLog(client, {
        admin: interaction.user,
        recipient: targetUser,
        type: "manual",
        prizeContent: prizeText,
        count: 1,
        source: "manual_modal",
        guildId
      });

      if (!permission.isAdmin) db.recordAccSends(interaction.user.id, 1, guildId);

      // تنظيف الذاكرة المؤقتة
      activeDeliveries.delete(interactionId);

      return await interaction.editReply({
        content: `تم تم تسليم الجائزة اليدوية بنجاح إلى خاص العضو ${targetUser}. تم تسجيل العملية بالكامل في اللوج.`
      });
    }

    // ج) مودال إدخال عدد مخصص من المخزون
    if (customId.startsWith("modal_custom_quantity_")) {
      const interactionId = customId.replace("modal_custom_quantity_", "");
      const flow = activeDeliveries.get(interactionId);

      if (!flow) {
        return interaction.reply({ content: "خطأ: انتهت صلاحية العملية. يرجى البدء من جديد.", flags: MessageFlags.Ephemeral });
      }

      const targetUser = await client.users.fetch(flow.targetUserId).catch(() => null);
      if (!targetUser) {
        return await interaction.editReply({ content: "خطأ: تعذر العثور على العضو." });
      }

      const qtyText = interaction.fields.getTextInputValue("quantity_number");
      const count = parseInt(qtyText.trim(), 10);

      if (isNaN(count) || count <= 0) {
        return interaction.reply({ content: "خطأ: الرجاء إدخال رقم صحيح أكبر من صفر.", flags: MessageFlags.Ephemeral });
      }

      if (!interaction.member?.permissions.has("Administrator")) {
        activeDeliveries.delete(interactionId);
        return interaction.reply({ content: "خطأ: هذا الإرسال مخصص للأدمن فقط.", flags: MessageFlags.Ephemeral });
      }

      const available = await db.getStockCount(guildId);
      if (available === 0) {
        return interaction.reply({ content: "خطأ: المخزون فارغ تماماً حالياً!", flags: MessageFlags.Ephemeral });
      }

      if (available < count) {
        return interaction.reply({
          content: `خطأ: المخزون غير كافٍ. يتوفر حالياً **${available}** حساب فقط، ولا يمكنك سحب **${count}**.`,
          flags: MessageFlags.Ephemeral
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const pulled = await db.pullStock(count, guildId);
      const dmSent = await sendPrizeToUser(targetUser, pulled, "dm", guildId);

      if (!dmSent) {
        await db.addStock(pulled, guildId); // إعادة الحسابات للمخزون
        return await interaction.editReply({ content: `خطأ: فشل تسليم الحسابات لـ ${targetUser} لأن الخاص لديه مغلق! تمت إعادة الحسابات للمخزون.` });
      }

      await sendDeliveryLog(client, {
        admin: interaction.user,
        recipient: targetUser,
        type: "stock",
        prizeContent: pulled,
        count: count,
        source: "custom_qty_modal",
        guildId
      });

      // تنظيف الذاكرة المؤقتة
      activeDeliveries.delete(interactionId);

      return await interaction.editReply({
        content: `تم تم سحب **${count}** حساب بنجاح من المخزون وحذفها تلقائياً، وتسليمها لـ ${targetUser}. تم تسجيل العملية بالكامل في اللوج.`
      });
    }

    // د) مودال إدخال رابط المقطع من لوحة TikTok
    if (customId.startsWith("modal_panel_video_")) {
      const panelId = customId.replace("modal_panel_video_", "");
      const panel = db.getPanel(panelId, guildId);

      if (!panel) {
        return interaction.reply({ content: "خطأ: اللوحة غير موجودة.", flags: MessageFlags.Ephemeral });
      }

      const videoLink = interaction.fields.getTextInputValue("video_link");

      // منع استلام نفس المقطع مرتين (حتى لو أُرسل من جديد)
      if (db.hasDeliveredVideo(interaction.user.id, videoLink, guildId)) {
        return interaction.reply({ content: "خطأ: لقد استلمت هذا المقطع مسبقاً ولا يمكن استلامه مرتين.", flags: MessageFlags.Ephemeral });
      }

      // منع إرسال نفس المقطع أكثر من مرة في نفس اليوم
      if (db.hasSubmittedLinkToday(interaction.user.id, videoLink, guildId)) {
        return interaction.reply({ content: "خطأ: لقد أرسلت هذا المقطع اليوم مسبقاً. يمكنك إرساله مرة واحدة فقط في اليوم.", flags: MessageFlags.Ephemeral });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const stats = await getTikTokStats(videoLink);

      if (stats.error) {
        return await interaction.editReply({ content: `خطأ: ${stats.error}` });
      }

      // رفض تلقائي إذا كانت المشاهدات أقل من الحد الأدنى المحدد
      const botConfig = await getBotConfig(guildId);
      const { minViews } = botConfig;
      if ((stats.views ?? 0) < minViews) {
        return await interaction.editReply({
          content: `تم رفض المقطع تلقائياً: عدد المشاهدات (\`${(stats.views ?? 0).toLocaleString("en-US")}\`) أقل من الحد الأدنى المطلوب (\`${minViews.toLocaleString("en-US")}\`).`
        });
      }

      const submission = db.addSubmission({
        panelId,
        userId: interaction.user.id,
        userTag: interaction.user.tag,
        videoLink,
        stats
      }, guildId);

      // قناة اللوق المحددة بأمر /set-log-channel لها الأولوية، وقناة اللوحة احتياطية
      const logChannelId = botConfig.logChannelId || panel.logChannelId;

      if (!logChannelId) {
        return await interaction.editReply({ content: "خطأ: لم يتم تحديد قناة اللوج. تواصل مع الإدارة." });
      }

      const logChannel = await client.channels.fetch(logChannelId).catch(() => null);
      if (!logChannel) {
        return await interaction.editReply({ content: "خطأ: قناة اللوج غير موجودة أو لا يمكن الوصول لها." });
      }

      const deadlineText = panel.deadlineDuration
        ? `**المهلة:** ${formatDuration(panel.deadlineDuration)} من وقت الإرسال`
        : "**المهلة:** لا توجد";

      const container = new ContainerBuilder()
        .setAccentColor(0x5865f2)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`## طلب مراجعة مقطع TikTok`)
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**المرسل:** ${interaction.user} — \`${interaction.user.tag}\`\n` +
            `**رابط المقطع:** ${videoLink}\n` +
            `**المشاهدات:** ${(stats.views ?? 0).toLocaleString("en-US")}\n` +
            `**اللايكات:** ${(stats.likes ?? 0).toLocaleString("en-US")}\n` +
            `**التعليقات:** ${(stats.comments ?? 0).toLocaleString("en-US")}\n` +
            `**المشاركات:** ${(stats.shares ?? 0).toLocaleString("en-US")}\n` +
            deadlineText
          )
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`${new Date().toLocaleString("en-US")}`)
        );

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`panel_accept_auto_${submission.id}`)
          .setLabel("قبول وتسليم أوتو")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`panel_reject_start_${submission.id}`)
          .setLabel("رفض")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`panel_accept_manual_${submission.id}`)
          .setLabel("قبول وتسليم يدوي")
          .setStyle(ButtonStyle.Primary)
      );

      container.addActionRowComponents(row);

      const logMessage = await logChannel.send({ components: [container], flags: MessageFlags.IsComponentsV2 });

      db.updateSubmission(submission.id, {
        logMessageId: logMessage.id,
        logChannelId: logMessage.channelId
      }, guildId);

      let replyText = "تم إرسال المقطع للمراجعة. ستصلك النتيجة في الخاص قريباً.";
      if (submission.deadlineAt) {
        const deadlineTs = Math.round(new Date(submission.deadlineAt).getTime() / 1000);
        replyText += `\n\nمهلة الاستلام حتى: <t:${deadlineTs}:F> (<t:${deadlineTs}:R>)`;
      }

      return await interaction.editReply({ content: replyText });
    }

    // د-2) مودال عدد الحسابات للقبول الأوتو
    if (customId.startsWith("modal_panel_auto_qty_")) {
      const deliveryId = customId.replace("modal_panel_auto_qty_", "");
      const flow = activeDeliveries.get(deliveryId);

      if (!flow) {
        return interaction.reply({ content: "خطأ: انتهت صلاحية العملية.", flags: MessageFlags.Ephemeral });
      }

      const qtyText = interaction.fields.getTextInputValue("quantity_number");
      const count = parseInt(qtyText.trim(), 10);

      if (isNaN(count) || count <= 0) {
        return interaction.reply({ content: "خطأ: أدخل رقم صحيح أكبر من صفر.", flags: MessageFlags.Ephemeral });
      }

      if (!interaction.member?.permissions.has("Administrator")) {
        activeDeliveries.delete(deliveryId);
        return interaction.reply({ content: "خطأ: هذا الإرسال مخصص للأدمن فقط.", flags: MessageFlags.Ephemeral });
      }

      const available = await db.getStockCount(guildId);
      if (available === 0) {
        return interaction.reply({ content: "خطأ: المخزون فارغ.", flags: MessageFlags.Ephemeral });
      }

      if (available < count) {
        return interaction.reply({
          content: `خطأ: المخزون غير كافٍ. يتوفر حالياً **${available}** حساب فقط.`,
          flags: MessageFlags.Ephemeral
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const targetUser = await client.users.fetch(flow.targetUserId).catch(() => null);
      if (!targetUser) {
        activeDeliveries.delete(deliveryId);
        return await interaction.editReply({ content: "خطأ: تعذر العثور على العضو." });
      }

      const submission = db.getSubmission(flow.submissionId, guildId);
      if (!submission) {
        activeDeliveries.delete(deliveryId);
        return await interaction.editReply({ content: "خطأ: لم يتم العثور على طلب المقطع." });
      }

      // فحص أمان نهائي: منع التكرار والمهلة المنقضية
      if (db.hasDeliveredVideo(submission.userId, submission.videoLink, guildId)) {
        activeDeliveries.delete(deliveryId);
        return await interaction.editReply({ content: "خطأ: هذا المقطع سبق وتم استلامه من قبل لنفس العضو." });
      }

      if (isSubmissionExpired(submission)) {
        await notifyDeadlineExpired(targetUser);
        db.updateSubmission(flow.submissionId, { status: "expired" }, guildId);
        activeDeliveries.delete(deliveryId);
        return await interaction.editReply({ content: "خطأ: انتهت مهلة هذا المقطع (وقتك خلص)." });
      }

      const pulled = await db.pullStock(count, guildId);
      const dmSent = await sendPrizeToUser(targetUser, pulled, "dm", guildId);

      if (!dmSent) {
        await db.addStock(pulled, guildId);
        activeDeliveries.delete(deliveryId);
        return await interaction.editReply({
          content: `خطأ: فشل إرسال الحسابات لـ ${targetUser} لأن الخاص مغلق! تمت إعادة الحسابات للمخزون.`
        });
      }

      db.updateSubmission(flow.submissionId, {
        status: "accepted_auto",
        adminId: interaction.user.id,
        adminTag: interaction.user.tag,
        deliveredContent: pulled
      }, guildId);

      await sendDeliveryLog(client, {
        admin: interaction.user,
        recipient: targetUser,
        type: "stock",
        prizeContent: pulled,
        count,
        source: "panel_auto_accept",
        guildId
      });

      activeDeliveries.delete(deliveryId);
      return await interaction.editReply({
        content: `تم قبول المقطع وتسليم **${count}** حساب أوتوماتيكياً لـ ${targetUser}.`
      });
    }

    // د-3) مودال التسليم اليدوي من لوحة TikTok
    if (customId.startsWith("modal_panel_manual_delivery_")) {
      const deliveryId = customId.replace("modal_panel_manual_delivery_", "");
      const flow = activeDeliveries.get(deliveryId);

      if (!flow) {
        return interaction.reply({ content: "خطأ: انتهت صلاحية العملية.", flags: MessageFlags.Ephemeral });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const targetUser = await client.users.fetch(flow.targetUserId).catch(() => null);
      if (!targetUser) {
        activeDeliveries.delete(deliveryId);
        return await interaction.editReply({ content: "خطأ: تعذر العثور على العضو." });
      }

      if (!interaction.member?.permissions.has("Administrator")) {
        activeDeliveries.delete(deliveryId);
        return await interaction.editReply({ content: "خطأ: هذا الإرسال مخصص للأدمن فقط." });
      }

      const submission = db.getSubmission(flow.submissionId, guildId);
      if (!submission) {
        activeDeliveries.delete(deliveryId);
        return await interaction.editReply({ content: "خطأ: لم يتم العثور على طلب المقطع." });
      }

      // فحص أمان نهائي: منع التكرار والمهلة المنقضية
      if (db.hasDeliveredVideo(submission.userId, submission.videoLink, guildId)) {
        activeDeliveries.delete(deliveryId);
        return await interaction.editReply({ content: "خطأ: هذا المقطع سبق وتم استلامه من قبل لنفس العضو." });
      }

      if (isSubmissionExpired(submission)) {
        await notifyDeadlineExpired(targetUser);
        db.updateSubmission(flow.submissionId, { status: "expired" }, guildId);
        activeDeliveries.delete(deliveryId);
        return await interaction.editReply({ content: "خطأ: انتهت مهلة هذا المقطع (وقتك خلص)." });
      }

      const prizeText = interaction.fields.getTextInputValue("prize_text");
      const dmSent = await sendPrizeToUser(targetUser, prizeText, "dm", guildId);

      if (!dmSent) {
        activeDeliveries.delete(deliveryId);
        return await interaction.editReply({
          content: `خطأ: فشل إرسال الجائزة لـ ${targetUser} لأن الخاص مغلق.`
        });
      }

      db.updateSubmission(flow.submissionId, {
        status: "accepted_manual",
        adminId: interaction.user.id,
        adminTag: interaction.user.tag,
        deliveredContent: prizeText
      }, guildId);

      await sendDeliveryLog(client, {
        admin: interaction.user,
        recipient: targetUser,
        type: "manual",
        prizeContent: prizeText,
        count: 1,
        source: "panel_manual_accept",
        guildId
      });

      activeDeliveries.delete(deliveryId);
      return await interaction.editReply({
        content: `تم قبول المقطع وتسليم الجائزة يدوياً لـ ${targetUser}.`
      });
    }

    // د-4) مودال سبب الرفض
    if (customId.startsWith("modal_panel_reject_reason_")) {
      const submissionId = customId.replace("modal_panel_reject_reason_", "");
      const submission = db.getSubmission(submissionId, guildId);

      if (!submission) {
        return interaction.reply({ content: "خطأ: الطلب غير موجود.", flags: MessageFlags.Ephemeral });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const reason = interaction.fields.getTextInputValue("reject_reason");
      const targetUser = await client.users.fetch(submission.userId).catch(() => null);

      if (targetUser) {
        await targetUser.send({
          content: `تم رفض مقطع TikTok الذي أرسلته.\n\n**السبب:** ${reason}`
        }).catch(() => {});
      }

      db.updateSubmission(submissionId, {
        status: "rejected",
        adminId: interaction.user.id,
        adminTag: interaction.user.tag,
        reason
      }, guildId);

      return await interaction.editReply({
        content: "تم رفض الطلب وإرسال السبب للعضو في الخاص."
      });
    }

    // د) مودال إدخال رابط المقطع بعد الموافقة على الشروط
    if (customId.startsWith("modal_video_link_")) {
      const buttonId = customId.replace("modal_video_link_", "");
      const button = db.getButton(buttonId, guildId);

      if (!button) {
        return interaction.reply({ content: "خطأ: حدث خطأ في العملية.", flags: MessageFlags.Ephemeral });
      }

      const videoLink = interaction.fields.getTextInputValue("video_link");

      // حفظ الإيمبد في قاعدة البيانات
      db.addEmbed({
        buttonId: buttonId,
        userId: interaction.user.id,
        videoLink: videoLink
      }, guildId);

      // معالجة الرابط وإرسال الرد المخفي
      const container = new ContainerBuilder()
        .setAccentColor(0x5865f2)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`## ${button.emoji} ${button.name}`)
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(button.response)
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`**رابط المقطع:** ${videoLink}`)
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(new Date().toLocaleString("en-US"))
        );

      return interaction.reply({ components: [container], flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
    }
  }
  } catch (err) {
    if (err && err.code === 10062) {
      console.warn("[WARN] انتهت صلاحية تفاعل زر/قائمة/مودال (Unknown interaction) — تم تجاهله.");
      return;
    }
    console.error("[ERROR] فشل في معالجة التفاعل (زر/قائمة/مودال):", err);
    await safeReply(interaction, { content: "حدث خطأ غير متوقع أثناء معالجة التفاعل.", flags: MessageFlags.Ephemeral });
  }
});

// التعامل مع الرسائل التقليدية (للتصحيح أو إرسال البانل بأمر عادي)
client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;
  const guildId = msg.guildId || null;

  if (msg.content === "!control-panel") {
    if (!msg.member.permissions.has("Administrator")) return;

    const currentStock = await db.getStockCount(guildId);
    const { minViews, logChannelId } = await getBotConfig(guildId);

    const container = new ContainerBuilder()
      .setAccentColor(0x5865f2)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent("## لوحة تحكم إدارة الجوائز والتسليم")
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "مرحباً بك في نظام تسليم الجوائز التلقائي والمخزون.\n\n" +
          "استخدم الأزرار أدناه للتحكم في المخزون أو بدء عملية تسليم مباشرة لأي عضو."
        )
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**المخزون الحالي:** \`${currentStock}\` حساب متوفر حالياً.\n` +
          `**الحد الأدنى للمشاهدات:** \`${minViews.toLocaleString("en-US")}\` مشاهدة.\n` +
          `**قناة السجلات (Logs):** ${logChannelId ? `<#${logChannelId}>` : "`غير محددة`"}`
        )
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`لوحة تحكم الإدارة — ${new Date().toLocaleString("en-US")}`)
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("btn_add_stock")
        .setLabel("إضافة حسابات للمخزون")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("btn_send_prize")
        .setLabel("إرسال جائزة لعضو")
        .setStyle(ButtonStyle.Success)
    );

    container.addActionRowComponents(row);
    await msg.channel.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
  }
});

/* ============================================================================
 *  (8) نظام التحديث التلقائي كل 20 دقيقة
 * ==========================================================================*/
function startAutoUpdateSystem() {
  // تحديث كل 20 دقيقة (1200000 مللي ثانية)
  setInterval(async () => {
    try {
      const guildIds = client.guilds.cache.size > 0 ? [...client.guilds.cache.keys()] : [null];
      let totalUpdated = 0;

      for (const guildId of guildIds) {
        const recentEmbeds = db.getRecentEmbeds(guildId);
        if (recentEmbeds.length === 0) continue;

        console.log(`[AUTO UPDATE] Updating ${recentEmbeds.length} embed(s) for guild ${guildId || "global"}...`);

        for (const embed of recentEmbeds) {
          if (!embed.videoLink || !/tiktok\.com/i.test(embed.videoLink)) {
            console.log(`[AUTO UPDATE] Skipping invalid link for embed: ${embed.id}`);
            continue;
          }

          const stats = await getTikTokStats(embed.videoLink);
          db.updateEmbed(embed.id, {
            lastUpdated: new Date().toISOString(),
            stats
          }, guildId);

          if (stats.error) {
            console.warn(`[AUTO UPDATE] Failed to update ${embed.id}: ${stats.error}`);
          } else {
            console.log(`[AUTO UPDATE] Updated ${embed.id} — views: ${stats.views ?? "?"}, likes: ${stats.likes ?? "?"}, comments: ${stats.comments ?? "?"}, shares: ${stats.shares ?? "?"}`);
          }
        }

        totalUpdated += recentEmbeds.length;
      }

      if (totalUpdated === 0) {
        console.log("[AUTO UPDATE] No embeds to update.");
      } else {
        console.log(`[AUTO UPDATE] Finished updating ${totalUpdated} embed(s).`);
      }
    } catch (error) {
      console.error("[ERROR] Auto update system failed:", error);
    }
  }, 20 * 60 * 1000); // 20 دقيقة

  console.log("[OK] Auto update system started (every 20 minutes).");
}

/* ============================================================================
 *  (9) تسجيل الدخول والبدء
 * ==========================================================================*/
(async () => {
  await connectMongo();
  await registerSlashCommands().catch((e) => console.warn("[WARN] Failed to register slash commands:", e.message));
  await client.login(TOKEN);
})();
