# ADMIN install (MSI)

Native Windows program. Not a web page.

```bat
cd /d C:\VS-main
echo I3_LAN_IP> ADMIN\config\SERVER_IP.txt
ADMIN\windows\BUILD_ADMIN.bat
START_MSI.bat
```

**UI:** `VS Admin.exe` (PySide6)  
**API:** `http://<i3-LAN>:3000`  
**Never:** Vite, `localhost:5188`, browser launch, port **5173**

If `START_MSI.bat` is run while VS Admin.exe is already open, the existing window is focused.
