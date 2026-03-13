// dump.js — 拉取所有表的字段结构 + 全量记录，保存到 data/ 目录
//
// 用法：node src/dump.js
//
// 输出：
//   data/schema.json  — 所有表的字段名、类型、选项
//   data/<表名>.json  — 每张表的全量记录

require("./env");
const fs = require("fs");
const path = require("path");
const config = require("./config");

const BASE = "https://open.feishu.cn/open-apis";
const DATA_DIR = path.join(__dirname, "../data");

async function getToken() {
  const res = await fetch(`${BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: config.feishu.appId,
      app_secret: config.feishu.appSecret,
    }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`获取 token 失败: ${data.msg}`);
  return data.tenant_access_token;
}

async function fetchFields(token, appToken, tableId) {
  const res = await fetch(`${BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`获取字段失败 [${tableId}]: ${data.msg}`);
  return data.data?.items || [];
}

async function fetchAllRecords(token, appToken, tableId) {
  const records = [];
  let pageToken = null;

  do {
    const body = { page_size: 500 };
    if (pageToken) body.page_token = pageToken;

    const res = await fetch(`${BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(`查询记录失败 [${tableId}]: ${data.msg}`);

    records.push(...(data.data?.items || []));
    pageToken = data.data?.has_more ? data.data.page_token : null;
  } while (pageToken);

  return records;
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log("获取 token...");
  const token = await getToken();

  // 所有要拉取的表
  const tables = [
    ...Object.entries(config.bitable.tables).map(([key, t]) => ({
      key,
      name: t.name,
      id: t.id,
      appToken: config.bitable.appToken,
    })),
    {
      key: "A",
      name: config.bitable.tableA.name,
      id: config.bitable.tableA.id,
      appToken: config.bitable.tableA.appToken,
    },
  ];

  const schema = {};

  for (const table of tables) {
    console.log(`\n[${table.name}] 拉取字段结构...`);
    const fields = await fetchFields(token, table.appToken, table.id);

    schema[table.key] = {
      name: table.name,
      id: table.id,
      fields: fields.map(f => ({
        id: f.field_id,
        name: f.field_name,
        type: f.type,
        // 单选/多选的选项值
        options: f.property?.options?.map(o => o.name) ?? null,
      })),
    };

    console.log(`[${table.name}] ${fields.length} 个字段`);

    console.log(`[${table.name}] 拉取记录...`);
    const records = await fetchAllRecords(token, table.appToken, table.id);
    console.log(`[${table.name}] ${records.length} 条记录`);

    const outPath = path.join(DATA_DIR, `${table.key}_${table.name}.json`);
    fs.writeFileSync(outPath, JSON.stringify(records, null, 2), "utf-8");
    console.log(`[${table.name}] 已保存 → ${outPath}`);
  }

  const schemaPath = path.join(DATA_DIR, "schema.json");
  fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2), "utf-8");
  console.log(`\n字段结构已保存 → ${schemaPath}`);
  console.log("\n完成。");
}

main().catch(e => {
  console.error("出错:", e.message);
  process.exit(1);
});
