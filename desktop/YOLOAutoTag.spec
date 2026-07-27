# -*- mode: python ; coding: utf-8 -*-

import sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_submodules

root = Path(SPECPATH)
web_root = root / 'build_assets' / 'web'
if not (web_root / 'index.html').is_file():
    raise SystemExit('请先运行 prepare_desktop_assets.py')

hiddenimports = collect_submodules('webview')

# The current build interpreter is a venv based on Conda Python. PyInstaller
# finds the extension modules under sys.base_prefix\DLLs, but it does not
# automatically collect their dependent DLLs from Library\bin. A build made
# without these files can appear healthy on the development computer because
# Conda is on PATH, then fail with "DLL load failed while importing _ctypes"
# on a clean user computer.
conda_bin_candidates = [
    Path(sys.prefix) / 'Library' / 'bin',
    Path(sys.base_prefix) / 'Library' / 'bin',
]
available_conda_bins = [candidate for candidate in conda_bin_candidates if candidate.is_dir()]
required_conda_dlls = (
    'ffi.dll',
    'liblzma.dll',
    'libbz2.dll',
    'libmpdec-4.dll',
    'libexpat.dll',
)
extra_binaries = []
if available_conda_bins:
    for dll_name in required_conda_dlls:
        source = next(
            (candidate / dll_name for candidate in available_conda_bins if (candidate / dll_name).is_file()),
            None,
        )
        if source is None:
            raise SystemExit(f'Required Conda runtime DLL not found: {dll_name}')
        extra_binaries.append((str(source), '.'))

a = Analysis(
    [str(root / 'desktop_app.py')],
    pathex=[str(root)],
    binaries=extra_binaries,
    datas=[(str(web_root), 'web')],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tkinter', 'pytest', 'numpy', 'cv2'],
    noarchive=False,
    optimize=1,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='YOLOAutoTag',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    version=str(root / 'version_info.txt'),
    icon=str(root / 'assets' / 'app_icon.ico'),
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='YOLOAutoTag',
)
