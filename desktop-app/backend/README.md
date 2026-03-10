# Backend

这个目录承载桌面应用的后端能力。

当前阶段目标不是重写现有脚本，而是先建立一套可持续扩展的基础结构，给后续 GUI、任务队列和导出流程提供稳定接口。

## 当前包含

- `requirements.txt`: 后端依赖清单
- `video_review_backend/`: Python 包

## 本阶段职责

- 定义视频任务与候选片段的数据模型
- 保存和恢复项目状态
- 提供视频导入和元数据读取能力
- 为后续接入检测引擎、导出引擎和桌面壳预留结构

## 暂不负责

- GUI
- 最终检测引擎重构
- 最终导出流程
- Electron / Tauri 集成

## 和现有脚本的关系

根目录下的 [ocr_ai_detector.py](/Users/hu/Desktop/gymnasticvedio/ocr_ai_detector.py) 和 [clip_athletes.py](/Users/hu/Desktop/gymnasticvedio/clip_athletes.py) 仍然保留。

后续会逐步把其中稳定能力抽到这里，而不是一次性迁移。
