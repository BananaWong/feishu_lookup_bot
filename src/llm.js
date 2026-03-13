// ============================================================
// llm.js — DeepSeek API 自然语言解析
//
// 唯一职责：把用户的口语化消息 → 结构化 JSON
// ============================================================

const config = require("./config");

/**
 * 系统提示词
 *
 * 设计原则：
 * - 只做提取，不做判断
 * - 尽可能覆盖用户的各种日期写法
 * - 严格 JSON 输出，便于下游解析
 */
function buildSystemPrompt() {
  const now = new Date();
  const year = now.getFullYear();
  const pad = n => String(n).padStart(2, "0");
  const todayStr = `${year}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const offset = d => {
    const t = new Date(now); t.setDate(t.getDate() + d);
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  };
  return `你是一个消息解析助手。你的唯一任务是从用户消息中提取【账号名称列表】和【时间条件】。

请严格按以下 JSON 格式输出，不要输出任何其他内容，不要用 markdown 代码块包裹：

{
  "accounts": ["账号1", "账号2"],
  "date_type": "exact | range | before | none",
  "date_start": "YYYY-MM-DD 或 null",
  "date_end": "YYYY-MM-DD 或 null",
  "brand": "品牌名称或null",
  "query_summary": "一句话概括用户的问题"
}

═══ 账号名称提取规则 ═══

1. 消息中每一行通常是一个账号名。即使某行看起来像问句、陈述句或无意义内容，只要它出现在查询指令之前、且不是指令本身，就应该将其视为账号名提取。
2. 保留原始写法，包括括号和后缀，如 "蹲蹲联动（资讯版）" "见过世面（4-1）"
3. 账号名可以是任何形式的字符串，包括看起来像问句或陈述句的内容，例如 "今天谁联动了" "见过世面吗" 都可能是账号名
4. 判断一行是否是账号名的关键：它是否是用来被查询的对象？
   - 如果整条消息结构是"账号名\n查询指令"，则第一行是账号名
   - 例："今天谁联动了\n这个账号3月20有档期吗" → 账号是"今天谁联动了"，查询指令是第二行
5. 忽略以下内容（不要当成账号名）：
   - @某人 的部分（如 @若雪-客服 @荟荟+客服）
   - 客套用语（如 宝、辛苦、帮我看下、帮我查一下）
   - 项目描述行（如 "项目名称：XXX" "合作形式：XXX" "档期：XXX"）
   - 含有明确日期查询的指令句（如 "这一批账号在3月20号有没有档期"、"3月20有空吗"）
   - 代词/泛指词（如 "这个账号"、"该账号"、"上面的账号"、"以上账号"），这些是指前文已提到的账号，不是账号名称本身
6. 【重要】当消息中出现 "这个账号"、"该账号"、"上面的账号" 等代词时，它指代的是同一条消息里前面出现的行——那一行才是真正的账号名，必须提取。
   - 例："今天谁联动了\n这个账号3月20有档期吗" → 账号是"今天谁联动了"（"这个账号"指代它）
   - 例："见过世面吗\n该账号3/21-3/24有空吗" → 账号是"见过世面吗"

═══ 日期解析规则（今天是 ${todayStr}）═══

相对日期（优先处理）：
- "今天" → exact, date_start = date_end = ${todayStr}
- "明天" → exact, date_start = date_end = ${offset(1)}
- "后天" → exact, date_start = date_end = ${offset(2)}
- "昨天" → exact, date_start = date_end = ${offset(-1)}
- "今天之前" "今天前" → before, date_end = ${todayStr}
- "明天之前" "明天前" → before, date_end = ${offset(1)}
- "今天起" "从今天到X" → range, date_start = ${todayStr}

绝对日期：
- "3月20号" "3/20" "3.20" → exact, date_start = date_end = ${year}-03-20
- "3/21-3/24" "3月21到24号" "3.21~3.24" → range, date_start = 03-21, date_end = 03-24
- "3月10号前" "3.10前" "3月10号之前" → before, date_start = null, date_end = ${year}-03-10
- 没有提到日期 → date_type = "none", date_start = null, date_end = null

═══ 品牌提取规则 ═══

- "可以接麦当劳不" → brand = "麦当劳"
- "项目名称：阿里-闲鱼新功能" → brand = "阿里-闲鱼"
- 没提到品牌 → brand = null

只输出 JSON。`;
}

/**
 * 调用 DeepSeek 解析用户消息
 *
 * @param {string} userMessage 用户原始消息文本
 * @returns {object} 解析后的结构化对象
 */
async function parseMessage(userMessage) {
  console.log("[llm] 调用 DeepSeek 解析消息 ...");
  console.log(`[llm] 原始输入: ${userMessage.replace(/\n/g, " | ")}`);
  const t0 = Date.now();

  const res = await fetch(`${config.deepseek.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.deepseek.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.deepseek.model,
      messages: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: userMessage },
      ],
      temperature: 0,    // 确定性输出，每次结果一致
      max_tokens: 2000,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`DeepSeek API 返回 ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content?.trim();

  if (!content) {
    throw new Error("DeepSeek 返回内容为空");
  }

  // 清理可能的 markdown 代码块包裹
  let clean = content;
  if (clean.startsWith("```")) {
    clean = clean.replace(/```json?\n?/g, "").replace(/```\s*$/g, "").trim();
  }

  console.log(`[llm] 原始输出: ${clean.replace(/\n/g, " ")}`);
  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    console.error("[llm] JSON 解析失败，原始输出:", content);
    throw new Error(`LLM 输出格式错误: ${e.message}`);
  }

  // 校验
  if (!Array.isArray(parsed.accounts)) {
    throw new Error("解析结果中 accounts 不是数组");
  }

  // 清理账号名中可能的空白
  parsed.accounts = parsed.accounts
    .map(a => (typeof a === "string" ? a.trim() : ""))
    .filter(a => a.length > 0);

  console.log(
    `[llm] 解析完成: ${parsed.accounts.length} 个账号, ` +
    `date_type=${parsed.date_type}, 耗时 ${Date.now() - t0}ms`
  );
  console.log(`[llm] DEBUG accounts=${JSON.stringify(parsed.accounts)}`);

  return parsed;
}

module.exports = { parseMessage };
