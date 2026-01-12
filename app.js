const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require("fs");

const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");

const app = express();
app.use(bodyParser.json({ limit: "2mb" }));
app.use(bodyParser.urlencoded({ extended: true }));
app.set("view engine", "ejs");

// ====== 识别函数：从一大段文本里提取 ======
function normalizeText(s) {
  return (s || "")
    .replace(/\r/g, "")
    .replace(/[：]/g, ":")
    .replace(/\u00A0/g, " "); // 处理特殊空格
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
    const re = new RegExp(`${escapeRegex(label)}[^\\d]{0,8}(1[3-9]\\d{9})`);
    const m = text.match(re);
    if (m) return m[1];
  }
  const fallback = text.match(/(?:^|\D)(1[3-9]\d{9})(?!\d)/);
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

function extractFromRaw(raw) {
  const t = normalizeText(raw);

  const nameLabels = [
    "姓名",
    "姓名/称呼",
    "客户姓名",
    "客户名称",
    "客户",
    "联系人",
    "联系人姓名",
    "卖家姓名",
    "卖方姓名",
    "出卖人",
    "出卖人姓名",
    "出售人",
    "出售人姓名",
    "回收人",
    "回收人姓名",
    "卖方",
    "卖家",
    "称呼",
  ];

  const phoneLabels = [
    "手机号",
    "手机号码",
    "联系手机",
    "电话",
    "电话号",
    "电话号码",
    "联系电话",
    "联系方式",
    "客户手机",
    "客户手机号",
    "客户电话",
    "客户电话号",
    "客户联系电话",
  ];

  const seller_name = pickByLabels(t, nameLabels);
  const seller_id = pick(t, /身份证(?:号码)?\s*:\s*([0-9Xx]{18})/);
  const seller_phone = extractPhone(t, phoneLabels);

  // 型号内存：17promax 256G  / 也兼容 “型号内存 ：”
  const model_mem = pick(t, /型号内存\s*:\s*([^\n]+)/) || pick(t, /型号\s*:\s*([^\n]+)/);

  // 从 “17promax 256G” 里拆出 model + memory
  let model = "";
  let memory = "";
  if (model_mem) {
    const mm = model_mem.replace(/\s+/g, " ").trim();
    // ?????17promax 256G / 17PM 256 / iPhone 16 Pro Max 256G
    const memMatch = mm.match(/(\d+)\s*(G|GB|T|TB)\b/i);
    if (memMatch) {
      memory = normalizeMemorySize(memMatch[1], memMatch[2]);
    } else {
      const keywordMatch = mm.match(
        /(?:内存|存储|容量|配置|ROM|ram|rom)\D*?(\d{2,4})(?:\s*(G|GB|T|TB))?/i
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

  const total_price = parseAmount(
    pick(t, new RegExp("\\u56de\\u6536\\u603b\\u4ef7\\D*([0-9,]+)")) ||
    pick(t, new RegExp("\\u603b\\u4ef7\\D*([0-9,]+)")) ||
    pick(t, new RegExp("\\u56de\\u6536\\u4ef7\\D*([0-9,]+)")) ||
    pick(t, new RegExp("\\u4ef7\\u683c\\D*([0-9,]+)"))
  );

  return {
    seller_name,
    seller_id,
    seller_phone,
    model,
    memory,
    total_price,
    unit_price: total_price || "", // default: unit price equals total price
  };
}

// ====== 生成 docx：用模板替换变量，格式保留 ======
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

app.get("/", (req, res) => res.render("index"));

// 1) 识别接口
app.post("/parse", (req, res) => {
  const { rawText } = req.body;
  const data = extractFromRaw(rawText || "");
  res.json({ ok: true, data });
});

// 2) 生成接口
app.post("/generate", (req, res) => {
  const payload = req.body;

  // 这里字段名要和模板里的 {{变量}} 对得上
  const data = {
    seller_name: payload.seller_name || "",
    seller_id: payload.seller_id || "",
    seller_phone: payload.seller_phone || "",
    model: payload.model || "",
    memory: payload.memory || "",
    unit_price: payload.unit_price || "",
    total_price: payload.total_price || "",
  };

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
  const out = renderDocx(templatePath, data);

  const filename = `${data.seller_name || "未命名"}_买卖合同.docx`;
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.send(out);
});

app.listen(3000, () => console.log("http://localhost:3000"));
