// ============================================================
// handler.js — 核心业务逻辑
//
// 流程：解析消息 → 构造查询 → 并发查表 → 匹配账号 → 格式化回复
// ============================================================

const config = require("./config");
const feishu = require("./feishu");
const { parseMessage } = require("./llm");

// ─── 日期工具 ───

const TZ_OFFSET = 8 * 3600 * 1000; // 飞书日期字段存的是 UTC+8 午夜时间戳

function dateStrToTs(dateStr) {
  return new Date(dateStr + "T00:00:00+08:00").getTime();
}

function dateToTs(dateStr) {
  return String(dateStrToTs(dateStr));
}

// ─── 字段解析 ───

/**
 * 根据 tableId 拿到该表各逻辑字段的当前名称（通过 field_id 解析）
 * 字段改名后，重启服务会自动更新，无需改代码。
 */
function getTableFields(tableId) {
  const tableCfg = Object.values(config.bitable.tables).find(t => t.id === tableId);
  if (!tableCfg?.fieldIds) return null;
  const fids = tableCfg.fieldIds;
  return {
    account: feishu.resolveField(tableId, fids.account),
    date:    feishu.resolveField(tableId, fids.date),
    status:  feishu.resolveField(tableId, fids.status),
    project: feishu.resolveField(tableId, fids.project),
    brand:   feishu.resolveField(tableId, fids.brand),
  };
}

// ─── Filter 构造 ───

/**
 * 返回一个 filterFn(tableId) → filter
 * exact 日期：用该表的 date field_id 解析出当前字段名，传给 API
 * range/before/none：返回 null（JS 端过滤）
 */
function buildFilterFn(parsed) {
  if (parsed.date_type !== "exact") return null;

  return (tableId) => {
    const f = getTableFields(tableId);
    if (!f?.date) return null;
    return {
      conjunction: "and",
      conditions: [{
        field_name: f.date,
        operator: "is",
        value: ["ExactDate", dateToTs(parsed.date_start)],
      }],
    };
  };
}

// ─── 字段值提取工具 ───

function extractField(record, fieldName) {
  if (!fieldName) return null;
  const val = record.fields?.[fieldName];
  if (val == null) return null;
  if (typeof val === "string") return val;
  if (typeof val === "number") return val;
  if (Array.isArray(val)) {
    return val.map(v => v.text || v.value || String(v)).join("");
  }
  if (typeof val === "object") {
    if (Array.isArray(val.value)) {
      return val.value.map(v => v.text || v.value || String(v)).join("");
    }
    return val.text || JSON.stringify(val);
  }
  return String(val);
}

function formatDate(val) {
  if (!val && val !== 0) return "未设定";
  if (typeof val === "object" && !Array.isArray(val)) {
    val = val.value ?? val.text ?? null;
    if (!val) return "未设定";
  }
  if (typeof val === "number" && val > 1e10) {
    const d = new Date(val + TZ_OFFSET);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }
  if (typeof val === "string") {
    return val.replace(/\//g, "-").split(" ")[0];
  }
  return String(val);
}

// ─── 账号名匹配 ───

function normalize(name) {
  if (!name && name !== 0) return "";
  return String(name)
    .trim()
    .replace(/\s+/g, "")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/【/g, "[")
    .replace(/】/g, "]")
    .toLowerCase();
}

function isAccountMatch(queryName, recordName) {
  return normalize(queryName) === normalize(recordName);
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array(n + 1).fill(0).map((_, j) => j === 0 ? i : 0));
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

// 比 normalize 更激进：额外剥掉括号和标点，只保留中文+字母数字
// 用于 fuzzy 的 substring 比较，避免括号差异导致匹配失败
function stripPunct(s) {
  return s.replace(/[^\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaffa-z0-9]/g, "");
}

function fuzzyFind(query, allAccounts) {
  const q = normalize(query);
  const qStripped = stripPunct(q);
  const scored = [];

  for (const a of allAccounts) {
    const n = normalize(a);
    if (n === q) continue;

    // substring 包含：先用原始 normalized，再用剥掉标点的版本（兼容括号差异）
    const nStripped = stripPunct(n);
    if (n.includes(q) || q.includes(n) ||
        (qStripped && nStripped && (nStripped.includes(qStripped) || qStripped.includes(nStripped)))) {
      scored.push({ account: a, score: 1.0 });
      continue;
    }

    // 编辑距离：同时比对全名和前缀，取最小值
    // 用较短串的长度定阈值：每 3 个字允许 1 个错，最少允许 1 个
    const minLen = Math.min(q.length, n.length);
    const allowed = Math.max(1, Math.floor(minLen / 3));

    const fullDist   = levenshtein(q, n);
    const prefixDist = q.length <= n.length ? levenshtein(q, n.slice(0, q.length)) : Infinity;
    const bestDist   = Math.min(fullDist, prefixDist);

    if (bestDist <= allowed) {
      scored.push({ account: a, score: 1 - bestDist / (minLen + 1) });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.account);
}

// ─── 主处理函数 ───

async function handleQuery(userMessage, accountOverrides = {}) {
  const t0 = Date.now();

  // ① NLP 解析
  let parsed;
  try {
    parsed = await parseMessage(userMessage);
  } catch (e) {
    console.error("[handler] NLP 解析失败:", e.message);
    return [
      "❌ 消息解析失败：" + e.message,
      "",
      "请用类似格式发送：",
      "账号名1",
      "账号名2",
      "日期：3月20号",
    ].join("\n");
  }

  if (parsed.accounts.length === 0) {
    return { reply: "没有识别到账号名称，请把需要查询的账号名每行一个发给我～", suggestions: [] };
  }

  console.log(`[handler] ① NLP 解析完成: ${parsed.accounts.length} 个账号, date_type=${parsed.date_type}, 日期=${parsed.date_start || ""}${parsed.date_end ? "~"+parsed.date_end : ""}`);

  if (Object.keys(accountOverrides).length > 0) {
    console.log(`[handler]    账号覆盖: ${JSON.stringify(accountOverrides)}`);
    parsed.accounts = parsed.accounts.map(a => accountOverrides[normalize(a)] || a);
  }

  // ② 构造日期 filter（每张表单独生成，使用该表当前字段名）
  const filterFn = buildFilterFn(parsed);
  console.log("[handler] ② filterFn:", parsed.date_type === "exact" ? "精确日期" : "null");

  // ③ 并发查询 4 张表
  let tableResults, failedTables;
  try {
    ({ results: tableResults, failedTables } = await feishu.queryAllTables(filterFn));
  } catch (e) {
    console.error("[handler] 查表失败:", e.message);
    return "❌ 查询数据库失败：" + e.message;
  }

  if (failedTables.length > 0) {
    console.warn(`[handler] ⚠️ ${failedTables.length} 张表查询失败: [${failedTables.join(", ")}]`);
  }

  // ④ 匹配账号
  const occupied = {};

  // JS 端日期范围过滤（range/before 时 API 不支持范围算子）
  const todayUtc8Start = dateStrToTs(new Date(Date.now() + TZ_OFFSET).toISOString().slice(0, 10));
  const jsDateStart = parsed.date_type === "range"
    ? dateStrToTs(parsed.date_start)
    : parsed.date_type === "before"
      ? todayUtc8Start
      : null;
  const jsDateEnd = (parsed.date_type === "range" || parsed.date_type === "before")
    ? dateStrToTs(parsed.date_end) + 86399999
    : null;

  function isInDateRange(record, dateFieldName) {
    if (jsDateStart === null && jsDateEnd === null) return true;
    if (!dateFieldName) return false;
    const raw = record.fields?.[dateFieldName];
    const ts = typeof raw === "number" ? raw : null;
    if (ts === null) return false;
    if (jsDateStart !== null && ts < jsDateStart) return false;
    if (jsDateEnd   !== null && ts > jsDateEnd)   return false;
    return true;
  }

  function matchRecords(records, tableName, tableId) {
    const f = getTableFields(tableId);
    if (!f) return;
    for (const record of records) {
      if (!isInDateRange(record, f.date)) continue;
      const recordAccount = extractField(record, f.account);
      if (!recordAccount) continue;
      for (const queryAccount of parsed.accounts) {
        if (isAccountMatch(queryAccount, recordAccount)) {
          if (!occupied[queryAccount]) occupied[queryAccount] = [];
          occupied[queryAccount].push({
            date:    formatDate(record.fields?.[f.date]),
            status:  extractField(record, f.status) || "未知",
            project: extractField(record, f.project) || "",
            brand:   extractField(record, f.brand) || "",
            table:   tableName,
          });
        }
      }
    }
  }

  for (const { tableName, tableId, records } of tableResults) {
    matchRecords(records, tableName, tableId);
  }

  const matchedCount = Object.keys(occupied).length;
  console.log(`[handler] ④ C表日期匹配: ${matchedCount} 个账号有排期 → [${Object.keys(occupied).join(", ")}]`);

  // ⑤ 对未匹配账号：C 表全量 + A 表 并行查询
  const unmatched = parsed.accounts.filter(a => !occupied[a]);
  const existsSet = new Set();
  const allKnownAccounts = new Set();
  const suggestions = [];

  if (unmatched.length > 0) {
    // A 表字段名（通过 field_id 解析）
    const aTableId = config.bitable.tableA.id;
    const aFids = config.bitable.tableA.fieldIds;
    const aAccountField  = feishu.resolveField(aTableId, aFids.account);
    const aProgressField = feishu.resolveField(aTableId, aFids.progress);

    const [cAllResult, aRecords] = await Promise.all([
      feishu.queryAllTables(null).catch(e => {
        console.error("[handler] C表存在性查询失败:", e.message);
        return { results: [], failedTables: [] };
      }),
      feishu.searchRecords(
        aTableId,
        null,
        [aAccountField, aProgressField].filter(Boolean),
        config.bitable.tableA.appToken
      ).catch(e => {
        console.error("[handler] A表查询失败:", e.message);
        return [];
      }),
    ]);

    const cAllResults = cAllResult.results;
    if (cAllResult.failedTables.length > 0) {
      failedTables.push(...cAllResult.failedTables.filter(t => !failedTables.includes(t)));
    }

    // C 表存在性检查（全量，不限日期）
    for (const { tableId, records } of cAllResults) {
      const f = getTableFields(tableId);
      if (!f) continue;
      for (const record of records) {
        const recordAccount = extractField(record, f.account);
        if (!recordAccount) continue;
        allKnownAccounts.add(String(recordAccount));
        for (const a of unmatched) {
          if (isAccountMatch(a, recordAccount)) existsSet.add(a);
        }
      }
    }
    console.log(`[handler] ⑤a C表全量: 已知账号 ${allKnownAccounts.size} 个，其中 ${existsSet.size} 个未匹配账号在 C 表存在（空闲）→ [${[...existsSet].join(", ")}]`);

    // A 表检查
    let aFree = 0, aConstruction = 0;
    for (const record of (aRecords || [])) {
      const recordAccount = extractField(record, aAccountField);
      if (!recordAccount) continue;
      allKnownAccounts.add(String(recordAccount));
      const progress = String(extractField(record, aProgressField) || "").trim();
      for (const a of unmatched) {
        if (!isAccountMatch(a, recordAccount)) continue;
        if (progress === "0") {
          occupied[a] = [{ date: null, status: "装修中", project: "", brand: "", table: "A表装修" }];
          aConstruction++;
        } else {
          existsSet.add(a);
          aFree++;
        }
      }
    }
    console.log(`[handler] ⑤b A表: 返回 ${(aRecords || []).length} 条，空闲 ${aFree} 个，装修中 ${aConstruction} 个`);

    // 模糊匹配建议
    const stillNotFound = unmatched.filter(a => !occupied[a] && !existsSet.has(a));
    for (const a of stillNotFound) {
      if (accountOverrides[normalize(a)]) continue;
      const matches = fuzzyFind(a, [...allKnownAccounts]);
      if (matches.length > 0) {
        suggestions.push({ from: a, candidates: matches.slice(0, 5) });
      }
    }
    console.log(`[handler] ⑤c 未找到: ${stillNotFound.length} 个，模糊建议: ${suggestions.length} 个 → [${suggestions.map(s=>s.from+"→["+s.candidates.join("|")+"]").join(", ")}]`);
  }

  // ⑥ 格式化输出
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  let rangeDates = null;
  if (parsed.date_type === "range" || parsed.date_type === "before") {
    const startStr = parsed.date_type === "range"
      ? parsed.date_start
      : new Date(Date.now() + TZ_OFFSET).toISOString().slice(0, 10);
    const endStr = parsed.date_end;
    if (startStr && endStr) {
      rangeDates = generateDateRange(new Date(startStr).getTime(), new Date(endStr).getTime());
    }
  }

  const reply = formatReply(parsed, occupied, existsSet, suggestions, elapsed, failedTables, rangeDates);

  const busyAccounts     = parsed.accounts.filter(a => occupied[a]?.length > 0 && occupied[a][0].table !== "A表装修");
  const freeAccounts     = parsed.accounts.filter(a => !occupied[a] && existsSet.has(a));
  const underConstructed = parsed.accounts.filter(a => occupied[a]?.[0]?.table === "A表装修");
  const suggestedFroms   = new Set(suggestions.map(s => normalize(s.from)));
  const notFoundAccounts = parsed.accounts.filter(a => !occupied[a] && !existsSet.has(a) && !suggestedFroms.has(normalize(a)));
  console.log(`[handler] ⑥ 结果: ❌有排期=${busyAccounts.length} ✅空闲=${freeAccounts.length} 🚧装修中=${underConstructed.length} ❓未找到=${notFoundAccounts.length} 🔍建议=${suggestions.length} | 耗时 ${elapsed}s`);

  return { reply, suggestions };
}

// ─── 日期范围枚举 ───

function generateDateRange(startMs, endMs) {
  const dates = [];
  let cur = startMs;
  while (cur <= endMs) {
    const d = new Date(cur + TZ_OFFSET);
    dates.push(
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`
    );
    cur += 86400000;
  }
  return dates;
}

// ─── 回复格式化 ───

function shortDate(dateStr) {
  if (!dateStr || dateStr === "未设定") return dateStr || "";
  const m = dateStr.match(/\d{4}-(\d{2})-(\d{2})/);
  if (!m) return dateStr;
  return `${parseInt(m[1])}/${parseInt(m[2])}`;
}

function formatReply(parsed, occupied, existsSet, suggestions, elapsed, failedTables = [], rangeDates = null) {
  const lines = [];

  let dateDesc = "全部日期";
  if (parsed.date_type === "exact")  dateDesc = shortDate(parsed.date_start);
  if (parsed.date_type === "range")  dateDesc = `${shortDate(parsed.date_start)} ~ ${shortDate(parsed.date_end)}`;
  if (parsed.date_type === "before") {
    const endTs   = dateStrToTs(parsed.date_end);
    const todayTs = dateStrToTs(new Date(Date.now() + TZ_OFFSET).toISOString().slice(0, 10));
    dateDesc = endTs < todayTs
      ? `${shortDate(parsed.date_end)} 前（已过期）`
      : `今天 ~ ${shortDate(parsed.date_end)}`;
  }

  const suggestedFroms = new Set(suggestions.map(s => normalize(s.from)));
  const underConstruction = parsed.accounts.filter(a => occupied[a]?.[0]?.table === "A表装修");
  const busy     = parsed.accounts.filter(a => occupied[a]?.length > 0 && occupied[a][0].table !== "A表装修");
  const free     = parsed.accounts.filter(a => !occupied[a] && existsSet.has(a));
  const notFound = parsed.accounts.filter(a => !occupied[a] && !existsSet.has(a) && !suggestedFroms.has(normalize(a)));

  lines.push(`📅 ${dateDesc} · ${parsed.accounts.length}个账号`);
  if (parsed.brand) lines.push(`品牌：${parsed.brand}`);
  lines.push("");

  for (const account of parsed.accounts) {
    if (suggestedFroms.has(normalize(account))) continue;

    if (occupied[account]?.[0]?.table === "A表装修") {
      lines.push(`🚧 ${account}（装修中，暂不可用）`);

    } else if (rangeDates) {
      if (occupied[account]?.length > 0) {
        lines.push(`⚠️ ${account}`);
        const sortedOccupied = [...occupied[account]].sort((a, b) => a.date.localeCompare(b.date));
        for (const e of sortedOccupied) {
          const parts = [shortDate(e.date), e.project, `[${e.status}]`].filter(Boolean);
          lines.push(`  ❌ ${parts.join("  ")}`);
        }
        const occupiedDateSet = new Set(occupied[account].map(e => e.date));
        const freeDates = rangeDates.filter(d => !occupiedDateSet.has(d));
        if (freeDates.length > 0) {
          lines.push(`  ✅ 空闲：${freeDates.map(shortDate).join("  ")}`);
        } else {
          lines.push(`  （该时段全部已占满）`);
        }
      } else if (existsSet.has(account)) {
        lines.push(rangeDates.length === 0
          ? `✅ ${account}（截止日期内无排期）`
          : `✅ ${account}（全部 ${rangeDates.length} 天空闲）`
        );
      } else {
        lines.push(`❓ ${account}（系统中未找到）`);
      }

    } else {
      if (occupied[account]?.length > 0) {
        lines.push(`❌ ${account}`);
        for (const e of occupied[account]) {
          const parts = [shortDate(e.date), e.project, `[${e.status}]`].filter(Boolean);
          lines.push(`  · ${parts.join("  ")}`);
        }
      } else if (existsSet.has(account)) {
        lines.push(`✅ ${account}`);
      } else {
        lines.push(`❓ ${account}（系统中未找到）`);
      }
    }
  }

  if (suggestions.length > 0) {
    lines.push("");
    const hasMulti = suggestions.some(s => s.candidates.length > 1);
    if (hasMulti) {
      lines.push("🔍 找到相似账号，请选择：");
      let idx = 1;
      for (const s of suggestions) {
        if (s.candidates.length === 1) {
          lines.push(`  ${idx}. 「${s.from}」→ 「${s.candidates[0]}」`);
          idx++;
        } else {
          lines.push(`「${s.from}」可能是：`);
          for (const c of s.candidates) {
            lines.push(`  ${idx}. ${c}`);
            idx++;
          }
        }
      }
      lines.push("回复数字选择");
    } else {
      lines.push("🔍 找到相似账号，请确认：");
      for (const s of suggestions) {
        lines.push(`  「${s.from}」→ 「${s.candidates[0]}」`);
      }
      lines.push("回复「确认」继续查询");
    }
  }

  if (!rangeDates && parsed.accounts.length > 1 && suggestions.length === 0) {
    lines.push("");
    lines.push("📋");
    if (busy.length > 0)              lines.push(`   ❌ 有排期：${busy.join(" / ")}`);
    if (free.length > 0)              lines.push(`   ✅ 空闲：${free.join(" / ")}`);
    if (underConstruction.length > 0) lines.push(`   🚧 装修中：${underConstruction.join(" / ")}`);
    if (notFound.length > 0)          lines.push(`   ❓ 未找到：${notFound.join(" / ")}`);
  }

  if (!rangeDates && busy.length === 0 && free.length > 0 && suggestions.length === 0) {
    lines.push("");
    lines.push(`🎉 全部 ${free.length} 个账号均可安排`);
  }

  if (failedTables.length > 0) {
    lines.push("");
    lines.push(`⚠️ 部分数据源查询失败，结果可能不完整：${failedTables.join("、")}`);
  }

  lines.push("");
  lines.push(`⏱ ${elapsed}s`);
  return lines.join("\n");
}

module.exports = { handleQuery, normalize };
