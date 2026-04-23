"""PyInstaller 入口脚本（必须放在 helper_app 包外）。

为什么需要这个壳脚本？
- PyInstaller 把入口脚本当**顶层模块**执行，__package__ 为 None。
- 如果直接用 helper_app/__main__.py 当入口，里面的 `from .config import ...`
  这种相对导入会立刻抛 ImportError: attempted relative import with no known
  parent package。
- 这里通过 `from helper_app import __main__ as _entry` 让 __main__ 作为
  helper_app 包的子模块被加载，__package__ 自动设为 "helper_app"，
  相对导入恢复正常。

开发模式（`python desktop/runbi_helper.py`）也能跑，因为 Python 自动把
脚本所在目录（desktop/）加到 sys.path[0]。
"""

from __future__ import annotations

import sys
from pathlib import Path


def _bootstrap_path() -> None:
    """让 `import helper_app` 在两种场景下都能找到包。

    - 打包模式：PyInstaller 把 helper_app/ 拷到 sys._MEIPASS 下，
      _MEIPASS 默认已经在 sys.path 里，无需额外处理。
    - 开发模式：Python 自动把脚本所在目录（desktop/）加到 sys.path[0]，
      所以 import helper_app 也直接 work。
    - 兜底：万一 sys.path 被环境变量污染，强行把 desktop/ 加回去。
    """
    here = Path(__file__).resolve().parent
    if str(here) not in sys.path:
        sys.path.insert(0, str(here))


_bootstrap_path()
from helper_app.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
