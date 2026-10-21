# -*- coding: utf-8 -*-
"""Serve the main workspace or review demo in the default browser."""

from __future__ import annotations

import argparse
import sys
import threading
import time
import traceback
import webbrowser
from functools import partial
from pathlib import Path
from urllib.request import urlopen


PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from local_proxy import HOST, ProxyHandler, ProxyServer  # noqa: E402


def wait_until_ready(url: str) -> None:
    last_error: Exception | None = None
    for _attempt in range(40):
        try:
            with urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except Exception as exc:  # The next short attempt usually succeeds.
            last_error = exc
            time.sleep(0.1)
    raise RuntimeError(f"Local preview server did not become ready: {last_error}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Preview the YOLO Auto-Tag UI")
    parser.add_argument(
        "--view",
        "-View",
        choices=("review", "main"),
        default="review",
        help="Open the review demo or the empty main workspace",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    return parser.parse_args()


def run() -> int:
    args = parse_args()
    handler = partial(ProxyHandler, directory=str(PROJECT_ROOT))
    server = ProxyServer((HOST, 0), handler)
    port = int(server.server_address[1])
    thread = threading.Thread(
        target=server.serve_forever,
        name="YOLOAutoTagPreviewServer",
        daemon=True,
    )
    thread.start()

    base_url = f"http://{HOST}:{port}/index.html"
    preview_url = base_url + ("?reviewDemo=1" if args.view == "review" else "")
    try:
        wait_until_ready(base_url)
        if args.check:
            print(f"Preview self-check passed: {base_url}")
            return 0
        opened = webbrowser.open(preview_url, new=2)
        print()
        print("YOLO Auto-Tag UI preview is ready.")
        print(f"Preview URL: {preview_url}")
        if not opened:
            print("The default browser did not open automatically. Copy the URL above.")
        print("Review mode contains 13 demo images.")
        print("Use the return button to inspect the main workspace.")
        print()
        input("Press Enter after previewing to stop the temporary server...")
        return 0
    except KeyboardInterrupt:
        print("\nStopping preview...")
        return 0
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def main() -> int:
    try:
        return run()
    except Exception:
        print("\n[ERROR] UI preview could not start:\n", file=sys.stderr)
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
