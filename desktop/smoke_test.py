# -*- coding: utf-8 -*-
"""Offline smoke tests for the desktop loopback server and configuration flow."""

from __future__ import annotations

import json
import tempfile
import threading
from http.client import HTTPConnection
from pathlib import Path
from urllib.request import Request, urlopen

from desktop_server import create_server
from secure_settings import SettingsStore


FAKE_KEY = "desktop-smoke-test-key-not-real"


def fetch_json(url: str, method: str = "GET", payload: dict | None = None):
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = Request(
        url,
        data=body,
        method=method,
        headers={"Content-Type": "application/json"} if body else {},
    )
    with urlopen(request, timeout=10) as response:
        return response.status, json.loads(response.read().decode("utf-8"))


def main() -> None:
    root = Path(__file__).resolve().parent
    web_root = root / "build_assets" / "web"
    assert (web_root / "index.html").is_file(), "run prepare_desktop_assets.py first"

    with tempfile.TemporaryDirectory(prefix="yolo-autotag-desktop-test-") as temp_dir:
        store = SettingsStore(Path(temp_dir) / "settings.json")
        server = create_server(web_root, store, port=0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            status, health = fetch_json(base + "/api/health")
            assert status == 200 and health["ok"] and not health["configured"]

            status, saved = fetch_json(
                base + "/api/app-config",
                method="POST",
                payload={
                    "api_url": "https://example.invalid/",
                    "api_key": FAKE_KEY,
                    "model": "gemini-3.6-flash",
                    "proxy_url": "",
                },
            )
            assert status == 200 and saved["configured"]
            assert saved["api_url"] == "https://example.invalid/v1/chat/completions"
            assert FAKE_KEY not in json.dumps(saved)

            status, saved_custom = fetch_json(
                base + "/api/app-config",
                method="POST",
                payload={
                    "api_url": "https://example.invalid/custom/vision",
                    "api_key": "",
                    "model": "gemini-3.6-flash",
                    "proxy_url": "",
                },
            )
            assert status == 200
            assert saved_custom["api_url"] == "https://example.invalid/custom/vision"

            status, public = fetch_json(base + "/api/app-config")
            assert status == 200 and public["configured"] and public["key_configured"]
            assert FAKE_KEY not in json.dumps(public)
            assert store.runtime()["api_key"] == FAKE_KEY

            # Regression: old desktop frontends sent a literal "{}" body to
            # the test endpoint. The server must drain it before reusing the
            # HTTP/1.1 connection, otherwise the next method becomes
            # "{}GET"/"{}POST" and returns an HTML 501 page.
            store.update(
                {
                    "api_url": base + "/v1/chat/completions",
                    "api_key": "",
                    "model": "gemini-3.6-flash",
                    "proxy_url": "",
                }
            )
            connection = HTTPConnection("127.0.0.1", server.server_address[1], timeout=10)
            try:
                connection.request(
                    "POST",
                    "/api/app-config/test",
                    body=b"{}",
                    headers={"Content-Type": "application/json"},
                )
                test_response = connection.getresponse()
                test_body = json.loads(test_response.read().decode("utf-8"))
                assert test_response.status == 502 and not test_body["ok"]

                connection.request("GET", "/api/health")
                reused_response = connection.getresponse()
                reused_body = json.loads(reused_response.read().decode("utf-8"))
                assert reused_response.status == 200 and reused_body["ok"]
            finally:
                connection.close()

            # A desktop save dialog registers a short-lived, one-time target.
            # The browser streams the generated ZIP to that token; only the
            # selected path may be written and success is reported after the
            # file has been flushed and atomically moved into place.
            export_payload = b"PK\x03\x04desktop-task-export-smoke-test"
            export_target = Path(temp_dir) / "chosen-task-package.zip"
            export_token, registered_target = server.register_export_target(export_target)
            assert registered_target == export_target
            export_connection = HTTPConnection(
                "127.0.0.1", server.server_address[1], timeout=10
            )
            try:
                export_connection.request(
                    "POST",
                    f"/api/task-export/{export_token}",
                    body=export_payload,
                    headers={"Content-Type": "application/zip"},
                )
                export_response = export_connection.getresponse()
                export_result = json.loads(export_response.read().decode("utf-8"))
                assert export_response.status == 200 and export_result["ok"]
                assert export_result["path"] == str(export_target)
                assert export_target.read_bytes() == export_payload
            finally:
                export_connection.close()

            with urlopen(base + "/index.html", timeout=10) as response:
                index_text = response.read().decode("utf-8")
            assert "desktop_config.js" in index_text
            assert "app_icon.png" in index_text
            assert 'id="exportTaskQuickBtn"' in index_text
            assert 'id="importTaskQuickInput"' in index_text
            task_manager_text = (web_root / "task_manager.js").read_text(encoding="utf-8")
            assert "choose_task_export_path" in task_manager_text
            assert "/api/task-export/" in task_manager_text
            assert "taskMenu.classList" not in task_manager_text
            assert (web_root / "app_icon.png").is_file()
            assert FAKE_KEY not in index_text
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    print("Desktop offline smoke test: passed")


if __name__ == "__main__":
    main()
