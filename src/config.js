// ============================================================
// config.js — 配置集中管理
//
// 所有敏感信息从环境变量读取，表结构信息硬编码（提速关键）
// field_id 是飞书 Bitable 的稳定标识，字段改名后 ID 不变。
//
// 如何找到 field_id：
//   node src/test.js --fields
// 或在飞书开放平台 API 调试工具中调用字段查询接口
// ============================================================

const config = {
  // ─── 飞书应用凭证 ───
  feishu: {
    appId:             process.env.FEISHU_APP_ID        || "",
    appSecret:         process.env.FEISHU_APP_SECRET    || "",
    verificationToken: process.env.FEISHU_VERIFY_TOKEN  || "",
    encryptKey:        process.env.FEISHU_ENCRYPT_KEY   || "",
  },

  // ─── LLM API（默认 DeepSeek，兼容 OpenAI 格式均可替换）───
  deepseek: {
    apiKey:  process.env.DEEPSEEK_API_KEY  || "",
    baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    model:   process.env.DEEPSEEK_MODEL    || "deepseek-chat",
  },

  // ─── 飞书多维表格 ───
  bitable: {
    // 主表 appToken（Bitable URL 中 /base/{appToken} 部分）
    appToken: "YOUR_BITABLE_APP_TOKEN",

    // 查询用的主表（可配置多张，并发查询）
    // fieldIds 使用飞书稳定的 field_id，字段改名后不影响查询
    tables: {
      T1: {
        id: "YOUR_TABLE_ID_1", name: "表1名称",
        fieldIds: {
          account: "YOUR_FIELD_ID_ACCOUNT",
          date:    "YOUR_FIELD_ID_DATE",
          status:  "YOUR_FIELD_ID_STATUS",
          project: "YOUR_FIELD_ID_PROJECT",
          brand:   "YOUR_FIELD_ID_BRAND",
        },
      },
      // 可继续添加 T2, T3...
      // T2: {
      //   id: "YOUR_TABLE_ID_2", name: "表2名称",
      //   fieldIds: { account: "...", date: "...", status: "...", project: "...", brand: "..." },
      // },
    },

    // 账号总库表（用于判断账号是否存在，以及是否处于不可用状态）
    // 如果没有单独的总库表，可以用主表之一替代，或自行调整 handler.js 中的逻辑
    tableA: {
      appToken: "YOUR_TABLE_A_APP_TOKEN",  // 与主表不同时才需要单独填写
      id: "YOUR_TABLE_A_ID",
      name: "账号总库",
      fieldIds: {
        account:  "YOUR_FIELD_ID_ACCOUNT",
        progress: "YOUR_FIELD_ID_PROGRESS",  // 0 = 不可用，其他值 = 正常
      },
    },
  },

  // ─── 服务 ───
  server: {
    port: parseInt(process.env.PORT) || 3000,
  },
};

// ─── 启动时校验必填项 ───
function validateConfig() {
  const missing = [];
  if (!config.feishu.appId)      missing.push("FEISHU_APP_ID");
  if (!config.feishu.appSecret)  missing.push("FEISHU_APP_SECRET");
  if (!config.deepseek.apiKey)   missing.push("DEEPSEEK_API_KEY");

  if (missing.length > 0) {
    console.error(`\n❌ 缺少必填环境变量: ${missing.join(", ")}`);
    console.error(`   请复制 .env.example 为 .env 并填入对应值\n`);
    process.exit(1);
  }
}

module.exports = config;
module.exports.validateConfig = validateConfig;
