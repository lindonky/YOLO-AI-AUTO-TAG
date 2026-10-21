# YOLO Auto-Tag

V1.2.7 · Windows 10/11 x64

基于视觉 API 的 YOLO 辅助标注工具，支持自动识别、人工编辑、全局类别、任务恢复、多服务配置和本机 MCP。

技术栈：JavaScript、Python 3.11–3.13、pywebview / WebView2；安装器使用 Inno Setup 6。

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r desktop\requirements-desktop.txt
.\.venv\Scripts\python.exe desktop\prepare_desktop_assets.py
.\.venv\Scripts\python.exe desktop\desktop_app.py
.\desktop\build_test.ps1 -Python .\.venv\Scripts\python.exe
```

构建输出：`desktop/dist/`、`desktop/output/`。MCP 入口：`YOLOAutoTagMCP.exe`。

API Key 使用 Windows DPAPI 保存在本机。支持 V1.2.5 可恢复任务包；训练数据按 `normal`、`background`、`error` 分类，未分类框保留在待处理区。

第三方组件与许可见 [NOTICE.md](NOTICE.md)。
