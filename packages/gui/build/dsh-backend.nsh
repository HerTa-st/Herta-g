!ifexist "${BUILD_RESOURCES_DIR}\\dsh-backend\\payload.json"
Section /o "DeepSeek Harness backend" SecDshBackend
  SectionIn 1 2
  SetOutPath "$INSTDIR\\resources\\dsh-backend"
  File /r "${BUILD_RESOURCES_DIR}\\dsh-backend\\*"
SectionEnd
!endif

!macro customUnInstall
  RMDir /r "$INSTDIR\\resources\\dsh-backend"
!macroend
