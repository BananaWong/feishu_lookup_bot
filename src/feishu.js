// ============================================================
// feishu.js — 飞书 API 封装
//
// 功能：
//   - tenant_access_token 获取与自动缓存
//   - 字段映射缓存：field_id → field_name（启动时加载，改名后自愈）
//   - 多维表格记录查询（支持 filter）
//   - 消息发送与回复
// ============================================================

const config = require("./config");

const BASE = "https://open.feishu.cn/open-apis";

// ─── Token 缓存 ───
let tokenCache = { token: null, expiresAt: 0 };

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  console.log("[feishu] 正在获取 tenant_access_token ...");

  const res = await fetch(`${BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: config.feishu.appId,
      app_secret: config.feishu.appSecret,
    }),
  });

  const data = await res.json();

  if (data.code !== 0) {
    throw new Error(`获取 token 失败 [${data.code}]: ${data.msg}`);
  }

  tokenCache = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + (data.expire - 300) * 1000,
  };

  console.log("[feishu] token 已刷新，有效期至", new Date(tokenCache.expiresAt).toLocaleString());
  return tokenCache.token;
}

// ─── 字段映射缓存 ───
// tableId → Map<fieldId, fieldName>
// 启动时加载一次，字段改名后重启自动更新
const fieldMappings = new Map();

/**
 * 查询所有表的 schema，建立 field_id → field_name 映射
 * 在 index.js 启动时调用一次
 */
async function loadFieldMappings() {
  const token = await getToken();

  const tasks = [
    ...Object.values(config.bitable.tables).map(t => ({
      id: t.id, name: t.name, appToken: config.bitable.appToken,
    })),
    {
      id: config.bitable.tableA.id,
      name: config.bitable.tableA.name,
      appToken: config.bitable.tableA.appToken,
    },
  ];

  await Promise.all(tasks.map(async ({ id, name, appToken }) => {
    try {
      const url = `${BASE}/bitable/v1/apps/${appToken}/tables/${id}/fields`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();

      if (data.code !== 0) {
        console.warn(`[feishu] schema 加载失败 ${name} [${data.code}]: ${data.msg}`);
        return;
      }

      const map = new Map();
      for (const f of data.data?.items || []) {
        map.set(f.field_id, f.field_name);
      }
      fieldMappings.set(id, map);
      console.log(`[feishu] schema 已加载: ${name} (${map.size} 个字段)`);
    } catch (e) {
      console.warn(`[feishu] schema 加载异常 ${name}: ${e.message}`);
    }
  }));
}

/**
 * 将 field_id 解析为当前字段名
 * 字段改名后，下次重启会自动拿到新名字
 */
function resolveField(tableId, fieldId) {
  return fieldMappings.get(tableId)?.get(fieldId) ?? null;
}

// ─── 记录查询 ───

/**
 * 查询多维表格记录
 *
 * @param {string}        tableId    表 ID
 * @param {object|null}   filter     筛选条件（可为 null）
 * @param {string[]|null} fieldNames 需要返回的字段列表（null = 返回全部）
 * @param {string}        appToken   可选，覆盖默认 appToken
 * @returns {object[]|null} 记录数组，失败返回 null
 */
async function searchRecords(tableId, filter, fieldNames, appToken) {
  const token = await getToken();
  const url = `${BASE}/bitable/v1/apps/${appToken || config.bitable.appToken}/tables/${tableId}/records/search`;

  const allItems = [];
  let pageToken = undefined;

  do {
    const body = { page_size: 500 };
    if (fieldNames && fieldNames.length > 0) body.field_names = fieldNames;
    if (filter) body.filter = filter;
    if (pageToken) body.page_token = pageToken;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();

    if (data.code !== 0) {
      console.error(`[feishu] 查询表 ${tableId} 失败 [${data.code}]: ${data.msg}`);
      return null;
    }

    allItems.push(...(data.data?.items || []));
    pageToken = data.data?.has_more ? data.data.page_token : undefined;
  } while (pageToken);

  console.log(`[feishu] 表 ${tableId}: 返回 ${allItems.length} 条记录`);
  return allItems;
}

/**
 * 并发查询全部 4 张 C 表
 *
 * @param {Function|null} filterFn  (tableId) => filter 对象，null 表示不过滤
 * @returns {{ results, failedTables }}
 */
async function queryAllTables(filterFn) {
  // 映射未加载时，先尝试加载（首次查询兜底）
  if (fieldMappings.size === 0) {
    console.warn("[feishu] 字段映射未加载，尝试加载...");
    await loadFieldMappings().catch(e => console.warn("[feishu] 映射加载失败:", e.message));
  }

  const tables = config.bitable.tables;
  const getFilter = typeof filterFn === "function" ? filterFn : () => null;

  console.log("[feishu] 并发查询 4 张表 ...");
  const t0 = Date.now();
  const failedTables = [];

  const results = await Promise.all(
    Object.entries(tables).map(([key, table]) => {
      // 用 field_id 解析出当前字段名，传给 field_names 参数
      const fieldNames = Object.values(table.fieldIds)
        .map(fid => resolveField(table.id, fid))
        .filter(Boolean);

      return searchRecords(table.id, getFilter(table.id), fieldNames).then(records => {
        if (records === null) failedTables.push(table.name);
        return { tableKey: key, tableId: table.id, tableName: table.name, records: records || [] };
      });
    })
  );

  const total = results.reduce((s, t) => s + t.records.length, 0);
  console.log(`[feishu] 4 张表查询完成，共 ${total} 条记录，耗时 ${Date.now() - t0}ms`);
  return { results, failedTables };
}

// ─── 消息发送 ───

async function replyMessage(messageId, text) {
  const token = await getToken();

  const res = await fetch(`${BASE}/im/v1/messages/${messageId}/reply`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: JSON.stringify({ text }),
      msg_type: "text",
    }),
  });

  const data = await res.json();
  if (data.code !== 0) {
    console.error(`[feishu] 回复消息失败 [${data.code}]: ${data.msg}`);
  }
  return data;
}

async function sendMessage(chatId, text) {
  const token = await getToken();

  const res = await fetch(`${BASE}/im/v1/messages?receive_id_type=chat_id`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      receive_id: chatId,
      content: JSON.stringify({ text }),
      msg_type: "text",
    }),
  });

  const data = await res.json();
  if (data.code !== 0) {
    console.error(`[feishu] 发送消息失败 [${data.code}]: ${data.msg}`);
  }
  return data;
}

module.exports = {
  getToken,
  loadFieldMappings,
  resolveField,
  searchRecords,
  queryAllTables,
  replyMessage,
  sendMessage,
};
