[CmdletBinding()]
param(
  [ValidateSet('', 'patch', 'minor', 'major')]
  [string]$Bump = '',
  [string]$Version = '',
  [switch]$AllowStable,
  [switch]$Force,
  [switch]$SkipTests,
  [switch]$AllowDirty,
  [switch]$HotfixOnly,
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

$tempFiles = @()
$phase = [System.Diagnostics.Stopwatch]::StartNew()
function Complete-Phase([string]$Name) {
  Write-Host ("{0} took {1:N1}s" -f $Name, $phase.Elapsed.TotalSeconds)
  $phase.Restart()
}

$previewVersionRe = '^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)$'
$strictSemverRe = '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$'

function Compare-SemVer([string]$A, [string]$B) {
  $pa = $A.Split('.') | ForEach-Object { [int]$_ }
  $pb = $B.Split('.') | ForEach-Object { [int]$_ }
  for ($i = 0; $i -lt 3; $i++) {
    if ($pa[$i] -lt $pb[$i]) { return -1 }
    if ($pa[$i] -gt $pb[$i]) { return 1 }
  }
  return 0
}

function Assert-ReleaseVersion([string]$Ver, [string]$ShellVer, [bool]$AllowStableRelease) {
  if ($AllowStableRelease) {
    if ($Ver -notmatch $strictSemverRe) {
      throw "Invalid version '$Ver'. Expected strict semver x.y.z."
    }
    if ($ShellVer -notmatch $strictSemverRe) {
      throw "Invalid shellVersion '$ShellVer'. Expected strict semver x.y.z."
    }
  } else {
    if ($Ver -notmatch $previewVersionRe) {
      throw "Public beta releases must use 0.x.y (got version '$Ver'). Pass -AllowStable only when intentionally promoting to 1.0.0+."
    }
    if ($ShellVer -notmatch $previewVersionRe) {
      throw "Public beta releases must use 0.x.y for shellVersion (got '$ShellVer'). Pass -AllowStable only when intentionally promoting to 1.0.0+."
    }
  }
  if ((Compare-SemVer $ShellVer $Ver) -gt 0) {
    throw "Invalid package.json versions: shellVersion ($ShellVer) cannot exceed version ($Ver)."
  }
}

function Resolve-TargetVersion([string]$CurrentVer, [string]$BumpKind, [string]$ExplicitVersion) {
  if ($BumpKind -and $ExplicitVersion) {
    throw 'Cannot specify both -Bump and -Version.'
  }
  if ($ExplicitVersion) {
    return $ExplicitVersion.Trim().TrimStart('v', 'V')
  }
  if ($BumpKind) {
    if ($CurrentVer -notmatch $strictSemverRe) {
      throw "Current package.json version '$CurrentVer' is not valid x.y.z semver."
    }
    $parts = $CurrentVer.Split('.') | ForEach-Object { [int]$_ }
    switch ($BumpKind) {
      'patch' { return "$($parts[0]).$($parts[1]).$($parts[2] + 1)" }
      'minor' { return "$($parts[0]).$($parts[1] + 1).0" }
      'major' { return "$($parts[0] + 1).0.0" }
    }
  }
  return $CurrentVer
}

try {
  foreach ($cmd in @('git', 'node', 'npm', 'gh')) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
      throw "Required command not found in PATH: $cmd"
    }
  }

  $curPkgJson = node -e "const p=require('./package.json'); console.log(JSON.stringify({version:String(p.version||'').trim(), shellVersion:String(p.shellVersion||p.version||'').trim()}))"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $curPkg = $curPkgJson | ConvertFrom-Json
  $plannedVer = Resolve-TargetVersion -CurrentVer $curPkg.version -BumpKind $Bump -ExplicitVersion $Version
  $plannedShellVer = if ($curPkg.shellVersion) { $curPkg.shellVersion } else { $plannedVer }
  Assert-ReleaseVersion -Ver $plannedVer -ShellVer $plannedShellVer -AllowStableRelease ([bool]$AllowStable)

  # 0. Inherit Windows system proxy for Go/gh CLI if HTTPS_PROXY is not already set
  if (-not $env:HTTPS_PROXY -and -not $env:HTTP_PROXY) {
    $inet = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
    if ($inet -and $inet.ProxyEnable -eq 1 -and $inet.ProxyServer) {
      $proxyVal = [string]$inet.ProxyServer
      if ($proxyVal -notmatch '://') { $proxyVal = "http://$proxyVal" }
      $env:HTTPS_PROXY = $proxyVal
      $env:HTTP_PROXY = $proxyVal
    }
  }

  # 1. Resolve GitHub token (prefer GH_TOKEN, fallback to Git Credential Manager without echoing secrets)
  if (-not $env:GH_TOKEN) {
    $credOut = (node -e "const{execFileSync}=require('child_process');process.stdout.write(execFileSync('git',['credential','fill'],{input:'protocol=https\nhost=github.com\n\n'}))")
    $pwLine = ($credOut -split "`r?`n") | Where-Object { $_ -like 'password=*' } | Select-Object -First 1
    if ($pwLine) {
      $env:GH_TOKEN = $pwLine.Substring('password='.Length)
    }
  }

  $ghUserOut = (gh api user --jq .login 2>&1)
  if ($LASTEXITCODE -ne 0 -or -not $ghUserOut) {
    $detail = ($ghUserOut | Out-String).Trim()
    throw "GitHub API/auth check failed: $detail`nCheck your network/proxy or run `"gh auth login`"."
  }
  $ghUser = ($ghUserOut | Select-Object -First 1).ToString().Trim()

  # 2. Resolve canonical GitHub repository (handles renamed repos like usefulTools -> MediaKiln)
  $originUrl = (git remote get-url origin).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $originUrl) { throw 'Failed to read git origin URL.' }
  if ($originUrl -match 'github\.com[:/]([^/]+/[^/.]+?)(?:\.git)?$') {
    $rawRepo = $Matches[1]
  } else {
    throw "Cannot parse GitHub repository from origin URL: $originUrl"
  }
  $repoOut = (gh repo view $rawRepo --json nameWithOwner --jq .nameWithOwner 2>&1)
  if ($LASTEXITCODE -ne 0 -or -not $repoOut) {
    $detail = ($repoOut | Out-String).Trim()
    throw "Failed to resolve GitHub repository ($rawRepo): $detail"
  }
  $repo = ($repoOut | Select-Object -First 1).ToString().Trim()

  # 3. Check git working tree
  $dirty = git status --porcelain
  if ($dirty -and -not $AllowDirty) {
    throw "Working tree has uncommitted changes. Commit or stash them first (or pass -AllowDirty)."
  }

  # 4. Optional version bump
  $verTarget = if ($Version) { $plannedVer } elseif ($Bump) { $Bump } else { '' }
  if ($verTarget) {
    if ($DryRun) {
      Write-Host "[DryRun] Would bump version via: npm version $verTarget --no-git-tag-version (target: v$plannedVer)"
    } else {
      npm version $verTarget --no-git-tag-version
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
      $bumpedVer = (node -p "require('./package.json').version").Trim()
      $filesToStage = @('package.json')
      if (Test-Path 'package-lock.json') { $filesToStage += 'package-lock.json' }
      git add $filesToStage
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
      git commit -m "chore: release v$bumpedVer"
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
  }

  # 5. Read package metadata
  $metaJson = node -e "const p=require('./package.json'); console.log(JSON.stringify({version:String(p.version||'').trim(), shellVersion:String(p.shellVersion||p.version||'').trim(), portable:(p.build&&p.build.portable&&p.build.portable.artifactName)||'', nsis:(p.build&&p.build.nsis&&p.build.nsis.artifactName)||''}))"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $meta = $metaJson | ConvertFrom-Json
  $ver = if ($DryRun -and $verTarget) { $plannedVer } else { $meta.version }
  $shellVer = if ($meta.shellVersion) { $meta.shellVersion } else { $ver }
  Assert-ReleaseVersion -Ver $ver -ShellVer $shellVer -AllowStableRelease ([bool]$AllowStable)
  $tag = "v$ver"
  $isPreview = $ver.StartsWith('0.')
  $releaseTitle = if ($isPreview) { "$tag (Beta)" } else { $tag }
  $previewArgs = @()
  if ($isPreview) { $previewArgs = @('--prerelease') }

  Write-Host "Repository : $repo (user: $ghUser)"
  Write-Host "Version    : $releaseTitle"

  # 6. Check if release already exists
  $releaseDraft = gh release view $tag --repo $repo --json isDraft --jq .isDraft 2>$null
  $releaseExists = ($LASTEXITCODE -eq 0)
  if ($releaseExists -and -not $Force) {
    Write-Host "Release $tag already exists on GitHub. Bump version (e.g. npm run release -- -Bump patch) or pass -Force to overwrite."
    exit 0
  }

  if ($DryRun) {
    $distLabel = if ($HotfixOnly) { "build-hotfix (HotfixOnly)" } else { "npm run dist + build-hotfix" }
    Write-Host "[DryRun] Ready to run: ensure-ffmpeg -> smoke-test -> $distLabel -> git push -> upload $tag to $repo (exists=$releaseExists, force=$Force)"
    exit 0
  }
  Complete-Phase 'Release preflight'

  # 7. Ensure FFmpeg binaries exist (needed for smoke tests and full dist)
  if (-not $HotfixOnly -or -not $SkipTests) {
    node scripts/ensure-ffmpeg.js
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }

  # 9. Run smoke tests
  if (-not $SkipTests) {
    Write-Host "Running smoke tests..."
    node scripts/smoke-test.js
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    if (Test-Path 'scripts/hotfix-test.js') {
      Write-Host "Running hotfix tests..."
      node scripts/hotfix-test.js
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
  }
  Complete-Phase 'Build and test prerequisites'

  # 10. Build hotfix bundle + optional Windows executables
  Write-Host "Building hotfix bundle..."
  node scripts/build-hotfix.js --repo $repo
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  $hotfixBundleName = "hotfix-bundle-$ver.zip"
  $hotfixBundlePath = Join-Path $repoRoot "release\$hotfixBundleName"
  $hotfixManifestPath = Join-Path $repoRoot "release\hotfix-manifest.json"
  if (-not (Test-Path $hotfixBundlePath)) { throw "Built hotfix bundle not found: $hotfixBundlePath" }
  if (-not (Test-Path $hotfixManifestPath)) { throw "Built hotfix manifest not found: $hotfixManifestPath" }
  Complete-Phase 'Hotfix bundle'

  $portableName = $meta.portable.Replace('${version}', $ver)
  $setupName = $meta.nsis.Replace('${version}', $ver)
  $portablePath = Join-Path $repoRoot "release\$portableName"
  $setupPath = Join-Path $repoRoot "release\$setupName"

  if (-not $HotfixOnly) {
    Write-Host "Building Windows executables (npm run dist)..."
    npm run dist
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    if (-not (Test-Path $portablePath)) { throw "Built portable exe not found: $portablePath" }
    if (-not (Test-Path $setupPath)) { throw "Built setup exe not found: $setupPath" }

    # Stage ASCII copies so GitHub does not normalize Chinese names into colliding asset filenames
    $portableStage = Join-Path $env:TEMP "video-gif-toolbox-$ver-portable.exe"
    $setupStage = Join-Path $env:TEMP "video-gif-toolbox-$ver-setup.exe"
    Copy-Item $portablePath $portableStage -Force
    Copy-Item $setupPath $setupStage -Force
    $tempFiles += $portableStage, $setupStage
    Complete-Phase 'Windows builds and staging'
  }

  Write-Host "Pushing commits to origin..."
  git push origin HEAD
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $headSha = (git rev-parse HEAD).Trim()
  Complete-Phase 'Git push'

  # Upload all required assets before publishing a new release
  if (-not $releaseExists) {
    Write-Host "Creating draft GitHub Release $tag..."
    gh release create $tag --repo $repo --target $headSha --title "$releaseTitle" --generate-notes --draft @previewArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  } else {
    Write-Host "Release $tag already exists; overwriting assets (-Force)..."
  }

  if (-not $HotfixOnly) {
    Write-Host "Uploading portable exe..."
    gh release upload $tag "${portableStage}#${portableName}" --repo $repo --clobber
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    Write-Host "Uploading setup exe..."
    gh release upload $tag "${setupStage}#${setupName}" --repo $repo --clobber
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }

  Write-Host "Uploading hotfix bundle ($hotfixBundleName)..."
  gh release upload $tag $hotfixBundlePath --repo $repo --clobber
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  Write-Host "Uploading hotfix manifest (hotfix-manifest.json)..."
  gh release upload $tag $hotfixManifestPath --repo $repo --clobber
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  $expected = @($hotfixBundlePath, $hotfixManifestPath)
  if (-not $HotfixOnly) { $expected += $portableStage, $setupStage }
  $assetsJson = (gh release view $tag --repo $repo --json assets)
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $assets = ($assetsJson | ConvertFrom-Json).assets
  foreach ($filePath in $expected) {
    $file = Get-Item -LiteralPath $filePath
    if (-not ($assets | Where-Object { $_.name -ceq $file.Name -and $_.size -eq $file.Length })) {
      throw "Release asset missing or wrong size: $($file.Name)"
    }
  }
  if (-not $releaseExists -or $releaseDraft -eq 'true') {
    gh release edit $tag --repo $repo --draft=false @previewArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  Complete-Phase 'Upload verification and publication'

  $releaseUrl = (gh release view $tag --repo $repo --json url --jq .url).Trim()
  Write-Host "Release published successfully: $releaseUrl"
} finally {
  foreach ($f in $tempFiles) {
    if ($f -and (Test-Path $f)) {
      Remove-Item $f -Force -ErrorAction SilentlyContinue
    }
  }
  Pop-Location
}
