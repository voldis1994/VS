@echo off
echo UNINSTALL_ADMIN — remove local ADMIN shortcut/config (does not touch i3 server)
setlocal EnableExtensions
cd /d "%~dp0.."
if exist "%~dp0..\config\control-panel.env" (
  echo Found config\control-panel.env — delete manually if desired.
)
echo ADMIN uninstall helper complete. Server on i3 is untouched.
exit /b 0
