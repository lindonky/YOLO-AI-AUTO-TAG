# -*- coding: utf-8 -*-
"""Loopback-only desktop web server and user-configured API proxy."""

from __future__ import annotations

import json
import logging
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler as UrlProxyHandler
from urllib.request import Request, build_opener
from urllib.parse import urlsplit

from branding import APP_VERSION
from secure_settings import SettingsStore


HOST = "127.0.0.1"
MAX_API_BODY_BYTES = 128 * 1024 * 1024
MAX_CONFIG_BODY_BYTES = 64 * 1024


def build_outbound_opener(proxy_url: str):
    if proxy_url:
        return build_opener(UrlProxyHandler({"http": proxy_url, "https": proxy_url}))
    # No explicit value means use Windows/system proxy discovery when available.
    return build_opener()


def request_upstream(payload: bytes, runtime: dict, timeout: int = 180):
    request = Request(
        runtime["api_url"],
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {runtime['api_key']}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": f"YOLOAutoTagDesktop/{APP_VERSION}",
        },
    )
    opener = build_outbound_opener(runtime.get("proxy_url", ""))
    try:
        with opener.open(request, timeout=timeout) as response:
            return (
                int(response.status),
                response.headers.get("Content-Type", "application/json; charset=utf-8"),
                response.read(),
            )
    except HTTPError as exc:
        return (
            int(exc.code),
            exc.headers.get("Content-Type", "application/json; charset=utf-8")
            if exc.headers
            else "application/json; charset=utf-8",
            exc.read(),
        )


def upstream_error_message(status: int, body: bytes) -> str:
    detail = ""
    try:
        error_data = json.loads(body.decode("utf-8", errors="replace"))
        detail = str(error_data.get("error", {}).get("message") or error_data.get("message") or "")
    except (json.JSONDecodeError, AttributeError):
        detail = body.decode("utf-8", errors="replace")
    if status == 405:
        return (
            "中转站拒绝了当前接口路径（HTTP 405）。如果你填写的是中转站首页，"
            "请改用完整聊天接口；通常以 /v1/chat/completions 结尾。"
        )
    return f"上游返回 HTTP {status}：{detail[:300]}"


class DesktopServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, server_address, handler_class, settings_store: SettingsStore):
        super().__init__(server_address, handler_class)
        self.settings_store = settings_store

    def handle_error(self, request, client_address) -> None:
        _exc_type, exc, _traceback = sys.exc_info()
        if isinstance(exc, (ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


class DesktopHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    @property
    def settings_store(self) -> SettingsStore:
        return self.server.settings_store

    def log_message(self, format_string: str, *args) -> None:
        # Keep useful request logs without touching stderr in a windowed executable.
        logging.getLogger("desktop.http").info("%s - %s", self.address_string(), format_string % args)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def send_bytes(self, status: int, content_type: str, payload: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def send_json(self, status: int, data: object) -> None:
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_bytes(status, "application/json; charset=utf-8", payload)

    def read_body(self, maximum: int) -> bytes:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("Content-Length 无效") from exc
        if content_length <= 0:
            raise ValueError("请求体为空")
        if content_length > maximum:
            raise ValueError("请求体超过允许大小")
        return self.rfile.read(content_length)

    def read_json(self, maximum: int = MAX_CONFIG_BODY_BYTES) -> dict:
        body = self.read_body(maximum)
        try:
            data = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("请求不是有效 JSON") from exc
        if not isinstance(data, dict):
            raise ValueError("JSON 顶层必须是对象")
        return data

    def discard_optional_body(self, maximum: int = MAX_CONFIG_BODY_BYTES) -> None:
        """Drain an optional request body so HTTP/1.1 keep-alive stays synchronized."""
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("Content-Length 无效") from exc
        if content_length < 0:
            raise ValueError("Content-Length 无效")
        if content_length > maximum:
            raise ValueError("请求体超过允许大小")
        if content_length:
            self.rfile.read(content_length)

    def do_GET(self) -> None:
        route = urlsplit(self.path).path
        if route == "/api/health":
            public = self.settings_store.public()
            self.send_json(
                200,
                {
                    "ok": True,
                    "version": APP_VERSION,
                    "configured": public["configured"],
                    "loopback_only": True,
                },
            )
            return
        if route == "/api/app-config":
            self.send_json(
                200,
                {
                    **self.settings_store.public(),
                    "version": APP_VERSION,
                },
            )
            return
        super().do_GET()

    def do_OPTIONS(self) -> None:
        route = urlsplit(self.path).path
        if route not in {"/api/app-config", "/api/app-config/test", "/api/proxy/custom"}:
            self.send_error(404)
            return
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self) -> None:
        route = urlsplit(self.path).path
        if route == "/api/app-config":
            self.handle_save_config()
            return
        if route == "/api/app-config/test":
            self.handle_test_config()
            return
        if route == "/api/proxy/custom":
            self.handle_api_proxy()
            return
        self.send_json(404, {"error": {"message": f"未知路径：{route}"}})

    def handle_save_config(self) -> None:
        try:
            public = self.settings_store.update(self.read_json())
            self.send_json(200, {"ok": True, **public})
        except ValueError as exc:
            self.send_json(400, {"ok": False, "message": str(exc)})
        except Exception as exc:
            self.send_json(500, {"ok": False, "message": f"保存配置失败：{type(exc).__name__}"})

    def handle_test_config(self) -> None:
        try:
            self.discard_optional_body()
        except ValueError as exc:
            self.send_json(400, {"ok": False, "message": str(exc)})
            return
        runtime = self.settings_store.runtime()
        if not runtime["api_url"] or not runtime["api_key"] or not runtime["model"]:
            self.send_json(400, {"ok": False, "message": "请先完整保存 URL、Key 和模型名称"})
            return
        payload = json.dumps(
            {
                "model": runtime["model"],
                "messages": [{"role": "user", "content": "Reply with [] only."}],
            },
            ensure_ascii=False,
        ).encode("utf-8")
        try:
            status, _content_type, body = request_upstream(payload, runtime, timeout=60)
            if 200 <= status < 300:
                self.send_json(200, {"ok": True, "message": "URL、Key、模型和网络连接测试成功"})
                return
            self.send_json(
                502,
                {"ok": False, "message": upstream_error_message(status, body)},
            )
        except URLError as exc:
            self.send_json(502, {"ok": False, "message": f"连接失败：{exc.reason}"})
        except Exception as exc:
            self.send_json(502, {"ok": False, "message": f"连接测试失败：{type(exc).__name__}: {exc}"})

    def handle_api_proxy(self) -> None:
        runtime = self.settings_store.runtime()
        if not runtime["api_url"] or not runtime["api_key"] or not runtime["model"]:
            self.send_json(401, {"error": {"message": "尚未配置 API URL、Key 或模型名称"}})
            return
        try:
            request_data = self.read_json(MAX_API_BODY_BYTES)
            # The installed user's saved model is authoritative.
            request_data["model"] = runtime["model"]
            payload = json.dumps(request_data, ensure_ascii=False).encode("utf-8")
            status, content_type, response_body = request_upstream(payload, runtime)
            self.send_bytes(status, content_type, response_body)
        except ValueError as exc:
            self.send_json(400, {"error": {"message": str(exc)}})
        except URLError as exc:
            self.send_json(502, {"error": {"message": f"无法连接上游 API：{exc.reason}"}})
        except Exception as exc:
            self.send_json(
                502,
                {"error": {"message": f"本地代理调用失败：{type(exc).__name__}: {exc}"}},
            )


def create_server(web_root: Path, settings_store: SettingsStore, port: int = 0) -> DesktopServer:
    handler = partial(DesktopHandler, directory=str(web_root))
    return DesktopServer((HOST, port), handler, settings_store)
