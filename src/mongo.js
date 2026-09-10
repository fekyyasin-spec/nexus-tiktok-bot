const mongoose = require("mongoose");

const MONGODB_URI = process.env.MONGODB_URI;

const sentAccountSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  username: { type: String },
  prize: { type: String, required: true },
  source: { type: String, default: "dm" },
  guildId: { type: String, default: "global" },
  sentAt: { type: Date, default: Date.now }
});
sentAccountSchema.index({ userId: 1, guildId: 1 });

const SentAccount = mongoose.model("SentAccount", sentAccountSchema);

let connected = false;

const configSchema = new mongoose.Schema({
  guildId: { type: String, default: "global" },
  logChannelId: { type: String, default: null },
  minViews: { type: Number, default: 1000 },
  allowedToSendRoleId: { type: String, default: null },
  allowedToSendDailyLimit: { type: Number, default: 0 }
});
configSchema.index({ guildId: 1 }, { unique: true });

const BotConfig = mongoose.model("BotConfig", configSchema);

const stockSchema = new mongoose.Schema({
  content: { type: String, required: true },
  guildId: { type: String, default: "global" },
  addedAt: { type: Date, default: Date.now }
});
// يمكن تكرار نفس الحساب في سيرفرات مختلفة، لكن ليس داخل نفس السيرفر
stockSchema.index({ content: 1, guildId: 1 });

const Stock = mongoose.model("Stock", stockSchema);

const bannedUserSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true, unique: true },
  username: { type: String },
  reason: { type: String },
  bannedBy: { type: String },
  bannedAt: { type: Date, default: Date.now }
});

const BannedUser = mongoose.model("BannedUser", bannedUserSchema);

function safeGuildId(guildId) {
  return guildId || "global";
}

async function connectMongo() {
  if (!MONGODB_URI) {
    console.warn("[WARN] MONGODB_URI not set in .env");
    return;
  }
  try {
    await mongoose.connect(MONGODB_URI);
    connected = true;
    console.log("[OK] MongoDB connected");

    try {
      const indexes = await Stock.collection.getIndexes();
      if (indexes["content_1"]) {
        await Stock.collection.dropIndex("content_1");
        console.log("[OK] Dropped old global stock unique index");
      }
    } catch (idxErr) {
      console.warn("[WARN] Could not drop old stock index:", idxErr.message);
    }

    try {
      await Stock.updateMany({ guildId: { $exists: false } }, { $set: { guildId: "global" } });
      await BotConfig.updateMany({ guildId: { $exists: false } }, { $set: { guildId: "global" } });
      await SentAccount.updateMany({ guildId: { $exists: false } }, { $set: { guildId: "global" } });
    } catch (migErr) {
      console.warn("[WARN] MongoDB guildId migration failed:", migErr.message);
    }
  } catch (err) {
    console.error("[ERROR] MongoDB connection failed:", err.message);
  }
}

async function saveSentAccount(userId, username, prize, source = "dm", guildId = null) {
  if (!connected) return;
  try {
    await SentAccount.create({ userId, username, prize: String(prize), source, guildId: safeGuildId(guildId) });
  } catch (err) {
    console.warn("[WARN] Failed to save sent account to MongoDB:", err.message);
  }
}

async function getSentAccounts(userId, guildId = null) {
  if (!connected) return [];
  try {
    const filter = { userId };
    if (guildId) filter.guildId = safeGuildId(guildId);
    return await SentAccount.find(filter).sort({ sentAt: -1 }).lean();
  } catch (err) {
    console.warn("[WARN] Failed to fetch sent accounts from MongoDB:", err.message);
    return [];
  }
}

async function getBotConfig(guildId = null) {
  if (!connected) return null;
  try {
    const cfg = await BotConfig.findOne({ guildId: safeGuildId(guildId) }).lean();
    if (cfg) {
      return {
        logChannelId: cfg.logChannelId || null,
        minViews: typeof cfg.minViews !== "undefined" ? cfg.minViews : 1000,
        allowedToSendRoleId: cfg.allowedToSendRoleId || null,
        allowedToSendDailyLimit: typeof cfg.allowedToSendDailyLimit !== "undefined" ? cfg.allowedToSendDailyLimit : 0
      };
    }
    return null;
  } catch (err) {
    console.warn("[WARN] Failed to get bot config from MongoDB:", err.message);
    return null;
  }
}

async function setBotConfig(updates, guildId = null) {
  if (!connected) return;
  try {
    const safe = safeGuildId(guildId);
    await BotConfig.findOneAndUpdate(
      { guildId: safe },
      { $set: { ...updates, guildId: safe } },
      { upsert: true, returnDocument: "after" }
    );
  } catch (err) {
    console.warn("[WARN] Failed to save bot config to MongoDB:", err.message);
  }
}

async function getStockList(guildId = null) {
  if (!connected) return null;
  try {
    const items = await Stock.find({ guildId: safeGuildId(guildId) }).sort({ addedAt: 1 }).lean();
    return items.map((i) => i.content);
  } catch (err) {
    console.warn("[WARN] Failed to get stock list from MongoDB:", err.message);
    return null;
  }
}

async function getStockCount(guildId = null) {
  if (!connected) return null;
  try {
    return await Stock.countDocuments({ guildId: safeGuildId(guildId) });
  } catch (err) {
    console.warn("[WARN] Failed to get stock count from MongoDB:", err.message);
    return null;
  }
}

async function addStock(accounts, guildId = null) {
  if (!connected) return null;
  const safe = safeGuildId(guildId);
  try {
    let added = 0;
    for (const account of accounts) {
      const content = account.trim();
      if (content.length === 0) continue;
      try {
        const exists = await Stock.findOne({ content, guildId: safe }).lean();
        if (exists) continue;
        await Stock.create({ content, guildId: safe });
        added++;
      } catch (err) {
        if (err.code === 11000) {
          // مكرر، نتجاهل
        } else {
          console.warn("[WARN] Failed to save stock item:", err.message);
        }
      }
    }
    return added;
  } catch (err) {
    console.warn("[WARN] addStock failed:", err.message);
    return null;
  }
}

async function pullStock(count, guildId = null) {
  if (!connected) return null;
  const safe = safeGuildId(guildId);
  try {
    const total = await Stock.countDocuments({ guildId: safe });
    const actualCount = Math.min(count, total);
    if (actualCount === 0) return [];
    const items = await Stock.find({ guildId: safe }).sort({ addedAt: 1 }).limit(actualCount).lean();
    const ids = items.map((i) => i._id);
    await Stock.deleteMany({ _id: { $in: ids } });
    return items.map((i) => i.content);
  } catch (err) {
    console.warn("[WARN] pullStock failed:", err.message);
    return null;
  }
}

async function removeStock(account, guildId = null) {
  if (!connected) return null;
  try {
    const result = await Stock.findOneAndDelete({ content: account.trim(), guildId: safeGuildId(guildId) });
    return !!result;
  } catch (err) {
    console.warn("[WARN] removeStock failed:", err.message);
    return null;
  }
}

async function clearStock(guildId = null) {
  if (!connected) return null;
  try {
    const safe = safeGuildId(guildId);
    const items = await Stock.find({ guildId: safe }).sort({ addedAt: 1 }).lean();
    await Stock.deleteMany({ guildId: safe });
    return items.map((i) => i.content);
  } catch (err) {
    console.warn("[WARN] clearStock failed:", err.message);
    return null;
  }
}

async function isBanned(userId) {
  if (!connected) return false;
  try {
    return !!(await BannedUser.exists({ userId }));
  } catch (err) {
    console.warn("[WARN] isBanned check failed:", err.message);
    return false;
  }
}

async function banUser(userId, username, bannedBy, reason) {
  if (!connected) return { success: false, error: "not connected" };
  try {
    await BannedUser.findOneAndUpdate(
      { userId },
      { userId, username, bannedBy, reason, bannedAt: new Date() },
      { upsert: true }
    );
    return { success: true };
  } catch (err) {
    console.warn("[WARN] banUser failed:", err.message);
    return { success: false, error: err.message };
  }
}

async function unbanUser(userId) {
  if (!connected) return false;
  try {
    const res = await BannedUser.findOneAndDelete({ userId });
    return !!res;
  } catch (err) {
    console.warn("[WARN] unbanUser failed:", err.message);
    return false;
  }
}

module.exports = { connectMongo, saveSentAccount, getSentAccounts, getBotConfig, setBotConfig, getStockList, getStockCount, addStock, pullStock, removeStock, clearStock, isBanned, banUser, unbanUser, SentAccount, BannedUser };
