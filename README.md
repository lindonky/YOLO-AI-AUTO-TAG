# YOLO Auto-Tag

当前版本：**V0.1**

一个面向 YOLO 目标检测数据集的 AI 辅助标注工具。它可以导入图片或视频，调用用户自行配置的视觉模型生成检测框，并导出 YOLO TXT、类别文件、可视化图片、裁剪图、透明抠图、视频抽帧和带框视频。

项目仓库：[lindonky/YOLO-AI-AUTO-TAG](https://github.com/lindonky/YOLO-AI-AUTO-TAG)。应用左下角保留该仓库的可点击入口；第三方组件说明见 [NOTICE.md](NOTICE.md)。

作者：粥沫鱼块 · 联系邮箱：`2093880845@qq.com`

> AI 标注不是人工复核的替代品。小目标、遮挡目标、画面边缘目标和密集目标仍可能发生漏检、误检或框选偏差。正式训练前请抽查图片与标签。

## V0.1 的目标

- 保留原 Web 版的图片/视频标注、任务管理与多种导出能力。
- 增加人工示例教学，让用户先画少量准确框，再由模型参考示例批量识别。
- 避免“图片中有目标却生成 0 KB TXT”的危险负样本。
- 针对 4K 高分辨率和小目标增加分块复核。
- 封装为 Windows 桌面应用，用户不需要手动启动 Python 服务或浏览器。
- 让中转站 URL、API Key、模型名称和代理地址由安装用户自行填写。

## 主要功能

### 原 Web 版已有并继续保留

- 图片批量导入与视频导入。
- 视频按帧率抽帧、手动指定抽帧和结果预览。
- 单类别与多类别检测。
- 图片框选结果、裁剪结果和透明抠图预览。
- YOLO TXT、`classes.txt`、原图、带框图片、裁剪图和透明图导出。
- 视频抽帧、抽帧 YOLO TXT 和带框追踪视频导出。
- 并发数量与请求速率控制。
- 任务暂停、恢复、结束、自动备份、任务包导入和断点续传。
- 深色模式、结果列表和时间轴预览。

### 本分支相对最初 Web 版本增加或强化

1. **Gemini 3.6 Flash 配置支持**
   - 默认模型示例改为 `gemini-3.6-flash`。
   - 模型名不再写死，桌面用户可以按中转站实际支持情况修改。

2. **人工示例教学**
   - 在图片上拖动画出一个或多个准确示例框。
   - 支持保存示例、撤销最后一框、清空示例和浮动快捷工具栏。
   - 批量识别时参考最近最多 3 张示例，学习目标定义和贴边框选方式。
   - 教学示例会进入任务备份和恢复数据。

3. **数量中立的识别提示**
   - 提示模型不要假设每张图一定有目标。
   - 同一批图片可以同时包含无目标、少量目标和大量密集目标。
   - 强调小目标、遮挡、边缘、低对比度和相似干扰物。

4. **空结果独立复核**
   - 初次返回 0 个框时，不立即认定为负样本。
   - 使用独立提示先判断“整张图是否存在目标”。
   - 只有高置信确认无目标时，结果才进入 `verified_empty` 状态。

5. **4K 分块复核**
   - 对高分辨率图片切分区域进行二次定位。
   - 把分块坐标映射回原图坐标。
   - 合并跨分块重叠框，并降低分块边缘截断框的优先级。
   - 分块部分失败时保留结果，但明确标记为可能不完整。

6. **0 KB YOLO TXT 导出保护**
   - 只有确认无目标的图片才允许导出空 TXT。
   - 未确认空结果、复核失败或分块调用失败时阻止导出并要求人工检查。
   - 结果列表显示“已复核无目标”“空结果复核后已找回”“待人工复核”等状态。

7. **异步图片与框同步修复**
   - 切换图片时使用当前图片身份和渲染状态约束异步结果。
   - 避免上一张图片的框短暂显示在下一张图片上。
   - 避免快速切换图片后旧请求覆盖新图片结果。

8. **进度与缓存修复**
   - 待复核空结果不会被当作已完成结果跳过。
   - 备份和恢复会保留教学示例与相关任务设置。
   - 批处理结束信息分别统计找回漏检、确认无目标和待复核数量。

9. **浏览器 CORS 本地代理**
   - `local_proxy.py` 同时提供静态页面与同源 API 代理。
   - URL 和 Key 可以通过环境变量提供，不需要提交到仓库。
   - 支持直连、Windows 系统代理或自定义 Mihomo HTTP 代理。

10. **Windows 桌面封装**
    - 使用 PyInstaller + pywebview + WebView2 + Inno Setup。
    - 自动选择本机动态端口，只监听 `127.0.0.1`。
    - 单实例运行，关闭窗口时自动停止本地服务。
    - 首次启动提供 URL、Key、模型名称和代理配置页面。
    - API Key 使用 Windows DPAPI 加密保存，公开配置接口不会返回 Key。
    - 本地打包 OpenCV.js，避免运行时依赖 OpenCV CDN。
    - 安装器检查 WebView2，缺少时调用微软 Bootstrapper。

11. **构建安全检查**
    - 桌面构建使用无密钥 `config.desktop.js` 替换浏览器配置。
    - 构建前扫描源配置中的 Key，确保它没有进入桌面资源。
    - PyInstaller 结束后再次扫描整个 `dist`。
    - Conda 构建会显式收集 `_ctypes`、`_lzma`、`_bz2`、`_decimal` 和 `pyexpat` 所需 DLL，避免用户电脑出现 DLL 加载失败。

## Windows 安装版使用教程

### 1. 安装

1. 从 Releases 下载 Windows 安装包。
2. 双击安装；测试构建未签名时，Windows 可能显示“未知发布者”。
3. 安装器按当前 Windows 用户安装，不需要系统级 Python。
4. 如果电脑缺少 WebView2，安装器会调用微软 WebView2 Bootstrapper；这一步可能需要联网。

### 2. 首次配置

首次启动会自动打开“首次使用配置”：

- **中转站 API URL**：可以填写中转站首页或完整聊天接口。首页地址会自动补全 `/v1/chat/completions`，已有自定义路径保持不变。
- **API Key**：填写安装用户自己的 Key。
- **模型名称**：填写中转站实际支持的视觉模型名称。
- **代理 URL**：选填，例如 `http://127.0.0.1:7897`。

点击“保存并测试”。Key 会经 Windows DPAPI 加密后保存到：

```text
%LOCALAPPDATA%\YOLOAutoTag\settings.json
```

启动日志位于：

```text
%LOCALAPPDATA%\YOLOAutoTag\logs\desktop.log
```

### 3. 图片标注

1. 切换到“图片模式”。
2. 从“文件”菜单导入一张或多张图片。
3. 填写目标描述和类别名称；多类别之间按界面提示分隔。
4. 目标容易混淆时，先选择代表图片并进入“示例教学”。
5. 从目标外沿拖动画框，点击“保存示例”。
6. 点击“开始分析”。
7. 在结果列表逐张检查框和空结果状态。
8. 确认后导出 YOLO 标注或任务包。

### 4. 视频标注

1. 切换到“视频模式”。
2. 导入视频，选择自动抽帧或手动指定抽帧设置。
3. 填写目标描述、类别和模型设置。
4. 开始分析并检查时间轴结果。
5. 可导出视频帧、YOLO TXT、`classes.txt` 或带框追踪视频。

### 5. 如何处理空结果

- `已复核无目标`：独立复核确认整图无目标，可以导出空 TXT。
- `空结果复核后已找回`：初次漏检，复核或分块检查找回了目标。
- `空结果待人工复核`：系统无法安全确认无目标，必须人工检查，导出会被阻止。
- `分块部分失败`：部分 API 请求失败，已有框可能不完整，建议重新分析。

## 浏览器版运行

浏览器版建议通过本地代理运行，不要双击 `index.html`，也不要把真实 Key 写进仓库。

PowerShell 示例：

```powershell
Set-Location -LiteralPath '仓库目录'
$env:UPSTREAM_API_URL = 'https://你的中转站.example/v1/chat/completions'
$env:UPSTREAM_API_KEY = '你的 API Key'
$env:LOCAL_PROXY_URL = 'http://127.0.0.1:7897'  # 不需要代理时可省略
python .\local_proxy.py
```

然后访问：

```text
http://127.0.0.1:8000
```

## 后台任务包处理

`py_run/` 保留了原 Web 版的后台任务包处理工具。建议通过环境变量提供 API 配置：

```powershell
$env:UPSTREAM_API_URL = 'https://你的中转站.example/v1/chat/completions'
$env:UPSTREAM_API_KEY = '你的 API Key'
$env:UPSTREAM_MODEL = 'gemini-3.6-flash'
python -m pip install -r .\py_run\requirements.txt
python .\py_run\main.py
```

## 从源码构建 Windows EXE

### 构建依赖

- Windows 10/11 x64
- Python 3.11—3.13（官方 CPython 或 Conda）
- `desktop/requirements-desktop.txt`
- Inno Setup 6（只有生成安装包时需要）

安装 Python 构建依赖：

```powershell
python -m venv .venv
& '.\.venv\Scripts\python.exe' -m pip install -r '.\desktop\requirements-desktop.txt'
```

只构建桌面 EXE：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File '.\desktop\build_test.ps1' `
  -Python '.\.venv\Scripts\python.exe' `
  -SkipInstaller
```

同时构建安装包：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File '.\desktop\build_test.ps1' `
  -Python '.\.venv\Scripts\python.exe'
```

输出位置：

```text
desktop\dist\YOLOAutoTag\YOLOAutoTag.exe
desktop\output\YOLO_Auto_Tag_V0.1_Setup.exe
```

如果使用 Conda Python，构建脚本会一并打包 `ffi.dll`、`liblzma.dll`、`libbz2.dll`、`libmpdec-4.dll` 和 `libexpat.dll`。使用官方 CPython 时不会要求这些 Conda 文件。

## 仓库结构

```text
.
├─ index.html / main.js / task_manager.js / style.css
├─ config.js                 # 无真实 Key 的安全默认配置
├─ local_proxy.py            # 浏览器版同源代理
├─ py_run/                   # 后台任务包处理
├─ desktop/
│  ├─ desktop_app.py         # Windows 窗口与生命周期
│  ├─ desktop_server.py      # 动态端口静态服务与 API 代理
│  ├─ secure_settings.py     # DPAPI 配置存储
│  ├─ YOLOAutoTag.spec       # PyInstaller 配置
│  ├─ build_test.ps1         # 一键构建
│  ├─ assets/                # 桌面专用无密钥前端
│  ├─ vendor/opencv/         # 本地 OpenCV.js
│  └─ installer/             # Inno Setup 与安装文案
├─ app_icon.png              # 应用图标 PNG
├─ COPY_REVIEW_V0.1.md       # V0.1 已确认文案记录
└─ NOTICE.md                 # 公开发布与第三方说明
```

## 安全提醒

- 不要把真实 API Key 写进 `config.js`、README、截图或 issue。
- 不要提交 `%LOCALAPPDATA%\YOLOAutoTag\settings.json`。
- 桌面应用只监听 `127.0.0.1`，但仍应避免在不受信任电脑上保存私人 Key。
- 4K 分块复核和“保存并测试”都会产生真实 API 请求和费用。
- 正式数据集必须进行人工抽查。

## 公开发布

本项目的公开仓库是 [lindonky/YOLO-AI-AUTO-TAG](https://github.com/lindonky/YOLO-AI-AUTO-TAG)。发布源码或安装包前，请确认没有提交 API Key、私人中转站配置、用户图片、视频、标注数据、日志或本地 DPAPI 配置。

项目尚未代替作者选择或添加项目级许可证；第三方组件仍分别遵循其自身许可证，详情见 [NOTICE.md](NOTICE.md)。
