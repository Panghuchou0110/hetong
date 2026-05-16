const express = require("express");
const path = require("path");
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();
const crypto = require("crypto");

const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.set("view engine", "ejs");

const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
const logDir = process.env.LOG_DIR || dataDir;
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}
const accessLogPath = path.join(logDir, "access.log");
const errorLogPath = path.join(logDir, "error.log");

if (process.env.TRUST_PROXY === "1") {
  app.set("trust proxy", true);
}

const parsedWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS);
const parsedRateMax = Number(process.env.RATE_LIMIT_MAX);
const rateLimitWindowMs = Number.isFinite(parsedWindowMs) && parsedWindowMs > 0 ? parsedWindowMs : 60_000;
const rateLimitMax = Number.isFinite(parsedRateMax) && parsedRateMax > 0 ? parsedRateMax : 60;
const rateLimitStore = new Map();
const allowedIps = (process.env.ALLOWED_IPS || "")
  .split(",")
  .map((ip) => ip.trim())
  .filter(Boolean);
const apiToken = process.env.API_TOKEN || "";
const parsedRememberMs = Number(process.env.REMEMBER_LOGIN_MS);
const loginRememberMs =
  Number.isFinite(parsedRememberMs) && parsedRememberMs > 0 ? parsedRememberMs : 24 * 60 * 60 * 1000;
const authUsers = loadAuthUsers();
const defaultAdminUser = "admin";
const defaultAdminPass = "20074";
const adminPass = process.env.ADMIN_PASS || defaultAdminPass;
const sessionStore = new Map();
const dbPath = process.env.DB_PATH || path.join(dataDir, "orders.sqlite");
const db = new sqlite3.Database(dbPath);
const defaultModels = [
  "iPhone 17 Pro Max",
  "iPhone 17 Pro",
  "iPhone 17",
  "iPhone 16 Pro Max",
  "iPhone 16 Pro",
  "iPhone 16",
];
const defaultModelColors = {
  "iPhone 17 Pro Max": ["白色", "黑色", "原色"],
  "iPhone 17 Pro": ["白色", "黑色", "原色"],
  "iPhone 17": ["白色", "黑色", "原色"],
  "iPhone 16 Pro Max": ["白色", "黑色", "原色"],
  "iPhone 16 Pro": ["白色", "黑色", "原色"],
  "iPhone 16": ["白色", "黑色", "原色"],
};
const defaultState = {
  orders: [],
  trash: [],
  sources: ["皖顺", "成都"],
  defaultSource: "皖顺",
  models: [...defaultModels],
  modelColors: { ...defaultModelColors },
  authRememberHours: {},
};
const iphonePriceFile = path.join(dataDir, "iphone-prices.json");
const iphonePriceCatalog = [
  { key: "promax", title: "iPhone 17 Pro Max", short: "17PM", section: "normal" },
  { key: "pro", title: "iPhone 17 Pro", short: "17Pro", section: "normal" },
  { key: "iphone17", title: "iPhone 17", short: "17", section: "normal" },
  { key: "promaxActive", title: "iPhone 17 Pro Max 仅激活", short: "17PM", section: "active" },
];
const iphonePriceCapacities = ["256G", "512G"];
const iphonePriceColorMap = {
  promax: [
    { key: "blue", label: "蓝", name: "蓝色", dot: "#49a9ff" },
    { key: "orange", label: "橙", name: "橙色", dot: "#ff9a43" },
    { key: "white", label: "白", name: "白色", dot: "#f2f6ff" },
  ],
  pro: [
    { key: "blue", label: "蓝", name: "蓝色", dot: "#49a9ff" },
    { key: "orange", label: "橙", name: "橙色", dot: "#ff9a43" },
    { key: "white", label: "白", name: "白色", dot: "#f2f6ff" },
  ],
  iphone17: [
    { key: "black", label: "黑", name: "黑色", dot: "#111111" },
    { key: "white", label: "白", name: "白色", dot: "#f2f6ff" },
    { key: "mistBlue", label: "青", name: "青雾蓝", dot: "#5aaed8" },
    { key: "sageGreen", label: "绿", name: "鼠尾草绿", dot: "#98b58c" },
    { key: "lavenderPurple", label: "紫", name: "薰衣草紫", dot: "#b58cff" },
  ],
  promaxActive: [
    { key: "blue", label: "蓝", name: "蓝色", dot: "#49a9ff" },
    { key: "orange", label: "橙", name: "橙色", dot: "#ff9a43" },
    { key: "white", label: "白", name: "白色", dot: "#f2f6ff" },
  ],
};

function getIphonePriceColors(modelKey) {
  return iphonePriceColorMap[modelKey] || iphonePriceColorMap.promax;
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

async function ensureColumns(table, columns) {
  const info = await dbAll(`PRAGMA table_info(${table})`);
  const existing = new Set(info.map((col) => col.name));
  for (const column of columns) {
    if (!existing.has(column.name)) {
      await dbRun(`ALTER TABLE ${table} ADD COLUMN ${column.name} ${column.type}`);
    }
  }
}

async function ensureSchema() {
  await dbRun("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT)");
  await dbRun(
    "CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL, hash TEXT)"
  );
  await dbRun(
    "CREATE TABLE IF NOT EXISTS trash (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL, hash TEXT)"
  );
  await dbRun(
    "CREATE TABLE IF NOT EXISTS auth_users (username TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL)"
  );
  await ensureColumns("orders", [{ name: "hash", type: "TEXT" }]);
  await ensureColumns("trash", [{ name: "hash", type: "TEXT" }]);
}

function readRawState() {
  return new Promise((resolve, reject) => {
    db.get("SELECT value FROM state WHERE key = ?", ["app_state"], (err, row) => {
      if (err) return reject(err);
      if (!row || !row.value) return resolve({ ...defaultState });
      try {
        resolve(JSON.parse(row.value));
      } catch (parseErr) {
        resolve({ ...defaultState });
      }
    });
  });
}

function saveConfigState(state) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      sources: Array.isArray(state.sources) ? state.sources : [...defaultState.sources],
      defaultSource: typeof state.defaultSource === "string" ? state.defaultSource : "",
      models: Array.isArray(state.models) && state.models.length ? state.models : [...defaultState.models],
      modelColors:
        state.modelColors && typeof state.modelColors === "object"
          ? state.modelColors
          : { ...defaultState.modelColors },
      authRememberHours:
        state.authRememberHours && typeof state.authRememberHours === "object"
          ? state.authRememberHours
          : {},
    });
    db.run(
      "REPLACE INTO state (key, value) VALUES (?, ?)",
      ["app_state", payload],
      (err) => {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}

function computePayloadHash(payload) {
  return crypto.createHash("sha1").update(payload).digest("hex");
}

function loadList(table) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT id, payload FROM ${table} ORDER BY created_at DESC`, [], (err, rows) => {
      if (err) return reject(err);
      const items = [];
      (rows || []).forEach((row) => {
        try {
          const parsed = JSON.parse(row.payload);
          if (parsed && typeof parsed === "object") {
            if (!parsed.id) parsed.id = row.id;
            items.push(parsed);
          }
        } catch (parseErr) {
          // skip corrupted row
        }
      });
      resolve(items);
    });
  });
}

async function syncList(table, items) {
  const list = Array.isArray(items) ? items : [];
  const existingRows = await dbAll(`SELECT id, hash FROM ${table}`);
  const existing = new Map(existingRows.map((row) => [row.id, row.hash]));
  const keepIds = new Set();

  await dbRun("BEGIN");
  try {
    for (const item of list) {
      const id = item && item.id ? String(item.id) : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const createdAt = Number(item && item.createdAt) || Date.now();
      const payload = JSON.stringify({ ...item, id });
      const hash = computePayloadHash(payload);
      keepIds.add(id);
      if (existing.get(id) === hash) continue;
      await dbRun(
        `INSERT OR REPLACE INTO ${table} (id, payload, created_at, hash) VALUES (?, ?, ?, ?)`,
        [id, payload, createdAt, hash]
      );
    }

    const toDelete = existingRows.filter((row) => !keepIds.has(row.id)).map((row) => row.id);
    const chunkSize = 500;
    for (let i = 0; i < toDelete.length; i += chunkSize) {
      const chunk = toDelete.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => "?").join(", ");
      await dbRun(`DELETE FROM ${table} WHERE id IN (${placeholders})`, chunk);
    }

    await dbRun("COMMIT");
  } catch (err) {
    await dbRun("ROLLBACK");
    throw err;
  }
}

async function getState() {
  const rawState = await readRawState();
  const config = {
    sources: Array.isArray(rawState.sources) ? rawState.sources : [...defaultState.sources],
    defaultSource: typeof rawState.defaultSource === "string" ? rawState.defaultSource : "",
    models: Array.isArray(rawState.models) && rawState.models.length ? rawState.models : [...defaultState.models],
    modelColors:
      rawState.modelColors && typeof rawState.modelColors === "object"
        ? rawState.modelColors
        : { ...defaultState.modelColors },
    authRememberHours:
      rawState.authRememberHours && typeof rawState.authRememberHours === "object" ? rawState.authRememberHours : {},
  };
  let orders = await loadList("orders");
  let trash = await loadList("trash");
  const legacyOrders = Array.isArray(rawState.orders) ? rawState.orders : [];
  const legacyTrash = Array.isArray(rawState.trash) ? rawState.trash : [];
  if (orders.length === 0 && trash.length === 0 && (legacyOrders.length || legacyTrash.length)) {
    await syncList("orders", legacyOrders);
    await syncList("trash", legacyTrash);
    orders = legacyOrders;
    trash = legacyTrash;
    await saveConfigState(config);
  }
  return {
    orders,
    trash,
    ...config,
  };
}

async function saveState(state) {
  const payload = state || defaultState;
  await syncList("orders", Array.isArray(payload.orders) ? payload.orders : []);
  await syncList("trash", Array.isArray(payload.trash) ? payload.trash : []);
  await saveConfigState(payload);
}

function createIphonePriceGrid() {
  const prices = {};
  iphonePriceCatalog.forEach((model) => {
    prices[model.key] = {};
    iphonePriceCapacities.forEach((capacity) => {
      prices[model.key][capacity] = {};
      getIphonePriceColors(model.key).forEach((color) => {
        prices[model.key][capacity][color.key] = "";
      });
    });
  });
  return prices;
}

function createDefaultIphonePriceState() {
  return {
    updatedAt: 0,
    prices: createIphonePriceGrid(),
  };
}

function normalizeIphonePriceCell(value) {
  const digits = String(value ?? "")
    .replace(/[^\d]/g, "")
    .trim();
  if (!digits) return "";
  return String(Number(digits));
}

function normalizeIphonePriceState(raw) {
  const base = createDefaultIphonePriceState();
  const source = raw && typeof raw === "object" ? raw : {};
  const rawPrices = source.prices && typeof source.prices === "object" ? source.prices : {};
  const prices = createIphonePriceGrid();
  iphonePriceCatalog.forEach((model) => {
    const rawModel = rawPrices[model.key];
    const colors = getIphonePriceColors(model.key);
    iphonePriceCapacities.forEach((capacity) => {
      const rawCapacity = rawModel && typeof rawModel === "object" ? rawModel[capacity] : null;
      colors.forEach((color) => {
        const rawValue = rawCapacity && typeof rawCapacity === "object" ? rawCapacity[color.key] : "";
        prices[model.key][capacity][color.key] = normalizeIphonePriceCell(rawValue);
      });
    });
  });
  return {
    updatedAt: Number(source.updatedAt) || base.updatedAt,
    prices,
  };
}

async function readIphonePriceState() {
  try {
    const raw = await fs.promises.readFile(iphonePriceFile, "utf8");
    return normalizeIphonePriceState(JSON.parse(raw));
  } catch (err) {
    return createDefaultIphonePriceState();
  }
}

async function saveIphonePriceState(state) {
  const normalized = normalizeIphonePriceState(state);
  normalized.updatedAt = Date.now();
  await fs.promises.writeFile(iphonePriceFile, JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
}

function loadAuthUsers() {
  const users = new Map();
  const rawList = process.env.AUTH_USERS || "";
  if (rawList) {
    rawList.split(",").forEach((item) => {
      const trimmed = item.trim();
      if (!trimmed) return;
      const idx = trimmed.indexOf(":");
      if (idx <= 0) return;
      const user = trimmed.slice(0, idx).trim();
      const pass = trimmed.slice(idx + 1);
      if (user && pass) users.set(user, pass);
    });
  }
  const singleUser = process.env.AUTH_USER;
  const singlePass = process.env.AUTH_PASS;
  if (singleUser && singlePass) {
    users.set(singleUser, singlePass);
  }
  return users;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function safeEqualHex(a, b) {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function getAuthUser(username) {
  return new Promise((resolve, reject) => {
    db.get(
      "SELECT username, salt, hash, created_at FROM auth_users WHERE username = ?",
      [username],
      (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      }
    );
  });
}

function listAuthUsers() {
  return new Promise((resolve, reject) => {
    db.all("SELECT username, created_at FROM auth_users ORDER BY created_at DESC", [], (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function createAuthUser(username, password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = hashPassword(password, salt);
    const createdAt = new Date().toISOString();
    db.run(
      "INSERT INTO auth_users (username, salt, hash, created_at) VALUES (?, ?, ?, ?)",
      [username, salt, hash, createdAt],
      (err) => {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}

function updateAuthUserPassword(username, password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = hashPassword(password, salt);
    db.run(
      "UPDATE auth_users SET salt = ?, hash = ? WHERE username = ?",
      [salt, hash, username],
      (err) => {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}

function deleteAuthUser(username) {
  return new Promise((resolve, reject) => {
    db.run("DELETE FROM auth_users WHERE username = ?", [username], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function countAuthUsers() {
  return new Promise((resolve, reject) => {
    db.get("SELECT COUNT(*) as count FROM auth_users", [], (err, row) => {
      if (err) return reject(err);
      resolve(row ? Number(row.count || 0) : 0);
    });
  });
}

function writeLog(filePath, payload) {
  fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, () => {});
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};
  header.split(";").forEach((part) => {
    const [key, ...rest] = part.trim().split("=");
    if (!key) return;
    cookies[key] = decodeURIComponent(rest.join("="));
  });
  return cookies;
}

function getRememberMsForUser(state, user) {
  const hoursRaw = state?.authRememberHours?.[user];
  const hours = Number(hoursRaw);
  if ([24, 36, 48].includes(hours)) {
    return hours * 60 * 60 * 1000;
  }
  return loginRememberMs;
}

function createSession(user, rememberMs = loginRememberMs) {
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = Date.now() + rememberMs;
  sessionStore.set(token, { user, expiresAt });
  return { token, expiresAt };
}

function setSessionCookie(req, res, token, rememberMs = loginRememberMs) {
  const maxAge = Math.floor(rememberMs / 1000);
  const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";
  const secureFlag = isSecure ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `session_token=${token}; Max-Age=${maxAge}; Path=/; SameSite=Lax; HttpOnly${secureFlag}`
  );
}

function clearSessionCookie(req, res) {
  const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";
  const secureFlag = isSecure ? "; Secure" : "";
  res.setHeader("Set-Cookie", `session_token=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly${secureFlag}`);
}

function getSession(req) {
  const cookies = parseCookies(req);
  const token = cookies.session_token;
  if (!token) return null;
  const session = sessionStore.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessionStore.delete(token);
    return null;
  }
  return session;
}

function requireSession(req, res, next) {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  req.session = session;
  next();
}

function requirePageSession(req, res, next) {
  const session = getSession(req);
  if (!session) {
    res.redirect("/");
    return;
  }
  req.session = session;
  next();
}

function requireAdmin(req, res, next) {
  const session = req.session || getSession(req);
  if (!session) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  if (!session.adminVerifiedUntil || session.adminVerifiedUntil <= Date.now()) {
    res.status(403).json({ ok: false, error: "admin_required" });
    return;
  }
  next();
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || "";
}

function rateLimit(req, res, next) {
  const now = Date.now();
  const key = getClientIp(req) || "unknown";
  const entry = rateLimitStore.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(key, { count: 1, resetAt: now + rateLimitWindowMs });
    return next();
  }
  entry.count += 1;
  if (entry.count > rateLimitMax) {
    res.status(429).send("请求过于频繁，请稍后再试");
    return;
  }
  next();
}

function requireAuth(req, res, next) {
  if (allowedIps.length) {
    const ip = getClientIp(req);
    if (!allowedIps.includes(ip)) {
      res.status(403).send("ip_not_allowed");
      return;
    }
  }
  if (apiToken) {
    const headerToken = req.get("x-api-token") || "";
    const auth = req.get("authorization") || "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (headerToken !== apiToken && bearer !== apiToken) {
      res.status(401).send("unauthorized");
      return;
    }
  }
  next();
}

app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    writeLog(accessLogPath, {
      ts: new Date().toISOString(),
      ip: getClientIp(req),
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      ms: Date.now() - startedAt,
      ua: req.headers["user-agent"] || "",
    });
  });
  next();
});

// ====== parse helpers ======
function cleanInputText(text) {
  const normalized = String(text || "")
    .replace(/\r/g, "")
    .replace(/[\u3000\u00A0\t]/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\uFF0C\uFF1B]/g, ":")
    .replace(/[\uFF1A]/g, ":");

  return normalized
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line, index, list) => line || (index > 0 && list[index - 1] !== ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeText(s) {
  return cleanInputText(s);
}

function extractMainText(text) {
  const source = String(text || "");
  const stopKeywords = ["联系人", "名字", "亲友", "父母", "配偶", "哥哥", "母亲", "朋友", "核实号码"];
  let cutIndex = source.length;
  stopKeywords.forEach((keyword) => {
    const idx = source.indexOf(keyword);
    if (idx !== -1 && idx < cutIndex) {
      cutIndex = idx;
    }
  });
  return source.slice(0, cutIndex).trim();
}

function pick(text, regex) {
  const m = text.match(regex);
  return m ? (m[1] || "").trim() : "";
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pickByLabels(text, labels) {
  const group = labels.map(escapeRegex).join("|");
  const re = new RegExp(`(?:${group})\\s*[:\\uFF1A]\\s*([^\\n]+)`);
  return pick(text, re);
}

function extractPhoneFromString(value) {
  const cleaned = (value || "").replace(/[\s-]/g, "");
  const m = cleaned.match(/1[3-9]\d{9}/);
  return m ? m[0] : "";
}

function extractPhone(text, labels) {
  for (const label of labels) {
    const re = new RegExp(`${escapeRegex(label)}[^\\d]{0,8}(1[3-9]\\d{9})(?!\\d)`);
    const m = text.match(re);
    if (m) return m[1];
  }
  const fallback = text.match(/(?:^|\\D)(1[3-9]\\d{9})(?!\\d)/);
  return fallback ? fallback[1] : "";
}

function isValidPhone(value) {
  return /^1[3-9]\d{9}$/.test(value || "");
}

function isValidChineseId(value) {
  const id = String(value || "").toUpperCase();
  if (!/^\d{17}[\dX]$/.test(id)) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checkMap = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"];
  const sum = id
    .slice(0, 17)
    .split("")
    .reduce((acc, ch, idx) => acc + Number(ch) * weights[idx], 0);
  return checkMap[sum % 11] === id[17];
}

function normalizeSellerName(raw) {
  const cleaned = String(raw || "").replace(/[^\u4e00-\u9fa5]/g, "");
  if (!cleaned) return { value: "", warning: "" };
  if (/^[\u4e00-\u9fa5]{2,4}$/.test(cleaned)) {
    return { value: cleaned, warning: "" };
  }
  return { value: cleaned.slice(0, 4), warning: "客户姓名应为2-4个中文字符，请核对" };
}

const commonChineseSurnames = new Set(
  [
    "赵",
    "钱",
    "孙",
    "李",
    "周",
    "吴",
    "郑",
    "王",
    "冯",
    "陈",
    "褚",
    "卫",
    "蒋",
    "沈",
    "韩",
    "杨",
    "朱",
    "秦",
    "尤",
    "许",
    "何",
    "吕",
    "施",
    "张",
    "孔",
    "曹",
    "严",
    "华",
    "金",
    "魏",
    "陶",
    "姜",
    "戚",
    "谢",
    "邹",
    "喻",
    "柏",
    "水",
    "窦",
    "章",
    "云",
    "苏",
    "潘",
    "葛",
    "奚",
    "范",
    "彭",
    "郎",
    "鲁",
    "韦",
    "昌",
    "马",
    "苗",
    "凤",
    "花",
    "方",
    "俞",
    "任",
    "袁",
    "柳",
    "唐",
    "罗",
    "薛",
    "伍",
    "余",
    "米",
    "贝",
    "姚",
    "孟",
    "顾",
    "尹",
    "江",
    "钟",
    "徐",
    "邱",
    "骆",
    "高",
    "夏",
    "蔡",
    "田",
    "樊",
    "胡",
    "凌",
    "霍",
    "虞",
    "万",
    "支",
    "柯",
    "昝",
    "管",
    "卢",
    "莫",
    "经",
    "房",
    "裘",
    "缪",
    "干",
    "解",
    "应",
    "宗",
    "丁",
    "宣",
    "贾",
    "邓",
    "郁",
    "单",
    "杭",
    "洪",
    "包",
    "诸",
    "左",
    "石",
    "崔",
    "吉",
    "钮",
    "龚",
    "程",
    "嵇",
    "邢",
    "滑",
    "裴",
    "陆",
    "荣",
    "翁",
    "荀",
    "羊",
    "於",
    "惠",
    "甄",
    "曲",
    "家",
    "封",
    "芮",
    "羿",
    "储",
    "靳",
    "汲",
    "邴",
    "糜",
    "松",
    "井",
    "段",
    "富",
    "巫",
    "乌",
    "焦",
    "巴",
    "弓",
    "牧",
    "隗",
    "山",
    "谷",
    "车",
    "侯",
    "宓",
    "蓬",
    "全",
    "郗",
    "班",
    "仰",
    "秋",
    "仲",
    "伊",
    "宫",
    "宁",
    "仇",
    "栾",
    "暴",
    "甘",
    "钭",
    "厉",
    "戎",
    "祖",
    "武",
    "符",
    "刘",
    "景",
    "詹",
    "束",
    "龙",
    "叶",
    "幸",
    "司",
    "韶",
    "郜",
    "黎",
    "蓟",
    "薄",
    "印",
    "宿",
    "白",
    "怀",
    "蒲",
    "邰",
    "从",
    "鄂",
    "索",
    "咸",
    "籍",
    "赖",
    "卓",
    "蔺",
    "屠",
    "蒙",
    "池",
    "乔",
    "阳",
    "胥",
    "能",
    "苍",
    "双",
    "闻",
    "莘",
    "党",
    "翟",
    "谭",
    "贡",
    "劳",
    "逄",
    "姬",
    "申",
    "扶",
    "堵",
    "冉",
    "宰",
    "郦",
    "雍",
    "郤",
    "璩",
    "桑",
    "桂",
    "濮",
    "牛",
    "寿",
    "通",
    "边",
    "扈",
    "燕",
    "冀",
    "郏",
    "浦",
    "尚",
    "农",
    "温",
    "别",
    "庄",
    "晏",
    "柴",
    "瞿",
    "阎",
    "充",
    "慕",
    "连",
    "茹",
    "习",
    "宦",
    "艾",
    "鱼",
    "容",
    "向",
    "古",
    "易",
    "慎",
    "戈",
    "廖",
    "庾",
    "终",
    "暨",
    "居",
    "衡",
    "步",
    "都",
    "耿",
    "满",
    "弘",
    "匡",
    "国",
    "文",
    "寇",
    "广",
    "禄",
    "阙",
    "东",
    "欧",
    "殴",
    "殷",
    "利",
    "蔚",
    "越",
    "夔",
    "隆",
    "师",
    "巩",
    "厍",
    "聂",
    "晁",
    "勾",
    "敖",
    "融",
    "冷",
    "訾",
    "辛",
    "阚",
    "那",
    "简",
    "饶",
    "空",
    "曾",
    "毋",
    "沙",
    "乜",
    "养",
    "鞠",
    "须",
    "丰",
    "巢",
    "关",
    "蒯",
    "相",
    "查",
    "后",
    "荆",
    "红",
    "游",
    "竺",
    "权",
    "逯",
    "盖",
    "益",
    "桓",
    "公",
    "万",
    "俟",
    "司马",
    "欧阳",
    "上官",
    "诸葛",
    "东方",
    "皇甫",
    "尉迟",
    "公羊",
    "赫连",
    "澹台",
    "皇甫",
    "宗政",
    "濮阳",
    "淳于",
    "单于",
    "太叔",
    "申屠",
    "公孙",
    "仲孙",
    "轩辕",
    "令狐",
    "钟离",
    "宇文",
    "长孙",
    "慕容",
    "鲜于",
    "闾丘",
    "司徒",
    "司空",
    "亓官",
    "司寇",
    "仉督",
    "子车",
    "颛孙",
    "端木",
    "巫马",
    "公西",
    "漆雕",
    "乐正",
    "壤驷",
    "公良",
    "拓跋",
    "夹谷",
    "宰父",
    "谷梁",
    "晋",
    "楚",
    "阎",
    "法",
  ].filter(Boolean)
);

const compoundChineseSurnames = [
  "欧阳",
  "司马",
  "上官",
  "诸葛",
  "东方",
  "皇甫",
  "尉迟",
  "公羊",
  "赫连",
  "澹台",
  "宗政",
  "濮阳",
  "淳于",
  "单于",
  "太叔",
  "申屠",
  "公孙",
  "仲孙",
  "轩辕",
  "令狐",
  "钟离",
  "宇文",
  "长孙",
  "慕容",
  "鲜于",
  "闾丘",
  "司徒",
  "司空",
  "亓官",
  "司寇",
  "仉督",
  "子车",
  "颛孙",
  "端木",
  "巫马",
  "公西",
  "漆雕",
  "乐正",
  "壤驷",
  "公良",
  "拓跋",
  "夹谷",
  "宰父",
  "谷梁",
];

const nameTailBlacklist = new Set(["手", "机", "电", "话", "号", "证", "型", "容", "量", "价", "格", "回", "收", "源", "激", "色", "备", "注", "联", "系", "名"]);
const nameRejectWords = ["配偶", "朋友", "母亲", "哥哥", "姐姐", "弟弟", "妹妹", "父亲", "父母", "亲友", "联系人", "核实号码", "核实号"];

function compactChineseOnly(value) {
  return String(value || "").replace(/[^\u4e00-\u9fa5]/g, "");
}

function isLikelyChineseName(value) {
  const compact = compactChineseOnly(value);
  if (!/^[\u4e00-\u9fa5]{2,4}$/.test(compact)) return false;
  if (compoundChineseSurnames.some((surname) => compact.startsWith(surname))) {
    return compact.length >= 3;
  }
  return commonChineseSurnames.has(compact[0]) && compact.length <= 3;
}

function extractLikelyChineseName(value) {
  const compact = compactChineseOnly(value);
  if (!compact) return "";
  for (let start = 0; start <= compact.length - 2; start += 1) {
    for (const size of [4, 3, 2]) {
      const candidate = compact.slice(start, start + size);
      if (!candidate || candidate.length !== size || !isLikelyChineseName(candidate)) continue;
      if (
        candidate.length === 4 &&
        commonChineseSurnames.has(candidate[0]) &&
        !compoundChineseSurnames.some((surname) => candidate.startsWith(surname))
      ) {
        continue;
      }
      if (candidate.length === 3 && commonChineseSurnames.has(candidate[0]) && nameTailBlacklist.has(candidate[2])) {
        continue;
      }
      if (candidate.length === 2 && nameTailBlacklist.has(candidate[1])) {
        continue;
      }
      if (candidate.length >= 2) {
        return candidate;
      }
    }
  }
  return "";
}

function extractNameFromText(text, labels = []) {
  const source = extractMainText(cleanInputText(text || ""));
  const explicitPattern = /(?:客户姓名|姓名|出卖人|名字)\s*[:：]?\s*([\u4e00-\u9fa5]{2,4})/g;
  let explicitMatch;
  while ((explicitMatch = explicitPattern.exec(source)) !== null) {
    const candidate = explicitMatch[1];
    if (candidate && !nameRejectWords.some((word) => candidate.includes(word))) {
      return candidate;
    }
  }

  const genericPattern = new RegExp(
    `(?:^|[^\\u4e00-\\u9fa5])((?:${compoundChineseSurnames.map(escapeRegex).join("|")}|[\\u4e00-\\u9fa5])[\\u4e00-\\u9fa5]{1,3})(?=[^\\u4e00-\\u9fa5]|$)`,
    "g"
  );
  let result;
  while ((result = genericPattern.exec(source)) !== null) {
    const candidate = result[1];
    if (!candidate) continue;
    if (!isLikelyChineseName(candidate)) continue;
    if (nameRejectWords.some((word) => candidate.includes(word))) continue;
    return candidate;
  }
  return extractLikelyChineseName(source);
}

function extractActivationFromText(text) {
  const compact = String(text || "").replace(/\s+/g, "");
  if (!compact) return "";

  const activePatterns = [/仅激活/, /已激活/, /国行激活/, /激活1-5天/, /激活3天内/];
  if (activePatterns.some((pattern) => pattern.test(compact))) return "仅激活（直结）";

  const explicitLabelPattern =
    /(?:激活状态|是否激活|激活情况)\s*[:：]?\s*(未激活|全新未拆封|未拆封|全新原封|原封|未使用|0充|仅激活(?:（直结）)?|已激活|国行激活|激活1-5天|激活3天内|预激活)/;
  const labelMatch = compact.match(explicitLabelPattern);
  if (labelMatch) {
    const value = labelMatch[1];
    if (/^(?:未激活|全新未拆封|未拆封|全新原封|原封|未使用|0充)$/.test(value)) return "未激活";
    return "仅激活（直结）";
  }

  const inactivePatterns = [/未激活/, /全新未拆封/, /未拆封/, /全新原封/, /原封/, /未使用/, /0充/];
  if (inactivePatterns.some((pattern) => pattern.test(compact))) return "未激活";

  return "";
}

function parsePriceValue(raw) {
  const cleaned = String(raw || "").replace(/,/g, "").trim();
  const numeric = Number(cleaned);
  if (Number.isFinite(numeric)) return numeric;
  const digits = parseAmount(cleaned);
  return digits ? Number(digits) : NaN;
}

function parseAmount(raw) {
  return (raw || "").replace(/[^\d]/g, "");
}

function normalizeMemoryInput(value) {
  const m = String(value || "").trim().toUpperCase().replace("GB", "G");
  if (["64G", "128G", "256G", "512G", "1TB", "2TB"].includes(m)) return m;
  return "";
}

function normalizeMemorySize(size, unit) {
  const num = Number(size);
  if (!Number.isFinite(num)) return "";
  const normalizedUnit = (unit || "").toUpperCase();
  if (normalizedUnit.startsWith("T")) {
    return num === 2 ? "2TB" : num === 1 ? "1TB" : `${num}TB`;
  }
  if (normalizedUnit.startsWith("G")) {
    return `${num}G`;
  }
  if (num === 1024) return "1TB";
  if (num === 2048) return "2TB";
  if ([64, 128, 256, 512].includes(num)) return `${num}G`;
  return "";
}

function normalizeModelName(raw) {
  const cleaned = (raw || "").trim();
  const compact = cleaned.toLowerCase().replace(/\s+/g, "");
  if (!compact) return "";

  const is17 = compact.includes("17") || compact.includes("iphone17") || compact.includes("ip17");
  const is16 = compact.includes("16") || compact.includes("iphone16") || compact.includes("ip16");

  if (is17) {
    const isProMax = /(promax|pmax|pm|max|prom)/.test(compact);
    if (isProMax) return "iPhone 17 Pro Max";
    const isPro = compact.includes("17pro") || /17p(?!m)/.test(compact);
    if (isPro) return "iPhone 17 Pro";
    return "iPhone 17";
  }

  if (is16) {
    const isProMax = /(promax|pmax|pm|max|prom)/.test(compact);
    if (isProMax) return "iPhone 16 Pro Max";
    const isPro = compact.includes("16pro") || /16p(?!m)/.test(compact);
    if (isPro) return "iPhone 16 Pro";
    return "iPhone 16";
  }

  return cleaned;
}

function normalizeForMatch(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, "");
}

function matchModelFromList(rawText, models) {
  const text = normalizeForMatch(rawText);
  let matched = "";
  let maxLen = 0;
  (models || []).forEach((model) => {
    const compact = normalizeForMatch(model);
    if (!compact) return;
    if (text.includes(compact) && compact.length > maxLen) {
      matched = model;
      maxLen = compact.length;
    }
  });
  return matched;
}

function matchColorFromList(rawText, colors) {
  const text = String(rawText || "").replace(/\s+/g, "");
  let matched = "";
  let maxLen = 0;
  (colors || []).forEach((color) => {
    const compact = String(color || "").replace(/\s+/g, "");
    if (!compact) return;
    const aliases = compact === "白色" ? ["白色", "银色"] : compact === "银色" ? ["银色", "白色"] : [compact];
    if (aliases.some((alias) => text.includes(alias)) && compact.length > maxLen) {
      matched = color;
      maxLen = compact.length;
    }
  });
  return matched;
}

function getAllColors(modelColors) {
  return Object.values(modelColors || {}).reduce((acc, list) => acc.concat(list || []), []);
}

function validateSelection(payload, state) {
  const models = Array.isArray(state.models) && state.models.length ? state.models : defaultState.models;
  const modelColors =
    state.modelColors && typeof state.modelColors === "object" ? state.modelColors : defaultState.modelColors;
  const model = (payload.model || "").trim();
  const memory = normalizeMemoryInput(payload.memory);
  const color = (payload.color || "").trim();

  if (model && !models.includes(model)) {
    return { ok: false, message: "\u673a\u578b\u4e0d\u5728\u914d\u7f6e\u4e2d" };
  }
  if (payload.memory && !memory) {
    return { ok: false, message: "\u5185\u5b58\u89c4\u683c\u4e0d\u6b63\u786e" };
  }
  if (color) {
    const allowedColors = model ? modelColors[model] || [] : getAllColors(modelColors);
    if (!allowedColors.includes(color)) {
      return { ok: false, message: "\u989c\u8272\u4e0d\u5728\u914d\u7f6e\u4e2d" };
    }
  }
  return { ok: true, memory };
}

function extractFromRaw(raw, options = {}) {
  const models = Array.isArray(options.models) ? options.models : [];
  const modelColors = options.modelColors && typeof options.modelColors === "object" ? options.modelColors : {};
  const t = normalizeText(raw);
  const mainText = extractMainText(t);
  const warnings = [];

  const nameLabels = [
    "\u59d3\u540d",
    "\u59d3\u540d/\u79f0\u547c",
    "\u5ba2\u6237\u59d3\u540d",
    "\u5ba2\u6237\u540d\u79f0",
    "\u5ba2\u6237",
    "\u8054\u7cfb\u4eba",
    "\u8054\u7cfb\u4eba\u59d3\u540d",
    "\u5356\u5bb6\u59d3\u540d",
    "\u5356\u65b9\u59d3\u540d",
    "\u51fa\u5356\u4eba",
    "\u51fa\u5356\u4eba\u59d3\u540d",
    "\u51fa\u552e\u4eba",
    "\u51fa\u552e\u4eba\u59d3\u540d",
    "\u56de\u6536\u4eba",
    "\u56de\u6536\u4eba\u59d3\u540d",
    "\u5356\u65b9",
    "\u5356\u5bb6",
    "\u79f0\u547c",
    "\u540d\u5b57",
  ];

  const phoneLabels = [
    "\u624b\u673a\u53f7",
    "\u624b\u673a\u53f7\u7801",
    "\u8054\u7cfb\u624b\u673a",
    "\u7535\u8bdd",
    "\u7535\u8bdd\u53f7",
    "\u7535\u8bdd\u53f7\u7801",
    "\u8054\u7cfb\u7535\u8bdd",
    "\u8054\u7cfb\u65b9\u5f0f",
    "\u5ba2\u6237\u624b\u673a",
    "\u5ba2\u6237\u624b\u673a\u53f7",
    "\u5ba2\u6237\u7535\u8bdd",
    "\u5ba2\u6237\u7535\u8bdd\u53f7\u7801",
    "\u5ba2\u6237\u8054\u7cfb\u7535\u8bdd",
  ];

  const idLabels = ["\u8eab\u4efd\u8bc1\u53f7\u7801", "\u8eab\u4efd\u8bc1\u53f7", "\u8eab\u4efd\u8bc1", "\u8eab\u4efd\u8bc1\u7f16\u53f7"];
  const nameResult = normalizeSellerName(extractNameFromText(mainText, nameLabels));
  const seller_name = nameResult.value;
  if (nameResult.warning) warnings.push(nameResult.warning);
  const seller_id_raw = pickByLabels(t, idLabels) || pick(t, /\u8eab\u4efd\u8bc1(?:\u53f7\u7801|\u53f7)?\s*:\s*([0-9Xx]{18})/);
  const seller_id_match = String(seller_id_raw || "").match(/\d{17}[\dXx]/);
  const seller_id = seller_id_match ? seller_id_match[0] : "";
  if (seller_id_raw && (!seller_id || !isValidChineseId(seller_id))) {
    warnings.push("身份证号可能错误，请核对");
  }
  const seller_phone = extractPhone(t, phoneLabels);
  const phoneRaw = pickByLabels(t, phoneLabels);
  const phoneDigits = String(phoneRaw || "").replace(/\D/g, "");
  if ((phoneRaw && phoneDigits.length !== 11) || (seller_phone && !isValidPhone(seller_phone))) {
    warnings.push("手机号可能错误：手机号必须是11位");
  }
  const activation = extractActivationFromText(t);

  // \u578b\u53f7\u5185\u5b58\uff1a17promax 256G / \u4e5f\u517c\u5bb9?\u578b\u53f7\u5185\u5b58\uff1a?
  const model_mem =
    pickByLabels(t, ["\u578b\u53f7\u5185\u5b58", "\u673a\u578b\u5185\u5b58", "\u578b\u53f7", "\u673a\u578b", "\u8bbe\u5907\u578b\u53f7", "\u624b\u673a\u578b\u53f7"]) ||
    pick(t, /\u578b\u53f7\u5185\u5b58\s*:\s*([^\n]+)/) ||
    pick(t, /\u578b\u53f7\s*:\s*([^\n]+)/);

  // \u4ece?17promax 256G?\u91cc\u62c6\u51fa model + memory
  let model = "";
  let memory = "";
  if (model_mem) {
    const mm = model_mem.replace(/\s+/g, " ").trim();
    // \u8bc6\u522b 17promax 256G / 17PM 256 / iPhone 16 Pro Max 256G
    const memMatch = mm.match(/(\d+)\s*(G|GB|T|TB)\b/i);
    if (memMatch) {
      memory = normalizeMemorySize(memMatch[1], memMatch[2]);
    } else {
      const keywordMatch = mm.match(
        /(?:\u5185\u5b58|\u5b58\u50a8|\u5bb9\u91cf|\u914d\u7f6e|ROM|ram|rom)\D*?(\d{2,4})(?:\s*(G|GB|T|TB))?/i
      );
      const fallbackMatch = mm.match(/(?:^|\D)(64|128|256|512|1024|2048)(?:\D|$)/);
      const sizeMatch = keywordMatch || fallbackMatch;
      if (sizeMatch) {
        memory = normalizeMemorySize(sizeMatch[1], sizeMatch[2]);
      }
    }
    model = normalizeModelName(
      mm
        .replace(/(\d+)\s*(G|GB|T|TB)\b/gi, "")
        .trim()
    );
  }
  const matchedModel = matchModelFromList(t, models);
  if ((!model || (models.length && !models.includes(model))) && matchedModel) {
    model = matchedModel;
  }
  if (models.length && model && !models.includes(model) && !matchedModel) {
    model = "";
  }

  const colorOptions = model ? modelColors[model] || [] : getAllColors(modelColors);
  const total_price = parseAmount(
    pick(t, new RegExp("\\u56de\\u6536\\u603b\\u4ef7\\D*([0-9,]+)")) ||
    pick(t, new RegExp("\\u603b\\u4ef7\\D*([0-9,]+)")) ||
    pick(t, new RegExp("\\u56de\\u6536\\u4ef7\\D*([0-9,]+)")) ||
    pick(t, new RegExp("\\u4ef7\\u683c\\D*([0-9,]+)"))
  );

  const color = matchColorFromList(t, colorOptions);
  if (model && colorOptions.length && !color) {
    warnings.push("未识别到有效颜色，请手动选择颜色");
  }

  return {
    seller_name,
    seller_id,
    seller_phone,
    model,
    memory,
    color,
    activation,
    total_price,
    unit_price: total_price || "", // default: unit price equals total price
    warnings,
  };
}

// ====== docx render ======
function renderDocx(templatePath, data) {
  const content = fs.readFileSync(templatePath, "binary");
  const zip = new PizZip(content);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: "{{", end: "}}" },
  });

  doc.setData(data);
  doc.render();

  const buf = doc.getZip().generate({ type: "nodebuffer" });
  return buf;
}

app.post("/api/auth/login", rateLimit, async (req, res) => {
  const payload = req.body || {};
  const user = String(payload.user || "").trim();
  const pass = String(payload.pass || "");
  if (!user || !pass) {
    res.status(400).json({ ok: false, error: "missing_credentials" });
    return;
  }
  const expected = authUsers.get(user);
  if (expected && expected === pass) {
    const state = await getState().catch(() => defaultState);
    const rememberMs = getRememberMsForUser(state, user);
    const session = createSession(user, rememberMs);
    setSessionCookie(req, res, session.token, rememberMs);
    res.json({ ok: true, user, expiresIn: Math.floor(rememberMs / 1000) });
    return;
  }
  try {
    const state = await getState();
    const rememberMs = getRememberMsForUser(state, user);
    if (authUsers.size === 0) {
      const total = await countAuthUsers();
      if (total === 0 && user === defaultAdminUser && pass === defaultAdminPass) {
        const session = createSession(user, rememberMs);
        setSessionCookie(req, res, session.token, rememberMs);
        res.json({ ok: true, user, expiresIn: Math.floor(rememberMs / 1000) });
        return;
      }
    }
    const row = await getAuthUser(user);
    if (!row) {
      res.status(401).json({ ok: false, error: "invalid_credentials" });
      return;
    }
    const hashed = hashPassword(pass, row.salt);
    if (!safeEqualHex(hashed, row.hash)) {
      res.status(401).json({ ok: false, error: "invalid_credentials" });
      return;
    }
    const session = createSession(user, rememberMs);
    setSessionCookie(req, res, session.token, rememberMs);
    res.json({ ok: true, user, expiresIn: Math.floor(rememberMs / 1000) });
  } catch (err) {
    writeLog(errorLogPath, { ts: new Date().toISOString(), type: "auth_login_failed", err: String(err) });
    res.status(500).json({ ok: false, error: "auth_login_failed" });
  }
});

app.get("/api/auth/users", requireSession, requireAdmin, rateLimit, async (req, res) => {
  try {
    const rows = await listAuthUsers();
    res.json({ ok: true, users: rows });
  } catch (err) {
    writeLog(errorLogPath, { ts: new Date().toISOString(), type: "auth_users_list_failed", err: String(err) });
    res.status(500).json({ ok: false, error: "auth_users_list_failed" });
  }
});

app.post("/api/auth/users", requireSession, requireAdmin, rateLimit, async (req, res) => {
  const payload = req.body || {};
  const user = String(payload.user || "").trim();
  const pass = String(payload.pass || "");
  if (!user || !pass) {
    res.status(400).json({ ok: false, error: "missing_credentials" });
    return;
  }
  if (authUsers.has(user)) {
    res.status(400).json({ ok: false, error: "user_reserved" });
    return;
  }
  try {
    await createAuthUser(user, pass);
    res.json({ ok: true });
  } catch (err) {
    const code = err && err.code;
    if (code === "SQLITE_CONSTRAINT") {
      res.status(409).json({ ok: false, error: "user_exists" });
      return;
    }
    writeLog(errorLogPath, { ts: new Date().toISOString(), type: "auth_user_create_failed", err: String(err) });
    res.status(500).json({ ok: false, error: "auth_user_create_failed" });
  }
});

app.delete("/api/auth/users", requireSession, requireAdmin, rateLimit, async (req, res) => {
  const payload = req.body || {};
  const user = String(payload.user || "").trim();
  if (!user) {
    res.status(400).json({ ok: false, error: "missing_user" });
    return;
  }
  if (authUsers.has(user)) {
    res.status(400).json({ ok: false, error: "user_reserved" });
    return;
  }
  if (user === defaultAdminUser) {
    res.status(400).json({ ok: false, error: "user_protected" });
    return;
  }
  try {
    await deleteAuthUser(user);
    res.json({ ok: true });
  } catch (err) {
    writeLog(errorLogPath, { ts: new Date().toISOString(), type: "auth_user_delete_failed", err: String(err) });
    res.status(500).json({ ok: false, error: "auth_user_delete_failed" });
  }
});

app.post("/api/auth/password", requireSession, rateLimit, async (req, res) => {
  const payload = req.body || {};
  const user = String(payload.user || "").trim();
  const oldPass = String(payload.oldPass || "");
  const newPass = String(payload.newPass || "");
  if (!user || !oldPass || !newPass) {
    res.status(400).json({ ok: false, error: "missing_credentials" });
    return;
  }
  if (req.session && req.session.user && req.session.user !== user) {
    res.status(403).json({ ok: false, error: "user_mismatch" });
    return;
  }
  if (authUsers.has(user)) {
    res.status(400).json({ ok: false, error: "user_reserved" });
    return;
  }
  try {
    const row = await getAuthUser(user);
    if (!row) {
      if (authUsers.size === 0) {
        const total = await countAuthUsers();
        if (total === 0 && user === defaultAdminUser && oldPass === defaultAdminPass) {
          await createAuthUser(user, newPass);
          res.json({ ok: true });
          return;
        }
      }
      res.status(401).json({ ok: false, error: "invalid_credentials" });
      return;
    }
    const hashed = hashPassword(oldPass, row.salt);
    if (!safeEqualHex(hashed, row.hash)) {
      res.status(401).json({ ok: false, error: "invalid_credentials" });
      return;
    }
    await updateAuthUserPassword(user, newPass);
    res.json({ ok: true });
  } catch (err) {
    writeLog(errorLogPath, { ts: new Date().toISOString(), type: "auth_password_change_failed", err: String(err) });
    res.status(500).json({ ok: false, error: "auth_password_change_failed" });
  }
});

app.post("/api/admin/verify", requireSession, rateLimit, (req, res) => {
  const payload = req.body || {};
  const password = String(payload.password || "");
  if (!password) {
    res.status(400).json({ ok: false, error: "missing_password" });
    return;
  }
  if (password !== adminPass) {
    res.status(401).json({ ok: false, error: "invalid_password" });
    return;
  }
  if (req.session) {
    req.session.adminVerifiedUntil = Date.now() + 5 * 60 * 1000;
  }
  res.json({ ok: true });
});

app.post("/api/auth/logout", requireSession, rateLimit, (req, res) => {
  const session = getSession(req);
  if (session) {
    const cookies = parseCookies(req);
    const token = cookies.session_token;
    if (token) sessionStore.delete(token);
  }
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.get("/api/state", requireSession, requireAuth, rateLimit, async (req, res) => {
  try {
    const state = await getState();
    res.json({ ok: true, state });
  } catch (err) {
    writeLog(errorLogPath, { ts: new Date().toISOString(), type: "state_read_failed", err: String(err) });
    res.status(500).json({ ok: false, error: "state_read_failed" });
  }
});

app.post("/api/state", requireSession, requireAuth, rateLimit, async (req, res) => {
  try {
    const payload = req.body || {};
    const state = {
      orders: Array.isArray(payload.orders) ? payload.orders : [],
      trash: Array.isArray(payload.trash) ? payload.trash : [],
      sources: Array.isArray(payload.sources) ? payload.sources : [...defaultState.sources],
      defaultSource: typeof payload.defaultSource === "string" ? payload.defaultSource : "",
      models: Array.isArray(payload.models) && payload.models.length ? payload.models : [...defaultState.models],
      modelColors:
        payload.modelColors && typeof payload.modelColors === "object"
          ? payload.modelColors
          : { ...defaultState.modelColors },
      authRememberHours:
        payload.authRememberHours && typeof payload.authRememberHours === "object"
          ? payload.authRememberHours
          : {},
    };
    await saveState(state);
    res.json({ ok: true });
  } catch (err) {
    writeLog(errorLogPath, { ts: new Date().toISOString(), type: "state_write_failed", err: String(err) });
    res.status(500).json({ ok: false, error: "state_write_failed" });
  }
});

app.get("/", (req, res) => res.render("index"));

app.get("/iphone-price", requirePageSession, requireAuth, async (req, res) => {
  try {
    const state = await readIphonePriceState();
    res.render("iphone-price", {
      initialState: state,
      pageUpdatedAt: state.updatedAt || Date.now(),
    });
  } catch (err) {
    writeLog(errorLogPath, { ts: new Date().toISOString(), type: "iphone_price_read_failed", err: String(err) });
    res.status(500).send("iphone_price_read_failed");
  }
});

app.get("/iphone-price/text", requirePageSession, requireAuth, async (req, res) => {
  try {
    const state = await readIphonePriceState();
    res.render("iphone-price-text", {
      initialState: state,
      pageUpdatedAt: state.updatedAt || Date.now(),
    });
  } catch (err) {
    writeLog(errorLogPath, { ts: new Date().toISOString(), type: "iphone_price_read_failed", err: String(err) });
    res.status(500).send("iphone_price_read_failed");
  }
});

app.get("/api/iphone-price", requireSession, requireAuth, rateLimit, async (req, res) => {
  try {
    const state = await readIphonePriceState();
    res.json({ ok: true, state });
  } catch (err) {
    writeLog(errorLogPath, { ts: new Date().toISOString(), type: "iphone_price_read_failed", err: String(err) });
    res.status(500).json({ ok: false, error: "iphone_price_read_failed" });
  }
});

app.post("/api/iphone-price", requireSession, requireAuth, rateLimit, async (req, res) => {
  try {
    const payload = req.body && typeof req.body === "object" ? req.body.state : null;
    if (!payload || typeof payload !== "object") {
      res.status(400).json({ ok: false, error: "invalid_state" });
      return;
    }
    const nextState = await saveIphonePriceState(payload);
    res.json({ ok: true, state: nextState });
  } catch (err) {
    writeLog(errorLogPath, { ts: new Date().toISOString(), type: "iphone_price_write_failed", err: String(err) });
    res.status(500).json({ ok: false, error: "iphone_price_write_failed" });
  }
});

// 1) 识别接口
app.post("/parse", requireSession, requireAuth, rateLimit, async (req, res) => {
  try {
    const { rawText } = req.body;
    const state = await getState();
    const data = extractFromRaw(rawText || "", {
      models: state.models || defaultState.models,
      modelColors: state.modelColors || defaultState.modelColors,
    });
    res.json({ ok: true, data });
  } catch (err) {
    writeLog(errorLogPath, { ts: new Date().toISOString(), type: "parse_failed", err: String(err) });
    res.status(500).json({ ok: false, error: "parse_failed" });
  }
});

// 2) 生成接口
app.post("/generate", requireSession, requireAuth, rateLimit, async (req, res) => {
  const payload = req.body;
  let state;
  try {
    state = await getState();
  } catch (err) {
    writeLog(errorLogPath, { ts: new Date().toISOString(), type: "state_read_failed", err: String(err) });
    res.status(500).send("state_read_failed");
    return;
  }
  const selectionCheck = validateSelection(payload || {}, state);
  if (!selectionCheck.ok) {
    res.status(400).send(selectionCheck.message);
    return;
  }

  // 这里字段名要和模板里的 {{变量}} 对得上
  const data = {
    seller_name: payload.seller_name || "",
    seller_id: payload.seller_id || "",
    seller_phone: payload.seller_phone || "",
    model: payload.model || "",
    memory: selectionCheck.memory || "",
    color: payload.color || "",
    activation: payload.activation || "未激活",
    unit_price: payload.unit_price || "",
    total_price: payload.total_price || "",
  };

  if (!/^[\u4e00-\u9fa5]{2,4}$/.test(data.seller_name)) {
    res.status(400).send("\u5ba2\u6237\u59d3\u540d\u5fc5\u987b\u662f2-4\u4e2a\u4e2d\u6587\u5b57\u7b26");
    return;
  }

  if (!isValidPhone(data.seller_phone)) {
    res.status(400).send("\u624b\u673a\u53f7\u683c\u5f0f\u4e0d\u6b63\u786e");
    return;
  }

  if (!isValidChineseId(data.seller_id)) {
    res.status(400).send("\u8eab\u4efd\u8bc1\u53f7\u7801\u4e0d\u6b63\u786e");
    return;
  }

  const priceValue = parsePriceValue(data.total_price || data.unit_price);
  if (!Number.isFinite(priceValue) || priceValue < 2000 || priceValue > 20000) {
    res.status(400).send("\u4ef7\u683c\u5fc5\u987b\u57282000-20000\u4e4b\u95f4");
    return;
  }

  const templatePath = path.join(__dirname, "templates", "0113.docx");
  let out;
  try {
    out = renderDocx(templatePath, data);
  } catch (err) {
    writeLog(errorLogPath, { ts: new Date().toISOString(), type: "render_failed", err: String(err) });
    res.status(500).send("render_failed");
    return;
  }

  const filename = `${data.seller_name || "???"}_????.docx`;
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.send(out);
});

const PORT = process.env.PORT || 3000;
ensureSchema()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => console.log(`http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error("schema init failed", err);
    app.listen(PORT, "0.0.0.0", () => console.log(`http://localhost:${PORT}`));
  });
