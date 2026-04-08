# Backend

这个目录承载桌面应用的后端能力。

当前阶段目标不是重写现有脚本，而是先建立一套可持续扩展的基础结构，给后续 GUI、任务队列和导出流程提供稳定接口。

## 当前包含

- `requirements.txt`: 后端依赖清单
- `main.py`: FastAPI 本地服务启动入口
- `video_review_backend/`: Python 包

## 本阶段职责

- 定义视频任务与候选片段的数据模型
- 保存和恢复项目状态
- 提供视频导入和元数据读取能力
- 提供 DetectionService，将检测结果直接写回 ProjectState
- 提供 ExportService，只导出保留片段并写回 ProjectState
- 提供 FastAPI API，给 React 前端调用
- 提供后台异步任务队列，用于检测和导出
- 提供时间轴缩略图生成与缓存
- 为后续接入检测引擎、导出引擎和桌面壳预留结构

## 和现有脚本的关系

根目录下的 [ocr_ai_detector.py](/Users/hu/Desktop/gymnasticvedio/ocr_ai_detector.py) 和 [clip_athletes.py](/Users/hu/Desktop/gymnasticvedio/clip_athletes.py) 仍然保留。

后续会逐步把其中稳定能力抽到这里，而不是一次性迁移。

## 本地启动

1. 安装依赖

```bash
python3 -m pip install --user -r requirements.txt
```

2. 启动 API

```bash
python3 main.py
```

默认地址：

```text
http://127.0.0.1:8000
```

当前关键接口：

- `GET /api/project`
- `GET /api/jobs`
- `POST /api/project/import`
- `POST /api/project/detect`
- `POST /api/project/export`
- `GET /api/videos/{video_id}/stream`
- `GET /api/videos/{video_id}/thumbnails`

运行时文件会落在：

- `workspace/project_state.json`
- `workspace/uploads/`
- `workspace/exports/`
- `workspace/thumbnails/`

## 构建独立后端运行时

如果要给 Electron 打包，不再依赖用户机器上的 Python，可以先构建后端独立运行时：

```bash
python3 -m pip install --user -r requirements-build.txt
python3 scripts/build_backend.py
```

构建结果会输出到：

- `dist/standalone/gymclip-backend/`

说明：

- mac 上的产物是 `gymclip-backend`
- Windows 上的产物会是 `gymclip-backend.exe`
- 产物是平台相关的，不能把 mac 构建出来的后端直接拿到 Windows 上运行

## 构建内置 ffmpeg / ffprobe

如果要让打包后的客户端尽量开箱即用，还需要把媒体工具一起准备好：

```bash
python3 scripts/build_media_tools.py
```

构建结果会输出到：

- `dist/media-tools/bin/ffmpeg`
- `dist/media-tools/bin/ffprobe`
- `dist/media-tools/lib/`

当前实现说明：

- 这一步会把当前构建机上的 `ffmpeg`、`ffprobe` 和它们依赖的 Homebrew 动态库一起复制出来
- 主要面向当前 mac 打包链路
- Windows 端后续也需要准备对应的 `ffmpeg.exe`、`ffprobe.exe` 和 DLL 依赖
