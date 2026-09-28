; Runs after extraction and before electron-builder's first launch, also on upgrades.
!macro customInstall
  InitPluginsDir
  File /oname=$PLUGINSDIR\sandbox-permissions.ps1 "${BUILD_RESOURCES_DIR}\windows\sandbox-permissions.ps1"
  GetTempFileName $R0 "$TEMP"
  DetailPrint "Checking application sandbox permissions. Report: $R0"
  nsExec::ExecToStack /TIMEOUT=60000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\sandbox-permissions.ps1" -Mode Repair -InstallRoot "$INSTDIR" -ReportPath "$R0"'
  Pop $R1
  Pop $R2
  DetailPrint "$R2"
  ${If} $R1 != "0"
    SetErrorLevel 1603
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONSTOP "Abandon Note 安装未完成：无法配置或验证沙箱所需的文件读取权限。$\r$\n$\r$\n请检查安装目录权限后重新运行安装程序，或选择其他安装目录。便签数据不会被清除。$\r$\n$\r$\n返回值：$R1$\r$\n诊断及权限备份：$R0"
    ${EndIf}
    ; Abort the install section: never reach the finish-page / silent auto-launch.
    Abort
  ${EndIf}
!macroend
