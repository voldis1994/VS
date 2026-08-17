from __future__ import annotations

import os
import sys
from pathlib import Path

from PySide6.QtCore import QLockFile, QSharedMemory

LOCK_NAME = "vs-admin-desktop.lock"
SHM_KEY = "vs-admin-desktop-instance"


def lock_path() -> Path:
    base = Path(os.environ.get("LOCALAPPDATA") or os.environ.get("TMPDIR") or "/tmp")
    return base / LOCK_NAME


def focus_existing_window() -> None:
    if sys.platform != "win32":
        return
    try:
        import ctypes

        hwnd = ctypes.windll.user32.FindWindowW(None, "VS Admin")
        if hwnd:
            ctypes.windll.user32.ShowWindow(hwnd, 9)
            ctypes.windll.user32.SetForegroundWindow(hwnd)
    except Exception:
        return


class SingleInstance:
    def __init__(self) -> None:
        self.lock = QLockFile(str(lock_path()))
        self.lock.setStaleLockTime(30_000)
        self.shm = QSharedMemory(SHM_KEY)

    def acquire(self) -> bool:
        if not self.lock.tryLock(100):
            return False
        if self.shm.attach():
            self.shm.detach()
        if not self.shm.create(1):
            return False
        return True

    def release(self) -> None:
        if self.shm.isAttached():
            self.shm.detach()
        self.lock.unlock()
