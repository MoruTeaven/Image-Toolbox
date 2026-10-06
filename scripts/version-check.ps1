# scripts/version-check.ps1
#
# App version consistency gate.
#
# Background: the app version used to be defined in several places at once
# (clients/*/plugin.json vs a hard-coded list in the in-app update records), so
# the uTools store showed 2.3.2 while the in-app About page showed a long-dead
# 1.2.3. The single source of truth is now APP_VERSION in core/src/changelog.js.
#
# Test-AppVersion compares every reference against it and fails the build on any
# mismatch, so a stale version can never ship.
#
# Version format: MAJOR.MINOR.PATCH, optionally with a SemVer pre-release tag
# (e.g. 2.5.1-dev) while a release has not been published yet. All references must
# carry the same tag, so cutting a release is one coordinated change that drops it.
#
# NOTE: keep this file free of non-ASCII punctuation inside comments - some
# Windows PowerShell hosts mis-decode it and report bogus parse errors.

function Test-AppVersion {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$DistRoot,
        [Parameter(Mandatory = $true)][array]$Platforms
    )

    $ok = $true

    $changelogPath = Join-Path $Root 'core\src\changelog.js'
    if (Test-Path $changelogPath) {
        $changelogSrc = [System.IO.File]::ReadAllText($changelogPath, [System.Text.Encoding]::UTF8)
    } else {
        Write-Host '  FAIL: missing core/src/changelog.js' -ForegroundColor Red
        return $false
    }

    $match = [regex]::Match($changelogSrc, "export\s+const\s+APP_VERSION\s*=\s*'([^']+)'")
    if ($match.Success) {
        $version = $match.Groups[1].Value
    } else {
        Write-Host '  FAIL: APP_VERSION not found in core/src/changelog.js' -ForegroundColor Red
        return $false
    }

    # 1. Per-platform plugin.json - the version the app stores publish.
    foreach ($platform in $Platforms) {
        $pluginPath = Join-Path $Root ('clients/' + $platform.Client + '/plugin.json')
        if (Test-Path $pluginPath) {
            $plugin = [System.IO.File]::ReadAllText($pluginPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
            if ($plugin.version -ne $version) {
                Write-Host ("  FAIL: clients/{0}/plugin.json is {1}, expected {2}" -f $platform.Client, $plugin.version, $version) -ForegroundColor Red
                $ok = $false
            }
        }
    }

    # 2. Root package.json version.
    $pkgPath = Join-Path $Root 'package.json'
    if (Test-Path $pkgPath) {
        $pkg = [System.IO.File]::ReadAllText($pkgPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        if ($pkg.version -ne $version) {
            Write-Host ("  FAIL: package.json is {0}, expected {1}" -f $pkg.version, $version) -ForegroundColor Red
            $ok = $false
        }
    }

    # 3. The newest changelog entry must be the current version.
    $latest = [regex]::Match($changelogSrc, "CHANGELOG\s*=\s*\[\s*\{\s*version:\s*'([^']+)'")
    if (-not $latest.Success) {
        Write-Host '  FAIL: cannot parse the newest CHANGELOG entry' -ForegroundColor Red
        $ok = $false
    } elseif ($latest.Groups[1].Value -ne $version) {
        Write-Host ("  FAIL: newest changelog entry is {0}, expected {1}" -f $latest.Groups[1].Value, $version) -ForegroundColor Red
        $ok = $false
    }

    # 4. Documentation that states the current version.
    $readmePath = Join-Path $Root 'README.md'
    if (Test-Path $readmePath) {
        $docSrc = [System.IO.File]::ReadAllText($readmePath, [System.Text.Encoding]::UTF8)
        $docMatch = [regex]::Match($docSrc, 'Current version|\u5f53\u524d\u7248\u672c')
        if ($docMatch.Success) {
            $verMatch = [regex]::Match($docSrc.Substring($docMatch.Index), 'v([0-9]+\.[0-9]+(?:\.[0-9]+)?(?:-[0-9A-Za-z.-]+)?)')
            if ($verMatch.Success -and $verMatch.Groups[1].Value -ne $version) {
                Write-Host ("  FAIL: README.md declares {0}, expected {1}" -f $verMatch.Groups[1].Value, $version) -ForegroundColor Red
                $ok = $false
            }
        }
    }

    # 5. Built plugin.json must match - catches a stale dist from an older run.
    foreach ($platform in $Platforms) {
        $distPlugin = Join-Path $DistRoot ($platform.Dist + '\plugin.json')
        if (Test-Path $distPlugin) {
            $distJson = [System.IO.File]::ReadAllText($distPlugin, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
            if ($distJson.version -ne $version) {
                Write-Host ("  FAIL: dist/{0}/plugin.json is {1}, expected {2}" -f $platform.Dist, $distJson.version, $version) -ForegroundColor Red
                $ok = $false
            }
        }
    }

    if ($ok) {
        Write-Host ("Version check passed: " + $version) -ForegroundColor Green
    } else {
        Write-Host ("       authoritative version is APP_VERSION in core/src/changelog.js: " + $version) -ForegroundColor Yellow
        Write-Host '       release checklist is in the header comment of that file' -ForegroundColor Yellow
    }

    return $ok
}
