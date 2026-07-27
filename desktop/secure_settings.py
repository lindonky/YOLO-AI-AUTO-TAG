# -*- coding: utf-8 -*-
"""Windows settings store with DPAPI protection for the API key."""

from __future__ import annotations

import base64
import ctypes
import json
import os
import threading
from ctypes import wintypes
from pathlib import Path
from urllib.parse import urlparse, urlunparse


SETTINGS_VERSION = 1
CRYPTPROTECT_UI_FORBIDDEN = 0x01


class DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


def settings_dir() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    base = Path(local_app_data) if local_app_data else Path.home() / "AppData" / "Local"
    return base / "YOLOAutoTag"


def protect_text(value: str) -> str:
    if os.name != "nt":
        raise RuntimeError("API Key 安全存储仅支持 Windows")
    raw = value.encode("utf-8")
    buffer = ctypes.create_string_buffer(raw)
    input_blob = DataBlob(len(raw), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)))
    output_blob = DataBlob()
    ok = ctypes.windll.crypt32.CryptProtectData(
        ctypes.byref(input_blob),
        "YOLO Auto-Tag API Key",
        None,
        None,
        None,
        CRYPTPROTECT_UI_FORBIDDEN,
        ctypes.byref(output_blob),
    )
    if not ok:
        raise ctypes.WinError()
    try:
        protected = ctypes.string_at(output_blob.pbData, output_blob.cbData)
        return base64.b64encode(protected).decode("ascii")
    finally:
        ctypes.windll.kernel32.LocalFree(output_blob.pbData)


def unprotect_text(value: str) -> str:
    if not value:
        return ""
    raw = base64.b64decode(value.encode("ascii"), validate=True)
    buffer = ctypes.create_string_buffer(raw)
    input_blob = DataBlob(len(raw), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)))
    output_blob = DataBlob()
    ok = ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(input_blob),
        None,
        None,
        None,
        None,
        CRYPTPROTECT_UI_FORBIDDEN,
        ctypes.byref(output_blob),
    )
    if not ok:
        raise ctypes.WinError()
    try:
        return ctypes.string_at(output_blob.pbData, output_blob.cbData).decode("utf-8")
    finally:
        ctypes.windll.kernel32.LocalFree(output_blob.pbData)


def validate_http_url(value: str, field_name: str, allow_empty: bool = False) -> str:
    cleaned = value.strip()
    if not cleaned and allow_empty:
        return ""
    parsed = urlparse(cleaned)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"{field_name} 必须是完整的 http:// 或 https:// 地址")
    if parsed.username or parsed.password:
        raise ValueError(f"{field_name} 不应包含用户名或密码")
    return cleaned


def normalize_api_url(value: str) -> str:
    """Accept a relay home URL while preserving explicit custom API paths."""
    cleaned = validate_http_url(value, "API URL")
    parsed = urlparse(cleaned)
    if parsed.path in {"", "/"}:
        parsed = parsed._replace(path="/v1/chat/completions")
        return urlunparse(parsed)
    return cleaned


class SettingsStore:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or (settings_dir() / "settings.json")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    def _load_unlocked(self) -> dict:
        if not self.path.exists():
            return {"version": SETTINGS_VERSION}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {"version": SETTINGS_VERSION}
        except (OSError, json.JSONDecodeError):
            return {"version": SETTINGS_VERSION}

    def _save_unlocked(self, data: dict) -> None:
        saved = dict(data)
        saved["version"] = SETTINGS_VERSION
        temp_path = self.path.with_suffix(".tmp")
        temp_path.write_text(json.dumps(saved, ensure_ascii=False, indent=2), encoding="utf-8")
        temp_path.replace(self.path)

    def public(self) -> dict:
        with self._lock:
            data = self._load_unlocked()
            encrypted_key = str(data.get("api_key_dpapi", ""))
            return {
                "configured": bool(data.get("api_url") and encrypted_key and data.get("model")),
                "api_url": str(data.get("api_url", "")),
                "model": str(data.get("model", "gemini-3.6-flash")),
                "proxy_url": str(data.get("proxy_url", "")),
                "key_configured": bool(encrypted_key),
            }

    def runtime(self) -> dict:
        with self._lock:
            data = self._load_unlocked()
            encrypted_key = str(data.get("api_key_dpapi", ""))
            return {
                "api_url": str(data.get("api_url", "")),
                "api_key": unprotect_text(encrypted_key) if encrypted_key else "",
                "model": str(data.get("model", "gemini-3.6-flash")),
                "proxy_url": str(data.get("proxy_url", "")),
            }

    def update(self, payload: dict) -> dict:
        if not isinstance(payload, dict):
            raise ValueError("配置请求格式错误")
        api_url = normalize_api_url(str(payload.get("api_url", "")))
        model = str(payload.get("model", "")).strip()
        if not model:
            raise ValueError("模型名称不能为空")
        proxy_url = validate_http_url(
            str(payload.get("proxy_url", "")), "代理 URL", allow_empty=True
        )
        new_key = str(payload.get("api_key", "")).strip()
        with self._lock:
            data = self._load_unlocked()
            data.update({"api_url": api_url, "model": model, "proxy_url": proxy_url})
            if new_key:
                data["api_key_dpapi"] = protect_text(new_key)
            if not data.get("api_key_dpapi"):
                raise ValueError("API Key 不能为空")
            self._save_unlocked(data)
        return self.public()
