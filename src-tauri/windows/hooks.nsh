; v0.6.3：修复 NSIS 安装/更新时「自动关闭运行中的工具」失败。
; 安装/卸载前通过单实例通道请求已运行实例退出；普通关窗仍保持隐藏到托盘。
; 这两个宏在官方模板调用 CheckIfAppIsRunning 之前执行。

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
