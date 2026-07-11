# build.ps1 — Assemble core + clients into dist/<platform>/
# Usage: .\build.ps1

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$distRoot = Join-Path $root "dist"
$platforms = @(
    @{ Client = "utools"; Dist = "uTools" },
    @{ Client = "ztools"; Dist = "zTools" }
)

function Update-ImportPaths {
    param(
        [string]$Target
    )

    # Fix import paths in dist/<platform>/src/ files.
    # From clients/<platform>/src/ the path was ../../../core/src/
    # From dist/<platform>/src/ the path should be ../core/src/
    # From dist/<platform>/src/ui/ the path should be ../../core/src/
    $rootSrcFiles = Get-ChildItem (Join-Path $Target "src\*.js") -File -ErrorAction SilentlyContinue
    foreach ($file in $rootSrcFiles) {
        $content = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
        $newContent = $content -replace "from '\.\./\.\./\.\./core/src/", "from '../core/src/" `
                               -replace "from '\.\./\.\./\.\./\.\./core/src/", "from '../core/src/"
        if ($newContent -ne $content) {
            [System.IO.File]::WriteAllText($file.FullName, $newContent, [System.Text.Encoding]::UTF8)
        }
    }

    $nestedSrcFiles = Get-ChildItem (Join-Path $Target "src\ui\*.js"),(Join-Path $Target "src\adapters\host\*.js") -File -ErrorAction SilentlyContinue
    foreach ($file in $nestedSrcFiles) {
        $content = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
        $newContent = $content -replace "from '\.\./\.\./\.\./\.\./core/src/", "from '../../core/src/" `
                               -replace "from '\.\./\.\./\.\./core/src/", "from '../../core/src/"
        if ($newContent -ne $content) {
            [System.IO.File]::WriteAllText($file.FullName, $newContent, [System.Text.Encoding]::UTF8)
        }
    }

    # Fix index.html fabric.js path.
    $htmlFile = Join-Path $Target "src\index.html"
    $htmlContent = [System.IO.File]::ReadAllText($htmlFile, [System.Text.Encoding]::UTF8)
    $htmlNew = $htmlContent -replace 'src="\.\./\.\./\.\./core/src/lib/fabric\.min\.js"', 'src="../core/src/lib/fabric.min.js"'
    if ($htmlNew -ne $htmlContent) {
        [System.IO.File]::WriteAllText($htmlFile, $htmlNew, [System.Text.Encoding]::UTF8)
    }
}

function Test-BuildOutput {
    param(
        [string]$Target,
        [string]$DistName
    )

    $ok = $true
    $checkPaths = @(
        (Join-Path $Target "src\*.js"),
        (Join-Path $Target "src\adapters\host\*.js"),
        (Join-Path $Target "core\src\*.js"),
        (Join-Path $Target "core\src\ui\*.js"),
        (Join-Path $Target "core\src\modules\*.js"),
        (Join-Path $Target "core\src\utils\*.js")
    )

    Get-ChildItem $checkPaths -File -ErrorAction SilentlyContinue | ForEach-Object {
        $result = node --check $_.FullName 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  FAIL: $($_.FullName.Replace($Target, "dist/$DistName"))" -ForegroundColor Red
            Write-Host $result -ForegroundColor Red
            $ok = $false
        }
    }

    return $ok
}

# Clean + create
New-Item -ItemType Directory -Path $distRoot -Force | Out-Null

# Remove legacy single-target dist output, but keep other platform folders.
foreach ($legacyItem in @('src', 'core', 'plugin.json', 'preload.js', 'logo.png')) {
    $legacyPath = Join-Path $distRoot $legacyItem
    if (Test-Path $legacyPath) { Remove-Item -Recurse -Force $legacyPath }
}

$allOk = $true

foreach ($platform in $platforms) {
    $clientName = $platform.Client
    $distName = $platform.Dist
    $clientRoot = Join-Path $root "clients\$clientName"
    $target = Join-Path $distRoot $distName

    Write-Host "Building dist/$distName/ ..." -ForegroundColor Cyan

    if (-not (Test-Path $clientRoot)) {
        throw "Client not found: $clientRoot"
    }

    if (Test-Path $target) { Remove-Item -Recurse -Force $target }

    New-Item -ItemType Directory -Path $target -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $target "src") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $target "core\src") -Force | Out-Null

    Copy-Item (Join-Path $clientRoot "plugin.json") $target
    Copy-Item (Join-Path $clientRoot "preload.js") $target
    Copy-Item (Join-Path $clientRoot "logo.png") $target
    xcopy (Join-Path $clientRoot "src") (Join-Path $target "src\") /E /I /Q /Y | Out-Null
    xcopy (Join-Path $root "core\src") (Join-Path $target "core\src\") /E /I /Q /Y | Out-Null

    Update-ImportPaths -Target $target

    if (Test-BuildOutput -Target $target -DistName $distName) {
        Write-Host "Build complete: dist/$distName/" -ForegroundColor Green
    } else {
        $allOk = $false
    }
}

if (-not $allOk) {
    Write-Host "Build failed!" -ForegroundColor Red
    exit 1
}
