# Desk Clock 开机自启 · 诊断与一键修复（Windows 10/11）
#
# 用法（两种都行）：
#   A. 把本文件与 desk-clock.exe 放在同一目录，右键 fix-autostart.cmd → 以管理员身份运行（更稳）
#   B. 双击 fix-autostart.cmd（普通权限即可，只改当前用户）
#
# 它会做 6 件事：
#   1. 定位 desk-clock.exe（优先：本目录 → 运行中的进程 → 标准安装目录 → 卸载注册表）
#   2. 打印 HKCU/HKLM Run 里所有 desk-clock 相关条目（原始内容 + 是否带引号 + 目标是否存在）
#   3. 打印 StartupApproved「启动应用已禁用」字节 与 UAC RUNASADMIN 标记
#   4. 打印 startup.log（Windows 到底有没有在登录时拉起过程序）
#   5. 修复：写入「带引号的当前 exe 绝对路径」到当前用户 Run、删除历史错值名、清禁用字节、去掉 RUNASADMIN
#   6. 自检：用与开机完全相同的命令拉起程序，确认进程真的起来
# 报告保存在桌面：DeskClock-autostart-report.txt

$ErrorActionPreference = 'Continue'
# UTF-8 console so Chinese output renders correctly in cmd/Windows Terminal.
try { chcp 65001 > $null; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$ProgressPreference = 'SilentlyContinue'

$report = New-Object System.Collections.Generic.List[string]
function Say([string]$s) { $script:report.Add($s); Write-Host $s }

$name       = 'Desk Clock'
$legacyName = 'desk-clock'
$runKeys    = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Run','HKLM:\Software\Microsoft\Windows\CurrentVersion\Run')
$saPaths    = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run','HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run')
$acPath     = 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers'
$matchName  = 'desk[-_ ]?clock'

Say '=============================================================='
Say '  Desk Clock 开机自启 · 诊断与一键修复'
Say '=============================================================='
Say ('时间: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $env:DC_ELEVATED) {
  # Not admin: re-launch ourselves elevated (one level only, guarded by env var).
  try {
    $env:DC_ELEVATED = '1'
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -WorkingDirectory $PSScriptRoot -ArgumentList @(
      '-NoProfile','-ExecutionPolicy','Bypass','-File', ('"' + $PSScriptRoot + '\fix-deskclock-autostart.ps1"')
    ) -Wait
    exit 0
  } catch {
    Say ''
    Say '    (没有提权成功，继续以普通权限运行 —— 只影响 HKLM 那部分写入，HKCU 自启照常修好)'
  }
}
Say ('用户: ' + $env:USERDOMAIN + '\' + $env:USERNAME + '   管理员权限: ' + $isAdmin)
Say ('系统: ' + [Environment]::OSVersion.VersionString)
Say ''

# ---------------- 1. 定位程序 ----------------
Say '[1/7] 定位 desk-clock.exe ...'
$exe = $null
$exeSource = ''

# 1a. 与本工具同目录（最可靠：主人把工具放在程序旁边跑）
if (-not $exe) {
    $cand = Join-Path $PSScriptRoot 'desk-clock.exe'
    if (Test-Path -LiteralPath $cand) { $exe = $cand; $exeSource = '本目录' }
}
# 1b. 运行中的进程
if (-not $exe) {
    Get-Process -Name 'desk-clock' -ErrorAction SilentlyContinue | ForEach-Object {
        if (-not $script:exe -and $_.Path) { $script:exe = $_.Path; $script:exeSource = '运行中的进程' }
    }
}
# 1c. 标准安装目录
if (-not $exe) {
    $cands = @()
    if ($env:LOCALAPPDATA) { $cands += (Join-Path $env:LOCALAPPDATA 'Desk Clock\desk-clock.exe') }
    if ($env:LOCALAPPDATA) { $cands += (Join-Path $env:LOCALAPPDATA 'Programs\Desk Clock\desk-clock.exe') }
    if ($env:ProgramFiles) { $cands += (Join-Path $env:ProgramFiles 'Desk Clock\desk-clock.exe') }
    if (${env:ProgramFiles(x86)}) { $cands += (Join-Path ${env:ProgramFiles(x86)} 'Desk Clock\desk-clock.exe') }
    foreach ($c in $cands) { if (Test-Path -LiteralPath $c) { $exe = $c; $exeSource = '标准安装目录'; break } }
}
# 1d. 卸载注册表
if (-not $exe) {
    $uninsDirs = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )
    foreach ($dir in $uninsDirs) {
        if ($exe) { break }
        if (-not (Test-Path $dir)) { continue }
        Get-ChildItem $dir -ErrorAction SilentlyContinue | ForEach-Object {
            if ($script:exe) { return }
            $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
            if (-not $p -or -not $p.DisplayName) { return }
            if ($p.DisplayName -notmatch 'Desk\s*Clock') { return }
            if ($p.InstallLocation) {
                $t = Join-Path $p.InstallLocation 'desk-clock.exe'
                if (Test-Path -LiteralPath $t) { $script:exe = $t; $script:exeSource = '卸载注册表'; return }
            }
            if ($p.DisplayIcon) {
                $t = ($p.DisplayIcon -replace ',\s*\d+$', '').Trim('"')
                if (Test-Path -LiteralPath $t) { $script:exe = $t; $script:exeSource = '卸载注册表'; return }
            }
        }
    }
}
if ($exe) {
    Say ('    程序路径: ' + $exe + '   (来源: ' + $exeSource + ')')
    $fi = Get-Item -LiteralPath $exe -ErrorAction SilentlyContinue
    if ($fi) {
        Say ('    文件版本: ' + $fi.VersionInfo.FileVersion + '   大小: ' + [math]::Round($fi.Length/1KB,0) + ' KB   修改时间: ' + $fi.LastWriteTime)
    }
} else {
    Say '    !! 没找到 desk-clock.exe'
    # 交互式兜底：让主人直接粘贴 exe 路径（拖进来也行）
    try {
        $typed = Read-Host '    请粘贴 desk-clock.exe 的完整路径（直接回车跳过）'
        if ($typed) {
            $typed = $typed.Trim('"').Trim()
            if (Test-Path -LiteralPath $typed) {
                $exe = $typed; $exeSource = '手动输入'
                Say ('    已采用手动输入的路径: ' + $exe)
            } else {
                Say ('    !! 该路径不存在: ' + $typed)
            }
        }
    } catch { }
    if (-not $exe) {
        Say '       请把本工具和 desk-clock.exe 放在同一个文件夹里再运行（右键 fix-autostart.cmd → 以管理员身份运行）。'
    }
}
Say ''

# ---------------- 2. 现有启动项 ----------------
Say '[2/7] 注册表 Run 启动项（原始内容） ...'
foreach ($rk in $runKeys) {
    Say ('--- ' + $rk)
    if (-not (Test-Path $rk)) { Say '    (键不存在)'; continue }
    $k = Get-Item $rk
    $names = @($k.GetValueNames())
    if ($names.Count -eq 0) { Say '    (空)' }
    foreach ($n in $names) {
        $v = [string]$k.GetValue($n)
        $isOurs = ($n -match $matchName)
        if (-not $isOurs) { continue }
        Say ('    [' + $n + '] = ' + $v)
        $quoted = $v -match '"[^"]+\.exe"'
        Say ('        带引号: ' + $(if ($quoted) { '是' } else { '否  <== 不带引号且路径含空格 = 登录必失败' }))
        $exeInVal = ''
        if ($v -match '"?([^"]*?desk-clock\.exe)"?') { $exeInVal = $Matches[1] }
        if ($exeInVal) {
            Say ('        目标路径: ' + $exeInVal)
            Say ('        目标存在: ' + $(if (Test-Path -LiteralPath $exeInVal) { '是' } else { '否  <== 程序已被移动/删除 = 登录静默失败' }))
        }
    }
}
Say ''

# ---------------- 3. 启动开关 / UAC ----------------
Say '[3/7] 「启动应用」禁用标记 与 UAC 兼容层 ...'
foreach ($sp in $saPaths) {
    Say ('--- ' + $sp)
    if (-not (Test-Path $sp)) { Say '    (键不存在 = 默认启用)'; continue }
    $k = Get-Item $sp
    $hit = $false
    foreach ($n in @($k.GetValueNames())) {
        if ($n -notmatch $matchName) { continue }
        $hit = $true
        $v = $k.GetValue($n)
        $hex = (@($v) | ForEach-Object { $_.ToString('X2') }) -join ' '
        $state = '已禁用(登录时不启动)'
        if ($v -and $v.Length -ge 1 -and ($v[0] -eq 2 -or $v[0] -eq 6)) { $state = '启用' }
        Say ('    [' + $n + '] ' + $hex + '  => ' + $state)
    }
    if (-not $hit) { Say '    (没有 desk-clock 相关记录 = 默认启用)' }
}
Say ('--- ' + $acPath)
if (Test-Path $acPath) {
    $k = Get-Item $acPath
    $hit = $false
    foreach ($n in @($k.GetValueNames())) {
        if ($n -notmatch $matchName) { continue }
        $hit = $true
        $v = [string]$k.GetValue($n)
        Say ('    [' + $n + '] = ' + $v)
        if ($v -match 'RUNASADMIN') { Say '        <== 「以管理员身份启动」会在登录时卡住 UAC = 静默不启动' }
    }
    if (-not $hit) { Say '    (没有 desk-clock 相关标记)' }
} else { Say '    (键不存在)' }
Say ''

# ---------------- 4. startup.log ----------------
Say '[4/7] startup.log（Windows 到底有没有在登录时拉起过程序） ...'
$logCandidates = @(
    (Join-Path $env:APPDATA 'app.deskclock.desktop\startup.log'),
    (Join-Path $env:APPDATA 'Desk Clock\startup.log'),
    (Join-Path $env:APPDATA 'com.tauri.dev\startup.log')
)
$logFound = $false
foreach ($lc in $logCandidates) {
    if (-not $lc) { continue }
    if (Test-Path -LiteralPath $lc) {
        $logFound = $true
        Say ('    文件: ' + $lc)
        try {
            Get-Content -LiteralPath $lc -Tail 20 -ErrorAction Stop | ForEach-Object { Say ('      ' + $_) }
        } catch { Say ('      读取失败: ' + $_.Exception.Message) }
        Say '      (有 AUTOSTART 行 = Windows 确实在登录时拉起了程序；只有 MANUAL = 登录时从没被拉起)'
        break
    }
}
if (-not $logFound) {
    Say '    (没有找到 startup.log —— 程序从未启动过，或不是本 v0.7.7 版本)'
}
Say ''

# ---------------- 5. 修复 ----------------
if ($exe) {
    Say '[5/7] 写入正确的启动项（带引号的绝对路径 + --startup）...'
    $data = '"' + $exe + '" --startup'
    Say ('    目标: [' + $name + '] = ' + $data)
    foreach ($rk in $runKeys) {
        if (-not (Test-Path $rk)) { continue }
        try {
            $k = Get-Item $rk
            foreach ($n in @($k.GetValueNames())) {
                if ($n -match $matchName -and $n -ne $name) {
                    Remove-ItemProperty -Path $rk -Name $n -Force -ErrorAction Stop
                    Say ('    已删除错误/旧的启动项: [' + $n + ']  (' + $rk + ')')
                }
            }
            New-ItemProperty -Path $rk -Name $name -Value $data -PropertyType String -Force -ErrorAction Stop | Out-Null
            $back = (Get-ItemProperty -Path $rk -Name $name -ErrorAction Stop).$name
            Say ('    写入并回读成功: ' + $back)
        } catch {
            Say ('    写入失败(该键需要管理员): ' + $rk + ' -> ' + $_.Exception.Message)
        }
    }
    Say ''
    Say '[5b] 清除「启动应用被禁用」与「以管理员身份启动」标记 ...'
    $enabledBytes = [byte[]](2,0,0,0,0,0,0,0,0,0,0,0)
    foreach ($sp in $saPaths) {
        if (-not (Test-Path $sp)) { continue }
        try {
            New-ItemProperty -Path $sp -Name $name -Value $enabledBytes -PropertyType Binary -Force -ErrorAction Stop | Out-Null
            Say ('    已设为启用: ' + $sp)
        } catch {
            Say ('    设置失败(该键需要管理员): ' + $sp + ' -> ' + $_.Exception.Message)
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
    } catch { Say ('    清理 UAC 标记失败: ' + $_.Exception.Message) }
} else {
    Say '[5/7] 跳过写入：没有找到程序（请把本工具放到 desk-clock.exe 同目录再运行）'
}
Say ''

# ---------------- 6. 备用方案：登录触发的计划任务 ----------------
# Run 键被 StartupApproved 禁用、或被安全软件拦下时，计划任务仍可作为备份通道。
Say '[6/7] 备用通道：创建「登录时」触发的计划任务（可选） ...'
$taskName = 'DeskClock Autostart'
if ($exe) {
    try {
        $tr = '"' + $exe + '" --startup'
        $act = New-ScheduledTaskAction -Execute $exe -Argument '--startup'
        $trg = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
        $prn = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
        $stg = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
        Register-ScheduledTask -TaskName $taskName -Action $act -Trigger $trg -Principal $prn -Settings $stg -Force -ErrorAction Stop | Out-Null
        Say ('    已创建计划任务: ' + $taskName + '（登录时运行，与开机自启双保险）')
    } catch {
        Say ('    创建计划任务失败（可选通道，不影响主流程）: ' + $_.Exception.Message)
    }
} else {
    Say '    跳过：没有找到程序'
}
Say ''

# ---------------- 7. 自检 ----------------
Say '[7/7] 自检：用与开机完全相同的命令拉起程序 ...'
if ($exe) {
    try {
        Start-Process -FilePath $exe -ArgumentList '--startup' -ErrorAction Stop
        Start-Sleep -Seconds 5
        $proc = Get-Process -Name 'desk-clock' -ErrorAction SilentlyContinue
        if ($proc) {
            Say ('    启动测试成功：进程已运行 (PID ' + ($proc | Select-Object -First 1).Id + ')')
            Say '    说明程序本身能启动；接下来重启电脑验证「登录时」自启。'
        } else {
            Say '    启动测试失败：这条命令没能把程序拉起来。'
            Say '    → 若此时火绒/360 等安全软件弹了拦截，请把 desk-clock.exe 加白名单后再试。'
            Say '    → 若没有任何拦截提示，程序可能在启动瞬间崩溃，请把本报告发回给我。'
        }
    } catch {
        Say ('    启动测试异常: ' + $_.Exception.Message)
    }
} else { Say '    跳过：没有找到程序' }
Say ''

# ---------------- 报告落盘 ----------------
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
        $report | Set-Content -LiteralPath $cand -Encoding UTF8 -ErrorAction Stop  # PS5.1 'UTF8' = with BOM -> Notepad reads Chinese correctly
        $out = $cand
        break
    } catch { }
}
if ($out) { Say ('诊断报告已保存: ' + $out) } else { Say '诊断报告保存失败（目录不可写）' }
Say ''
Say '下一步：'
Say '  1) 先把上面「目标存在」「带引号」「startup.log」三行看一遍，那基本就是根因；'
Say '  2) 重启电脑，看时钟是否自动出现；'
Say '  3) 如果还不行，把这份报告文件直接发回给我（桌面上的 DeskClock-autostart-report.txt）。'
Say ''
Say '按任意键关闭窗口 ...'
try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { }
