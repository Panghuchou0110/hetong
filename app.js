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

function parseAmount(raw) {
  return (raw || "").replace(/[^\d]/g, "");
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

  const seller_name = pick(t, /姓名\s*:\s*([^\n]+)/);
  const seller_id = pick(t, /身份证(?:号码)?\s*:\s*([0-9Xx]{18})/);
  const seller_phone = pick(t, /手机号码\s*:\s*(1\d{10})/);

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
      memory = memMatch[1] + (memMatch[2].toUpperCase().includes("T") ? "TB" : "G");
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

  const templatePath = path.join(__dirname, "templates", "0113.docx");
  const out = renderDocx(templatePath, data);

  const filename = `${data.seller_name || "未命名"}_买卖合同.docx`;
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.send(out);
});

app.listen(3000, () => console.log("http://localhost:3000"));
