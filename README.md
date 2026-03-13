# 飞书多维表格查询 Bot

在飞书群聊或私聊中用自然语言查询飞书 Bitable（多维表格）数据，数秒内返回结果。

适合用于：**档期查询、排班查询、资源可用性查询**等需要频繁人工查表的场景。

```
用户:  帮我看下这几个账号 3/21-3/24 有没有排期
       账号A
       账号B
       账号C

Bot:   📅 3/21 ~ 3/24 · 3个账号

       ✅ 账号A（全部 4 天空闲）
       ❌ 账号B
         · 3/22  某项目  [进行中]
       ✅ 账号C（全部 4 天空闲）

       ⏱ 6.2s
```

---

## 工作原理

```
用户在飞书发消息
      │
      ▼
飞书 webhook → 你的服务（Node.js）
      │
      ├─① LLM 解析自然语言（提取查询条件）
      │
      ├─② 并发查询 Bitable 多张表
      │    精确日期：API 端 filter
      │    日期范围：全量拉取，JS 端过滤
      │
      ├─③ 账号匹配（精确 + 模糊）
      │
      └─④ 格式化结果 → 发回飞书
```

**核心设计：LLM 只调用 1 次做自然语言解析，查询逻辑全部在代码里，成本极低。**

---

## 项目结构

```
feishu-bot/
├── src/
│   ├── config.js     # 凭证 + Bitable 表ID/field_id
│   ├── feishu.js     # 飞书 API：Token、字段映射缓存、查表、发消息
│   ├── llm.js        # LLM 调用：自然语言 → 结构化 JSON
│   ├── handler.js    # 核心逻辑：查询、匹配、模糊搜索、格式化
│   ├── index.js      # HTTP 服务：webhook 处理、事件去重、pending 状态
│   ├── env.js        # .env 加载器（零依赖）
│   └── test.js       # 本地测试脚本
├── .env.example
├── Dockerfile
└── package.json
```

**零第三方依赖**，只用 Node.js 原生模块，无需 `npm install`。Node.js >= 18。

---

## 功能

### 查询结果类型

| 标识 | 含义 |
|------|------|
| ❌ 有排期 | 该条目在查询日期内已有记录 |
| ✅ 空闲 | 条目存在于系统，该日期无记录 |
| ⚠️ 部分有排期 | 范围查询时，某些天有记录某些天空闲 |
| ❓ 未找到 | 系统中不存在该条目名称 |
| 🔍 相似条目 | 名称不精确，Bot 找到相似条目询问确认 |

### 支持的日期表达

| 类型 | 示例 |
|------|------|
| 精确日期 | `3月20号`、`3/20`、`3.20` |
| 相对日期 | `今天`、`明天`、`后天`、`昨天` |
| 日期范围 | `3/21-3/24`、`3月21到24号` |
| 截止日期 | `3月10号前`、`3.10之前` |

### 模糊匹配

输入名称不精确时（打错字、漏后缀），Bot 使用 **substring + 编辑距离（Levenshtein）** 双算法查找相似条目：

- 单候选：直接提示并等待「确认」
- 多候选：列出编号让用户选择（回复 `1` 或 `1 3`）

待确认状态 5 分钟内有效。

### 范围查询明细

```
⚠️ 账号B
  ❌ 3/22  某项目  [进行中]
  ✅ 空闲：3/21  3/23  3/24
```

---

## 快速开始

### 第一步：获取 LLM API Key

项目默认使用 **DeepSeek**（兼容 OpenAI 格式，成本极低）。

1. 打开 [DeepSeek 开放平台](https://platform.deepseek.com)，注册并创建 API Key

也可以换成任何兼容 OpenAI 格式的 LLM（Qwen、Moonshot、豆包等），在 `.env` 中修改 `DEEPSEEK_BASE_URL` 和 `DEEPSEEK_MODEL` 即可。

### 第二步：配置飞书应用

1. 打开 [飞书开放平台](https://open.feishu.cn)，创建企业自建应用
2. 记录 **App ID** 和 **App Secret**
3. 「应用能力 → 机器人」→ 启用（必须先启用，事件订阅菜单才出现）
4. 「权限管理」中开通：
   - `im:message`
   - `im:message:send_as_bot`
   - `bitable:record:read`
5. 「事件订阅」中添加事件：`im.message.receive_v1`

> 每次修改权限后需重新发布应用才生效。

### 第三步：配置 config.js

编辑 `src/config.js`，填入你的多维表格信息：

```js
bitable: {
  appToken: "你的多维表格 appToken",  // Bitable URL 中 /base/{appToken} 部分

  // 查询用的主表（可配置多张，并发查询）
  tables: {
    T1: {
      id: "表ID",
      name: "表名称",
      fieldIds: {
        account: "账号字段的 field_id",
        date:    "日期字段的 field_id",
        status:  "状态字段的 field_id",
        project: "项目字段的 field_id",
        brand:   "品牌字段的 field_id",
      },
    },
    // 可继续添加 T2, T3...
  },

  // 账号总库表（用于判断账号是否存在）
  tableA: {
    appToken: "账号总库的 appToken（如与主表相同则填同一个）",
    id: "表ID",
    name: "表名称",
    fieldIds: {
      account:  "账号字段的 field_id",
      progress: "状态字段的 field_id（0=不可用，其他=可用）",
    },
  },
},
```

**如何找到 field_id？**

```bash
# 启动后运行，会列出所有表的 field_id
node src/test.js --fields
```

或在飞书开放平台的「API 调试工具」中调用字段查询接口获取。

### 第四步：配置环境变量

```bash
cp .env.example .env
```

```env
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
PORT=3000
```

### 第五步：启动服务

```bash
node src/index.js
```

服务启动后，将显示的地址填入飞书开放平台「事件订阅 → 请求地址」，飞书会自动完成验证。

---

## 部署

### 云平台（推荐，无需管理服务器）

推荐 [Zeabur](https://zeabur.com)、[Railway](https://railway.app) 等支持 Git 自动部署的平台：

1. 将代码推到 GitHub 私有仓库
2. 在平台上连接仓库
3. 填入环境变量
4. 部署完成后绑定域名，将域名填入飞书事件订阅

注意：Zeabur 默认转发端口为 8080，需将 `PORT` 设为 `8080`。

### Docker

```bash
docker build -t feishu-bot .
docker run -d --name feishu-bot --restart always -p 3000:3000 --env-file .env feishu-bot
docker logs -f feishu-bot
```

### 本地 / 服务器（PM2）

```bash
npm install -g pm2
pm2 start src/index.js --name feishu-bot
pm2 save && pm2 startup
pm2 logs feishu-bot
```

---

## 本地测试

```bash
# 只测 LLM 解析（只需 DEEPSEEK_API_KEY）
node src/test.js --llm-only

# 完整流程（LLM + 查表，需要飞书凭证）
node src/test.js

# 只跑第 N 个用例
node src/test.js --case 3

# 查询各表字段结构
node src/test.js --fields
```

---

## 自定义

### 修改回复格式

编辑 `src/handler.js` 中的 `formatReply` 函数。

### 修改自然语言解析规则

编辑 `src/llm.js` 中的 `buildSystemPrompt` 函数，调整 LLM 的提取规则。

### 群聊中机器人名称

如果你的机器人不叫默认名称，修改 `src/index.js`：

```js
m.name === "你的机器人名称"
```

---

## 常见问题

**Q: 飞书事件验证失败？**
- 确认服务正在运行：`curl http://你的地址/` 应返回 `{"status":"running"}`
- 确认服务有公网访问地址，端口已开放

**Q: 机器人不回复消息？**
- 确认应用已发布（草稿状态不收事件）
- 群聊中需要 @机器人，私聊直接发消息
- 查看服务日志确认是否收到事件

**Q: 查询结果全部显示空闲？**
- 运行 `node src/test.js --fields` 确认 field_id 配置正确
- 查看日志中「返回 N 条记录」，确认查到了数据

**Q: 换成其他 LLM？**

```env
DEEPSEEK_BASE_URL=https://对应api地址
DEEPSEEK_MODEL=模型名
DEEPSEEK_API_KEY=对应的key
```

兼容 OpenAI Chat Completions 格式的 API 均可直接替换。

---

## License

MIT
