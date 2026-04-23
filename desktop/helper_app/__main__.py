"""支持 `python -m desktop.helper_app` 启动的薄壳。

真正的逻辑在 cli.py。这样设计的原因见 cli.py 的模块文档。
"""

from __future__ import annotations

import sys

from .cli import main

if __name__ == "__main__":
    sys.exit(main())
