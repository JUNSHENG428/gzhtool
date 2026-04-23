@echo off
REM 本机 Windows 构建脚本：双击得到 dist\Runbi Helper\Runbi Helper.exe + Runbi-Helper-win-x64.zip
REM 用法（cmd 或 PowerShell）:
REM   desktop\build\build_win.bat
REM
REM 前置:
REM   python -m venv .venv
REM   .venv\Scripts\activate
REM   pip install -r desktop\requirements.txt

setlocal enabledelayedexpansion

REM 切到仓库根
cd /d "%~dp0\..\.."

where pyinstaller >nul 2>nul
if errorlevel 1 (
  echo X 未安装 pyinstaller。请先 pip install -r desktop\requirements.txt
  exit /b 1
)

echo - Python:
python --version
echo - PyInstaller:
pyinstaller --version

REM 清理上次产物
if exist build rmdir /s /q build
if exist dist  rmdir /s /q dist
mkdir dist

pyinstaller desktop\build\runbi-helper.spec --noconfirm --clean
if errorlevel 1 (
  echo X PyInstaller 失败
  exit /b 2
)

if not exist "dist\Runbi Helper\Runbi Helper.exe" (
  echo X 找不到 dist\Runbi Helper\Runbi Helper.exe
  exit /b 3
)

REM 打 zip（Windows 10+ 自带 tar 命令支持 zip）
pushd dist
tar -a -c -f "Runbi-Helper-win-x64.zip" "Runbi Helper"
popd

echo.
echo OK 完成: dist\Runbi-Helper-win-x64.zip
echo.
echo 用户首次打开提示（未签名）: SmartScreen 会拦截，点 "更多信息" -^> "仍要运行"
echo 如果你要做正式签名，看 desktop\README.md 的 "签名与公证" 一节。

endlocal
