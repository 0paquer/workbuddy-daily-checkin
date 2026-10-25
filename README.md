# WorkBuddy 每日自动签到

利用本机 WorkBuddy 桌面客户端的登录态，自动完成「Buddy 加油站」每日签到领积分。**零依赖、零配置、幂等安全**，全程不提取或导出任何令牌，仅复用客户端本地会话。

## 能干啥

- 每天自动签到，领取每日积分（连续签到有额外奖励）。
- 统计连续签到天数（累计 / 当前连续 / 最长连续），记录在本机 `checkin-history.json`。
- 返回明确退出码与 `--json` 输出，可被定时任务 / 自动化直接调用。

## 如何使用

### 1. 准备
- 安装 [Node.js](https://nodejs.org) ≥ 16（仅用内置模块，无需 `npm install`）。
- 保持 WorkBuddy 桌面客户端处于运行状态。

### 2. 运行

```bash
node checkin.js            # 签到（重复运行安全，已签则视为成功）
node checkin.js --status   # 查看今日状态
node checkin.js --json     # 机器可读输出，供自动化解析
```

> 在 Git Bash / WSL 里请用 POSIX 路径，或用仓库里的 `run-checkin.sh` / `run-checkin.bat` 自动定位 node：
> `bash /c/Users/你的用户名/.workbuddy/wbipc/run-checkin.sh`

### 3. 接入每日定时任务
用 WorkBuddy 自带自动化（或系统计划任务）每天调用一次启动器即可：

```bash
bash /c/Users/你的用户名/.workbuddy/wbipc/run-checkin.sh
```

### 4. 进阶（可选）
- 自定义路径或部署到其它机器：参考 `.env.example` 设置环境变量（默认零配置即可运行）。
- 关闭连续天数统计：`node checkin.js --no-stats`（或环境变量 `WBIP_NO_STATS=1`）。

## 许可证
[MIT](./LICENSE)
