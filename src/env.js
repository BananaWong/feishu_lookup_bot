// ============================================================
// env.js — 简易 .env 文件加载器（零依赖，替代 dotenv）
//
// 在 index.js 最顶部 require 一次即可：
//   require("./env");
// ============================================================

const fs = require("fs");
const path = require("path");

const envPath = path.resolve(process.cwd(), ".env");

if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    // 跳过空行和注释
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // 去掉引号
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // 不覆盖已有的环境变量
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
  console.log("[env] 已加载 .env 文件");
} else {
  console.log("[env] 未找到 .env 文件，使用环境变量");
}
