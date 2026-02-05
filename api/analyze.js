const https = require("https");

const API_ENDPOINT = "https://ark.cn-beijing.volces.com/api/v3/responses";
const REQUEST_TIMEOUT_MS = Number(process.env.ARK_TIMEOUT_MS || 180000);
const DEFAULT_VISION_PROMPT =
  process.env.ARK_VISION_PROMPT ||
  "请详细描述这张游戏截图的内容。提取其中的文字（OCR）、识别界面元素（按钮、菜单、数值、角色、任务、地图、战斗/经营等）、判断游戏类型与核心玩法线索、推测平台（手游/PC/主机）、画面风格与视角。如果出现关卡/活动/付费信息，请明确指出。";
const DEFAULT_THINKING_PROMPT =
  process.env.ARK_THINKING_PROMPT ||
  "你是资深游戏分析师和产品研究员，擅长通过截图判断游戏类型、玩法机制、目标用户与市场定位，并能给出结构化结论。\n\n你的任务是根据用户提供的游戏截图信息（由视觉模型提取），输出该游戏的多维度分析结论。\n\n分析维度：\n1. 基本信息：可能的游戏类型、题材/世界观、平台（手游/PC/主机）、玩法核心循环。\n2. 界面信号：UI 结构、关键按钮/数值、任务/关卡/货币/活动提示带来的设计意图。\n3. 体验判断：节奏、难度、PVE/PVP、社交/公会、养成/收集等特征。\n4. 商业化线索：内购、礼包、体力/抽卡/订阅等可能出现的付费点。\n5. 市场对标：推测原型游戏，并给出 3-5 款市场相似游戏与相似点。\n\n输出要求：\n1. 结构清晰：用小标题或列表呈现。\n2. 结论具体：尽量引用截图中的可见信息。\n3. 语气风格：专业、简洁、可落地。";

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
  const visionPrompt = String(prompts.vision || DEFAULT_VISION_PROMPT).trim();
  const thinkingPrompt = String(prompts.thinking || DEFAULT_THINKING_PROMPT).trim();

  if (images.length < 2 || images.length > 9) {
    sendJson(res, 400, { error: "请上传 2-9 张截图" });
    return;
  }

  try {
    const visionContent = images.map((image) => ({
      type: "input_image",
      image_url: image,
    }));
    visionContent.push({
      type: "input_text",
      text: `${visionPrompt || "请描述截图内容。"}\n请逐张输出，按顺序标注为【截图1】、【截图2】...`,
    });

    const visionResponse = await postArk({
      apiKey,
      model: visionModel,
      content: visionContent,
    });
    const visionText =
      extractTextFromResponse(visionResponse) || "未能获取视觉解析结果。";

    const combinedInput = `${thinkingPrompt || "请给出游戏分析。"}\n\n以下是游戏截图的视觉解析结果：\n${visionText}`;

    const thinkingResponse = await postArk({
      apiKey,
      model: thinkingModel,
      content: [{ type: "input_text", text: combinedInput }],
    });
    const resultText =
      extractTextFromResponse(thinkingResponse) || "未能获取模型输出，请检查模型响应。";

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

