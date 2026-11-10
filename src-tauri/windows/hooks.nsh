; v0.6.3：修复 NSIS 安装/更新时「自动关闭运行中的工具」失败。
; 根因：本程序所有窗口的 on_window_event 对 CloseRequested 一律 prevent_close + hide
; （点 × 只是隐藏到托盘），而官方 installer.nsi 的 CheckIfAppIsRunning 走 Windows
; RestartManager 发 WM_CLOSE，会被拦成「隐藏窗口」而不是退出进程，RmShutdown 返回
; ERROR_FAIL_SHUTDOWN → 弹出「点击确定以终止运行」却始终关不掉。
; 所以这里不用 WM_CLOSE：不改普通关窗语义，仅在 PREINSTALL / PREUNINSTALL 里经
; 单实例插件通道发专用参数请求旧实例 app.exit(0)，再兜底强制结束当前用户下的
; desk-clock.exe。这两个宏在官方模板调用 CheckIfAppIsRunning 之前执行。

!include LogicLib.nsh

; 公共逻辑：先优雅退出请求 → 最多等约 3 秒 → 仍在运行则强制结束。
; 用 LogicLib 循环而非手写 label，避免该宏被 !insertmacro 两次时 label 重复定义。
!macro _DC_PREPARE_APP_EXIT
  ; 先确认真的有实例在跑，避免应用未运行时被安装器“启动一次再杀掉”。
  nsis_tauri_utils::FindProcessCurrentUser "desk-clock.exe"
  Pop $0
  ${If} $0 == 0
    ; 单实例插件把参数转发给已在运行的实例，Rust 回调识别后 app.exit(0)
    nsis_tauri_utils::RunAsUser "$INSTDIR\desk-clock.exe" "--dc-exit-for-install"
    Pop $0
    ; 每 200ms 查一次，最多 15 次（约 3 秒）。
    ; FindProcessCurrentUser 返回数字：存在=0（继续等），不存在=1（已退出，跳出）。
    StrCpy $1 0
    ${Do}
      nsis_tauri_utils::FindProcessCurrentUser "desk-clock.exe"
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
    ; 兜底：仍在运行则强制结束当前用户下的实例。
    ; 结果不强制判断（返回 1 = 有没杀掉的），交给后续 CheckIfAppIsRunning 如实报错。
    nsis_tauri_utils::KillProcessCurrentUser "desk-clock.exe"
    Pop $0
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
