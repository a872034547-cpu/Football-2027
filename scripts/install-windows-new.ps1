# =============================================================
# Football-2027 Windows PowerShell 全自动安装脚本
# 用法（在 PowerShell 管理员窗口中执行）：
#   Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
#   irm https://raw.githubusercontent.com/a872034547-cpu/Football-2027/main/scripts/install-windows-new.ps1 | iex
# =============================================================

#Requires -Version 5.1

param(
    [switch]$NoHermes,
    [string]$InstallDir = "$env:USERPROFILE\Desktop\Football-2027"
)

$ErrorActionPreference = "Stop"

# ── 颜色输出 ─────────────────────────────────────────────────
function Write-Step  { param($msg) Write-Host "`n▶ $msg" -ForegroundColor Cyan }
function Write-OK    { param($msg) Write-Host "[OK]    $msg" -ForegroundColor Green }
function Write-Info  { param($msg) Write-Host "[INFO]  $msg" -ForegroundColor White }
function Write-Warn  { param($msg) Write-Host "[WARN]  $msg" -ForegroundColor Yellow }
function Write-Err   { param($msg) Write-Host "[ERROR] $msg" -ForegroundColor Red }

function Invoke-SafeCommand {
    param([string]$Command, [string]$Description)
    Write-Info "$Description"
    try {
        Invoke-Expression $Command
        if ($LASTEXITCODE -ne 0) { throw "命令返回非零退出码 $LASTEXITCODE" }
    } catch {
        throw "执行失败 ($Description): $_"
    }
}

# ── 横幅 ─────────────────────────────────────────────────────
Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  ⚽ Football-2027 Windows 一键安装脚本" -ForegroundColor Cyan
Write-Host "  GitHub: https://github.com/a872034547-cpu/Football-2027" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# ── 检查 Docker ───────────────────────────────────────────────
Write-Step "检查 Docker Desktop"
try {
    $dockerVersion = docker --version 2>&1
    Write-OK "Docker 已安装：$dockerVersion"
} catch {
    Write-Err "未检测到 Docker Desktop！"
    Write-Host ""
    Write-Host "请先安装 Docker Desktop for Windows：" -ForegroundColor Yellow
    Write-Host "  https://www.docker.com/products/docker-desktop/" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "安装步骤：" -ForegroundColor Yellow
    Write-Host "  1. 打开上方链接，点击 Download Docker Desktop"
    Write-Host "  2. 双击安装包，一路 Next 安装"
    Write-Host "  3. 安装完成后重启电脑"
    Write-Host "  4. 打开 Docker Desktop，等待左下角变为绿色（Running）"
    Write-Host "  5. 重新运行本脚本"
    Write-Host ""
    Start-Process "https://www.docker.com/products/docker-desktop/"
    Read-Host "按回车退出..."
    exit 1
}

# 检查 Docker 是否运行
try {
    docker info 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw }
} catch {
    Write-Err "Docker Desktop 未运行！请打开 Docker Desktop 等待其完全启动后重试。"
    exit 1
}

# 检查 Docker Compose
try {
    docker compose version 2>&1 | Out-Null
    Write-OK "Docker Compose 可用"
} catch {
    Write-Err "Docker Compose 不可用，请更新 Docker Desktop 到最新版本。"
    exit 1
}

# ── 检查 Git ─────────────────────────────────────────────────
Write-Step "检查 Git"
try {
    $gitVersion = git --version 2>&1
    Write-OK "Git 已安装：$gitVersion"
} catch {
    Write-Err "未检测到 Git！"
    Write-Host ""
    Write-Host "请先安装 Git for Windows：" -ForegroundColor Yellow
    Write-Host "  https://git-scm.com/download/win" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "安装步骤：" -ForegroundColor Yellow
    Write-Host "  1. 打开上方链接，点击下载"
    Write-Host "  2. 双击安装包，一路 Next（默认选项即可）"
    Write-Host "  3. 安装完成后，关闭并重新打开 PowerShell"
    Write-Host "  4. 重新运行本脚本"
    Write-Host ""
    Start-Process "https://git-scm.com/download/win"
    Read-Host "按回车退出..."
    exit 1
}

# ── 克隆或更新代码 ────────────────────────────────────────────
Write-Step "获取项目代码"
$repoUrl = "https://github.com/a872034547-cpu/Football-2027.git"

if (Test-Path "$InstallDir\.git") {
    Write-Info "检测到已有仓库，执行 git pull..."
    try {
        Push-Location $InstallDir
        git pull --rebase --autostash
        Write-OK "代码已更新"
        Pop-Location
    } catch {
        Write-Warn "git pull 失败，继续使用现有代码：$_"
        Pop-Location
    }
} else {
    Write-Info "克隆仓库到 $InstallDir ..."
    $parentDir = Split-Path $InstallDir -Parent
    if (!(Test-Path $parentDir)) {
        New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
    }
    try {
        git clone $repoUrl $InstallDir
        Write-OK "克隆完成"
    } catch {
        Write-Err "克隆失败：$_"
        Write-Host "请检查网络连接，或手动下载：$repoUrl" -ForegroundColor Yellow
        exit 1
    }
}

Set-Location $InstallDir
Write-OK "当前目录：$(Get-Location)"

# ── 配置 .env ─────────────────────────────────────────────────
Write-Step "配置环境变量"

if (Test-Path ".env") {
    Write-OK "检测到已有 .env，跳过模板复制。"
} else {
    if (!(Test-Path ".env.example")) {
        Write-Err "找不到 .env.example，请检查仓库完整性。"
        exit 1
    }
    Copy-Item ".env.example" ".env"
    Write-OK "已从 .env.example 创建 .env"

    Write-Host ""
    Write-Host "🔧 请现在编辑配置文件，填入你的 AI API Key 和推送地址。" -ForegroundColor Yellow
    Write-Host "   配置文件位置：$InstallDir\.env" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "   最少需要填写：" -ForegroundColor Yellow
    Write-Host "     AI_API_KEY=sk-你的密钥" -ForegroundColor White
    Write-Host "     AI_CUSTOM_ENDPOINT=https://api.openai.com/v1" -ForegroundColor White
    Write-Host "     AI_MODEL=gpt-4o-mini" -ForegroundColor White
    Write-Host ""

    $openEditor = Read-Host "是否现在用记事本打开 .env 文件进行编辑？(Y/n)"
    if ($openEditor -ne 'n' -and $openEditor -ne 'N') {
        Start-Process notepad.exe -ArgumentList "$InstallDir\.env" -Wait
        Write-OK "配置文件编辑完成。"
    } else {
        Write-Warn "跳过编辑。请在启动后手动编辑 .env 并重启服务。"
    }
}

# ── 创建目录 ─────────────────────────────────────────────────
Write-Step "创建运行目录"
@("data", "logs", "hermes_data") | ForEach-Object {
    if (!(Test-Path $_)) {
        New-Item -ItemType Directory -Path $_ -Force | Out-Null
    }
}
Write-OK "已确保 data/ logs/ hermes_data/ 目录存在"

# ── 读取配置 ─────────────────────────────────────────────────
$appPort = 3000
$composeFile = "docker-compose.yml"

if (Test-Path ".env") {
    $envContent = Get-Content ".env" | Where-Object { $_ -match "^APP_PORT=" }
    if ($envContent) {
        $portVal = ($envContent[-1] -split "=", 2)[1].Trim()
        if ($portVal -match '^\d+$') { $appPort = [int]$portVal }
    }
}

# ── 构建并启动 ───────────────────────────────────────────────
Write-Step "构建 Docker 镜像（首次较慢，约 3-5 分钟）"
try {
    if ($NoHermes) {
        docker compose -f $composeFile build football-auto
    } else {
        docker compose -f $composeFile build football-auto
    }
    Write-OK "镜像构建完成"
} catch {
    Write-Err "镜像构建失败：$_"
    Write-Host "查看错误详情：docker compose logs" -ForegroundColor Yellow
    exit 1
}

Write-Step "启动 Docker 服务"
try {
    if ($NoHermes) {
        docker compose -f $composeFile up -d football-auto
    } else {
        docker compose -f $composeFile up -d
    }
    Write-OK "服务启动命令已执行"
} catch {
    Write-Err "服务启动失败：$_"
    exit 1
}

# ── 健康检查 ─────────────────────────────────────────────────
Write-Step "等待服务就绪"
$healthUrl = "http://127.0.0.1:$appPort/health"
$maxWait = 120
$elapsed = 0
$healthy = $false

Write-Info "健康检查地址：$healthUrl（最多等待 ${maxWait} 秒）"

while ($elapsed -lt $maxWait) {
    try {
        $response = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3 -ErrorAction Stop
        if ($response.status -eq "ok") {
            $healthy = $true
            break
        }
    } catch { }
    Write-Host -NoNewline "."
    Start-Sleep -Seconds 5
    $elapsed += 5
}

Write-Host ""

if ($healthy) {
    Write-OK "服务已就绪 ✅"
} else {
    Write-Warn "健康检查超时，服务可能仍在启动中。"
    Write-Info "查看日志：docker compose logs football-auto"
}

# ── 打印完成信息 ──────────────────────────────────────────────
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  ✅ Football-2027 安装完成！" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "📌 服务地址：" -ForegroundColor White
Write-Host "  足球预测 API：  http://localhost:$appPort" -ForegroundColor Cyan
Write-Host "  健康检查：      http://localhost:$appPort/health" -ForegroundColor Cyan
Write-Host ""
Write-Host "📁 项目目录：$InstallDir" -ForegroundColor White
Write-Host "⚙️  配置文件：$InstallDir\.env" -ForegroundColor White
Write-Host ""
Write-Host "🔧 常用命令（在项目目录的 PowerShell 中执行）：" -ForegroundColor White
Write-Host "  查看状态：    docker compose ps" -ForegroundColor Cyan
Write-Host "  查看日志：    docker compose logs -f football-auto" -ForegroundColor Cyan
Write-Host "  重启服务：    docker compose restart football-auto" -ForegroundColor Cyan
Write-Host "  手动采集：    Invoke-RestMethod -Method Post http://localhost:$appPort/api/collect/today" -ForegroundColor Cyan
Write-Host "  测试推送：    Invoke-RestMethod -Method Post http://localhost:$appPort/api/push/test" -ForegroundColor Cyan
Write-Host "  升级版本：    git pull; docker compose up -d --build" -ForegroundColor Cyan
Write-Host ""

# 检查 AI Key 是否配置
if (Test-Path ".env") {
    $aiKeyLine = Get-Content ".env" | Where-Object { $_ -match "^AI_API_KEY=" }
    if ($aiKeyLine) {
        $aiKeyVal = ($aiKeyLine[-1] -split "=", 2)[1].Trim()
        if ($aiKeyVal -eq "your_ai_api_key_here" -or [string]::IsNullOrEmpty($aiKeyVal)) {
            Write-Host "⚠️  提醒：AI_API_KEY 尚未配置！" -ForegroundColor Yellow
            Write-Host "   请编辑 $InstallDir\.env 填入 API Key 后执行：" -ForegroundColor Yellow
            Write-Host "   docker compose restart football-auto" -ForegroundColor Cyan
            Write-Host ""
        }
    }
}

Write-Host "📚 查看详细文档：" -ForegroundColor White
Write-Host "  $InstallDir\docs\DEPLOY.md" -ForegroundColor Cyan
Write-Host ""

# 打开浏览器
if ($healthy) {
    $openBrowser = Read-Host "是否在浏览器中打开服务页面？(Y/n)"
    if ($openBrowser -ne 'n' -and $openBrowser -ne 'N') {
        Start-Process "http://localhost:$appPort/health"
    }
}
