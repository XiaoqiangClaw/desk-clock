# Desk Clock 开机自启 · 诊断与一键修复（Windows）
# 用法：双击同目录的 fix-autostart.cmd（不要直接右键运行本文件）
# 只改「当前用户」的启动项，不需要管理员；如提示 HKLM 写入失败，属正常。

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$report = New-Object System.Collections.Generic.List[string]
function Say([string]$s) { $script:report.Add($s); Write-Host $s }

$name      = 'Desk Clock'
$runKeys   = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Run', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run')
$saPaths   = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run')
$acPath    = 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers'
$matchName = 'desk[-_ ]?clock'

Say '=================================================='
Say '  Desk Clock 开机自启 · 诊断与一键修复'
Say '=================================================='
Say ('时间: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Say ('用户: ' + $env:USERDOMAIN + '\' + $env:USERNAME + '   管理员: ' + $isAdmin)
Say ('系统: ' + [Environment]::OSVersion.VersionString)
Say ''

# ---------------- 1. 定位程序 ----------------
Say '[1/6] 定位 desk-clock.exe ...'
$exe = $null
Get-Process -Name 'desk-clock' -ErrorAction SilentlyContinue | ForEach-Object {
    if (-not $exe -and $_.Path) { $exe = $_.Path }
}
if (-not $exe) {
    $cands = @()
    if ($env:LOCALAPPDATA) { $cands += (Join-Path $env:LOCALAPPDATA 'Desk Clock\desk-clock.exe') }
    if ($env:ProgramFiles) { $cands += (Join-Path $env:ProgramFiles 'Desk Clock\desk-clock.exe') }
    if (${env:ProgramFiles(x86)}) { $cands += (Join-Path ${env:ProgramFiles(x86)} 'Desk Clock\desk-clock.exe') }
    foreach ($c in $cands) { if (Test-Path -LiteralPath $c) { $exe = $c; break } }
}
if (-not $exe) {
    $uninsDirs = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )
    foreach ($dir in $uninsDirs) {
        if (-not (Test-Path $dir)) { continue }
        Get-ChildItem $dir -ErrorAction SilentlyContinue | ForEach-Object {
            if ($exe) { return }
            $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
            if (-not $p -or -not $p.DisplayName) { return }
            if ($p.DisplayName -notmatch 'Desk\s*Clock') { return }
            if ($p.InstallLocation) {
                $t = Join-Path $p.InstallLocation 'desk-clock.exe'
                if (Test-Path -LiteralPath $t) { $script:exe = $t; return }
            }
            if ($p.DisplayIcon) {
                $t = ($p.DisplayIcon -replace ',\s*\d+$', '').Trim('"')
                if (Test-Path -LiteralPath $t) { $script:exe = $t; return }
            }
        }
    }
}
if ($exe) {
    Say ('    程序路径: ' + $exe)
    $fi = Get-Item -LiteralPath $exe -ErrorAction SilentlyContinue
    if ($fi) { Say ('    文件版本: ' + $fi.VersionInfo.FileVersion + '    修改时间: ' + $fi.LastWriteTime) }
} else {
    Say '    !! 没有找到 desk-clock.exe'
}
Say ''

# ---------------- 2. 读取现有启动项 ----------------
Say '[2/6] 现有注册表启动项 ...'
foreach ($rk in $runKeys) {
    Say ('--- ' + $rk)
    if (Test-Path $rk) {
        $k = Get-Item $rk
        $names = @($k.GetValueNames())
        if ($names.Count -eq 0) { Say '    (空)' }
        foreach ($n in $names) {
            Say ('    [' + $n + '] = ' + $k.GetValue($n))
        }
    } else {
        Say '    (键不存在)'
    }
}
Say ''

# ---------------- 3. 启动开关 / UAC 标记 ----------------
Say '[3/6] 「启动应用」开关 与 UAC 兼容标记 ...'
foreach ($sp in $saPaths) {
    Say ('--- ' + $sp)
    if (Test-Path $sp) {
        $k = Get-Item $sp
        $hit = $false
        foreach ($n in @($k.GetValueNames())) {
            if ($n -notmatch $matchName) { continue }
            $hit = $true
            $v = $k.GetValue($n)
            $hex = (@($v) | ForEach-Object { $_.ToString('X2') }) -join ' '
            $state = '已禁用(会导致登录不启动)'
            if ($v -and $v.Length -ge 1 -and ($v[0] -eq 2 -or $v[0] -eq 6)) { $state = '启用' }
            Say ('    [' + $n + '] ' + $hex + '  => ' + $state)
        }
        if (-not $hit) { Say '    (没有 desk-clock 相关记录 = 默认启用)' }
    } else {
        Say '    (键不存在)'
    }
}
Say ('--- ' + $acPath)
if (Test-Path $acPath) {
    $k = Get-Item $acPath
    $hit = $false
    foreach ($n in @($k.GetValueNames())) {
        if ($n -notmatch $matchName) { continue }
        $hit = $true
        Say ('    [' + $n + '] = ' + $k.GetValue($n))
    }
    if (-not $hit) { Say '    (没有 desk-clock 相关标记)' }
} else {
    Say '    (键不存在)'
}
Say ''

# ---------------- 4. 写入正确启动项 ----------------
if ($exe) {
    Say '[4/6] 写入正确的启动项（绝对路径 + 必带引号）...'
    $data = '"' + $exe + '" --startup'
    Say ('    目标: [' + $name + '] = ' + $data)
    foreach ($rk in $runKeys) {
        if (-not (Test-Path $rk)) { continue }
        try {
            $k = Get-Item $rk
            foreach ($n in @($k.GetValueNames())) {
                if ($n -match $matchName -and $n -ne $name) {
                    Remove-ItemProperty -Path $rk -Name $n -Force -ErrorAction Stop
                    Say ('    已删除错误/旧的启动项: ' + $rk + '  [' + $n + ']')
                }
            }
            New-ItemProperty -Path $rk -Name $name -Value $data -PropertyType String -Force -ErrorAction Stop | Out-Null
            $back = (Get-ItemProperty -Path $rk -Name $name -ErrorAction Stop).$name
            Say ('    写入并回读成功: ' + $back)
        } catch {
            Say ('    写入失败(该键通常需要管理员): ' + $rk + ' -> ' + $_.Exception.Message)
        }
    }
    Say ''
} else {
    Say '[4/6] 跳过写入：没有找到程序'
    Say ''
}

# ---------------- 5. 清掉禁用标记 / 阻止自启的 UAC 标记 ----------------
Say '[5/6] 清除「启动应用被禁用」与「以管理员身份启动」标记 ...'
$enabledBytes = [byte[]](2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
foreach ($sp in $saPaths) {
    if (-not (Test-Path $sp)) { continue }
    try {
        New-ItemProperty -Path $sp -Name $name -Value $enabledBytes -PropertyType Binary -Force -ErrorAction Stop | Out-Null
        Say ('    已设为启用: ' + $sp)
    } catch {
        Say ('    设置失败(该键通常需要管理员): ' + $sp + ' -> ' + $_.Exception.Message)
    }
}
try {
    if (Test-Path $acPath) {
        $k = Get-Item $acPath
        foreach ($n in @($k.GetValueNames())) {
            if ($n -notmatch $matchName) { continue }
            $v = [string]$k.GetValue($n)
            if ($v -match 'RUNASADMIN') {
                Remove-ItemProperty -Path $acPath -Name $n -Force -ErrorAction Stop
                Say ('    已移除会阻止登录自启的「以管理员身份启动」标记: ' + $n)
            }
        }
    }
} catch {
    Say ('    清理 UAC 标记失败: ' + $_.Exception.Message)
}
Say ''

# ---------------- 6. 启动测试 ----------------
Say '[6/6] 启动测试（用和开机完全相同的命令拉起程序）...'
if ($exe) {
    try {
        Start-Process -FilePath $exe -ArgumentList '--startup' -ErrorAction Stop
        Start-Sleep -Seconds 4
        $proc = Get-Process -Name 'desk-clock' -ErrorAction SilentlyContinue
        if ($proc) {
            Say ('    启动测试成功：进程已运行 (PID ' + ($proc | Select-Object -First 1).Id + ')')
        } else {
            Say '    启动测试失败：命令没有把程序拉起来，可能是安全软件拦截或文件损坏'
        }
    } catch {
        Say ('    启动测试异常: ' + $_.Exception.Message)
    }
} else {
    Say '    跳过：没有找到程序'
}
Say ''

# ---------------- 报告 ----------------
$outDirs = @()
$desktop = [Environment]::GetFolderPath('Desktop')
if ($desktop) { $outDirs += $desktop }
if ($env:USERPROFILE) { $outDirs += (Join-Path $env:USERPROFILE 'Desktop') }
if ($env:TEMP) { $outDirs += $env:TEMP }
$outDirs += $PSScriptRoot

$out = $null
foreach ($d in $outDirs) {
    if (-not $d) { continue }
    try {
        if (-not (Test-Path -LiteralPath $d)) { continue }
        $cand = Join-Path $d 'DeskClock-autostart-report.txt'
        $report | Set-Content -LiteralPath $cand -Encoding UTF8 -ErrorAction Stop
        $out = $cand
        break
    } catch { }
}
if ($out) { Say ('诊断报告已保存: ' + $out) } else { Say '诊断报告保存失败（目录不可写）' }
Say '下一步：重启电脑看是否自动出现时钟；若仍不启动，把这个报告文件发回给我。'
Say ''
Say '按任意键关闭窗口 ...'
try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { }
