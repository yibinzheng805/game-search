const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const API_ENDPOINT = "https://ark.cn-beijing.volces.com/api/v3/responses";
const ENV_VISION_MODEL = (process.env.ARK_VISION_MODEL || "").trim();
const ENV_THINKING_MODEL = (process.env.ARK_THINKING_MODEL || "").trim();
const REQUEST_TIMEOUT_MS = Number(process.env.ARK_TIMEOUT_MS || 180000);
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").trim();

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return "";
  }
}

function getApiKey() {
  if (process.env.ARK_API_KEY) return process.env.ARK_API_KEY.trim();
  const apiKeyFile = path.join(ROOT, "API key.txt");
  const content = readFileSafe(apiKeyFile);
  const match = content.match(/ARK_API_KEY="([^"]+)"/);
  if (match) return match[1].trim();
  const rawMatch = content.match(/Bearer\s+([A-Za-z0-9-_.]+)/);
  if (rawMatch) return rawMatch[1].trim();
  return "";
}

function getModelFromFile() {
  const apiKeyFile = path.join(ROOT, "API key.txt");
  const content = readFileSafe(apiKeyFile);
  const visionMatch = content.match(/"model"\s*:\s*"([^"]+)"/);
  return {
    visionModel: visionMatch ? visionMatch[1].trim() : "",
  };
}

function sendJson(res, status, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function logInfo(message, extra) {
  if (LOG_LEVEL === "silent") return;
  const base = `[INFO] ${new Date().toISOString()} ${message}`;
  if (extra) {
    // eslint-disable-next-line no-console
    console.log(base, extra);
  } else {
    // eslint-disable-next-line no-console
    console.log(base);
  }
}

function logError(message, extra) {
  if (LOG_LEVEL === "silent") return;
  const base = `[ERROR] ${new Date().toISOString()} ${message}`;
  if (extra) {
    // eslint-disable-next-line no-console
    console.error(base, extra);
  } else {
    // eslint-disable-next-line no-console
    console.error(base);
  }
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(text);
}

function extractTextFromResponse(data) {
  const candidates = [];
  if (data && data.output_text) candidates.push(data.output_text);
  if (Array.isArray(data?.output)) {
    data.output.forEach((item) => {
      if (item?.content) {
        item.content.forEach((content) => {
          if (content?.text) candidates.push(content.text);
        });
      }
    });
  }
  if (Array.isArray(data?.choices)) {
    data.choices.forEach((choice) => {
      const content = choice?.message?.content;
      if (content) candidates.push(content);
    });
  }
  return candidates.join("\n").trim();
}

function postArk({ apiKey, model, content, step }) {
  const body = JSON.stringify({
    model,
    input: [
      {
        role: "user",
        content,
      },
    ],
  });

  return new Promise((resolve, reject) => {
    const url = new URL(API_ENDPOINT);
    const startedAt = Date.now();
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          const took = Date.now() - startedAt;
          logInfo(`Ark 响应完成 step=${step} status=${res.statusCode} cost=${took}ms`);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`模型请求失败：${res.statusCode} ${raw}`));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(new Error("模型返回非 JSON 格式"));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error("模型请求超时"));
    });
    req.write(body);
    req.end();
  });
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 50 * 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch (err) {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
  });
}

async function handleAnalyze(req, res) {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const apiKey = getApiKey();
  if (!apiKey) {
    sendJson(res, 500, { error: "未找到 ARK_API_KEY，请检查 API key.txt" });
    return;
  }
  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
    return;
  }

  const images = Array.isArray(body?.images) ? body.images : [];
  const prompts = body?.prompts || {};
  const visionPrompt = String(prompts.vision || "").trim();
  const thinkingPrompt = String(prompts.thinking || "").trim();
  const modelFromFile = getModelFromFile();
  const visionModel = String(
    body?.visionModel || ENV_VISION_MODEL || modelFromFile.visionModel
  ).trim();
  const thinkingModel = String(
    body?.thinkingModel || ENV_THINKING_MODEL || modelFromFile.visionModel || visionModel
  ).trim();

  logInfo(`分析开始 id=${requestId} images=${images.length}`);
  logInfo(`模型配置 id=${requestId} vision=${visionModel} thinking=${thinkingModel}`);

  if (images.length < 5 || images.length > 9) {
    sendJson(res, 400, { error: "请上传 5-9 张截图" });
    return;
  }
  if (!visionModel || !thinkingModel) {
    sendJson(res, 400, { error: "模型参数缺失，请在 API key.txt 中配置 model" });
    return;
  }

  try {
    const visionResults = [];
    for (let i = 0; i < images.length; i += 1) {
      logInfo(`视觉解析开始 id=${requestId} index=${i + 1}/${images.length}`);
      const response = await postArk({
        apiKey,
        model: visionModel,
        content: [
          { type: "input_image", image_url: images[i] },
          {
            type: "input_text",
            text: `${visionPrompt || "请描述截图内容。"}\n（第 ${i + 1} 张截图）`,
          },
        ],
        step: `vision_${i + 1}`,
      });
      const text = extractTextFromResponse(response);
      visionResults.push(`【截图 ${i + 1}】\n${text || "无识别结果"}`);
    }

    logInfo(`推理开始 id=${requestId} inputLength=${visionResults.length}`);
    const combinedInput = `${thinkingPrompt || "请给出游戏分析。"}\n\n以下是游戏截图的视觉解析结果：\n${visionResults.join(
      "\n\n"
    )}`;

    const thinkingResponse = await postArk({
      apiKey,
      model: thinkingModel,
      content: [{ type: "input_text", text: combinedInput }],
      step: "thinking",
    });
    const resultText =
      extractTextFromResponse(thinkingResponse) || "未能获取模型输出，请检查模型响应。";

    logInfo(`分析完成 id=${requestId} resultLength=${resultText.length}`);
    sendJson(res, 200, { resultText });
  } catch (err) {
    logError(`分析失败 id=${requestId}`, err?.message || err);
    sendJson(res, 500, { error: err.message || "模型调用失败" });
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.join(ROOT, pathname);
  if (!filePath.startsWith(ROOT)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  const ext = path.extname(filePath);
  const contentTypeMap = {
    ".html": "text/html; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
  };
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendText(res, 404, "Not Found");
    return;
  }
  const data = fs.readFileSync(filePath);
  sendText(res, 200, data, contentTypeMap[ext] || "application/octet-stream");
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url.startsWith("/api/analyze")) {
    handleAnalyze(req, res);
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/api/health")) {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }
  sendText(res, 405, "Method Not Allowed");
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server running at http://localhost:${PORT}`);
});

