# verify-web-deploy.ps1 — 端到端验证 Web 部署产物（dist/web/）
#
# 用途：在没有外网出口的机器上用本地静态服务器 + 无头浏览器复现「从站点根加载」
# 的真实场景。与 build.ps1 的静态断言互补：静态断言看的是文件是否存在，
# 这里看的是浏览器实际发出的每个请求是否命中 200、以及应用是否真的挂载起来。
#
# Usage: powershell -ExecutionPolicy Bypass -File .\scripts\verify-web-deploy.ps1
#
# 需要 Edge。若机器上没有 Edge，脚本会明确报错退出，而不是假装通过。

param(
    [int]$Port = 8137
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$siteRoot = Join-Path $root "dist\web"

if (-not (Test-Path (Join-Path $siteRoot "index.html"))) {
    Write-Host "dist/web/index.html 不存在，请先执行 build.ps1" -ForegroundColor Red
    exit 1
}

$edge = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $edge) {
    Write-Host "未找到 Edge，无法进行浏览器端验证。" -ForegroundColor Yellow
    exit 1
}

$serverLog = Join-Path $env:TEMP "web-deploy-server.log"
$domFile = Join-Path $env:TEMP "web-deploy-dom.html"
Remove-Item $serverLog, $domFile -Force -ErrorAction SilentlyContinue

# 静态服务器以 dist/web 为站点根，逐条打印请求路径与状态码。
# 站点根通过环境变量传入：Start-Process 的 -ArgumentList 不保证保留非 ASCII
# 路径（本仓库路径含中文），走环境变量可以避开这层编码转换。
$env:WEB_DEPLOY_SITE_ROOT = $siteRoot
$env:WEB_DEPLOY_PORT = "$Port"
$server = Start-Process -FilePath "node" `
    -ArgumentList @("scripts/web-deploy-static-server.cjs") `
    -WorkingDirectory $root -PassThru -NoNewWindow `
    -RedirectStandardOutput $serverLog

try {
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        if ((Test-Path $serverLog) -and ((Get-Content $serverLog -Raw) -match 'LISTENING')) { break }
        Start-Sleep -Milliseconds 300
    }
    if (-not ((Get-Content $serverLog -Raw -ErrorAction SilentlyContinue) -match 'LISTENING')) {
        Write-Host "静态服务器启动失败，日志：" -ForegroundColor Red
        Get-Content $serverLog -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
        exit 1
    }

    $profileDir = Join-Path $env:TEMP "edge-verify-profile"
    # Edge writes harmless noise to stderr (QQBrowser probe, crashpad). Native
    # stderr must not abort the run, so the preference is relaxed just here.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $edge --headless --disable-gpu --no-first-run --no-default-browser-check `
            --user-data-dir="$profileDir" --virtual-time-budget=12000 `
            --dump-dom "http://127.0.0.1:$Port/" 2>$null | Out-File -Encoding utf8 $domFile
    } finally {
        $ErrorActionPreference = $previous
    }
} finally {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
}

$ok = $true
Write-Host ""
Write-Host "═══ 验证结果 ═══" -ForegroundColor Cyan

# ── 1. 浏览器实际请求的资源，除 favicon 外不得有任何 404 ──
$log = Get-Content $serverLog -Raw -ErrorAction SilentlyContinue
$requests = [regex]::Matches($log, '(?m)^(\d{3}) (\S+)$') | ForEach-Object {
    [pscustomobject]@{ Status = $_.Groups[1].Value; Path = $_.Groups[2].Value }
}
$misses = @($requests | Where-Object { $_.Status -eq '404' -and $_.Path -ne '/favicon.ico' })

Write-Host ("页面共发起 {0} 个请求，非 favicon 的 404 有 {1} 个" -f $requests.Count, $misses.Count)
if ($misses.Count -gt 0) {
    Write-Host "FAIL: 存在资源 404，部署后必然加载失败：" -ForegroundColor Red
    $misses | ForEach-Object { Write-Host ("    {0} {1}" -f $_.Status, $_.Path) -ForegroundColor Red }
    $ok = $false
}

# ── 2. 本次事故中失效的三个资源必须命中 200 ──
foreach ($required in @('/core/src/style.css', '/core/src/lib/fabric.min.js', '/core/src/lib/jszip.min.js', '/index.js')) {
    $hit = @($requests | Where-Object { $_.Path -eq $required -and $_.Status -eq '200' })
    if ($hit.Count -eq 0) {
        Write-Host ("FAIL: {0} 未被以 200 命中" -f $required) -ForegroundColor Red
        $ok = $false
    } else {
        Write-Host ("  OK  200 {0}" -f $required) -ForegroundColor DarkGray
    }
}

# ── 3. 应用真的挂载起来了（脚本链路完整，不只是 HTML 拿到） ──
$dom = if (Test-Path $domFile) { [System.IO.File]::ReadAllText($domFile, [System.Text.Encoding]::UTF8) } else { "" }
if ([string]::IsNullOrWhiteSpace($dom)) {
    Write-Host "FAIL: 未取得页面 DOM，脚本可能未执行" -ForegroundColor Red
    $ok = $false
} else {
    Write-Host ("DOM {0} 字节" -f $dom.Length)
    foreach ($probe in @(
        @{ Name = '应用容器已挂载'; Pattern = 'id="app"' },
        @{ Name = '工具栏由脚本生成'; Pattern = 'toolbar__btn' },
        @{ Name = '欢迎区已渲染'; Pattern = 'welcome__text' }
    )) {
        if ($dom -match $probe.Pattern) {
            Write-Host ("  OK  {0}" -f $probe.Name) -ForegroundColor DarkGray
        } else {
            Write-Host ("FAIL: {0}（DOM 中未出现 {1}）" -f $probe.Name, $probe.Pattern) -ForegroundColor Red
            $ok = $false
        }
    }
}

Write-Host ""
if ($ok) { Write-Host "验证通过。" -ForegroundColor Green; exit 0 }
Write-Host "验证失败。" -ForegroundColor Red; exit 1
