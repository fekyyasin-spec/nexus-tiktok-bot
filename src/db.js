"use strict";

/**
 * db.js
 * ----------------------------------------------------------------------------
 * إدارة البيانات للبوت باستخدام ملف JSON محلي، مع فصل تام حسب السيرفر (guildId).
 * كل سيرفر يملك نسخته الخاصة من: المخزون، الإعدادات، الأزرار، اللوحات، الطلبات، واللوقات.
 * ----------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const mongo = require("./mongo");

const DB_PATH = path.join(__dirname, "..", "database.json");
const DB_TMP_PATH = DB_PATH + ".tmp";
const DB_BAK_PATH = DB_PATH + ".bak";

// الهيكل الافتراضي لبيانات كل سيرفر/عالم
const DEFAULT_DB = {
  stock: [],       // مصفوفة تحتوي على الحسابات/الجوائز
  logs: [],        // سجل عمليات التسليم والفحوصات
  buttons: [],     // مصفوفة الأزرار المخصصة للوحة التحكم
  embeds: [],      // الإيمبدات المرسلة من الأزرار
  panels: [],      // لوحات مقاطع TikTok
  submissions: [], // طلبات المقاطع المُرسلة
  sendAccUsage: {}, // تتبع عدد الحسابات المرسلة يومياً لكل مستخدم
  config: {
    minViews: 1000,
    logChannelId: null,
    allowedToSendRoleId: null,
    allowedToSendDailyLimit: 0
  }
};

function clone(obj) {
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {
    return obj;
  }
}

function ensureDefaults(target) {
  for (const key of Object.keys(DEFAULT_DB)) {
    if (typeof target[key] === "undefined") {
      target[key] = clone(DEFAULT_DB[key]);
    }
  }
  if (target.config && DEFAULT_DB.config) {
    for (const key of Object.keys(DEFAULT_DB.config)) {
      if (typeof target.config[key] === "undefined") {
        target.config[key] = DEFAULT_DB.config[key];
      }
    }
  }
}

/**
 * قراءة البيانات من الملف.
 */
function readDb() {
  try {
    let data;
    if (!fs.existsSync(DB_PATH)) {
      data = clone(DEFAULT_DB);
    } else {
      const raw = fs.readFileSync(DB_PATH, "utf8");
      try {
        data = JSON.parse(raw);
      } catch (parseErr) {
        // الملف تالف — نحاول الاسترجاع من النسخة الاحتياطية
        if (fs.existsSync(DB_BAK_PATH)) {
          try {
            data = JSON.parse(fs.readFileSync(DB_BAK_PATH, "utf8"));
            console.warn("[WARN] database.json was corrupt; restored from database.json.bak");
          } catch {
            data = null;
          }
        }
        if (!data) {
          // نحتفظ بالملف التالف للمراجعة ونبدأ من جديد
          try { fs.renameSync(DB_PATH, DB_PATH + ".corrupt-" + Date.now()); } catch {}
          console.error("[ERROR] database.json corrupt and no valid backup; starting fresh:", parseErr.message);
          data = clone(DEFAULT_DB);
        }
      }
    }
    ensureDefaults(data);
    if (!data.guilds) data.guilds = {};
    for (const gid of Object.keys(data.guilds)) {
      ensureDefaults(data.guilds[gid]);
    }
    writeDb(data);
    return data;
  } catch (err) {
    console.error("[ERROR] Failed to read database:", err);
    return clone(DEFAULT_DB);
  }
}

/**
 * حفظ البيانات في الملف.
 */
function writeDb(data) {
  try {
    const json = JSON.stringify(data, null, 2);
    // كتابة ذرّية: نكتب لملف مؤقت ثم نعيد تسميته حتى لا يتلف الملف عند انقطاع مفاجئ
    fs.writeFileSync(DB_TMP_PATH, json, "utf8");
    // نحتفظ بنسخة من آخر ملف سليم قبل الاستبدال
    try {
      if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, DB_BAK_PATH);
    } catch {}
    fs.renameSync(DB_TMP_PATH, DB_PATH);
    return true;
  } catch (err) {
    console.error("[ERROR] Failed to write database:", err);
    try { if (fs.existsSync(DB_TMP_PATH)) fs.unlinkSync(DB_TMP_PATH); } catch {}
    return false;
  }
}

/**
 * الحصول على كائن بيانات الهدف (سيرفر محدد أو البيانات العامة).
 */
function getTarget(data, guildId) {
  if (!guildId) {
    ensureDefaults(data);
    return data;
  }
  if (!data.guilds) data.guilds = {};
  if (!data.guilds[guildId]) {
    data.guilds[guildId] = clone(DEFAULT_DB);
  }
  ensureDefaults(data.guilds[guildId]);
  return data.guilds[guildId];
}

/**
 * إضافة حسابات للمخزون (كل عنصر سطر).
 * @param {string[]} accounts
 * @param {string|null} guildId
 */
async function addStock(accounts, guildId = null) {
  const clean = accounts.map(a => a.trim()).filter(a => a.length > 0);
  const mongoAdded = await mongo.addStock(clean, guildId);
  if (mongoAdded !== null) return mongoAdded;
  const data = readDb();
  const target = getTarget(data, guildId);
  target.stock.push(...clean);
  writeDb(data);
  return clean.length;
}

/**
 * سحب عدد معين من الحسابات من المخزون.
 * @param {number} count
 * @param {string|null} guildId
 * @returns {string[]}
 */
async function pullStock(count, guildId = null) {
  const mongoPulled = await mongo.pullStock(count, guildId);
  if (mongoPulled !== null) return mongoPulled;
  const data = readDb();
  const target = getTarget(data, guildId);
  if (target.stock.length === 0) return [];
  const actualCount = Math.min(count, target.stock.length);
  const pulled = target.stock.splice(0, actualCount);
  writeDb(data);
  return pulled;
}

/**
 * الحصول على إجمالي المخزون الحالي.
 * @param {string|null} guildId
 */
async function getStockCount(guildId = null) {
  const mongoCount = await mongo.getStockCount(guildId);
  if (mongoCount !== null) return mongoCount;
  const data = readDb();
  const target = getTarget(data, guildId);
  return target.stock.length;
}

/**
 * الحصول على قائمة الحسابات في المخزون.
 * @param {string|null} guildId
 */
async function getStockList(guildId = null) {
  const mongoList = await mongo.getStockList(guildId);
  if (mongoList !== null) return mongoList;
  const data = readDb();
  const target = getTarget(data, guildId);
  return target.stock || [];
}

/**
 * حذف حساب محدد من المخزون.
 * @param {string} account
 * @param {string|null} guildId
 */
async function removeStock(account, guildId = null) {
  const mongoRemoved = await mongo.removeStock(account, guildId);
  if (mongoRemoved !== null) return mongoRemoved;
  const data = readDb();
  const target = getTarget(data, guildId);
  const index = target.stock.findIndex(a => a === account.trim());
  if (index !== -1) {
    target.stock.splice(index, 1);
    writeDb(data);
    return true;
  }
  return false;
}

/**
 * حذف كامل المخزون وإرجاع الحسابات المحذوفة.
 * @param {string|null} guildId
 * @returns {string[]}
 */
async function clearStock(guildId = null) {
  const mongoCleared = await mongo.clearStock(guildId);
  if (mongoCleared !== null) return mongoCleared;
  const data = readDb();
  const target = getTarget(data, guildId);
  const removed = [...target.stock];
  target.stock = [];
  writeDb(data);
  return removed;
}

/**
 * إضافة سجل تسليم أو فحص.
 * @param {string} type
 * @param {object} details
 * @param {string|null} guildId
 */
function addLog(type, details, guildId = null) {
  const data = readDb();
  const target = getTarget(data, guildId);
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).substring(2, 5),
    timestamp: new Date().toISOString(),
    type,
    guildId: guildId || null,
    ...details
  };
  target.logs.push(entry);
  if (target.logs.length > 1000) target.logs.shift();
  writeDb(data);
  return entry;
}

/**
 * تحديث الإعدادات في قاعدة البيانات
 * @param {object} newConfig
 * @param {string|null} guildId
 */
function updateConfig(newConfig, guildId = null) {
  const data = readDb();
  const target = getTarget(data, guildId);
  target.config = { ...(target.config || {}), ...newConfig };
  writeDb(data);
  return target.config;
}

/**
 * إضافة زر مخصص للوحة التحكم
 * @param {object} buttonData
 * @param {string|null} guildId
 */
function addButton(buttonData, guildId = null) {
  const data = readDb();
  const target = getTarget(data, guildId);
  const button = {
    id: `btn_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    name: buttonData.name,
    emoji: buttonData.emoji,
    color: buttonData.color,
    response: buttonData.response,
    terms: buttonData.terms || null,
    guildId: guildId || null,
    createdAt: new Date().toISOString(),
    enabled: true
  };
  target.buttons.push(button);
  writeDb(data);
  return button;
}

/**
 * حذف زر من لوحة التحكم
 * @param {string} buttonId
 * @param {string|null} guildId
 */
function deleteButton(buttonId, guildId = null) {
  const data = readDb();
  const target = getTarget(data, guildId);
  const initialLength = target.buttons.length;
  target.buttons = target.buttons.filter(btn => btn.id !== buttonId);
  writeDb(data);
  return target.buttons.length < initialLength;
}

/**
 * الحصول على جميع الأزرار المخصصة
 * @param {string|null} guildId
 */
function getButtons(guildId = null) {
  const data = readDb();
  const target = getTarget(data, guildId);
  return target.buttons || [];
}

/**
 * الحصول على زر محدد بالمعرف
 * @param {string} buttonId
 * @param {string|null} guildId
 */
function getButton(buttonId, guildId = null) {
  const data = readDb();
  const target = getTarget(data, guildId);
  return target.buttons.find(btn => btn.id === buttonId);
}

/**
 * تفعيل/تعطيل زر
 * @param {string} buttonId
 * @param {boolean} enabled
 * @param {string|null} guildId
 */
function toggleButton(buttonId, enabled, guildId = null) {
  const data = readDb();
  const target = getTarget(data, guildId);
  const button = target.buttons.find(btn => btn.id === buttonId);
  if (button) {
    button.enabled = enabled;
    writeDb(data);
    return true;
  }
  return false;
}

/**
 * إضافة إيمبد جديد
 * @param {object} embedData
 * @param {string|null} guildId
 */
function addEmbed(embedData, guildId = null) {
  const data = readDb();
  const target = getTarget(data, guildId);
  const embed = {
    id: `embed_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    buttonId: embedData.buttonId,
    userId: embedData.userId,
    videoLink: embedData.videoLink,
    guildId: guildId || null,
    timestamp: new Date().toISOString()
  };
  target.embeds.push(embed);
  if (target.embeds.length > 10) {
    target.embeds = target.embeds.slice(-10);
  }
  writeDb(data);
  return embed;
}

/**
 * الحصول على آخر الإيمبدات
 * @param {string|null} guildId
 */
function getRecentEmbeds(guildId = null) {
  const data = readDb();
  const target = getTarget(data, guildId);
  return target.embeds || [];
}

/**
 * تحديث إيمبد محدد
 * @param {string} embedId
 * @param {object} updateData
 * @param {string|null} guildId
 */
function updateEmbed(embedId, updateData, guildId = null) {
  const data = readDb();
  const target = getTarget(data, guildId);
  const embed = target.embeds.find(e => e.id === embedId);
  if (embed) {
    Object.assign(embed, updateData);
    writeDb(data);
    return true;
  }
  return false;
}

/**
 * إضافة لوحة مقاطع TikTok جديدة
 * @param {object} panelData
 * @param {string|null} guildId
 */
function addPanel(panelData, guildId = null) {
  const data = readDb();
  const target = getTarget(data, guildId);
  const panel = {
    id: `panel_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    name: panelData.name,
    description: panelData.description,
    image: panelData.image || null,
    buttonColor: panelData.buttonColor || "blue",
    buttonName: panelData.buttonName,
    logChannelId: panelData.logChannelId || null,
    deadlineDuration: panelData.deadlineDuration || null,
    guildId: guildId || null,
    createdAt: new Date().toISOString(),
    enabled: true
  };
  target.panels.push(panel);
  writeDb(data);
  return panel;
}

/**
 * الحصول على جميع اللوحات
 * @param {string|null} guildId
 */
function getPanels(guildId = null) {
  const data = readDb();
  const target = getTarget(data, guildId);
  return target.panels || [];
}

/**
 * الحصول على لوحة محددة
 * @param {string} panelId
 * @param {string|null} guildId
 */
function getPanel(panelId, guildId = null) {
  const data = readDb();
  const target = getTarget(data, guildId);
  return target.panels.find(p => p.id === panelId);
}

/**
 * تحديث لوحة
 * @param {string} panelId
 * @param {object} updateData
 * @param {string|null} guildId
 */
function updatePanel(panelId, updateData, guildId = null) {
  const data = readDb();
  const target = getTarget(data, guildId);
  const panel = target.panels.find(p => p.id === panelId);
  if (panel) {
    Object.assign(panel, updateData);
    writeDb(data);
    return true;
  }
  return false;
}

/**
 * تحديد/تعديل مهلة استلام المقاطع للوحة
 * @param {string} panelId
 * @param {number|null} durationMs
 * @param {string|null} guildId
 */
function setPanelDeadline(panelId, durationMs, guildId = null) {
  const data = readDb();
  const target = getTarget(data, guildId);
  const panel = target.panels.find(p => p.id === panelId);
  if (!panel) return null;
  panel.deadlineDuration = durationMs || null;
  writeDb(data);
  return panel;
}

/**
 * حذف لوحة
 * @param {string} panelId
 * @param {string|null} guildId
 */
function deletePanel(panelId, guildId = null) {
  const data = readDb();
  const target = getTarget(data, guildId);
  const initialLength = target.panels.length;
  target.panels = target.panels.filter(p => p.id !== panelId);
  writeDb(data);
  return target.panels.length < initialLength;
}

/**
 * تفعيل/تعطيل لوحة
 * @param {string} panelId
 * @param {boolean} enabled
 * @param {string|null} guildId
 */
function togglePanel(panelId, enabled, guildId = null) {
  const data = readDb();
  const target = getTarget(data, guildId);
  const panel = target.panels.find(p => p.id === panelId);
  if (panel) {
    panel.enabled = enabled;
    writeDb(data);
    return true;
  }
  return false;
}

/**
 * إضافة طلب مقطع جديد
 * @param {object} submissionData
 * @param {string|null} guildId
 */
function addSubmission(submissionData, guildId = null) {
  const data = readDb();
  const target = getTarget(data, guildId);

  let deadlineAt = submissionData.deadlineAt || null;
  if (!deadlineAt && submissionData.panelId) {
    const panel = (target.panels || []).find(p => p.id === submissionData.panelId);
    if (panel && panel.deadlineDuration) {
      deadlineAt = new Date(Date.now() + panel.deadlineDuration).toISOString();
    }
  }

  const submission = {
    id: `sub_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    panelId: submissionData.panelId,
    userId: submissionData.userId,
    userTag: submissionData.userTag,
    videoLink: submissionData.videoLink,
    stats: submissionData.stats || {},
    status: "pending",
    adminId: null,
    adminTag: null,
    reason: null,
    deliveredContent: null,
    logMessageId: null,
    deadlineAt,
    guildId: guildId || null,
    timestamp: new Date().toISOString()
  };
  target.submissions.push(submission);
  if (target.submissions.length > 500) {
    target.submissions = target.submissions.slice(-500);
  }
  writeDb(data);
  return submission;
}

/**
 * الحصول على طلب محدد
 * @param {string} submissionId
 * @param {string|null} guildId
 */
function getSubmission(submissionId, guildId = null) {
  const data = readDb();
  const target = getTarget(data, guildId);
  return target.submissions.find(s => s.id === submissionId);
}

/**
 * تطبيع رابط المقطع للمقارنة (إزالة الباراميترات والسلاش الأخير)
 * @param {string} link
 */
function normalizeVideoLink(link) {
  return String(link || "")
    .trim()
    .toLowerCase()
    .split(/[?#]/)[0]
    .replace(/\/+$/, "");
}

/**
 * هل أرسل المستخدم نفس رابط المقطع اليوم مسبقاً؟
 * @param {string} userId
 * @param {string} videoLink
 * @param {string|null} guildId
 */
function hasSubmittedLinkToday(userId, videoLink, guildId = null) {
  const data = readDb();
  const target = getTarget(data, guildId);
  const today = getTodayKey();
  const normalized = normalizeVideoLink(videoLink);
  return (target.submissions || []).some(s =>
    s.userId === userId &&
    typeof s.timestamp === "string" &&
    s.timestamp.slice(0, 10) === today &&
    normalizeVideoLink(s.videoLink) === normalized
  );
}

/**
 * هل استلم/قُبِل المستخدم نفس رابط المقطع مسبقاً؟
 * @param {string} userId
 * @param {string} videoLink
 * @param {string|null} guildId
 */
function hasDeliveredVideo(userId, videoLink, guildId = null) {
  const data = readDb();
  const target = getTarget(data, guildId);
  const normalized = normalizeVideoLink(videoLink);
  return (target.submissions || []).some(s =>
    s.userId === userId &&
    ["accepted_auto", "accepted_manual"].includes(s.status) &&
    normalizeVideoLink(s.videoLink) === normalized
  );
}

/**
 * تحديث طلب
 * @param {string} submissionId
 * @param {object} updateData
 * @param {string|null} guildId
 */
function updateSubmission(submissionId, updateData, guildId = null) {
  const data = readDb();
  const target = getTarget(data, guildId);
  const submission = target.submissions.find(s => s.id === submissionId);
  if (submission) {
    Object.assign(submission, updateData);
    writeDb(data);
    return true;
  }
  return false;
}

function getTodayKey() {
  return new Date().toISOString().split("T")[0];
}

/**
 * جلب إعدادات إرسال الحسابات للسيرفر
 * @param {string|null} guildId
 */
function getSendAccConfig(guildId = null) {
  const data = readDb();
  const target = getTarget(data, guildId);
  return {
    allowedToSendRoleId: target.config.allowedToSendRoleId || null,
    allowedToSendDailyLimit: typeof target.config.allowedToSendDailyLimit !== "undefined" ? target.config.allowedToSendDailyLimit : 0
  };
}

/**
 * تحديث إعدادات إرسال الحسابات
 * @param {string|null} roleId
 * @param {number|null} dailyLimit
 * @param {string|null} guildId
 */
async function setSendAccConfig(roleId, dailyLimit, guildId = null) {
  const updates = {};
  if (roleId !== undefined) updates.allowedToSendRoleId = roleId;
  if (dailyLimit !== undefined) updates.allowedToSendDailyLimit = dailyLimit;
  updateConfig(updates, guildId);
  if (mongo.setBotConfig) {
    await mongo.setBotConfig(updates, guildId).catch((err) => console.warn("[WARN] Failed to save allowed-to-send config to MongoDB:", err.message));
  }
}

/**
 * تسجيل عدد الحسابات المرسلة اليوم
 * @param {string} userId
 * @param {number} count
 * @param {string|null} guildId
 */
function recordAccSends(userId, count = 1, guildId = null) {
  const data = readDb();
  const target = getTarget(data, guildId);
  const today = getTodayKey();
  if (!target.sendAccUsage) target.sendAccUsage = {};
  if (!target.sendAccUsage[userId] || target.sendAccUsage[userId].date !== today) {
    target.sendAccUsage[userId] = { count: 0, date: today };
  }
  target.sendAccUsage[userId].count += count;
  writeDb(data);
}

/**
 * الحصول على عدد الحسابات المرسلة اليوم
 * @param {string} userId
 * @param {string|null} guildId
 */
function getDailyAccSendCount(userId, guildId = null) {
  const data = readDb();
  const target = getTarget(data, guildId);
  const today = getTodayKey();
  if (!target.sendAccUsage || !target.sendAccUsage[userId]) return 0;
  if (target.sendAccUsage[userId].date !== today) return 0;
  return target.sendAccUsage[userId].count;
}

module.exports = {
  readDb,
  writeDb,
  getTarget,
  addStock,
  pullStock,
  getStockCount,
  getStockList,
  removeStock,
  clearStock,
  addLog,
  updateConfig,
  addButton,
  deleteButton,
  getButtons,
  getButton,
  toggleButton,
  addEmbed,
  getRecentEmbeds,
  updateEmbed,
  addPanel,
  getPanels,
  getPanel,
  updatePanel,
  setPanelDeadline,
  deletePanel,
  togglePanel,
  addSubmission,
  getSubmission,
  hasSubmittedLinkToday,
  hasDeliveredVideo,
  normalizeVideoLink,
  updateSubmission,
  getSendAccConfig,
  setSendAccConfig,
  recordAccSends,
  getDailyAccSendCount
};
