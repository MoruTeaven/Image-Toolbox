# deploy-cf-pages.ps1 — 构建并部署 Web 端到 Cloudflare Pages
# Usage: .\deploy-cf-pages.ps1
# Prereq: 已通过 npx wrangler login 登录 Cloudflare 账号

param(
    [string]$ProjectName = "img-toolbox"
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$distWeb = Join-Path $root "dist\web"

Write-Host "1/3  Building dist/web/ ..." -ForegroundColor Cyan
powershell -ExecutionPolicy Bypass -File (Join-Path $root "build.ps1")
if ($LASTEXITCODE -ne 0) { Write-Host "Build failed!" -ForegroundColor Red; exit 1 }

Write-Host "2/3  Preparing root index.html for Cloudflare Pages ..." -ForegroundColor Cyan
# 读取 src/index.html 并修正资源路径，输出到 dist/web/index.html
$srcHtml = Join-Path $distWeb "src\index.html"
$html = [System.IO.File]::ReadAllText($srcHtml, [System.Text.Encoding]::UTF8)
$html = $html -replace 'href="style\.css"', 'href="src/style.css"'
$html = $html -replace 'src="\.\./core/src/lib/fabric\.min\.js"', 'src="core/src/lib/fabric.min.js"'
$html = $html -replace 'src="index\.js"', 'src="src/index.js"'
[System.IO.File]::WriteAllText((Join-Path $distWeb "index.html"), $html, [System.Text.Encoding]::UTF8)

Write-Host "3/3  Deploying to Cloudflare Pages (project: $ProjectName) ..." -ForegroundColor Cyan
npx wrangler pages deploy $distWeb --project-name $ProjectName
if ($LASTEXITCODE -ne 0) { Write-Host "Deploy failed!" -ForegroundColor Red; exit 1 }

Write-Host "Done!" -ForegroundColor Green
