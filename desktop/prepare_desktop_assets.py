# -*- coding: utf-8 -*-
"""Create a sanitized desktop-only copy of the existing web frontend."""

from __future__ import annotations

import re
import shutil
from pathlib import Path


DESKTOP_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = DESKTOP_ROOT.parent
STAGING_ROOT = DESKTOP_ROOT / "build_assets"
WEB_ROOT = STAGING_ROOT / "web"


def reset_staging() -> None:
    resolved = STAGING_ROOT.resolve()
    if DESKTOP_ROOT.resolve() not in resolved.parents:
        raise RuntimeError(f"拒绝清理非 desktop 目录：{resolved}")
    if STAGING_ROOT.exists():
        shutil.rmtree(STAGING_ROOT)
    WEB_ROOT.mkdir(parents=True, exist_ok=True)


def copy_frontend() -> None:
    for name in ("index.html", "main.js", "task_manager.js", "style.css", "app_icon.png"):
        shutil.copy2(PROJECT_ROOT / name, WEB_ROOT / name)
    shutil.copytree(PROJECT_ROOT / "libs", WEB_ROOT / "libs")
    shutil.copy2(DESKTOP_ROOT / "assets" / "config.desktop.js", WEB_ROOT / "config.js")
    shutil.copy2(DESKTOP_ROOT / "assets" / "desktop_config.js", WEB_ROOT / "desktop_config.js")


def patch_desktop_index() -> None:
    index_path = WEB_ROOT / "index.html"
    content = index_path.read_text(encoding="utf-8")
    config_pattern = re.compile(r'<script\s+src="config\.js[^"\n]*"></script>')
    replacement = (
        '<script src="config.js?v=desktop-0.5"></script>\n'
        '<script src="desktop_config.js?v=desktop-0.5"></script>'
    )
    content, count = config_pattern.subn(replacement, content, count=1)
    if count != 1:
        raise RuntimeError("没有找到唯一的 config.js 脚本标签")

    local_opencv = DESKTOP_ROOT / "vendor" / "opencv" / "opencv.js"
    if local_opencv.is_file():
        target_dir = WEB_ROOT / "libs" / "opencv"
        target_dir.mkdir(parents=True, exist_ok=True)
        for item in local_opencv.parent.iterdir():
            if item.is_file():
                shutil.copy2(item, target_dir / item.name)
        content = content.replace(
            '<script src="https://docs.opencv.org/4.x/opencv.js"></script>',
            '<script src="libs/opencv/opencv.js"></script>',
        )
    index_path.write_text(content, encoding="utf-8")


def assert_no_source_keys() -> None:
    source_config = (PROJECT_ROOT / "config.js").read_text(encoding="utf-8")
    secret_values = {
        match.strip()
        for match in re.findall(r"(?i)key\s*:\s*['\"]([^'\"]+)['\"]", source_config)
        if len(match.strip()) >= 8
    }
    staged_text = "\n".join(
        path.read_text(encoding="utf-8", errors="ignore")
        for path in WEB_ROOT.rglob("*")
        if path.is_file() and path.suffix.lower() in {".js", ".html", ".css", ".txt", ".json"}
    )
    leaked = [value for value in secret_values if value in staged_text]
    if leaked:
        raise RuntimeError(f"桌面构建目录检测到 {len(leaked)} 个源配置密钥，已停止构建")


def main() -> None:
    reset_staging()
    copy_frontend()
    patch_desktop_index()
    assert_no_source_keys()
    opencv_mode = "local" if (WEB_ROOT / "libs" / "opencv" / "opencv.js").is_file() else "cdn"
    print(f"Desktop assets prepared: {WEB_ROOT}")
    print("Secret scan: passed")
    print(f"OpenCV asset mode: {opencv_mode}")


if __name__ == "__main__":
    main()
