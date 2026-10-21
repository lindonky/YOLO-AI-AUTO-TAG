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


class DesktopApi:
    def __init__(self, server) -> None:
        self.server = server

    def choose_task_export_path(self, suggested_name: str) -> dict:
        safe_name = Path(str(suggested_name or "autotag_task_export.zip")).name
        if not safe_name.lower().endswith(".zip"):
            safe_name += ".zip"
        downloads = Path(os.environ.get("USERPROFILE") or Path.home()) / "Downloads"
        initial_directory = downloads if downloads.is_dir() else Path.home()
        try:
            window = webview.windows[0]
            selected = window.create_file_dialog(
                webview.FileDialog.SAVE,
                directory=str(initial_directory),
                save_filename=safe_name,
                file_types=("ZIP 文件 (*.zip)",),
            )
            if not selected:
                return {"ok": False, "cancelled": True}
            raw_path = selected[0] if not isinstance(selected, str) else selected
            token, target = self.server.register_export_target(Path(raw_path))
            return {
                "ok": True,
                "cancelled": False,
                "token": token,
                "path": str(target),
            }
        except Exception as exc:
            logging.exception("Failed to choose task export path")
            return {
                "ok": False,
                "cancelled": False,
                "message": f"打开保存窗口失败：{type(exc).__name__}: {exc}",
            }

    def open_last_export_location(self) -> dict:
        """Open the folder of the most recently completed export.

        The web layer does not provide an arbitrary local path here.  Only a
        path recorded by the loopback server after an atomic successful write
        can be opened.
        """
        try:
            target = self.server.last_completed_export()
            if target is None or not target.is_file():
                return {"ok": False, "message": "尚未找到已成功保存的任务包"}
            os.startfile(str(target.parent))
            return {"ok": True, "path": str(target), "folder": str(target.parent)}
        except Exception as exc:
            logging.exception("Failed to open last export location")
            return {"ok": False, "message": f"打开保存位置失败：{type(exc).__name__}: {exc}"}


def resource_root() -> Path:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent / "build_assets"


def setup_logging(root=None) -> None:
    log_dir = (root or settings_dir()) / "logs"
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
    if len(sys.argv) == 3 and sys.argv[1] in {'--self-test', '--self-test-ui'}:
        return run_self_test(Path(sys.argv[2]), with_ui=sys.argv[1] == '--self-test-ui')
    session=Path(sys.argv[2]).resolve() if len(sys.argv)==3 and sys.argv[1]=='--automation-session' else None
    if session:session.mkdir(parents=True,exist_ok=True)
    setup_logging(session)
    logging.info("Starting %s %s", APP_NAME, APP_VERSION)
    mutex = acquire_single_instance_mutex() if session is None else None
    if mutex is None and session is None:
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

        settings_store = SettingsStore(session/'settings.json') if session else SettingsStore()
        if session and not settings_store.path.exists():settings_store.update(SettingsStore().runtime())
        server = create_server(web_root, settings_store, port=0)
        from automation import AutomationService
        server.automation=AutomationService(server,(session or settings_dir())/'automation.json')
        server.journal.path=(session or settings_dir())/'logs'/'requests.jsonl'
        port = int(server.server_address[1])
        server_thread = threading.Thread(
            target=server.serve_forever,
            name="YOLOAutoTagLocalServer",
            daemon=True,
        )
        server_thread.start()
        logging.info("Loopback server started on port %s", port)

        url = f"http://127.0.0.1:{port}/index.html?desktop=1&version={APP_VERSION}"
        app_window=webview.create_window(
            WINDOW_TITLE,
            url=url,
            js_api=DesktopApi(server),
            width=1280,
            height=820,
            min_size=(1080, 680),
            confirm_close=False,
            text_select=True,
            hidden=bool(session),
        )
        def wake_control():
            try:app_window.evaluate_js('void window.AutoTagAutomation?.tick()')
            except Exception:pass
        server.automation.wake_ui=wake_control
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
                server.automation.close()
                server.shutdown()
                server.server_close()
            except Exception:
                logging.exception("Failed to stop loopback server cleanly")
        if mutex:ctypes.windll.kernel32.CloseHandle(mutex)


def run_self_test(output: Path, with_ui: bool = False) -> int:
    """Offline packaged-runtime check; no user settings, API calls or GUI changes."""
    import json
    import tempfile
    from urllib.request import urlopen
    result = {"version": APP_VERSION, "ok": False}
    server = None
    try:
        import _ctypes, _lzma, _bz2, _decimal, pyexpat
        from webview.platforms import winforms
        result['runtime_imports'] = True
        result['windows_backend_import'] = True
        result['webview2_detected'] = bool(webview2_version())
        with tempfile.TemporaryDirectory(prefix='autotag-runtime-check-') as temp:
            server = create_server(resource_root() / 'web', SettingsStore(Path(temp) / 'settings.json'))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f'http://127.0.0.1:{server.server_address[1]}'
            for name in ['index.html', 'annotation_core.js', 'main.js', 'desktop_config.js','result_inspector.js','connection_recovery.js']:
                with urlopen(base + '/' + name, timeout=5) as response:
                    if response.status != 200 or not response.read():
                        raise RuntimeError('Missing packaged asset: ' + name)
            with urlopen(base + '/api/health', timeout=5) as response:
                health = json.loads(response.read())
                if not health['ok'] or health['configured']:
                    raise RuntimeError('Isolated loopback health check failed')
            if with_ui:
                import time
                ui_errors = []
                window = webview.create_window(
                    'YOLO Auto-Tag runtime check', base + '/index.html',
                    js_api=DesktopApi(server), hidden=True, width=1280, height=820,
                )
                def inspect_window():
                    try:
                        if not window.events.loaded.wait(30):
                            raise RuntimeError('WebView2 page load timed out')
                        for _ in range(40):
                            if window.evaluate_js('Boolean(window.AnnotationCore && window.AppConfigManager && window.AppConfigManager.ready)'):
                                break
                            time.sleep(0.1)
                        else:
                            raise RuntimeError('Packaged application scripts did not initialize')
                        if not window.evaluate_js("Boolean(document.getElementById('teachingLabelSelect') && document.getElementById('verifyDetections') && document.getElementById('desktopAutoModel') && document.getElementById('desktopModelProbe') && document.getElementById('desktopMaxConcurrency') && window.pywebview.api.choose_task_export_path)"):
                            raise RuntimeError('Packaged controls or native export bridge missing')
                        result['webview2_page_initialized'] = True
                        if not window.evaluate_js("Boolean(window.AutoTagAutomation && window.ResultInspector && typeof window.AppConfigManager.executeWithRecovery === 'function' && document.getElementById('timelineSearch') && document.getElementById('timelineSort') && document.getElementById('readImageNumbers'))"):
                            raise RuntimeError('Result inspector or recovery controls missing')
                        result['result_inspector_and_recovery_initialized'] = True
                        if not window.evaluate_js("Boolean(document.getElementById('desktopDeepSeekPreset') && document.getElementById('desktopProfile') && document.getElementById('desktopProtocol') && document.getElementById('desktopMaxRetries'))"):
                            raise RuntimeError('Provider and retry controls missing')
                        result['provider_and_retry_controls_initialized'] = True
                        if not window.evaluate_js("Boolean(window.ReviewState && window.AnnotationDisplay && window.RequestStatus && document.getElementById('taskWorkbenchBtn') && document.getElementById('annotationLabelsBtn') && document.getElementById('annotationVisibilityBtn') && document.getElementById('requestStatsPanel'))"):
                            raise RuntimeError('Task workbench or display controls missing')
                        settings_visible=window.evaluate_js("(() => { window.toggleDropdown('settingsMenu'); const panel=document.getElementById('settingsMenu'); const rect=panel.getBoundingClientRect(); const valid=panel.parentElement===document.body && rect.height>300 && document.getElementById('modelSelect').getBoundingClientRect().top<innerHeight; window.toggleDropdown('settingsMenu'); return valid; })()")
                        if not settings_visible:raise RuntimeError('Settings panel collapsed or outside viewport')
                        result['workbench_display_and_settings_initialized'] = True
                        if not window.evaluate_js("Boolean(window.AnnotationEditor && window.TaskClasses && typeof window.ReviewState.validGeometry === 'function' && document.getElementById('manualAnnotateBtn') && document.querySelector('[data-ae-tool=draw]') && document.querySelector('[data-ae-undo]') && document.querySelector('[data-ae-class-list]'))"):
                            raise RuntimeError('Manual annotation editor or global class controls missing')
                        result['annotation_editor_and_classes_initialized'] = True
                    except Exception as exc:
                        ui_errors.append(str(exc))
                    finally:
                        window.destroy()
                webview.start(inspect_window, gui='edgechromium', private_mode=True, storage_path=str(Path(temp) / 'webview'))
                if ui_errors:
                    raise RuntimeError(ui_errors[0])
            server.shutdown(); server.server_close(); server = None
            thread.join(timeout=5)
        result['packaged_assets'] = True
        result['ok'] = True
    except Exception as exc:
        result['error'] = type(exc).__name__ + ': ' + str(exc)
    finally:
        if server is not None:
            server.shutdown(); server.server_close()
        output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    return 0 if result['ok'] else 1


if __name__ == "__main__":
    raise SystemExit(main())
