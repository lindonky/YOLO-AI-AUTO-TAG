# YOLO Auto-Tag

V1.1 · Windows 10/11 x64

基于 Chat Completions 视觉接口的图片、视频辅助标注工具，支持多类别检测、人工示例、漏检复核及 YOLO 数据集导出。

## 结构

- `main.js` / `annotation_core.js`：标注流程、JSON 提取与坐标校验。
- `review_workspace.js` / `task_manager.js`：人工复核、任务恢复与分类导出。
- `desktop/`：Python、pywebview、WebView2 桌面封装及安装器。

## 开发与构建

依赖 Python 3.11–3.13、Node.js、WebView2；构建安装器需要 Inno Setup 6。

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r desktop\requirements-desktop.txt
.\.venv\Scripts\python.exe desktop\prepare_desktop_assets.py
.\.venv\Scripts\python.exe desktop\desktop_app.py
.\desktop\build_test.ps1 -Python .\.venv\Scripts\python.exe
```

输出：`desktop/dist/`、`desktop/output/`。

## 验证

```powershell
node desktop/annotation_regression_test.js
node desktop/js_smoke_test.js
.\.venv\Scripts\python.exe desktop/smoke_test.py
.\.venv\Scripts\python.exe desktop/test_regressions.py
```

API 参数由用户在本机配置，Key 使用 Windows DPAPI 保存。导出分为 `normal`、`background`、`error`；训练前需复核，`error` 中的空 TXT 不能作为负样本。

第三方组件与许可说明见 [NOTICE.md](NOTICE.md)。
