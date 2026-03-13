// ============================================================
// test.js — 基于真实数据的用例测试
//
// 用法:
//   完整测试（NLP + 查表）:
//     node src/test.js
//
//   只测试 NLP 解析（只需 DeepSeek Key）:
//     node src/test.js --llm-only
//
//   只跑某个用例（按编号）:
//     node src/test.js --case 3
// ============================================================

require("./env");

const config  = require("./config");
const { parseMessage } = require("./llm");
const { handleQuery }  = require("./handler");
const { getToken }     = require("./feishu");

const llmOnly   = process.argv.includes("--llm-only");
const fieldsMode = process.argv.includes("--fields");
const caseArg   = process.argv.indexOf("--case");
const onlyCase  = caseArg !== -1 ? parseInt(process.argv[caseArg + 1]) : null;

// ─── 用例表 ───
// expected 是人工注释，不做自动断言，跑完肉眼对比
const testCases = [

  // ── 1. 精确日期 · 全部有排期 ──────────────────────────────
  {
    name: "1. 精确日期 · 全部有排期",
    message: `出圈名场面\n冲浪桃浦万\n娱乐小浪花\n3月20号有档期吗`,
    expected: `
    ❌ 三个账号在 3/20 均有 C 表排期
    出圈名场面 → 某项目
    冲浪桃浦万 → 某项目
    娱乐小浪花 → 某项目
    汇总：❌ 有排期 × 3`,
  },

  // ── 2. 精确日期 · 混合结果 ──────────────────────────────
  {
    name: "2. 精确日期 · 混合（有排期 + 空闲 + 不存在）",
    message: `出圈名场面\n巨星来咯\n阿巴阿巴\n3月20号`,
    expected: `
    ❌ 出圈名场面 → C 表有排期
    ✅ 巨星来咯   → A 表有(进度=1)，C 表 3/20 无记录 → 空闲
    ❓ 阿巴阿巴   → C/A 表均无 → 未找到`,
  },

  // ── 3. 精确日期 · 账号仅在 A 表（空闲） ──────────────────
  {
    name: "3. 精确日期 · 仅 A 表账号（应显示空闲）",
    message: `彭彭时尚说\n3月20号有档期吗`,
    expected: `
    ✅ 彭彭时尚说 → A 表 progress=1，C 表 3/20 无记录 → 空闲`,
  },

  // ── 4. 精确日期 · 一账号多个广告项目 ────────────────────
  {
    name: "4. 精确日期 · 同一账号同一天多个项目",
    message: `联动bot\n2月5号有没有档期`,
    expected: `
    ❌ 联动bot → C 表 2/5 可能有多条记录（不同品牌/项目）
    每个项目单独一行列出`,
  },

  // ── 5. 范围查询 · 部分日期有排期 ──────────────────────────
  {
    name: "5. 范围查询 · 部分日期有排期（应显示具体项目）",
    message: `胡饱饱【已正常】\n3月1号到3月20号之间有没有档期`,
    expected: `
    ⚠️ 部分有排期
    → 2026-03-05 美团团购到餐38业务 (美团团购) [已发布]
    → 2026-03-18 美团惊喜口袋多邻国3月联名 (美团官方) [已发布]
    以上日期已占用，其余时间可安排
    汇总：⚠️ 部分有排期：胡饱饱【已正常】（占用：3/5、3/18）`,
  },

  // ── 6. 范围查询 · 多账号混合 ──────────────────────────────
  {
    name: "6. 范围查询 · 多账号混合（部分有排期 + 完全空闲）",
    message: `一只小饭团（资讯版）\n巨星来咯\n摸了个娱\n3月1号到3月20号`,
    expected: `
    ⚠️ 一只小饭团（资讯版） → 3/3 汉堡王
    ✅ 巨星来咯              → C 表该期间无记录，A 表有(进度=1) → 空闲
    ✅ 摸了个娱              → C 表无记录，A 表有(进度=1) → 空闲
    汇总：⚠️ 部分有排期 × 1 / ✅ 无排期 × 2`,
  },

  // ── 7. 截止日期查询 ────────────────────────────────────────
  {
    name: "7. 截止日期 · 3月10日前",
    message: `小羊不要再吃了\n饮料超人（资讯版）\n超爱喝饮料（资讯版）\n3月10号之前有没有档期`,
    expected: `
    ⚠️ 小羊不要再吃了      → 3/5 美团团购到餐38业务
    ⚠️ 饮料超人（资讯版）  → 3/5 美团团购到餐38业务
    ⚠️ 超爱喝饮料（资讯版）→ 3/5 淘宝闪购
    以上日期已占用，其余时间可安排`,
  },

  // ── 8. 模糊匹配 ────────────────────────────────────────────
  {
    name: "8. 模糊匹配 · 输入不带括号后缀",
    message: `芝士奶盖\n小糕同学\n3月20号`,
    expected: `
    🔍 找到相似账号：
    「芝士奶盖」→「芝士奶盖（资讯版）」
    「小糕同学」→「小糕同学（资讯版）」
    回复"确认"后重新查询，显示正确档期结果`,
  },

  // ── 9. 系统未找到 ──────────────────────────────────────────
  {
    name: "9. 账号完全不存在",
    message: `阿巴阿巴\n不存在的号\n3月20号`,
    expected: `
    ❓ 系统中未找到 × 2
    汇总为空`,
  },

  // ── 10. 品牌 + 自然语言表述 ────────────────────────────────
  {
    name: "10. 自然语言 · 品牌查询 + 日期范围",
    message: `宝 这几个号3/21-3/24 可以接麦当劳吗
甜筒降落（资讯版）
请假煮泡面（资讯版）
蹲蹲联动（资讯版）`,
    expected: `
    NLP 应提取：品牌=麦当劳，日期=3/21-3/24
    视 C 表数据返回有排期/空闲结果`,
  },

  // ── 11. 完整业务消息（真实群消息格式） ─────────────────────
  {
    name: "11. 真实群消息格式 · 截止日期 + 多账号",
    message: `辛苦看下这些账号3.10前还有档期不
可可熊（资讯版）
一只小饭团（资讯版）
联动圈速报（资讯版）`,
    expected: `
    ⚠️ 可可熊（资讯版）     → 3/14 小红书春上新（在3.10之后，不在查询范围内 → 空闲）
    ⚠️ 一只小饭团（资讯版） → 3/3 汉堡王（在3.10前 → 有排期）
    ⚠️ 联动圈速报（资讯版） → 3/4 LAZADA（在3.10前 → 有排期）`,
  },
];

// ─── 查字段结构 ───
async function inspectFields() {
  const token = await getToken();
  const BASE = "https://open.feishu.cn/open-apis";

  console.log("\n🔍 查询各表字段结构...\n");

  // C 表（用默认 appToken）
  for (const [key, table] of Object.entries(config.bitable.tables)) {
    const url = `${BASE}/bitable/v1/apps/${config.bitable.appToken}/tables/${table.id}/fields`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (data.code !== 0) {
      console.log(`[${key}] ${table.name}: 查询失败 [${data.code}] ${data.msg}`);
      continue;
    }
    const fields = data.data?.items || [];
    console.log(`[${key}] ${table.name} (${table.id}):`);
    for (const f of fields) {
      console.log(`  field_id=${f.field_id}  type=${f.type}  name="${f.field_name}"`);
    }
    console.log();
  }

  // A 表（用自己的 appToken）
  const aUrl = `${BASE}/bitable/v1/apps/${config.bitable.tableA.appToken}/tables/${config.bitable.tableA.id}/fields`;
  const aRes = await fetch(aUrl, { headers: { Authorization: `Bearer ${token}` } });
  const aData = await aRes.json();
  if (aData.code === 0) {
    console.log(`[A表] ${config.bitable.tableA.name} (${config.bitable.tableA.id}):`);
    for (const f of aData.data?.items || []) {
      console.log(`  field_id=${f.field_id}  type=${f.type}  name="${f.field_name}"`);
    }
    console.log();
  }
}

// ─── 运行 ───
async function run() {
  if (fieldsMode) return inspectFields();

  if (!config.deepseek.apiKey) {
    console.error("❌ 请设置 DEEPSEEK_API_KEY");
    process.exit(1);
  }
  if (!llmOnly && (!config.feishu.appId || !config.feishu.appSecret)) {
    console.error("❌ 完整测试需要 FEISHU_APP_ID 和 FEISHU_APP_SECRET");
    console.error("   只测 NLP: node src/test.js --llm-only");
    process.exit(1);
  }

  const cases = onlyCase !== null
    ? testCases.filter((_, i) => i + 1 === onlyCase)
    : testCases;

  console.log(`\n🧪 模式: ${llmOnly ? "仅 NLP" : "完整流程"}  用例数: ${cases.length}\n`);

  let passed = 0, failed = 0;

  for (const tc of cases) {
    console.log(`${"═".repeat(65)}`);
    console.log(`📝 ${tc.name}`);
    console.log(`   输入: ${tc.message.replace(/\n/g, " | ").substring(0, 100)}`);
    if (tc.expected) {
      console.log(`   预期: ${tc.expected.trim().split("\n")[0].trim()}`);
    }
    console.log(`${"─".repeat(65)}`);

    const t0 = Date.now();
    try {
      if (llmOnly) {
        const result = await parseMessage(tc.message);
        console.log("   NLP:", JSON.stringify(result));
      } else {
        const result = await handleQuery(tc.message);
        const reply = typeof result === "string" ? result : result.reply;
        console.log(reply);
      }
      passed++;
    } catch (e) {
      console.error(`   ❌ 异常: ${e.message}`);
      failed++;
    }
    console.log(`   ⏱ ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  }

  console.log(`${"═".repeat(65)}`);
  console.log(`✅ 完成  通过: ${passed}  失败: ${failed}`);
  console.log(`（预期结果为人工注释，请对照上方输出手动核对）\n`);
}

run().catch(console.error);
