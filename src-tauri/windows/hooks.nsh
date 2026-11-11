; 修复手动更新时「关闭正在运行的工具」卡死在 Uninstallation Aborted（下一版生效）。
;
; 根因（逐行核对 Tauri v2 官方 installer.nsi / utils.nsh 与 nsis_tauri_utils v0.5.3 源码）：
;  1) 官方 CheckIfAppIsRunning 用 RestartManager 的 RmShutdown 请求程序退出，
;     失败即 Abort(failedToKillApp) —— 截图里那句 "Failed to kill Desk Clock"
;     正是它。本程序 on_window_event 把 CloseRequested 一律 prevent_close()+hide()
;     隐藏到托盘、进程不退出，所以 RmShutdown 必然超时失败。
;  2) 旧 hook 用 FindProcessCurrentUser / KillProcessCurrentUser：这两个 API 通过
;     OpenProcess(PROCESS_QUERY_INFORMATION) 取目标进程 SID 判断是否「当前用户」。
;     安装器与时钟完整性级别不同时（例如时钟勾了「以管理员身份启动」）取不到 SID，
;     会误判成「没有进程」→ ${If} $0 == 0 不成立 → 整个优雅退出 + 强杀块被跳过；
;     即便走到强杀，KillProcessCurrentUser 也只杀 SID 匹配的进程，同样漏杀。
;     结果：进程还活着 → 官方 RmShutdown 失败 → 卸载中止。
;
; 对策：改用不限用户/不限完整性级别的 FindProcess / KillProcess（两者都只按进程名，
;       不做 SID 过滤），并对强杀做 3 轮重试；单实例优雅退出通道保留但不再依赖。
; 这两个宏在官方模板调用 CheckIfAppIsRunning 之前执行（installer.nsi 686 / 823 行）。

!include LogicLib.nsh

; 公共逻辑：优雅退出请求 → 最多等约 3 秒 → 不限用户强杀（最多 3 轮重试）。
; 用 LogicLib 循环而非手写 label，避免宏被 !insertmacro 两次时 label 重复定义。
!macro _DC_PREPARE_APP_EXIT
  ; FindProcess 返回值：0 = 有同名进程（含任意用户/完整性级别），1 = 没有。
  nsis_tauri_utils::FindProcess "desk-clock.exe"
  Pop $0
  ${If} $0 == 0
    ; ① 先请求已运行实例优雅退出（单实例插件转发 --dc-exit-for-install → app.exit(0)）。
    ;    注意 RunAsUser 是降权启动，跨完整性级别时可能送不到；故下面有强杀兜底，
    ;    这一段只是「能优雅就优雅」。
    nsis_tauri_utils::RunAsUser "$INSTDIR\desk-clock.exe" "--dc-exit-for-install"
    Pop $0
    ; ② 每 200ms 查一次，最多 15 次（约 3 秒）。
    StrCpy $1 0
    ${Do}
      nsis_tauri_utils::FindProcess "desk-clock.exe"
      Pop $0
      ${If} $0 != 0
        ${Break}
      ${EndIf}
      Sleep 200
      IntOp $1 $1 + 1
      ${If} $1 >= 15
        ${Break}
      ${EndIf}
    ${Loop}
    ; ③ 仍在运行 → 不限用户的 KillProcess 全杀（0=全成功 1=部分失败 2=没有进程）。
    ;    重试 3 轮，处理「正在退出但还没消失」的竞态；不再依赖未随 Tauri 打包
    ;    验证过的 nsExec/taskkill，避免 NSIS 编译期缺插件导致打包失败。
    ;    KillProcess 与 taskkill 同样受 Windows 权限限制：若时钟以管理员运行而
    ;    安装器未提权，两者都杀不掉；此时官方 CheckIfAppIsRunning 会给出明确的
    ;    「权限不足请手动关闭」提示，不再是「点了关闭却卡在 Abort」的死局。
    StrCpy $2 0
    ${Do}
      nsis_tauri_utils::FindProcess "desk-clock.exe"
      Pop $0
      ${If} $0 != 0
        ${Break}
      ${EndIf}
      nsis_tauri_utils::KillProcess "desk-clock.exe"
      Pop $0
      Sleep 300
      IntOp $2 $2 + 1
      ${If} $2 >= 3
        ${Break}
      ${EndIf}
    ${Loop}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro _DC_PREPARE_APP_EXIT
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro _DC_PREPARE_APP_EXIT
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
