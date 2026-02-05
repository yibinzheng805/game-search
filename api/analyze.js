const https = require("https");

const API_ENDPOINT = "https://ark.cn-beijing.volces.com/api/v3/responses";
const REQUEST_TIMEOUT_MS = Number(process.env.ARK_TIMEOUT_MS || 180000);
const DEFAULT_ANALYSIS_PROMPT =
  process.env.ARK_ANALYSIS_PROMPT ||
  "请根据这些游戏截图做一次简短分析，输出：\n1) 游戏类型/题材与平台\n2) 玩法核心与界面要点（引用可见元素）\n3) 可能的原型与相似游戏（1-3 个）\n要求：简洁、条目化、不过度推理。";

function sendJson(res, status, payload) {
  const data = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(data));
  res.end(data);
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

function postArk({ apiKey, model, content }) {
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

async function parseBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
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

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method Not Allowed" });
    return;
  }

  const apiKey = (process.env.ARK_API_KEY || "").trim();
  const visionModel = (process.env.ARK_VISION_MODEL || process.env.ARK_MODEL || "").trim();
  const thinkingModel = (process.env.ARK_THINKING_MODEL || visionModel).trim();

  if (!apiKey) {
    sendJson(res, 500, { error: "未配置 ARK_API_KEY" });
    return;
  }
  if (!visionModel || !thinkingModel) {
    sendJson(res, 500, { error: "未配置模型 ID（ARK_MODEL/ARK_VISION_MODEL）" });
    return;
  }

  let body;
  try {
    body = await parseBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
    return;
  }

  const images = Array.isArray(body?.images) ? body.images : [];
  const prompts = body?.prompts || {};
  const analysisPrompt = String(prompts.analysis || DEFAULT_ANALYSIS_PROMPT).trim();

  if (images.length < 2 || images.length > 9) {
    sendJson(res, 400, { error: "请上传 2-9 张截图" });
    return;
  }

  try {
    const content = images.map((image) => ({
      type: "input_image",
      image_url: image,
    }));
    content.push({
      type: "input_text",
      text: analysisPrompt,
    });

    const response = await postArk({
      apiKey,
      model: thinkingModel || visionModel,
      content,
    });
    const resultText =
      extractTextFromResponse(response) || "未能获取模型输出，请检查模型响应。";

    sendJson(res, 200, { resultText });
  } catch (err) {
    sendJson(res, 500, { error: err.message || "模型调用失败" });
  }
};

module.exports.config = {
  api: {
    bodyParser: {
      sizeLimit: "20mb",
    },
  },
};

