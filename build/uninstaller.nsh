!macro customUnInstall
  ; Prompt user with Preserve Data vs 100% Full Clean choices during Windows Settings uninstallation
  MessageBox MB_YESNO|MB_ICONQUESTION "SERA Uninstallation & Data Management:$\r$\n$\r$\nDo you want to PRESERVE your memories, learned facts, and settings for a future reinstall?$\r$\n$\r$\n- Click YES to PRESERVE user data (memories and settings kept).$\r$\n- Click NO for 100% FULL CLEAN (permanently deletes all SERA data, models, and memories)." IDYES preserve_data IDNO full_clean

preserve_data:
  ; Remove shortcuts and local runtime caches, keep %APPDATA%\SERA
  Delete "$DESKTOP\SERA.lnk"
  Delete "$SMPROGRAMS\SERA.lnk"
  RMDir /r "$LOCALAPPDATA\SERA"
  RMDir /r "$LOCALAPPDATA\sera-updater"
  Goto done_uninstall

full_clean:
  ; 100% Full Clean: remove all SERA-owned data across all known locations
  Delete "$DESKTOP\SERA.lnk"
  Delete "$SMPROGRAMS\SERA.lnk"
  RMDir /r "$LOCALAPPDATA\SERA"
  RMDir /r "$LOCALAPPDATA\sera-updater"
  RMDir /r "$APPDATA\SERA"
  RMDir /r "$APPDATA\sera-electron"
  RMDir /r "$PROFILE\.sera"
  Goto done_uninstall

done_uninstall:
!macroend
