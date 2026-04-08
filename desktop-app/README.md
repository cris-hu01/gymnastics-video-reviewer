# GymClip Reviewer

GymClip Reviewer 是一个面向竞技体操比赛视频的桌面审核工具，用来把“导入视频 -> 自动检测候选片段 -> 人工审核 -> 批量导出”这条流程收敛到一个可直接使用的 App 里。

它的核心目标不是做通用视频剪辑，而是帮助你更快从长比赛录像中找出运动员字幕出现的片段，并把这些候选片段整理成可复核、可导出的结果。

## 这个 App 能做什么

- 导入本地比赛视频，建立项目任务列表
- 基于视频字幕区域做候选片段检测
- 对候选片段进行人工审核、保留、删除和裁剪
- 批量导出已保留片段
- 显示检测进度、导出进度和视频任务状态
- 在桌面端使用系统文件夹选择器、打包后的后端服务和媒体工具

## 典型使用流程

1. 导入一个或多个比赛视频
2. 选择要处理的视频并开始检测
3. 等待候选片段生成
4. 在中间栏逐个审核候选片段
5. 标记保留片段并调整裁剪范围
6. 批量导出最终片段

## 适用场景

- 竞技体操比赛录像整理
- 从长视频中快速定位运动员登场字幕片段
- 比赛片段二次筛选和归档
- 桌面端本地审核工作流

## 当前技术栈

- 前端：React + Vite
- 桌面壳：Electron
- 后端：Python + FastAPI
- 媒体工具：ffmpeg / ffprobe（随客户端一起打包）

## 仓库结构

- `gymclip-reviewer/`
  - React 前端
  - Electron 主进程、preload、打包配置
  - 桌面端构建脚本与安装包输出目录
- `backend/`
  - FastAPI 后端入口
  - 检测、审核、导出、缩略图等服务
  - PyInstaller 与媒体工具打包脚本
- `docs/`
  - 产品方案
  - 交互设计
  - 前后端契约
- `.github/`
  - GitHub Actions
  - Issue 模板
  - PR 模板
- `frontend/`
  - 历史预留目录，当前主线前端已迁移到 `gymclip-reviewer/`

## 获取与安装

正式安装包通过 GitHub Releases 分发：

- 打开 [Releases](../../releases)
- 优先下载 `.dmg` 安装包
- `.zip` 适合手动解压获取 `.app`

当前主线发布以 macOS Apple Silicon (`arm64`) 为主。  
部分热修复版本可能先以本地测试包形式验证，再整理进正式 Release。

## 本地开发

### 前置环境

- Node.js 22+
- npm 11+
- Python 3.10+
- macOS（当前桌面打包主流程基于 macOS）

### 方式一：浏览器联调

启动后端：

```bash
cd backend
python3 main.py
```

启动前端：

```bash
cd gymclip-reviewer
npm install
npm run dev
```

### 方式二：Electron 开发模式

```bash
cd gymclip-reviewer
npm install
npm run electron:dev
```

这个模式会同时启动：

- Vite 前端开发服务器
- Electron 桌面壳

## 本地打包

在 `gymclip-reviewer/` 目录下执行：

```bash
npm install
npm run electron:pack
```

如果本地环境存在 mac 打包签名或扩展属性干扰，优先使用 cleanroom 打包脚本：

```bash
cd gymclip-reviewer
npm run electron:pack:cleanroom
```

打包产物默认在：

- `gymclip-reviewer/electron-dist/`

## 后端工作目录说明

运行桌面端后，后端会在工作区维护项目数据和运行文件，常见内容包括：

- `uploads/`：导入的视频文件
- `exports/`：导出的片段
- `thumbnails/`：缩略图缓存
- `project_state.json`：项目状态、视频状态、候选片段和设置

这也是为什么异常退出后，某些任务状态会保留在本地项目文件里；当前仓库已经补充了针对异常中断任务的恢复逻辑。

## 文档入口

- [贡献说明](./CONTRIBUTING.md)
- [后端契约](./docs/BACKEND_CONTRACT.md)
- [产品方案](./docs)

## GitHub 工作方式

- `main` 作为稳定分支
- 功能开发分支统一使用 `codex/...`、`feature/...`、`fix/...`
- 通过 Pull Request 合并
- 通过 GitHub Releases 分发桌面安装包

如果你要参与开发，建议先看 [CONTRIBUTING.md](./CONTRIBUTING.md)。
