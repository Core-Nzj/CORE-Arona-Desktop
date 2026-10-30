# Install the FRAME Issue #4 smoke-test plugin into the current user's
# personal ChatGPT desktop marketplace. No admin rights or network required.
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$source = Join-Path $root 'plugins\frame-mcp-test'
$destination = Join-Path $HOME '.codex\plugins\frame-mcp-test'
$marketplaceFile = Join-Path $HOME '.agents\plugins\marketplace.json'

if (-not (Test-Path (Join-Path $source 'plugin.json'))) {
  throw 'FRAME MCP Test plugin not found. Run this script from the Issue #4 repository branch.'
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js not on PATH. Install Node.js 22.12+ (Node.js 24 recommended) before continuing.'
}
New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $marketplaceFile) | Out-Null

# Only the test plugin is replaced. Other locally installed plugins are untouched.
if (Test-Path $destination) {
  Remove-Item -LiteralPath $destination -Recurse -Force
}
Copy-Item -LiteralPath $source -Destination $destination -Recurse

if (Test-Path $marketplaceFile) {
  $marketplace = Get-Content -LiteralPath $marketplaceFile -Raw | ConvertFrom-Json
  Copy-Item -LiteralPath $marketplaceFile -Destination ($marketplaceFile + '.bak') -Force
} else {
  $marketplace = [pscustomobject]@{
    name = 'frame-local'
    interface = @{ displayName = 'FRAME Local Plugins' }
    plugins = @()
  }
}
if (-not $marketplace.PSObject.Properties['plugins']) {
  $marketplace | Add-Member -MemberType NoteProperty -Name plugins -Value @()
}
$entry = [pscustomobject]@{
  name = 'frame-mcp-test'
  source = @{ source = 'local'; path = './.codex/plugins/frame-mcp-test' }
  policy = @{ installation = 'AVAILABLE'; authentication = 'ON_INSTALL' }
  category = 'Productivity'
}
$other = @($marketplace.plugins | Where-Object { $_.name -ne 'frame-mcp-test' })
$marketplace.plugins = @($other) + @($entry)
$json = $marketplace | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($marketplaceFile, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))

Write-Host 'FRAME MCP Test installed to personal marketplace.' -ForegroundColor Green
Write-Host ('Marketplace: ' + $marketplaceFile)
Write-Host 'Fully restart ChatGPT Windows, open Plugins, and search for FRAME MCP Test.'
Write-Host 'Do not use Work or Codex for this ordinary Chat verification.'
