// ============================================================
// index.js — HTTP 服务入口
//
// 接收飞书事件回调 → 分发给 handler 处理 → 回复飞书消息
// ============================================================

// 强制 stdout/stderr 同步写入（容器环境非 TTY 时默认全缓冲，会导致日志丢失）
process.stdout._handle?.setBlocking(true);
process.stderr._handle?.setBlocking(true);

// 加载 .env 文件（必须最先执行）
require("./env");

const http = require("http");
const config = require("./config");
const { validateConfig } = require("./config");
const feishu = require("./feishu");
const { handleQuery, normalize } = require("./handler");

// 校验配置
validateConfig();

// ─── 消息去重 ───
// 飞书会在超时后重发事件，需要去重避免重复处理
const processedEvents = new Map();
const EVENT_TTL = 5 * 60 * 1000;

// ─── 模糊匹配待确认状态 ───
const pendingConfirmations = new Map(); // chatId -> {overrides, originalText, expiresAt}
const PENDING_TTL = 5 * 60 * 1000;

function isConfirmation(text) {
  const t = text.trim().replace(/[。！!？?]/g, "").toLowerCase();
  return ["确认", "是", "对", "好", "是的", "对的", "好的", "yes", "嗯", "嗯嗯"].includes(t);
}

function isSelectionInput(text) {
  // 纯数字、空格、逗号组成，如 "1" "1 3" "1,2"
  return /^\d[\d\s,，]*$/.test(text.trim());
}

function isDuplicate(eventId) {
  if (!eventId) return false;
  if (processedEvents.has(eventId)) return true;
  processedEvents.set(eventId, Date.now());
  // 定期清理过期记录
  if (processedEvents.size > 500) {
    const now = Date.now();
    for (const [id, time] of processedEvents) {
      if (now - time > EVENT_TTL) processedEvents.delete(id);
    }
  }
  return false;
}

// ─── 请求体解析 ───
function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve(null);
      }
    });
    req.on("error", reject);
  });
}

// ─── 从飞书事件中提取用户文本 ───
function extractUserText(event) {
  const msg = event?.message;
  if (!msg || msg.message_type !== "text") return null;

  try {
    const content = JSON.parse(msg.content);
    let text = content.text || "";

    // 群聊中 @机器人 会在文本中出现 @_user_xxx 格式，需要清理
    // 同时 mentions 数组里会有详细信息
    const mentions = event.message?.mentions || [];
    for (const m of mentions) {
      if (m.key) {
        text = text.replace(m.key, "");
      }
    }

    return text.trim() || null;
  } catch {
    return null;
  }
}

// ─── 判断是否是发给机器人的消息 ───
function shouldProcess(event) {
  // 忽略机器人自己发的消息
  if (event.sender?.sender_type === "app") return false;

  const chatType = event.message?.chat_type;
  const mentions = event.message?.mentions || [];

  // 单聊：所有消息都处理
  if (chatType === "p2p") return true;

  // 群聊：只处理 @了机器人的消息
  if (chatType === "group") {
    const botMentioned = mentions.some(
      m => m.id?.app_id === config.feishu.appId || m.name === "档期助手"
    );
    return botMentioned;
  }

  return true; // 其他情况默认处理
}

// ─── 主请求处理 ───
async function handleRequest(req, res) {
  // GET = 健康检查
  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "running",
      service: "feishu-schedule-bot",
      version: "1.0.0",
    }));
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405);
    res.end("Method Not Allowed");
    return;
  }

  const body = await parseBody(req);
  if (!body) {
    res.writeHead(400);
    res.end("Bad Request");
    return;
  }

  // ─── 飞书 URL 验证 ───
  // 首次在飞书开放平台配置回调地址时，飞书会发送一个验证请求
  if (body.type === "url_verification") {
    console.log("[server] 收到 URL 验证请求 ✓");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ challenge: body.challenge }));
    return;
  }

  // ─── 事件回调 ───
  // 关键：必须立即返回 200，否则飞书会超时重发
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ code: 0 }));

  // 事件去重
  const eventId = body.header?.event_id;
  if (isDuplicate(eventId)) {
    console.log(`[server] 重复事件，跳过: ${eventId}`);
    return;
  }

  // 只处理消息接收事件
  if (body.header?.event_type !== "im.message.receive_v1") {
    return;
  }

  const event = body.event;
  if (!event || !shouldProcess(event)) return;

  const text = extractUserText(event);
  const messageId = event.message?.message_id;
  const chatId = event.message?.chat_id;

  if (!text || !messageId) {
    console.log("[server] 消息为空或非文本消息，跳过");
    return;
  }

  // ─── 处理查询 ───
  const logPrefix = `[${new Date().toLocaleTimeString()}]`;
  console.log(`\n${"═".repeat(60)}`);
  console.log(`${logPrefix} 收到查询:`);
  console.log(`  文本: ${text.substring(0, 120)}${text.length > 120 ? "..." : ""}`);
  console.log(`  消息ID: ${messageId}`);
  console.log(`  会话ID: ${chatId}`);

  // ─── 检查是否是对模糊匹配的确认/选择 ───
  const pending = pendingConfirmations.get(chatId);
  if (pending && Date.now() < pending.expiresAt) {
    // 确认模式（单候选）
    if (pending.overrides && isConfirmation(text)) {
      pendingConfirmations.delete(chatId);
      console.log(`${logPrefix} 用户确认模糊匹配，重新查询`);
      try {
        await feishu.replyMessage(messageId, "🔍 查询中，请稍候...");
        const result = await handleQuery(pending.originalText, pending.overrides);
        await feishu.sendMessage(chatId, result.reply);
        console.log(`${logPrefix} ✓ 确认查询回复已发送`);
      } catch (e) {
        console.error(`${logPrefix} ✗ 确认查询失败:`, e);
      }
      return;
    }

    // 选择模式（多候选）
    if (pending.selectionMap && isSelectionInput(text)) {
      const nums = text.trim().split(/[\s,，]+/).map(Number)
        .filter(n => !isNaN(n) && n >= 1 && n <= pending.selectionMap.length);
      if (nums.length > 0) {
        pendingConfirmations.delete(chatId);
        // 合并用户选择 + 单候选自动覆盖
        const overrides = { ...pending.autoOverrides };
        const selectedFroms = new Set();
        for (const n of nums) {
          const e = pending.selectionMap[n - 1];
          if (!selectedFroms.has(e.normalizedFrom)) {
            overrides[e.normalizedFrom] = e.to;
            selectedFroms.add(e.normalizedFrom);
          }
        }
        // 未选到的多候选账号，自动取第一个候选
        for (const e of pending.selectionMap) {
          if (!selectedFroms.has(e.normalizedFrom)) {
            overrides[e.normalizedFrom] = e.to;
            selectedFroms.add(e.normalizedFrom);
          }
        }
        console.log(`${logPrefix} 用户选择 [${nums.join(",")}]，重新查询`);
        try {
          await feishu.replyMessage(messageId, "🔍 查询中，请稍候...");
          const result = await handleQuery(pending.originalText, overrides);
          await feishu.sendMessage(chatId, result.reply);
          console.log(`${logPrefix} ✓ 选择查询回复已发送`);
        } catch (e) {
          console.error(`${logPrefix} ✗ 选择查询失败:`, e);
        }
        return;
      }
    }
  } else if (pending) {
    pendingConfirmations.delete(chatId);
  }

  // 先回复一个"查询中"的提示
  try {
    await feishu.replyMessage(messageId, "🔍 查询中，请稍候...");
  } catch (e) {
    console.error(`${logPrefix} 发送查询中提示失败:`, e.message);
  }

  // 执行查询
  try {
    const result = await handleQuery(text);
    const reply = typeof result === "string" ? result : result.reply;
    const suggestions = typeof result === "string" ? [] : (result.suggestions || []);

    // 如果有模糊匹配建议，保存待确认/选择状态
    if (suggestions.length > 0 && chatId) {
      const hasMulti = suggestions.some(s => s.candidates.length > 1);
      if (!hasMulti) {
        // 全部单候选：确认模式
        const overrides = {};
        for (const s of suggestions) {
          overrides[normalize(s.from)] = s.candidates[0];
        }
        pendingConfirmations.set(chatId, {
          overrides,
          originalText: text,
          expiresAt: Date.now() + PENDING_TTL,
        });
      } else {
        // 有多候选：选择模式，flat 化 selectionMap，单候选自动解析
        const selectionMap = [];
        const autoOverrides = {};
        for (const s of suggestions) {
          if (s.candidates.length === 1) {
            autoOverrides[normalize(s.from)] = s.candidates[0];
          } else {
            for (const c of s.candidates) {
              selectionMap.push({ normalizedFrom: normalize(s.from), from: s.from, to: c });
            }
          }
        }
        pendingConfirmations.set(chatId, {
          selectionMap,
          autoOverrides,
          originalText: text,
          expiresAt: Date.now() + PENDING_TTL,
        });
      }
    }

    // 把结果发到会话中
    if (chatId) {
      await feishu.sendMessage(chatId, reply);
    } else {
      await feishu.replyMessage(messageId, reply);
    }

    console.log(`${logPrefix} ✓ 回复已发送`);
  } catch (e) {
    console.error(`${logPrefix} ✗ 处理失败:`, e);
    try {
      const errMsg = `❌ 处理出错：${e.message}\n\n如果持续出错，请联系管理员。`;
      if (chatId) {
        await feishu.sendMessage(chatId, errMsg);
      }
    } catch {
      // 连错误消息都发不出去，只能记日志了
    }
  }
}

// ─── 启动服务 ───
const server = http.createServer(handleRequest);

server.listen(config.server.port, () => {
  // 启动后立即加载字段映射（field_id → 当前字段名），之后每小时刷新一次
  feishu.loadFieldMappings().then(() => {
    console.log("  ✅ 字段映射加载完成，可以接收查询");
    console.log("");
  }).catch(e => {
    console.warn("  ⚠️ 字段映射加载失败（首次查询时会自动重试）:", e.message);
    console.log("");
  });
  setInterval(() => {
    feishu.loadFieldMappings().catch(e => console.warn("[schema] 定时刷新失败:", e.message));
  }, 60 * 60 * 1000);
  console.log("");
  console.log("  ┌─────────────────────────────────────┐");
  console.log("  │   🤖 飞书档期查询 Bot 已启动         │");
  console.log("  └─────────────────────────────────────┘");
  console.log("");
  console.log(`  端口:     ${config.server.port}`);
  console.log(`  飞书应用: ${config.feishu.appId}`);
  console.log(`  LLM:     ${config.deepseek.model} @ ${config.deepseek.baseUrl}`);
  console.log("");
  console.log(`  👉 把以下地址填入飞书开放平台「事件订阅」的请求地址：`);
  console.log(`     http://你的公网IP:${config.server.port}/`);
  console.log("");
  console.log("  等待飞书消息中 ...");
  console.log("");
});
