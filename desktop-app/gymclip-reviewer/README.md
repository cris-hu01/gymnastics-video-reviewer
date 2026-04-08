# GymClip Reviewer Frontend

这是 GymClip Reviewer 的前端项目，基于 React + Vite + TypeScript。

当前前端已经接入：

- 本地 Python API
- 异步检测 / 导出任务轮询
- 当前候选片段时间轴缩略图
- Electron 桌面壳

## 本地运行

### 前置条件

- Node.js 18+
- Python API 服务已启动

### 启动步骤

1. 安装依赖

```bash
npm install
```

2. 创建本地环境变量文件

```bash
cp .env.example .env.local
```

3. 启动前端

```bash
npm run dev
```

默认会读取 `VITE_API_BASE_URL`，指向本地 Python API 服务。

## 推荐联调顺序

1. 在 `desktop-app/backend/` 启动 Python API
2. 在当前目录启动 Vite
3. 打开浏览器访问 `http://127.0.0.1:3000`

## Electron 开发运行

1. 安装依赖

```bash
npm install
```

2. 直接启动桌面版开发环境

```bash
npm run electron:dev
```

这个命令会：

- 启动 Vite 前端
- 启动 Electron 主进程
- 在 Electron 内部自动拉起 Python 后端

说明：

- 开发模式下，Electron 仍会通过 `python3` 启动 `../backend/main.py`
- 如果你的 Python 命令不是 `python3`，可以先设置环境变量 `GYMCLIP_PYTHON`

## Electron 打包

```bash
npm run electron:pack
```

当前打包流程会先做两件事：

- 构建前端静态资源
- 用 PyInstaller 构建后端独立运行时，并作为 `extraResources` 打进 Electron
- 打包内置 `ffmpeg` / `ffprobe` 及其依赖库，并作为 `extraResources` 打进 Electron

这意味着：

- 打包后的客户端不再依赖用户机器上安装 Python
- 打包后的客户端默认也不再依赖用户机器额外安装 `ffmpeg` / `ffprobe`
- Electron 会直接启动内置的后端可执行文件

## API Key 保存

桌面客户端支持记住 API Key。

- 只在 Electron 桌面环境启用
- 不写入 `project_state.json`
- 会保存在当前用户本机的系统安全存储中
  - mac 通过系统安全存储保护
  - Windows 通过系统账户加密保护

## 平台说明

当前这套客户端不是只支持 mac。

- 架构上支持 mac 和 Windows
- `electron-builder` 已配置 Windows `nsis` 目标
- Electron 主进程也已经兼容 `.exe` 后端路径

但构建产物是平台相关的：

- 在 mac 上构建，得到的是 mac 客户端
- 要得到可安装的 Windows 客户端，最好在 Windows 机器或 Windows CI 上执行整套打包

原因不是 React 或 Electron 不支持 Windows，而是：

- PyInstaller 需要在目标平台生成对应的后端可执行文件
- Windows 安装包也更适合在 Windows 环境里生成和验证
