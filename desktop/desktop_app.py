# -*- coding: utf-8 -*-
"""YOLO Auto-Tag Windows desktop host."""

from __future__ import annotations

import ctypes
import logging
import os
import sys
import threading
from pathlib import Path

import webview

from branding import APP_NAME, APP_VERSION, APP_VERSION_LABEL, WINDOW_TITLE
from desktop_server import create_server
from secure_settings import SettingsStore, settings_dir


MUTEX_NAME = "Local\\YOLOAutoTagDesktop.SingleInstance"
ERROR_ALREADY_EXISTS = 183
WEBVIEW2_CLIENT_ID = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"


def resource_root() -> Path:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent / "build_assets"


def setup_logging() -> None:
    log_dir = settings_dir() / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        filename=log_dir / "desktop.log",
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        encoding="utf-8",
    )


def show_message(title: str, message: str, flags: int = 0x40) -> None:
    ctypes.windll.user32.MessageBoxW(None, message, title, flags)


def acquire_single_instance_mutex():
    handle = ctypes.windll.kernel32.CreateMutexW(None, False, MUTEX_NAME)
    if not handle:
        raise ctypes.WinError()
    if ctypes.windll.kernel32.GetLastError() == ERROR_ALREADY_EXISTS:
        show_message(APP_NAME, f"{APP_NAME} {APP_VERSION_LABEL} 已经在运行。", 0x30)
        ctypes.windll.kernel32.CloseHandle(handle)
        return None
    return handle


def webview2_version() -> str:
    try:
        import winreg

        locations = (
            (winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_CLIENT_ID}"),
            (winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_CLIENT_ID}"),
            (winreg.HKEY_CURRENT_USER, rf"Software\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_CLIENT_ID}"),
        )
        for root, key_path in locations:
            try:
                with winreg.OpenKey(root, key_path) as key:
                    value, _kind = winreg.QueryValueEx(key, "pv")
                    if value:
                        return str(value)
            except OSError:
                continue
    except Exception:
        return ""
    return ""


def main() -> int:
    setup_logging()
    logging.info("Starting %s %s", APP_NAME, APP_VERSION)
    mutex = acquire_single_instance_mutex()
    if mutex is None:
        return 0

    server = None
    try:
        detected_webview2 = webview2_version()
        if not detected_webview2:
            show_message(
                APP_NAME,
                "未检测到 Microsoft Edge WebView2 Runtime。\n\n"
                "请重新运行安装程序修复 WebView2 环境后再打开应用。",
                0x10,
            )
            return 2
        logging.info("WebView2 runtime=%s", detected_webview2)

        web_root = resource_root() / "web"
        if not (web_root / "index.html").is_file():
            show_message(APP_NAME, f"应用资源缺失：{web_root / 'index.html'}", 0x10)
            return 3

        settings_store = SettingsStore()
        server = create_server(web_root, settings_store, port=0)
        port = int(server.server_address[1])
        server_thread = threading.Thread(
            target=server.serve_forever,
            name="YOLOAutoTagLocalServer",
            daemon=True,
        )
        server_thread.start()
        logging.info("Loopback server started on port %s", port)

        url = f"http://127.0.0.1:{port}/index.html?desktop=1&version={APP_VERSION}"
        webview.create_window(
            WINDOW_TITLE,
            url=url,
            width=1440,
            height=920,
            min_size=(1080, 700),
            confirm_close=False,
            text_select=True,
        )
        debug = os.environ.get("YOLO_AUTOTAG_DESKTOP_DEBUG", "0") == "1"
        webview.start(gui="edgechromium", debug=debug)
        return 0
    except Exception:
        logging.exception("Desktop application failed")
        show_message(
            APP_NAME,
            "应用启动失败。详细信息已写入：\n"
            f"{settings_dir() / 'logs' / 'desktop.log'}",
            0x10,
        )
        return 1
    finally:
        if server is not None:
            try:
                server.shutdown()
                server.server_close()
            except Exception:
                logging.exception("Failed to stop loopback server cleanly")
        ctypes.windll.kernel32.CloseHandle(mutex)


if __name__ == "__main__":
    raise SystemExit(main())
