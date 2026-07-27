# -*- coding: utf-8 -*-
"""Offline smoke tests for the desktop loopback server and configuration flow."""

from __future__ import annotations

import json
import tempfile
import threading
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

            with urlopen(base + "/index.html", timeout=10) as response:
                index_text = response.read().decode("utf-8")
            assert "desktop_config.js" in index_text
            assert "app_icon.png" in index_text
            assert (web_root / "app_icon.png").is_file()
            assert FAKE_KEY not in index_text
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    print("Desktop offline smoke test: passed")


if __name__ == "__main__":
    main()
