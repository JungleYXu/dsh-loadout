<#
.SYNOPSIS
Install dsh-loadout into a DeepSeek Harness profile as a LINKED directory
(local development install, no npm and no dsh CLI needed).

.DESCRIPTION
1. links <profile>\node_modules\dsh-loadout -> this folder (a junction, so no
   administrator rights are needed and edits never go stale)
2. adds it to the profile package.json: "dependencies" + "dsh.profile.bundles"
3. backs the old package.json up to package.json.bak

WHY A LINK AND NOT A COPY: a copied node_modules snapshot is frozen. Edit
client.js afterwards, restart, and the app still boots the old bundle. If that
old bundle registers a factory id that no longer matches the package name, the
Web boot re-executes it, the second registration throws "duplicate factory
registration", and the whole application refuses to start. With -Copy you get
that snapshot back, so the script warns about it and the preflight check fails.

Restart DeepSeek Harness afterwards (host plugins have no hot reload), then open
Settings -> Loadout.

Keep this file ASCII-only: Windows PowerShell 5.1 reads .ps1 as ANSI.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Profile other-profile
#>
param(
  [string]$Profile = 'desktop',
  [string]$Source = (Split-Path -Parent $PSScriptRoot),
  [switch]$Copy
)

$ErrorActionPreference = 'Stop'
$packageName = 'dsh-loadout'

if (-not (Test-Path (Join-Path $Source 'package.json'))) {
  throw "Source folder does not look like the plugin: $Source"
}
$Source = (Resolve-Path $Source).Path

# ---- 0. refuse to install a bundle that would fail the Web boot --------------
# The factory id must equal the package name, or the boot graph looks it up under
# the package name, misses it, and runs the bundle twice until it throws.
$clientPath = Join-Path $Source 'client.js'
if (-not (Test-Path $clientPath)) { throw "client.js is missing from $Source" }
$client = Get-Content $clientPath -Raw
if ($client -notmatch "__ModuleLoader__\.load\(\{\s*\r?\n?\s*id:\s*'([^']+)'") {
  throw "client.js has no window.__ModuleLoader__.load({ id: '...', factory }) call"
}
$factoryId = $Matches[1]
if ($factoryId -ne $packageName) {
  throw "client.js registers id '$factoryId' but the package name is '$packageName'. The Web boot would re-execute the bundle and crash with 'duplicate factory registration'. Fix the id before installing."
}

$profileDir = Join-Path (Join-Path $env:USERPROFILE '.dsh\profiles') $Profile
if (-not (Test-Path $profileDir)) { throw "Profile not found: $profileDir" }

$manifestPath = Join-Path $profileDir 'package.json'
$targetDir = Join-Path $profileDir 'node_modules'
$target = Join-Path $targetDir $packageName
if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }

# ---- 1. place the bundle ----------------------------------------------------
# Clear whatever is there: an old copy, an old link, or a half-written folder.
if (Test-Path $target) {
  $item = Get-Item $target -Force
  if ($item.LinkType -or $item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    # A junction/directory link: delete the link, never the folder it points at.
    [System.IO.Directory]::Delete($target, $false)
  } else {
    Remove-Item $target -Recurse -Force
  }
}
if ($Copy) {
  New-Item -ItemType Directory -Path $target -Force | Out-Null
  foreach ($entry in 'index.js', 'client.js', 'cordis.patch.yml', 'package.json', 'icon.svg', 'LICENSE', 'README.md') {
    Copy-Item (Join-Path $Source $entry) (Join-Path $target $entry) -Force
  }
  foreach ($dir in 'locale') {
    $from = Join-Path $Source $dir
    if (Test-Path $from) { Copy-Item $from (Join-Path $target $dir) -Recurse -Force }
  }
  Write-Warning "copied -> $target (a snapshot: this copy will go stale on the next edit; the default link install does not)"
} else {
  New-Item -ItemType Junction -Path $target -Target $Source | Out-Null
  Write-Host "linked -> $target => $Source"
}

# ---- 2. register the bundle -------------------------------------------------
Copy-Item $manifestPath (Join-Path $profileDir 'package.json.bak') -Force
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json

$spec = 'file:' + ($Source -replace '\\', '/')
if ($null -eq $manifest.dependencies) {
  $manifest | Add-Member -MemberType NoteProperty -Name dependencies -Value (New-Object psobject) -Force
}
$manifest.dependencies | Add-Member -MemberType NoteProperty -Name $packageName -Value $spec -Force

if ($null -eq $manifest.dsh) {
  $manifest | Add-Member -MemberType NoteProperty -Name dsh -Value (New-Object psobject) -Force
}
if ($null -eq $manifest.dsh.profile) {
  $manifest.dsh | Add-Member -MemberType NoteProperty -Name profile -Value (New-Object psobject) -Force
}
$bundles = @($manifest.dsh.profile.bundles)
if ($bundles -notcontains $packageName) { $bundles += $packageName }
$manifest.dsh.profile | Add-Member -MemberType NoteProperty -Name bundles -Value $bundles -Force

# Write without a BOM. The Host parses this manifest with a bare JSON.parse,
# which rejects a leading U+FEFF, and an install-time BOM once kept the whole
# app from booting ("Unexpected token '', ... is not valid JSON").
$json = $manifest | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText($manifestPath, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
$check = [System.IO.File]::ReadAllBytes($manifestPath)
if ($check.Length -ge 3 -and $check[0] -eq 0xEF -and $check[1] -eq 0xBB -and $check[2] -eq 0xBF) {
  throw "profile manifest still starts with a BOM: $manifestPath"
}
Write-Host "registered $packageName in $manifestPath"

Write-Host ''
Write-Host 'Done. Restart DeepSeek Harness, then open: Settings -> Loadout'
