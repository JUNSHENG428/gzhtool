"""桌面助手版本号。

修改这里 → 重新打包 → 在 GitHub Release 标签发布时也写同样的版本号
（约定 tag 形如 helper-v0.1.0）。

约定:
- 版本号遵循 SemVer (MAJOR.MINOR.PATCH)
- helper 协议字段 helperVersion 与本地浏览器扩展握手时使用同一个值
- 不同于浏览器扩展的 manifest.json version；两者解耦，独立发版
"""

__version__ = "0.1.0"
