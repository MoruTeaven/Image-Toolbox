# build.ps1 - Bundle core + clients into dist/<platform>/ with esbuild.
# Usage: .\build.ps1   (requires 'pnpm install' first: esbuild is a devDependency)
#
# Path strategy since the esbuild migration (see ESBUILD_EVALUATION.md):
#   Source code keeps using the location-independent #core/ alias (declared in
#   the root package.json "imports"). esbuild resolves the alias natively while
#   bundling - the build no longer rewrites paths inside the output, so the old
#   Update-ImportPaths machinery and its silent-miss failure mode are gone.
#
#   Every platform emits the same page trio:
#     index.html   rewritten by scripts/prepare-build.mjs (asserted there)
#     app.js       one ESM bundle: vendored fabric/jszip wrappers + the real
#                  client entry (clients/<platform>/src/index.js, imported
#                  unchanged)
#     index.css    bundled core/src/style.css, minified
#   Electron platforms additionally emit preload.js: a CommonJS bundle of
#   clients/<platform>/preload.js with require("electron") kept external, plus
#   plugin.json and logo.png copied as-is.
#
#   dist/web/ is served with the folder as the site root; the rewritten page
#   only references ./app.js and ./index.css, which resolve from the root by
#   construction. scripts/verify-web-root-load.mjs recomputes the browser
#   request map from disk as the acceptance gate. No per-path regex patching
#   of product HTML exists anywhere in this build (the historical 404 incident
#   class this replaces; scripts/prepare-build.mjs asserts its own rewrite).
#
# Gates, any failure fails the build:
#   0. scripts/version-check.ps1 up front (source truth) and again after all
#      platforms are built (catches a stale dist from an interrupted run).
#   1. scripts/verify-artifact.mjs - esbuild metafile assertions: every bundled
#      input comes from core/src, clients/, scripts/ or the staging dir, and
#      externals are only the whitelisted ones.
#   2. Test-BuildOutput - node --check on the emitted bundles, no unresolved
#      #core/ anywhere in dist, and no ancestor package.json of preload.js may
#      declare "type": "module".
#   3. scripts/verify-bundle-smoke.mjs - the page bundle really evaluates under
#      the Node DOM stubs and mounts fabric 5.3.0 + JSZip.
#   4. web only: scripts/verify-web-root-load.mjs - every first-screen request
#      resolves on disk from the site root.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$distRoot = Join-Path $root "dist"
$platforms = @(
    @{ Client = "utools"; Dist = "uTools" },
    @{ Client = "ztools"; Dist = "zTools" },
    @{ Client = "web";   Dist = "web" }
)

function New-Utf8NoBom {
    return New-Object System.Text.UTF8Encoding($false)
}

# Resolve the esbuild CLI (Windows-only toolchain assumption). The layout differs by package manager, and hardcoding
# one layout silently breaks the build after a package manager switch:
#   pnpm (strict node_modules) - the real binary lives under node_modules/.pnpm/
#     @esbuild+win32-x64@<ver>/node_modules/@esbuild/win32-x64/, and the callable
#     entry is the .bin shim (esbuild.CMD on Windows); the top-level
#     node_modules/@esbuild/ directory is empty, so the old path found nothing.
#   npm (flat node_modules) - node_modules/@esbuild/win32-x64/esbuild.exe.
# Prefer the .bin shim: it exists under both managers and stays valid across
# version bumps. The .pnpm glob and the flat path are fallbacks.
$esbuildExe = @(
    (Join-Path $root "node_modules\.bin\esbuild.CMD"),
    (Join-Path $root "node_modules\.bin\esbuild.exe")
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $esbuildExe) {
    $esbuildExe = Get-ChildItem -Path (Join-Path $root "node_modules\.pnpm") -Filter "esbuild.exe" -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match "win32-x64|win32-arm64" } |
        Select-Object -First 1 |
        ForEach-Object { $_.FullName }
}

if (-not $esbuildExe) {
    foreach ($arch in @("win32-x64", "win32-arm64")) {
        $candidate = Join-Path $root ("node_modules\@esbuild\" + $arch + "\esbuild.exe")
        if (Test-Path $candidate) { $esbuildExe = $candidate; break }
    }
}

if (-not $esbuildExe) {
    Write-Host "FAIL: esbuild CLI not found under node_modules\.bin or node_modules\@esbuild." -ForegroundColor Red
    Write-Host "      Run 'pnpm install' (or 'npm install') first - esbuild is a devDependency." -ForegroundColor Red
    exit 1
}

# Runs scripts/prepare-build.mjs and returns the staging dir it printed.
# Staging lives in the system temp dir on purpose: it is build scratch, and it
# must stay outside dist/ where Test-BuildOutput would otherwise node --check
# the ESM stubs as if they were CommonJS products.
function Get-StagingDir {
    param([string]$ClientName)
    $out = node (Join-Path $root "scripts\prepare-build.mjs") --platform $ClientName 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw ("prepare-build.mjs failed for " + $ClientName + ":" + [Environment]::NewLine + ($out -join [Environment]::NewLine))
    }
    $hit = @($out | Select-String -Pattern '-> (.+)$' | Select-Object -Last 1)
    if ($hit.Count -eq 0) {
        throw ("prepare-build.mjs printed no staging path for " + $ClientName)
    }
    return $hit[0].Matches[0].Groups[1].Value.Trim()
}

# One esbuild invocation. External commands never honour $ErrorActionPreference,
# so the exit code decides. PS 5.1 wraps native stderr lines into ErrorRecords when
# they are merged into the pipeline (2>&1): with a Stop preference the build would
# abort on the FIRST esbuild warning even though esbuild exits 0. Scope the
# preference to Continue while capturing output, then judge by exit code only.
function Invoke-Esbuild {
    param(
        [string]$Label,
        [string[]]$Arguments
    )
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $output = & $esbuildExe @Arguments 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    foreach ($line in @($output)) {
        Write-Host ("  esbuild[" + $Label + "] " + ($line | Out-String).Trim())
    }
    if ($code -ne 0) {
        throw ("esbuild failed for " + $Label + " (exit " + $code + ")")
    }
}

# Guards over one platform's dist. Same intent as the pre-esbuild build,
# reduced to what the new output actually is: two bundles, not ~70 copied
# source files (the copies are gone - esbuild consumed the sources).
function Test-BuildOutput {
    param(
        [string]$Target,
        [string]$DistName,
        [string]$PageBundle
    )

    $ok = $true

    # 1. Syntax of the emitted bundles. app.js is format=esm; the minified body
    #    carries no import/export statements, but parsing it through a .cjs copy
    #    proves the syntax even under CJS rules. preload.js is cjs and checked
    #    in place.
    $pageCheck = Join-Path $env:TEMP ("imgtb-check-" + $DistName + "-" + (Get-Random) + ".cjs")
    Copy-Item $PageBundle $pageCheck -Force
    $result = node --check $pageCheck 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host ("  FAIL: node --check on dist/" + $DistName + " page bundle") -ForegroundColor Red
        Write-Host $result -ForegroundColor Red
        $ok = $false
    }
    Remove-Item $pageCheck -Force -ErrorAction SilentlyContinue

    $preload = Join-Path $Target "preload.js"
    if (Test-Path $preload) {
        $result = node --check $preload 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host ("  FAIL: node --check on dist/" + $DistName + "/preload.js") -ForegroundColor Red
            Write-Host $result -ForegroundColor Red
            $ok = $false
        }
    }

    # 2. The output must not contain unresolved aliases. esbuild resolving
    #    #core/ natively makes this structural rather than a rewrite check; it
    #    stays as the belt-and-braces guard the evaluation report promised.
    $leftover = Get-ChildItem $Target -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -eq '.js' -or $_.Extension -eq '.html' } |
        Select-String -Pattern "#core/" -SimpleMatch -ErrorAction SilentlyContinue
    if ($leftover) {
        Write-Host ("  FAIL: unresolved #core/ alias in dist/" + $DistName) -ForegroundColor Red
        $leftover | ForEach-Object { Write-Host ("    " + $_.Path) -ForegroundColor Red }
        $ok = $false
    }

    # 3. preload.js is loaded by Electron via CommonJS require(). If an ancestor
    #    package.json declares "type": "module", Node rejects it with
    #    "require() of ES Module ... not supported" and the plugin fails to load.
    #    This guard makes that failure explicit instead of a confusing syntax error.
    if (Test-Path $preload) {
        $dir = Split-Path $preload -Parent
        $type = $null
        while ($dir -and -not $type) {
            $candidate = Join-Path $dir "package.json"
            if (Test-Path $candidate) {
                $json = [System.IO.File]::ReadAllText($candidate, (New-Utf8NoBom))
                if ($json -match '"type"\s*:\s*"module"') {
                    $type = "module"
                } else {
                    $type = "commonjs"
                }
            }
            $dir = Split-Path $dir -Parent
        }
        if ($type -eq "module") {
            Write-Host ("  FAIL: dist/" + $DistName + "/preload.js would be treated as an ES module.") -ForegroundColor Red
            Write-Host "        Electron requires it as CommonJS, so it would fail to load." -ForegroundColor Red
            Write-Host "        Remove the 'type: module' field from the ancestor package.json." -ForegroundColor Red
            $ok = $false
        }
    }

    return $ok
}

# #core/ alias rewrite safety gate (provides Test-AliasRewriteSafety).
# The old Update-ImportPaths rewrote the alias with an unbounded plain-text
# replacement and mangled a JSDoc example into a relative path; the check of
# that era only scanned for leftover "#core/", which a munged line no longer
# contains, so the corruption was invisible to the build. esbuild resolves the
# alias natively now, so this gate pins that down and adds the reverse
# assertions the old one-directional check was missing.
# English-only comments here on purpose: this file is parsed by Windows
# PowerShell 5.1, which must not have to tokenize a large CJK comment surface.
. (Join-Path $PSScriptRoot "scripts\verify-alias-rewrite.ps1")

# App version consistency gate (single source of truth: core/src/changelog.js).
# The implementation lives in scripts/version-check.ps1 - it is kept out of this
# file so the heavy CJK comment surface of the docs does not sit inside the
# build script that Windows PowerShell has to tokenize.
. (Join-Path $PSScriptRoot "scripts\version-check.ps1")

Write-Host "Checking app version consistency ..." -ForegroundColor Cyan
if (-not (Test-AppVersion -Root $root -DistRoot $distRoot -Platforms $platforms)) {
    Write-Host "Build failed." -ForegroundColor Red
    exit 1
}

New-Item -ItemType Directory -Path $distRoot -Force | Out-Null

# Remove legacy single-target dist output, but keep other platform folders.
foreach ($legacyItem in @('src', 'core', 'plugin.json', 'preload.js', 'logo.png')) {
    $legacyPath = Join-Path $distRoot $legacyItem
    if (Test-Path $legacyPath) { Remove-Item -Recurse -Force $legacyPath }
}
# dist/.build is where staging used to live before it moved to the temp dir;
# remove it if present. Best effort: it is inert scratch, never deployed.
$legacyStaging = Join-Path $distRoot ".build"
if (Test-Path $legacyStaging) {
    Remove-Item -Recurse -Force $legacyStaging -ErrorAction SilentlyContinue
    if (Test-Path $legacyStaging) {
        Write-Host "NOTE: dist/.build could not be removed (it is inert scratch; delete it by hand)." -ForegroundColor Yellow
    }
}

$allOk = $true

foreach ($platform in $platforms) {
    $clientName = $platform.Client
    $distName = $platform.Dist
    $clientRoot = Join-Path $root "clients\$clientName"
    $target = Join-Path $distRoot $distName
    $isElectron = ($clientName -ne 'web')

    Write-Host ("Building dist/" + $distName + "/ ...") -ForegroundColor Cyan

    if (-not (Test-Path $clientRoot)) {
        throw ("Client not found: " + $clientRoot)
    }

    $stage = Get-StagingDir -ClientName $clientName

    if (Test-Path $target) { Remove-Item -Recurse -Force $target }

    New-Item -ItemType Directory -Path $target -Force | Out-Null
    if ($isElectron) {
        New-Item -ItemType Directory -Path (Join-Path $target "src") -Force | Out-Null
        $pageOut = Join-Path $target "src\app.js"
        $cssOut  = Join-Path $target "src\index.css"
        $htmlOut = Join-Path $target "src\index.html"
    } else {
        $pageOut = Join-Path $target "app.js"
        $cssOut  = Join-Path $target "index.css"
        $htmlOut = Join-Path $target "index.html"
    }

    # 1. Page bundle. The staging entry imports the vendor wrappers first and
    #    then the real client entry, mirroring the old <script> order; jsdom
    #    stays external because the vendored fabric.min.js keeps a Node-only
    #    require("jsdom") branch that never runs in a browser and would not
    #    resolve from this repo.
    Invoke-Esbuild ("page-" + $distName) @(
        (Join-Path $stage "entry.js"),
        "--bundle",
        ("--outfile=" + $pageOut),
        "--format=esm",
        "--platform=browser",
        "--target=chrome100",
        "--charset=utf8",
        "--define:global=globalThis",
        "--minify",
        "--legal-comments=inline",
        "--external:jsdom",
        "--external:jsdom/lib/*",
        "--log-level=warning",
        ("--metafile=" + (Join-Path $stage "meta-page.json"))
    )

    # 2. Stylesheet.
    Invoke-Esbuild ("css-" + $distName) @(
        (Join-Path $root "core\src\style.css"),
        "--bundle",
        ("--outfile=" + $cssOut),
        "--minify",
        "--log-level=warning"
    )

    # 3. Page copy. The staging HTML was already rewritten and asserted by
    #    scripts/prepare-build.mjs; it is moved byte for byte, never patched
    #    here.
    Copy-Item (Join-Path $stage "index.html") $htmlOut -Force

    # 4. Client assets. plugin.json / preload.js are Electron-only, logo.png is
    #    the plugin icon on Electron and kept as a favicon on web.
    Copy-Item (Join-Path $clientRoot "logo.png") $target
    if ($isElectron) {
        Copy-Item (Join-Path $clientRoot "plugin.json") $target

        # 5. preload: CommonJS bundle for Electron's require(). electron stays
        #    external; node builtins (fs/path/os/child_process) stay external by
        #    --platform=node.
        Invoke-Esbuild ("preload-" + $distName) @(
            (Join-Path $clientRoot "preload.js"),
            "--bundle",
            ("--outfile=" + (Join-Path $target "preload.js")),
            "--platform=node",
            "--format=cjs",
            "--external:electron",
            "--charset=utf8",
            "--log-level=warning",
            ("--metafile=" + (Join-Path $stage "meta-preload.json"))
        )
    }

    # Gate 1: metafile scope assertions.
    node (Join-Path $root "scripts\verify-artifact.mjs") (Join-Path $stage "meta-page.json") --staging $stage --allow-external jsdom --label ("page-" + $distName)
    if ($LASTEXITCODE -ne 0) { $allOk = $false }

    if ($isElectron) {
        node (Join-Path $root "scripts\verify-artifact.mjs") (Join-Path $stage "meta-preload.json") --allow-external electron,fs,path,os,child_process,events,util --label ("preload-" + $distName)
        if ($LASTEXITCODE -ne 0) { $allOk = $false }

        # Gate 3b: the preload bundle must really evaluate under stubbed electron +
        # window. node --check cannot catch CJS/ESM interop breakage (the bundle
        # stays syntactically valid while initPlatformPreload becomes undefined);
        # this is the only guard against that runtime class.
        node (Join-Path $root "scripts\verify-preload-smoke.mjs") (Join-Path $target "preload.js")
        if ($LASTEXITCODE -ne 0) { $allOk = $false }
    }

    # Gate 2: output guards.
    if (-not (Test-BuildOutput -Target $target -DistName $distName -PageBundle $pageOut)) {
        $allOk = $false
    }

    # Gate 3: the page bundle must evaluate with the vendored globals mounted.
    $smokeFile = Join-Path $env:TEMP ("imgtb-smoke-" + $distName + "-" + (Get-Random) + ".mjs")
    Copy-Item $pageOut $smokeFile -Force
    node (Join-Path $root "scripts\verify-bundle-smoke.mjs") $smokeFile
    if ($LASTEXITCODE -ne 0) { $allOk = $false }
    Remove-Item $smokeFile -Force -ErrorAction SilentlyContinue

    # Gate 4 (web only): recompute every first-screen request from the site root.
    if (-not $isElectron) {
        node (Join-Path $root "scripts\verify-web-root-load.mjs") $target
        if ($LASTEXITCODE -ne 0) { $allOk = $false }
    }

    if ($allOk) {
        Write-Host ("Build complete: dist/" + $distName + "/") -ForegroundColor Green
    }
}

# Version gate again: dist copies of plugin.json must match the sources -
# catches a stale or half-written platform folder from an interrupted run.
if (-not (Test-AppVersion -Root $root -DistRoot $distRoot -Platforms $platforms)) {
    $allOk = $false
}

# Alias-rewrite safety gate. Runs last because it audits the whole dist tree
# plus the build chain itself, and it bundles its own fixture - so it needs the
# platforms already emitted and the esbuild binary already resolved.
Write-Host "Checking #core/ alias rewrite safety ..." -ForegroundColor Cyan
if (-not (Test-AliasRewriteSafety -Root $root -DistRoot $distRoot -EsbuildExe $esbuildExe)) {
    $allOk = $false
}

if (-not $allOk) {
    Write-Host "Build failed!" -ForegroundColor Red
    exit 1
}

Write-Host "Build succeeded." -ForegroundColor Green
