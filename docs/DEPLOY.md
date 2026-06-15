# 🚀 小白部署教程

> 本文档适合**完全没有编程基础**的用户。按步骤操作，30分钟内即可上线。

---

## 目录

1. [前置条件检查](#1-前置条件检查)
2. [VPS Linux 一键安装（推荐）](#2-vps-linux-一键安装推荐)
3. [Windows 本地安装](#3-windows-本地安装)
4. [配置教程](#4-配置教程)
5. [验证安装成功](#5-验证安装成功)
6. [日志查看](#6-日志查看)
7. [升级到新版本](#7-升级到新版本)
8. [常见问题 FAQ](#8-常见问题-faq)

---

## 1. 前置条件检查

### 服务器要求

| 项目 | 最低要求 | 推荐配置 |
|------|---------|---------|
| 操作系统 | Ubuntu 20.04 / Debian 11 | Ubuntu 22.04 LTS |
| CPU | 1 核 | 2 核 |
| 内存 | 1 GB | 2 GB |
| 磁盘 | 10 GB | 20 GB |
| 网络 | 能访问外网 | 国际线路（访问 AI 接口） |

### 必备账号

在开始之前，你需要准备：

- ✅ **AI API Key**（必填）：OpenAI / 其他兼容接口的密钥
  - OpenAI：[platform.openai.com/api-keys](https://platform.openai.com/api-keys)
  - 国内可用替代：硅基流动、deepseek、月之暗面等
- ✅ **推送渠道**（至少一个）：飞书 / 企业微信 / QQ 机器人的 Webhook 地址

---

## 2. VPS Linux 一键安装（推荐）

### 第一步：登录服务器

用 SSH 工具（如 Xshell、PuTTY、MobaXterm）连接到你的 VPS。

### 第二步：运行一键安装脚本

复制以下命令，粘贴到终端，按回车：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/a872034547-cpu/Football-2027/main/scripts/install.sh)
```

> 💡 **如果访问 GitHub 很慢**，可以先手动克隆再执行：
> ```bash
> git clone https://github.com/a872034547-cpu/Football-2027.git ~/Football-2027
> cd ~/Football-2027
> bash scripts/install.sh
> ```

### 第三步：按提示填写配置

脚本运行时会询问以下信息：

```
请输入 AI API Key（必填）: sk-xxxx...
请输入 AI 接口地址（默认 OpenAI，回车跳过）: 
请输入 AI 模型名称（默认 gpt-4o-mini，回车跳过）: 
请输入飞书 Webhook 地址（可选，回车跳过）: 
```

> 💡 **不确定就回车跳过**，后面可以手动编辑 `.env` 文件。

### 第四步：等待安装完成

安装大约需要 **3-10 分钟**（取决于网速）。看到以下提示表示成功：

```
✅ 安装完成！

📌 服务地址：
  - 足球预测 API：http://你的服务器IP:3000
  - 健康检查：http://你的服务器IP:3000/health
```

---

## 3. Windows 本地安装

### 第一步：安装 Docker Desktop

1. 打开浏览器，访问 [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/)
2. 下载并安装 Docker Desktop for Windows
3. 安装完成后重启电脑
4. 打开 Docker Desktop，确认左下角显示绿色（Running）

### 第二步：安装 Git（如已安装跳过）

1. 访问 [git-scm.com](https://git-scm.com/download/win)
2. 下载安装 Git for Windows（一路默认点 Next 即可）

### 第三步：运行 PowerShell 安装脚本

1. 右键点击"开始"菜单 → 选择"Windows PowerShell（管理员）"
2. 复制并运行以下命令：

```powershell
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
irm https://raw.githubusercontent.com/a872034547-cpu/Football-2027/main/scripts/install-windows-new.ps1 | iex
```

3. 脚本会将项目克隆到桌面的 `Football-2027` 文件夹，并自动启动服务

### 第四步：编辑配置文件

脚本运行后，打开桌面的 `Football-2027` 文件夹，用记事本打开 `.env` 文件，填入你的 API Key 和 Webhook 地址，保存后重启服务：

```powershell
cd "$env:USERPROFILE\Desktop\Football-2027"
docker compose restart football-auto
```

---

## 4. 配置教程

配置文件是项目根目录下的 `.env` 文件。用任意文本编辑器打开（推荐 VS Code 或 Notepad++）。

### 4.1 AI 接口配置（必填）

```dotenv
AI_CUSTOM_ENDPOINT=https://api.openai.com/v1
AI_API_KEY=sk-你的密钥
AI_MODEL=gpt-4o-mini
```

**各接口地址参考：**

| 服务商 | endpoint 地址 | 推荐模型 |
|--------|-------------|---------|
| OpenAI 官方 | `https://api.openai.com/v1` | `gpt-4o-mini` |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-72B-Instruct` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 月之暗面 | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |

### 4.2 飞书机器人配置

**获取飞书 Webhook 步骤：**

1. 打开飞书，进入你想推送消息的群
2. 点击群右上角的 **"···"** → **"设置"** → **"群机器人"**
3. 点击 **"添加机器人"** → 选择 **"自定义机器人"**
4. 填写机器人名称（如"足球预测"），点击添加
5. 复制生成的 **Webhook 地址**（格式：`https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxx`）

```dotenv
FEISHU_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/你的hook
FEISHU_SECRET=你的签名密钥（可选，安全起见建议填写）
```

> 💡 **签名密钥**：在添加机器人时，选择"加签"安全方式，会生成一个签名密钥（类似 `SECxxxxxxx`），填入 `FEISHU_SECRET`。

### 4.3 企业微信机器人配置

**获取企业微信 Webhook 步骤：**

1. 打开企业微信，进入群聊
2. 点击右上角成员列表 → 拉到底部 → 点击 **"添加群机器人"**
3. 点击 **"新创建一个机器人"**，填写名称
4. 复制 **Webhook 地址**

```dotenv
WECOM_WEBHOOK=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=你的key
```

### 4.4 QQ 机器人配置（OneBot）

需要先部署 OneBot 实现（如 LLOneBot、go-cqhttp）：

```dotenv
ONEBOT_BASE_URL=http://127.0.0.1:5700
ONEBOT_ACCESS_TOKEN=你的token（可选）
ONEBOT_TARGET_TYPE=group          # group=群聊，private=私聊
ONEBOT_TARGET_ID=你的群号或QQ号
```

### 4.5 推送渠道开关

```dotenv
# 填入要使用的渠道，多个渠道用英文逗号分隔
AUTO_PUSH_CHANNELS=feishu
# AUTO_PUSH_CHANNELS=feishu,wecom
# AUTO_PUSH_CHANNELS=feishu,wecom,onebot
```

### 4.6 修改配置后重启

```bash
# Linux
cd ~/Football-2027
docker compose restart football-auto

# Windows PowerShell
cd "$env:USERPROFILE\Desktop\Football-2027"
docker compose restart football-auto
```

---

## 5. 验证安装成功

### 方法一：浏览器访问

打开浏览器，访问：`http://你的服务器IP:3000/health`

看到以下内容表示成功：

```json
{"status":"ok","time":"2026-06-15T08:00:00.000Z","db":"ok"}
```

### 方法二：命令行检查

```bash
# 查看服务运行状态
docker compose ps

# 期望输出
NAME              STATUS          PORTS
football-auto     Up (healthy)    0.0.0.0:3000->3000/tcp
```

### 方法三：手动触发测试推送

```bash
curl -X POST http://localhost:3000/api/push/test
```

如果配置正确，你的飞书/企业微信/QQ 会收到一条测试消息。

### 方法四：手动触发采集测试

```bash
curl -X POST http://localhost:3000/api/collect/today
```

稍等片刻后查询：

```bash
curl http://localhost:3000/api/matches?date=$(date +%Y-%m-%d)
```

---

## 6. 日志查看

### 实时日志

```bash
# 进入项目目录
cd ~/Football-2027

# 查看实时日志（Ctrl+C 退出）
docker compose logs -f football-auto

# 只看最近100行
docker compose logs --tail=100 football-auto
```

### 日志关键词搜索

```bash
# 查看采集相关日志
docker compose logs football-auto | grep "采集"

# 查看错误日志
docker compose logs football-auto | grep "ERROR"

# 查看推送日志
docker compose logs football-auto | grep "推送"
```

---

## 7. 升级到新版本

```bash
cd ~/Football-2027

# 拉取最新代码
git pull

# 重新构建并启动
docker compose up -d --build

# 查看升级后状态
docker compose ps
```

> ⚠️ **注意**：升级不会覆盖你的 `.env` 配置文件和 `data/` 数据库文件，数据安全。

---

## 8. 常见问题 FAQ

**Q1: 安装脚本报错 "curl: command not found"**

A: 先安装 curl：
```bash
sudo apt-get update && sudo apt-get install -y curl   # Ubuntu/Debian
sudo yum install -y curl                               # CentOS
```

---

**Q2: Docker 安装失败**

A: 脚本会自动安装 Docker，如果失败，手动安装：
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
```

---

**Q3: 健康检查一直失败（访问 /health 报错）**

A: 查看日志找原因：
```bash
docker compose logs football-auto | tail -50
```
常见原因：端口被占用（改 `.env` 中的 `APP_PORT`）、数据库权限问题（检查 `data/` 目录权限）

---

**Q4: AI 分析不工作，日志报 "AI 接口错误"**

A: 检查以下配置：
- `AI_API_KEY` 是否填写正确（注意前后不要有空格）
- `AI_CUSTOM_ENDPOINT` 格式是否正确（只填到 `/v1`，不要加 `/chat/completions`）
- VPS 是否能访问该 AI 接口（国内 VPS 访问 OpenAI 需要代理）

---

**Q5: 飞书收不到消息**

A: 依次排查：
1. `FEISHU_WEBHOOK` 是否正确填写
2. `AUTO_PUSH_CHANNELS` 是否包含 `feishu`
3. 手动触发测试：`curl -X POST http://localhost:3000/api/push/test`
4. 查看日志：`docker compose logs football-auto | grep feishu`

---

**Q6: 每天几点会自动推送报告？**

A: 默认每天 **08:00** 采集比赛数据并分析，**23:00** 同步赛果。推送时间跟随采集完成时间，通常在 08:30 前完成。

可以通过修改 `.env` 中的 Cron 表达式调整时间：
```dotenv
DAILY_COLLECT_CRON=0 8 * * *    # 每天 08:00
RESULT_SYNC_CRON=0 23 * * *     # 每天 23:00
```

---

**Q7: 服务器重启后服务不会自动启动**

A: Docker Compose 服务配置了 `restart: unless-stopped`，服务器重启后会自动恢复。如果没有自动恢复，手动执行：
```bash
cd ~/Football-2027 && docker compose up -d
```

---

**Q8: 如何备份数据？**

A: 只需备份 `data/` 目录和 `.env` 文件：
```bash
tar -czf football-backup-$(date +%Y%m%d).tar.gz data/ .env
```

---

**Q9: 如何查看今日预测结果？**

A: 通过 API 查询：
```bash
# 查看今日比赛列表
curl "http://localhost:3000/api/matches?date=$(date +%Y-%m-%d)"

# 查看今日组合方案
curl "http://localhost:3000/api/portfolio?date=$(date +%Y-%m-%d)"
```

---

**Q10: 端口 3000 被占用怎么办？**

A: 修改 `.env` 文件中的端口号：
```dotenv
APP_PORT=3001   # 改成其他未占用的端口
```
然后重启：`docker compose up -d`

---

**Q11: 如何完全卸载？**

A: 
```bash
cd ~/Football-2027
docker compose down -v          # 停止并删除容器
cd ..
rm -rf Football-2027            # 删除项目文件（含数据库！）
```

> ⚠️ **注意**：删除前请先备份 `data/` 目录！

---

**Q12: 想同时推送多个飞书群怎么办？**

A: 目前每个渠道只支持一个 Webhook。如需多群推送，可以用飞书的"群消息转发"功能，或者在飞书机器人上设置多个订阅群。

---

## 🆘 遇到问题？

1. 查看日志：`docker compose logs football-auto`
2. 运行诊断：`npm run doctor`（需进入项目目录且已安装 Node.js）
3. 提交 Issue：[github.com/a872034547-cpu/Football-2027/issues](https://github.com/a872034547-cpu/Football-2027/issues)
