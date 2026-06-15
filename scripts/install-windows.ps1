param(
    [switch]$SkipDockerBuild
)

# Windows 一键安装 / 启动脚本
# 位置：server/scripts/install-windows.ps1
# 用途：启动 Hermes Studio Web UI + Football Auto 服务，并执行基础健康检查。

$ErrorActionPreference = 'Stop'

function Write-Info {
    param([string]$Message)
    Write-Host "[信息] $Message" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Message)
    Write-Host "[完成] $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "[警告] $Message" -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Message)
    Write-Host "[错误] $Message" -ForegroundColor Red
}

function Invoke-NativeRequired {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$Description
    )

    Write-Info $Description
    & $Command @Arguments
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "命令执行失败（退出码 $exitCode）：$Command $($Arguments -join ' ')"
    }
}

function Invoke-NativeOptional {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$Description
    )

    Write-Info $Description
    & $Command @Arguments
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        Write-Warn "命令执行失败（退出码 $exitCode），上方已保留原始错误输出：$Command $($Arguments -join ' ')"
        return $false
    }

    return $true
}

function Get-DotEnvValue {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$DefaultValue
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return $DefaultValue
    }

    $escapedName = [regex]::Escape($Name)
    $line = Get-Content -LiteralPath $Path -ErrorAction Stop |
        Where-Object { $_ -match "^\s*$escapedName\s*=" } |
        Select-Object -First 1

    if (-not $line) {
        return $DefaultValue
    }

    $value = ($line -replace "^\s*$escapedName\s*=\s*", '').Trim()
    $value = $value.Trim('"').Trim("'")

    if ([string]::IsNullOrWhiteSpace($value)) {
        return $DefaultValue
    }

    return $value
}

try {
    # 自动定位脚本所在目录，并切换到 server 根目录。
    $scriptDir = Split-Path -Parent $PSCommandPath
    if ([string]::IsNullOrWhiteSpace($scriptDir)) {
        $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    }

    $serverRoot = Resolve-Path -LiteralPath (Join-Path $scriptDir '..')
    Set-Location -LiteralPath $serverRoot
    Write-Ok "已切换到 server 根目录：$serverRoot"

    # 检查 Docker CLI。
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Fail "未检测到 docker 命令。请先安装并启动 Docker Desktop：https://www.docker.com/products/docker-desktop/"
        exit 1
    }

    Write-Info "检查 Docker 版本"
    docker --version
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "docker 命令不可用。请确认 Docker Desktop 已安装并正在运行。"
        exit 1
    }

    Write-Info "检查 Docker Compose 版本"
    docker compose version
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "未检测到可用的 docker compose。请安装新版 Docker Desktop，并确认 Docker Compose V2 可用。"
        exit 1
    }

    if (-not (Test-Path -LiteralPath 'docker-compose.hermes.yml')) {
        Write-Fail "缺少 docker-compose.hermes.yml，请确认脚本位于当前项目的 server/scripts/ 目录下。"
        exit 1
    }

    # 首次部署时从 Hermes 模板复制 .env。
    if (-not (Test-Path -LiteralPath '.env')) {
        if (-not (Test-Path -LiteralPath '.env.hermes.example')) {
            Write-Fail "未找到 .env，且缺少 .env.hermes.example，无法生成默认配置。"
            exit 1
        }

        Copy-Item -LiteralPath '.env.hermes.example' -Destination '.env'
        Write-Ok "已从 .env.hermes.example 复制生成 .env，请按需修改 AI Key、推送 Webhook 等配置。"
    }
    else {
        Write-Info ".env 已存在，跳过复制。"
    }

    # 创建运行所需目录。
    foreach ($dir in @('data', 'hermes_data', 'logs')) {
        if (-not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir | Out-Null
            Write-Ok "已创建目录：$dir"
        }
        else {
            Write-Info "目录已存在：$dir"
        }
    }

    # 构建 Football Auto 镜像；可通过 -SkipDockerBuild 跳过。
    if ($SkipDockerBuild) {
        Write-Warn "已指定 -SkipDockerBuild，跳过 docker compose build football-auto。"
    }
    else {
        Invoke-NativeRequired -Command 'docker' -Arguments @('compose', '-f', 'docker-compose.hermes.yml', 'build', 'football-auto') -Description '构建 football-auto Docker 镜像'
    }

    # 启动服务。
    Invoke-NativeRequired -Command 'docker' -Arguments @('compose', '-f', 'docker-compose.hermes.yml', 'up', '-d') -Description '启动 Hermes Studio Web UI + Football Auto 服务'

    # 读取 APP_PORT，按 ${APP_PORT:-3000} 的语义默认使用 3000。
    $appPort = Get-DotEnvValue -Path '.env' -Name 'APP_PORT' -DefaultValue '3000'
    $hermesPort = Get-DotEnvValue -Path '.env' -Name 'HERMES_PORT' -DefaultValue '6060'
    $healthUrl = "http://127.0.0.1:$appPort/health"

    # 等待 Football Auto 健康检查，最多 90 秒。
    Write-Info "等待 Football Auto 健康检查：$healthUrl（最多 90 秒）"
    $deadline = (Get-Date).AddSeconds(90)
    $healthy = $false
    $lastError = $null

    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 5
            if ($response) {
                $healthy = $true
                break
            }
        }
        catch {
            $lastError = $_
            Start-Sleep -Seconds 3
        }
    }

    if (-not $healthy) {
        Write-Fail "90 秒内未通过健康检查：$healthUrl"
        if ($lastError) {
            Write-Warn "最后一次健康检查错误：$($lastError.Exception.Message)"
        }
        Write-Host "可用以下命令查看日志："
        Write-Host "  docker compose -f docker-compose.hermes.yml logs -f football-auto"
        exit 1
    }

    Write-Ok "Football Auto 健康检查通过：$healthUrl"

    # 如果本机存在 npm，则执行本地诊断和冒烟测试；失败时提示，但保留 npm 原始错误输出。
    if (Get-Command npm -ErrorAction SilentlyContinue) {
        Write-Info "检测到 npm，开始执行本地诊断命令。"
        Invoke-NativeOptional -Command 'npm' -Arguments @('run', 'doctor') -Description '执行 npm run doctor'
        Invoke-NativeOptional -Command 'npm' -Arguments @('run', 'smoke:local') -Description '执行 npm run smoke:local'
    }
    else {
        Write-Warn "未检测到 npm，跳过 npm run doctor 和 npm run smoke:local。"
    }

    Write-Host ''
    Write-Ok "部署启动流程完成。"
    Write-Host ''
    Write-Host '访问地址：' -ForegroundColor Cyan
    Write-Host "  Football Auto：       http://127.0.0.1:$appPort"
    Write-Host "  Football Auto 健康：  $healthUrl"
    Write-Host "  Hermes Studio Web UI：http://127.0.0.1:$hermesPort"
    Write-Host ''
    Write-Host '常用维护命令（在 server 目录执行）：' -ForegroundColor Cyan
    Write-Host '  docker compose -f docker-compose.hermes.yml ps'
    Write-Host '  docker compose -f docker-compose.hermes.yml logs -f football-auto'
    Write-Host '  docker compose -f docker-compose.hermes.yml logs -f hermes-webui'
    Write-Host '  docker compose -f docker-compose.hermes.yml restart football-auto'
    Write-Host '  docker compose -f docker-compose.hermes.yml down'
    Write-Host '  docker compose -f docker-compose.hermes.yml pull'
    Write-Host '  docker compose -f docker-compose.hermes.yml build football-auto'
    Write-Host ''
    Write-Warn '首次登录 Hermes 后请立即修改默认密码；如需配置 AI Key 或推送 Webhook，请编辑 server/.env 后重启服务。'
}
catch {
    Write-Fail $_.Exception.Message
    exit 1
}
