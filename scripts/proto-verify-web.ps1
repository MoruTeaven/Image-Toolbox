# proto-verify-web.ps1 — esbuild 原型产物的端到端验证（评估用，不进正式构建）
#
# 复用 scripts/web-deploy-static-server.cjs（站点根由环境变量传入），
# 但站点根指向 dist-proto/web-esbuild，断言改成打包后的资源形态：
#   /（index.html）、/app.js、/index.css 必须以 200 命中；
#   DOM 必须出现脚本生成的 toolbar__btn（证明 bundle 真正执行并挂载了 App）。
param(
    [int]$Port = 8147
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$siteRoot = Join-Path $root "dist-proto\web-esbuild"

if (-not (Test-Path (Join-Path $siteRoot "index.html"))) {
    Write-Host "原型产物不存在，请先跑 esbuild 打包" -ForegroundColor Red
    exit 1
}

$edge = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { Write-Host "未找到 Edge" -ForegroundColor Yellow; exit 1 }

$serverLog = Join-Path $env:TEMP "proto-web-server.log"
$domFile = Join-Path $env:TEMP "proto-web-dom.html"
Remove-Item $serverLog, $domFile -Force -ErrorAction SilentlyContinue

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
    $env:WEB_DEPLOY_KNOWN_404 = '1'  # 允许 favicon 缺失
    $profileDir = Join-Path $env:TEMP "edge-proto-profile"
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $edge --headless --disable-gpu --no-first-run --no-default-browser-check `
            --user-data-dir="$profileDir" --virtual-time-budget=15000 `
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
Write-Host "═══ 原型验证结果 ═══" -ForegroundColor Cyan

$log = Get-Content $serverLog -Raw -ErrorAction SilentlyContinue
$requests = [regex]::Matches($log, '(?m)^(\d{3}) (\S+)$') | ForEach-Object {
    [pscustomobject]@{ Status = $_.Groups[1].Value; Path = $_.Groups[2].Value }
}
$misses = @($requests | Where-Object { $_.Status -eq '404' -and $_.Path -ne '/favicon.ico' })

Write-Host ("共 {0} 个请求，非 favicon 的 404：{1} 个" -f $requests.Count, $misses.Count)
if ($misses.Count -gt 0) {
    $misses | ForEach-Object { Write-Host ("    404 {0}" -f $_.Path) -ForegroundColor Red }
    $ok = $false
}

foreach ($required in @('/', '/app.js', '/index.css')) {
    $hit = @($requests | Where-Object { $_.Path -eq $required -and $_.Status -eq '200' })
    if ($hit.Count -eq 0) {
        Write-Host ("FAIL: {0} 未被 200 命中" -f $required) -ForegroundColor Red
        $ok = $false
    } else {
        Write-Host ("  OK  200 {0}" -f $required) -ForegroundColor DarkGray
    }
}

$dom = if (Test-Path $domFile) { [System.IO.File]::ReadAllText($domFile, [System.Text.Encoding]::UTF8) } else { "" }
if ([string]::IsNullOrWhiteSpace($dom)) {
    Write-Host "FAIL: 未取得 DOM，脚本可能未执行" -ForegroundColor Red
    $ok = $false
} else {
    Write-Host ("DOM {0} 字节" -f $dom.Length)
    foreach ($probe in @(
        @{ Name = '应用容器已挂载'; Pattern = 'id="app"' },
        @{ Name = '工具栏由脚本生成（bundle 已执行）'; Pattern = 'toolbar__btn' },
        @{ Name = '欢迎区已渲染'; Pattern = 'welcome__text' }
    )) {
        if ($dom -match [regex]::Escape($probe.Pattern)) {
            Write-Host ("  OK  {0}" -f $probe.Name) -ForegroundColor Green
        } else {
            Write-Host ("FAIL: {0}（未出现 {1}）" -f $probe.Name, $probe.Pattern) -ForegroundColor Red
            $ok = $false
        }
    }
}

Write-Host ""
if ($ok) { Write-Host "原型产物端到端验证通过" -ForegroundColor Green; exit 0 }
Write-Host "原型产物验证失败" -ForegroundColor Red; exit 1
