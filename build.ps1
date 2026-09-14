# build.ps1 - Assemble core + clients into dist/<platform>/
# Usage: .\build.ps1
#
# Path strategy:
#   Source uses the location-independent #core/ alias (resolved by the root
#   package.json "imports" field). At build time #core/ is rewritten to the
#   correct relative path for each output file, with the depth computed from
#   the file's actual location in dist instead of being hardcoded per directory.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$distRoot = Join-Path $root "dist"
$platforms = @(
    @{ Client = "utools"; Dist = "uTools" },
    @{ Client = "ztools"; Dist = "zTools" },
    @{ Client = "web";   Dist = "web" }
)

# Returns the "../" prefix a file needs to reach the platform root.
function Get-CorePrefix {
    param(
        [string]$File,
        [string]$TargetRoot
    )

    $dir = Split-Path $File -Parent
    $rel = $dir.Substring($TargetRoot.Length)
    $rel = ($rel -split '[\\/]' | Where-Object { $_ -ne '' }) -join '/'
    $rel = $rel.Trim('/')
    if ([string]::IsNullOrEmpty($rel)) {
        return './'
    }
    $depth = @($rel.Split('/') | Where-Object { $_ -ne '' }).Count
    return ('../' * $depth)
}

# Rewrites the #core/ alias into a real relative path usable inside dist.
function Update-ImportPaths {
    param(
        [string]$Target
    )

    $targeted = Get-ChildItem $Target -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -eq '.js' -or $_.Extension -eq '.html' }
    foreach ($file in $targeted) {
        $content = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
        if ($content -notlike "*#core/*") {
            continue
        }
        $prefix = Get-CorePrefix -File $file.FullName -TargetRoot $Target
        $newContent = $content.Replace("#core/", ($prefix + "core/src/"))
        if ($newContent -ne $content) {
            [System.IO.File]::WriteAllText($file.FullName, $newContent, [System.Text.Encoding]::UTF8)
        }
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
        (Join-Path $Target "core\src\adapters\*.js"),
        (Join-Path $Target "core\src\app\*.js"),
        (Join-Path $Target "core\src\ui\*.js"),
        (Join-Path $Target "core\src\modules\*.js"),
        (Join-Path $Target "core\src\utils\*.js"),
        (Join-Path $Target "core\src\identity\*.js"),
        (Join-Path $Target "core\src\lib\identity-sdk\*.js"),
        (Join-Path $Target "core\src\lib\identity-sdk\adapters\*.js")
    )

    Get-ChildItem $checkPaths -File -ErrorAction SilentlyContinue | ForEach-Object {
        $result = node --check $_.FullName 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  FAIL: $($_.FullName.Replace($Target, "dist/$DistName"))" -ForegroundColor Red
            Write-Host $result -ForegroundColor Red
            $ok = $false
        }
    }

    # The build output must not contain unresolved aliases.
    $leftover = Get-ChildItem $Target -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -eq '.js' -or $_.Extension -eq '.html' } |
        Select-String -Pattern "#core/" -SimpleMatch -ErrorAction SilentlyContinue
    if ($leftover) {
        Write-Host "  FAIL: unresolved #core/ alias in dist/$DistName" -ForegroundColor Red
        $leftover | ForEach-Object { Write-Host "    $($_.Path)" -ForegroundColor Red }
        $ok = $false
    }

    # preload.js is loaded by Electron via CommonJS require(). If an ancestor
    # package.json declares "type": "module", Node rejects it with
    # "require() of ES Module ... not supported" and the plugin fails to load.
    # This guard makes that failure explicit instead of a confusing syntax error.
    $preload = Join-Path $Target "preload.js"
    if (Test-Path $preload) {
        # Walk up from preload.js to the nearest package.json and check its "type".
        $dir = Split-Path $preload -Parent
        $type = $null
        while ($dir -and -not $type) {
            $candidate = Join-Path $dir "package.json"
            if (Test-Path $candidate) {
                $json = [System.IO.File]::ReadAllText($candidate, [System.Text.Encoding]::UTF8)
                if ($json -match '"type"\s*:\s*"module"') {
                    $type = "module"
                } else {
                    $type = "commonjs"
                }
            }
            $dir = Split-Path $dir -Parent
        }
        if ($type -eq "module") {
            Write-Host "  FAIL: dist/$DistName/preload.js would be treated as an ES module." -ForegroundColor Red
            Write-Host "        Electron requires it as CommonJS, so it would fail to load." -ForegroundColor Red
            Write-Host "        Remove the 'type: module' field from the ancestor package.json." -ForegroundColor Red
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

    # Platform-optional files: plugin.json / preload.js are Electron-only.
    if (Test-Path (Join-Path $clientRoot "plugin.json")) {
        Copy-Item (Join-Path $clientRoot "plugin.json") $target
    }
    if (Test-Path (Join-Path $clientRoot "preload.js")) {
        Copy-Item (Join-Path $clientRoot "preload.js") $target
    }
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