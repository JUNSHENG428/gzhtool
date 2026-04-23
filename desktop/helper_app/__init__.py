"""润笔桌面助手（Runbi Helper）.

打包后会作为独立可执行程序，给浏览器扩展提供本地 DrissionPage 抓取通道。

包含:
- config.py    应用层常量（端口、bundle id、产品名、更新检查 URL 等）
- version.py   版本号定义
- server.py    HTTP helper 服务（核心抓取逻辑，从 scripts/drissionpage_helper.py 抽出）
- gui.py       Tkinter 极简 GUI
- updater.py   GitHub Release API 版本检查
- __main__.py  GUI 启动入口（PyInstaller 也以这里为 entry point）
"""

from .version import __version__

__all__ = ["__version__"]
