# verify-alias-rewrite.ps1 - #core/ alias rewrite safety gate (called by build.ps1)
#
# Background (actually happened, not hypothetical):
#   The old build rewrote the alias with an unbounded plain-text replacement:
#     $newContent = $content.Replace("#core/", ($prefix + "core/src/"))
#   It did not distinguish code / string / comment / URL context, so the JSDoc
#   example at the top of core/src/preloadHelpers.js (renamed to .cjs after the
#   esbuild migration: a CJS helper inside a type:module package must carry the
#   .cjs extension - Node's own rule, quoted from esbuild's warning text)
#     } = require('#core/preloadHelpers.js');
#   came out in dist as
#     } = require('../../core/src/preloadHelpers.js');
#   The check of that era only scanned for leftover "#core/", and a munged line
#   no longer contains "#core/" - so this class of corruption was completely
#   invisible to the build, which still printed Build complete and exited 0.
#
# Now: after the esbuild migration the build no longer rewrites paths (#core/
# is resolved natively by esbuild) and Update-ImportPaths is retired. This gate
# pins that down and adds the reverse direction the old check was missing:
#   - forward (old): no unresolved #core/ may remain in the output
#   - reverse (new): no rewritten-into-relative-path trace may appear;
#                    no unbounded alias text replacement may exist in the build;
#                    #core/ string literals must survive bundling verbatim
# So alias-rewrite corruption must fail the build instead of passing silently.
#
# It also self-verifies by mutation: a gate that stays green when the fix is
# deleted protects nothing (this repo has been burned by that before).

$script:RewriteFingerprintPattern = '(?:\.\./)+core/src/'
$script:UnresolvedAliasPattern = '#core/'
$script:BlindReplacePattern = '\.Replace\("#core/"'

# --- detectors (pure functions, so the mutation self-check can call them) ---

function Test-RewriteFingerprint {
    param([string]$Text)
    return ($Text -match $script:RewriteFingerprintPattern)
}

function Test-BlindAliasReplace {
    param([string]$Text)
    return ($Text -match $script:BlindReplacePattern)
}

# --- gate ---

function Test-AliasRewriteSafety {
    param(
        [string]$Root,
        [string]$DistRoot,
        [string]$EsbuildExe
    )

    # $ok/$failed live in the enclosing function scope. Using $script: here would
    # silently decouple them from the returned value - a gate that can never fail
    # is exactly the failure mode this file exists to prevent.
    $ok = $true
    $failed = 0

    $check = {
        param([string]$Name, [bool]$Pass, [string]$Detail = '')
        if ($Pass) {
            Write-Host ('  OK   ' + $Name)
        } else {
            $script:GateFailed = $script:GateFailed + 1
            $script:GateOk = $false
            Write-Host ('  FAIL ' + $Name + $(if ($Detail) { ' - ' + $Detail } else { '' })) -ForegroundColor Red
        }
    }
    $script:GateOk = $true
    $script:GateFailed = 0

    # 1. No unbounded alias text replacement anywhere in the build chain.
    #    scripts/prepare-build.mjs does rewrite HTML href/src, but its patterns
    #    are anchored to <link rel="stylesheet" href="..."> and <script src="...">
    #    and it self-asserts the rewrite happened - not what this bans.
    $buildScript = Join-Path $Root 'build.ps1'
    if (Test-Path $buildScript) {
        $buildText = [System.IO.File]::ReadAllText($buildScript)
        & $check 'build.ps1 has no unbounded #core/ text replacement' (-not (Test-BlindAliasReplace $buildText)) ''
        & $check 'build.ps1 no longer defines Update-ImportPaths' (-not ($buildText -match 'function Update-ImportPaths')) ''
    } else {
        & $check 'build.ps1 exists' $false ''
    }

    # 2. Scan the artifacts: both directions must be clean.
    $distFiles = @()
    foreach ($platform in @('uTools', 'zTools', 'web')) {
        $dir = Join-Path $DistRoot $platform
        if (-not (Test-Path $dir)) { continue }
        $distFiles += Get-ChildItem $dir -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { @('.js', '.mjs', '.cjs', '.html', '.css') -contains $_.Extension }
    }

    if ($distFiles.Count -eq 0) {
        & $check 'dist artifacts exist' $false 'nothing to verify under dist'
    } else {
        $fingerprinted = @()
        $unresolved = @()
        foreach ($file in $distFiles) {
            try { $text = [System.IO.File]::ReadAllText($file.FullName) } catch { continue }
            if (Test-RewriteFingerprint $text) { $fingerprinted += $file.FullName }
            if ($text.Contains($script:UnresolvedAliasPattern)) { $unresolved += $file.FullName }
        }
        & $check ('no rewritten-into-relative-path trace in output (' + $distFiles.Count + ' files)') ($fingerprinted.Count -eq 0) ($fingerprinted -join ', ')
        & $check 'no unresolved #core/ alias in output' ($unresolved.Count -eq 0) ($unresolved -join ', ')

        # 3. No copied core/src source tree in dist - that tree was the shape that
        #    made path rewriting necessary at all. The bundles replace it.
        $copied = @()
        foreach ($platform in @('uTools', 'zTools', 'web')) {
            $tree = Join-Path $DistRoot ($platform + '\core\src')
            if (Test-Path $tree) { $copied += ($platform + '/core/src') }
        }
        & $check 'no copied core/src tree in dist (bundles need no path rewrite)' ($copied.Count -eq 0) ($copied -join ', ')
    }

    # 4. Behavioural check: bundle a file that carries #core/ literals and assert
    #    they survive verbatim - the standing form of "a file containing a
    #    #core/ string must not be mangled by the build".
    #    Note esbuild strips plain comments by default, so the historical
    #    "comment got mangled" corruption cannot occur at all (the comment never
    #    reaches the output); what can be silently polluted is a string literal,
    #    hence string / URL / template-literal contexts are the assertion targets.
    # The fixture must live inside the repo: esbuild resolves #core/* through
    # the nearest package.json "imports", and only the repo root declares it.
    # It goes at the repo root because that is the directory the build can
    # actually write to here (some subdirs carry restrictive ACLs), and it is
    # removed again in the finally block - never committed.
    $fixtureDir = $Root
    $stamp = [guid]::NewGuid().ToString('N')
    $fixture = Join-Path $fixtureDir ('alias-rewrite-fixture-' + $stamp + '.js')
    $bundle = Join-Path $fixtureDir ('alias-rewrite-fixture-' + $stamp + '.bundle.js')
    $literals = @(
        'literal string mentioning #core/preloadHelpers.js',
        'https://example.com/#core/thing',
        "} = require('#core/preloadHelpers.js');"
    )

    $fixtureLines = @(
        '/**',
        ' * Alias rewrite regression fixture: if any #core/ literal below were',
        ' * rewritten by an unbounded replacement, this gate must fail.',
        ' */',
        "export const note = 'literal string mentioning #core/preloadHelpers.js';",
        "export const url = 'https://example.com/#core/thing';",
        'export const doc = `} = require(''#core/preloadHelpers.js'');`;',
        "import eventBus from '#core/EventBus.js';",
        'export const bus = eventBus;',
        ''
    )

    try {
        [System.IO.File]::WriteAllText($fixture, ($fixtureLines -join "`n"), (New-Object System.Text.UTF8Encoding($false)))

        & $EsbuildExe $fixture --bundle "--outfile=$bundle" --format=esm --platform=browser --charset=utf8 --log-level=error 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            & $check 'fixture bundles successfully' $false ('esbuild exit ' + $LASTEXITCODE)
        } else {
            $bundleText = [System.IO.File]::ReadAllText($bundle)
            foreach ($literal in $literals) {
                & $check ('#core/ literal survives verbatim: ' + $literal) $bundleText.Contains($literal) ''
            }
            # The same fixture must prove the alias itself still resolves -
            # "do not rewrite" must not quietly become "do not resolve".
            $eventBusSrc = [System.IO.File]::ReadAllText((Join-Path $Root 'core\src\EventBus.js'), (New-Object System.Text.UTF8Encoding($false)))
            $eventBusMarker = ([regex]::Match($eventBusSrc, "_idCounter\s*=\s*\d")).Value
            & $check 'real #core/ import still resolves (alias works)' ($bundleText.Contains($eventBusMarker)) ''
            & $check 'fixture bundle has no rewrite trace' (-not (Test-RewriteFingerprint $bundleText)) ''
        }
    } catch {
        & $check 'fixture bundle and assertions ran' $false $_.Exception.Message
    } finally {
        foreach ($scratch in @($fixture, $bundle)) {
            if ($scratch -and (Test-Path $scratch)) {
                Remove-Item $scratch -Force -ErrorAction SilentlyContinue
            }
        }
    }

    # 5. Mutation self-check: the detectors must be falsifiable.
    $cleanSample = "const x = require('#core/preloadHelpers.js');"
    $corruptSample = "const x = require('../../core/src/preloadHelpers.js');"
    & $check 'mutation: clean sample does not trip the rewrite detector' (-not (Test-RewriteFingerprint $cleanSample)) ''
    & $check 'mutation: corrupted sample must trip the rewrite detector' (Test-RewriteFingerprint $corruptSample) ''

    $blindSample = '$newContent = $content.Replace("#core/", ($prefix + "core/src/"))'
    $anchoredSample = 'html = html.replace(/<link rel="stylesheet" href="#core\/style\.css">/, ...)'
    & $check 'mutation: unbounded replacement sample must trip the replacement detector' (Test-BlindAliasReplace $blindSample) ''
    & $check 'mutation: HTML-attribute-anchored rewrite is not flagged as unbounded' (-not (Test-BlindAliasReplace $anchoredSample)) ''

    $ok = $script:GateOk
    $failed = $script:GateFailed
    Remove-Variable -Name GateOk -Scope Script -ErrorAction SilentlyContinue
    Remove-Variable -Name GateFailed -Scope Script -ErrorAction SilentlyContinue

    if (-not $ok) {
        Write-Host ('Alias rewrite safety gate failed: ' + $failed + ' check(s)') -ForegroundColor Red
    }
    return $ok
}
