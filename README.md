# WorkBuddy 每日自动签到

[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A516-green)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)]()
[![Config](https://img.shields.io/badge/config-0-blue)]()
[![License](https://img.shields.io/badge/license-MIT-orange)]()

利用本机 WorkBuddy 桌面客户端的登录态，自动完成「Buddy 加油站」每日签到领积分。

> **一句话总结：不用抓包、不用填 token、不用 npm install —— 克隆下来直接跑。**

---

## ✨ 为什么选这个

市面上常见的签到脚本，大多要求你打开浏览器开发者工具、抓包提取 token、塞进配置文件 —— 然后 token 一过期就得重来一遍。

**这个项目从原理上绕开了这些问题：**

| | 🔥 本项目 | 😮‍💨 常见同类脚本 |
|---|---|---|
| **Token** | ❌ 完全不需要。复用客户端本地登录态，直连 wbipc 命名管道 | 需要抓包提取，手动填入配置 |
| **Token 过期** | 不存在。客户端登录态更新后自动跟随 | 频繁失效，需要重新抓包维护 |
| **Token 安全** | 零暴露：不提取、不导出、不落盘任何令牌 | Token 明文写在配置/环境变量里，有泄露风险 |
| **依赖** | 零依赖，仅 Node.js 内置模块 | 通常需要 axios 等一堆 `npm install` |
| **配置** | 零配置，自动探测登录态文件 | 需要手动填写 token、接口地址等 |
| **重复运行** | 幂等安全，已签到视为成功（exit 0） | 视实现而定，可能报错干扰自动化 |

### 核心优势详解

- 🔐 **零 Token、零暴露**
  全程通过 wbipc 命名管道与本机 WorkBuddy 客户端会话，由客户端代理注入登录态。
  你的凭据从头到尾不离开本机，脚本里没有任何地方需要（也找不到）你的 token。

- 📦 **零依赖**
  只用 Node.js 内置模块（`net` / `crypto` / `fs` / `os` / `path`）。
  没有 `node_modules`，没有供应链风险，克隆即用。

- ⚙️ **零配置**
  自动从用户主目录探测登录态文件（支持 `WORKBUDDY_HOME` / `WBIP_ENDPOINT_FILE` 覆盖），
  默认情况下一行配置都不用写。

- 🔁 **幂等安全**
  重复调用返回「今日已签到」并视为成功（exit 0），
  接进定时任务、自动化流程里放心跑，不会误签也不会报错骚扰。

- 📈 **成长中心 · 连续签到统计**
  本地记录并计算 累计 / 当前连续 / 最长连续 签到天数，
  不依赖接口字段 —— 断网或接口改版都不影响统计，仅写本机一个 JSON 文件。

- 🤖 **自动化友好**
  明确的退出码（0~5 各有语义）+ `--json` 机器可读输出，
  CLI 与库双形态（`require('./checkin').runCheckin`），随便你怎么编排。

---

## 🚀 如何使用

### 1. 准备

- 安装 [Node.js](https://nodejs.org) ≥ 16（仅用内置模块，无需 `npm install`）
- 保持 WorkBuddy 桌面客户端处于运行状态

### 2. 运行

```bash
node checkin.js            # 签到（重复运行安全，已签则视为成功）
node checkin.js --status   # 查看今日签到状态
node checkin.js --json     # 机器可读输出，供自动化解析
node checkin.js --no-stats # 关闭连续天数统计
```

> 在 Git Bash / WSL 里请用 POSIX 路径，或用仓库里的 `run-checkin.sh` / `run-checkin.bat` 自动定位 node：
>
> ```bash
> bash /c/Users/你的用户名/.workbuddy/wbipc/run-checkin.sh
> ```

### 3. 接入每日定时任务

用 WorkBuddy 自带自动化（或系统计划任务）每天调用一次启动器即可：

```bash
bash /c/Users/你的用户名/.workbuddy/wbipc/run-checkin.sh
```

### 4. 进阶（可选）

默认零配置即可运行。仅当你想把数据放在非默认位置、或在其它机器/容器里部署时，参考 `.env.example` 设置环境变量：

| 环境变量 | 说明 |
|---|---|
| `WBIP_ENDPOINT_FILE` | 显式指定 endpoint.json 路径（指定后缺失即报错，不静默回退） |
| `WORKBUDDY_HOME` | WorkBuddy 主目录（其下应有 `wbipc/endpoint.json`） |
| `WBIP_CHECKIN_HISTORY` | 连续签到统计的历史文件路径 |
| `WBIP_NO_STATS` | 设为 `1` 关闭连续天数统计 |
| `WBIP_LOG` | 日志文件路径 |
| `WBIP_ENDPOINT` + `WBIP_TICKET` | 高级部署：直连模式，跳过读取 endpoint.json |

---

## 🔍 工作原理

```
┌──────────────────┐   wbipc 命名管道(带认证)   ┌──────────────────┐
│  checkin.js      │ ────────────────────────▶ │ WorkBuddy 客户端  │
│  (本脚本)         │ ◀──────────────────────── │  (本机运行中)      │
└──────────────────┘                           └────────┬─────────┘
       │ 自动读取本机登录态文件                          │ 受控 HTTP 代理
       │ ~/.workbuddy/wbipc/endpoint.json              │ (host 自动注入登录态)
       ▼                                               ▼
┌──────────────────┐                           ┌──────────────────┐
│ checkin-history  │                           │ WorkBuddy 后端    │
│ .json 连续签到统计 │                           │ POST /daily-checkin│
└──────────────────┘                           └──────────────────┘
```

关键点：**脚本从不接触原始凭据**。登录态由客户端在代理层自动注入，token 全程不出客户端进程。

### 退出码

| 退出码 | 含义 |
|---|---|
| 0 | 签到成功 / 今日已签到 |
| 1 | 业务异常（接口返回非预期） |
| 2 | 缺少登录态（未找到 endpoint.json） |
| 3 | 连接握手失败（客户端未运行？） |
| 4 | 调用失败 |
| 5 | 未找到 node |

---

## 📄 许可证

[MIT](./LICENSE)
