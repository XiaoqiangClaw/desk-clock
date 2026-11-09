# Desk Clock · 预置 Windows 打包工具（WiX 3.14 / NSIS 3.13）
#
# 背景：Tauri 打 MSI / setup.exe 时会临时从 GitHub Release 下载 WiX 与 NSIS
# 工具包；CI runner 上偶发 `http status: 504`，会在 Rust 编译成功后仍把整个
# Windows job 判失败。这里提前用普通 GET 下载并展开到 Tauri 期望的缓存目录
# （$env:LOCALAPPDATA\tauri\），必需文件齐全时 bundler 直接复用、不再联网。
#
# 目录布局与必需文件清单来自 tauri-bundler 源码：
#   crates/tauri-bundler/src/bundle/windows/msi/mod.rs  (WixTools314)
#   crates/tauri-bundler/src/bundle/windows/nsis/mod.rs (NSIS)
# 用法：CI 里 `pwsh -File scripts/prepare-windows-tools.ps1`
$ErrorActionPreference = 'Stop'

$root = Join-Path $env:LOCALAPPDATA 'tauri'
New-Item -ItemType Directory -Force -Path $root | Out-Null

function Get-ToolFile {
    param([string]$Url, [string]$Out, [int]$MinBytes)
    for ($i = 1; $i -le 5; $i++) {
        try {
            Write-Host "GET $Url (attempt $i)"
            Invoke-WebRequest -Uri $Url -OutFile $Out -UseBasicParsing -TimeoutSec 300 `
                -Headers @{ 'User-Agent' = 'DeskClock-CI' }
            if ((Get-Item $Out).Length -ge $MinBytes) { return $true }
        } catch {
            Write-Host "  failed: $_"
        }
        Start-Sleep -Seconds (4 * $i)
    }
    return $false
}

function Test-Files {
    param([string]$Dir, [string[]]$Names)
    if (-not (Test-Path $Dir)) { return $false }
    foreach ($f in $Names) {
        if (-not (Test-Path (Join-Path $Dir $f))) { return $false }
    }
    return $true
}

# ---------------------------------------------------------------- WiX (MSI)
$wixDir = Join-Path $root 'WixTools314'
$wixReq = @(
    'candle.exe', 'candle.exe.config', 'darice.cub', 'light.exe',
    'light.exe.config', 'wconsole.dll', 'winterop.dll', 'wix.dll',
    'WixUIExtension.dll', 'WixUtilExtension.dll'
)
if (-not (Test-Files $wixDir $wixReq)) {
    $zip = Join-Path $env:TEMP 'wix314.zip'
    $url = 'https://github.com/wixtoolset/wix3/releases/download/wix3141rtm/wix314-binaries.zip'
    if (-not (Get-ToolFile $url $zip 1000000)) { throw 'WiX download failed' }
    Remove-Item -Recurse -Force $wixDir -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $wixDir | Out-Null
    Expand-Archive -Path $zip -DestinationPath $wixDir -Force
    if (-not (Test-Files $wixDir $wixReq)) { throw 'WiX tools incomplete after extraction' }
    Write-Host "WiX sha256: $((Get-FileHash $zip).Hash)"
}
Write-Host 'WiX ready'

# ----------------------------------------------------------- NSIS (setup.exe)
$nsisDir = Join-Path $root 'NSIS'
$nsisReq = @(
    'makensis.exe', 'Bin/makensis.exe',
    'Stubs/lzma-x86-unicode', 'Stubs/lzma_solid-x86-unicode',
    'Plugins/x86-unicode/additional/nsis_tauri_utils.dll',
    'Include/MUI2.nsh', 'Include/FileFunc.nsh', 'Include/x64.nsh',
    'Include/nsDialogs.nsh', 'Include/WinMessages.nsh',
    'Include/Win/COM.nsh', 'Include/Win/Propkey.nsh',
    'Include/Win/RestartManager.nsh'
)
if (-not (Test-Files $nsisDir $nsisReq)) {
    $nz = Join-Path $env:TEMP 'nsis-3.13.zip'
    $url = 'https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.13/nsis-3.13.zip'
    if (-not (Get-ToolFile $url $nz 1000000)) { throw 'NSIS download failed' }
    Remove-Item -Recurse -Force (Join-Path $root 'nsis-3.13') -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $nsisDir -ErrorAction SilentlyContinue
    Expand-Archive -Path $nz -DestinationPath $root -Force
    if (Test-Path (Join-Path $root 'nsis-3.13')) {
        Rename-Item -Path (Join-Path $root 'nsis-3.13') -NewName 'NSIS'
    }
    # tauri 插件 dll 单独发布，需补放；SHA1 由 bundler 自行校验。
    $plugin = Join-Path $nsisDir 'Plugins/x86-unicode/additional/nsis_tauri_utils.dll'
    if (-not (Test-Path $plugin)) {
        New-Item -ItemType Directory -Force -Path (Split-Path $plugin) | Out-Null
        $purl = 'https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll'
        if (-not (Get-ToolFile $purl $plugin 30000)) { throw 'nsis_tauri_utils.dll download failed' }
    }
    if (-not (Test-Files $nsisDir $nsisReq)) { throw 'NSIS tools incomplete after extraction' }
}
Write-Host 'NSIS ready'
