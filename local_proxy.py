# -*- coding: utf-8 -*-
"""Serve the local Web UI and proxy vision API requests without browser CORS."""

import json
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler as UrlProxyHandler
from urllib.request import Request, build_opener


ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT = int(os.environ.get("LOCAL_WEB_PORT", "8000"))
MAX_BODY_BYTES = 128 * 1024 * 1024
OUTBOUND_PROXY = os.environ.get("LOCAL_PROXY_URL", "").strip()
UPSTREAM_API_URL = os.environ.get("UPSTREAM_API_URL", "").strip()
UPSTREAM_API_KEY = os.environ.get("UPSTREAM_API_KEY", "").strip()
OUTBOUND_OPENER = build_opener(
    UrlProxyHandler(
        {"http": OUTBOUND_PROXY, "https": OUTBOUND_PROXY}
        if OUTBOUND_PROXY
        else {}
    )
)

UPSTREAMS = {"/api/proxy/custom": UPSTREAM_API_URL}


class ProxyHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def send_bytes(self, status: int, content_type: str, payload: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def send_json(self, status: int, data: object) -> None:
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_bytes(status, "application/json; charset=utf-8", payload)

    def do_GET(self) -> None:
        if self.path == "/api/health":
            self.send_json(
                200,
                {
                    "ok": True,
                    "outbound_proxy": OUTBOUND_PROXY or "direct",
                    "upstream_configured": bool(UPSTREAM_API_URL and UPSTREAM_API_KEY),
                    "routes": list(UPSTREAMS),
                },
            )
            return
        super().do_GET()

    def do_OPTIONS(self) -> None:
        if self.path not in UPSTREAMS:
            self.send_error(404)
            return
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self) -> None:
        upstream = UPSTREAMS.get(self.path)
        if upstream is None:
            self.send_json(404, {"error": {"message": f"未知代理路径：{self.path}"}})
            return

        if not upstream or not UPSTREAM_API_KEY:
            self.send_json(
                503,
                {"error": {"message": "请先设置 UPSTREAM_API_URL 和 UPSTREAM_API_KEY 环境变量"}},
            )
            return

        authorization = f"Bearer {UPSTREAM_API_KEY}"

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        if content_length <= 0:
            self.send_json(400, {"error": {"message": "请求体为空"}})
            return
        if content_length > MAX_BODY_BYTES:
            self.send_json(413, {"error": {"message": "图片请求超过 128 MiB 限制"}})
            return

        body = self.rfile.read(content_length)
        request = Request(
            upstream,
            data=body,
            method="POST",
            headers={
                "Authorization": authorization,
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "YOLOAutoTagLocalProxy/0.1",
            },
        )

        try:
            with OUTBOUND_OPENER.open(request, timeout=180) as response:
                payload = response.read()
                content_type = response.headers.get(
                    "Content-Type", "application/json; charset=utf-8"
                )
                self.send_bytes(response.status, content_type, payload)
        except HTTPError as exc:
            payload = exc.read() or json.dumps(
                {"error": {"message": f"上游 API 返回 HTTP {exc.code}: {exc.reason}"}},
                ensure_ascii=False,
            ).encode("utf-8")
            content_type = (
                exc.headers.get("Content-Type", "application/json; charset=utf-8")
                if exc.headers
                else "application/json; charset=utf-8"
            )
            self.send_bytes(exc.code, content_type, payload)
        except URLError as exc:
            self.send_json(
                502,
                {
                    "error": {
                        "message": (
                            f"无法通过 {OUTBOUND_PROXY or 'direct'} 连接上游 API："
                            f"{exc.reason}"
                        )
                    }
                },
            )
        except Exception as exc:
            self.send_json(
                502,
                {
                    "error": {
                        "message": f"本地代理调用失败：{type(exc).__name__}: {exc}"
                    }
                },
            )


class ProxyServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address) -> None:
        _exc_type, exc, _traceback = sys.exc_info()
        if isinstance(exc, (ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


def main() -> None:
    handler = partial(ProxyHandler, directory=str(ROOT))
    server = ProxyServer((HOST, PORT), handler)
    print(f"Web: http://{HOST}:{PORT}")
    print(f"Outbound proxy: {OUTBOUND_PROXY or 'direct'}")
    print(f"Upstream configured: {bool(UPSTREAM_API_URL and UPSTREAM_API_KEY)}")
    print("API proxy route: /api/proxy/custom")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping...")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
