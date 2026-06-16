# build.ps1 — Assemble core + uTools client into dist/uTools/
# Usage: .\build.ps1

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$distRoot = Join-Path $root "dist"
$target = Join-Path $distRoot "uTools"

Write-Host "Building dist/uTools/ ..." -ForegroundColor Cyan

# Clean + create
New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
if (Test-Path $target) { Remove-Item -Recurse -Force $target }

# Remove legacy single-target dist output, but keep other platform folders.
foreach ($legacyItem in @('src', 'core', 'plugin.json', 'preload.js', 'logo.png')) {
    $legacyPath = Join-Path $distRoot $legacyItem
    if (Test-Path $legacyPath) { Remove-Item -Recurse -Force $legacyPath }
}

New-Item -ItemType Directory -Path $target -Force | Out-Null
New-Item -ItemType Directory -Path "$target\src" -Force | Out-Null
New-Item -ItemType Directory -Path "$target\core\src" -Force | Out-Null

# 1. Copy client files
Copy-Item "$root\clients\utools\plugin.json" "$target\"
Copy-Item "$root\clients\utools\preload.js" "$target\"
Copy-Item "$root\clients\utools\logo.png" "$target\"
xcopy "$root\clients\utools\src" "$target\src\" /E /I /Q /Y
xcopy "$root\core\src" "$target\core\src\" /E /I /Q /Y

# 3. Fix import paths in dist/uTools/src/ files
#    From clients/utools/src/ the path was ../../../core/src/
#    From dist/uTools/src/ the path should be ../core/src/
#    From dist/uTools/src/ui/ the path should be ../../core/src/

$rootSrcFiles = Get-ChildItem "$target\src\*.js"
foreach ($file in $rootSrcFiles) {
    $content = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
    $newContent = $content -replace "from '\.\./\.\./\.\./core/src/", "from '../core/src/" `
                           -replace "from '\.\./\.\./\.\./\.\./core/src/", "from '../core/src/"
    if ($newContent -ne $content) {
        [System.IO.File]::WriteAllText($file.FullName, $newContent, [System.Text.Encoding]::UTF8)
    }
}

$nestedSrcFiles = Get-ChildItem "$target\src\ui\*.js","$target\src\adapters\host\*.js"
foreach ($file in $nestedSrcFiles) {
    $content = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
    $newContent = $content -replace "from '\.\./\.\./\.\./\.\./core/src/", "from '../../core/src/" `
                           -replace "from '\.\./\.\./\.\./core/src/", "from '../../core/src/"
    if ($newContent -ne $content) {
        [System.IO.File]::WriteAllText($file.FullName, $newContent, [System.Text.Encoding]::UTF8)
    }
}

# Fix index.html fabric.js path
$htmlFile = "$target\src\index.html"
$htmlContent = [System.IO.File]::ReadAllText($htmlFile, [System.Text.Encoding]::UTF8)
$htmlNew = $htmlContent -replace 'src="\.\./\.\./\.\./core/src/lib/fabric\.min\.js"', 'src="../core/src/lib/fabric.min.js"'
if ($htmlNew -ne $htmlContent) {
    [System.IO.File]::WriteAllText($htmlFile, $htmlNew, [System.Text.Encoding]::UTF8)
}

# 4. Verify
$ok = $true
Get-ChildItem "$target\src\*.js","$target\src\ui\*.js","$target\src\adapters\host\*.js","$target\core\src\*.js","$target\core\src\modules\*.js","$target\core\src\utils\*.js" | ForEach-Object {
    $result = node --check $_.FullName 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  FAIL: $($_.FullName.Replace($target, 'dist/uTools'))" -ForegroundColor Red
        $ok = $false
    }
}

if ($ok) {
    Write-Host "Build complete: dist/uTools/" -ForegroundColor Green
} else {
    Write-Host "Build failed!" -ForegroundColor Red
    exit 1
}
