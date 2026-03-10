# 后端协作约定

这份文档用于约束桌面应用前后端的第一阶段协作边界。

## 1. 当前目标

前端由外部设计工具和后续 React 实现负责。

后端当前优先提供：

- 项目状态模型
- 视频导入
- 视频元数据读取
- 候选片段持久化结构

检测引擎与导出引擎后续再逐步接入。

## 2. 当前状态文件

当前约定项目状态落在一个 JSON 文件中，例如：

```text
project_state.json
```

建议由桌面壳为每个项目分配单独目录。

## 3. 状态文件顶层结构

```json
{
  "version": "0.1.0",
  "name": "Untitled Project",
  "created_at": "2026-03-10T13:00:00+00:00",
  "updated_at": "2026-03-10T13:05:00+00:00",
  "videos": [],
  "detection_blocks": [],
  "candidate_clips": [],
  "settings": {}
}
```

## 4. 视频任务状态

`videos[].status` 当前约定值：

- `queued`
- `detecting`
- `ready_for_review`
- `reviewing`
- `done`
- `error`

## 5. 候选片段状态

`candidate_clips[].status` 当前约定值：

- `pending`
- `kept`
- `deleted`
- `reviewed`
- `exported`

## 6. 字段含义

### VideoTask

- `file_path`: 原视频绝对路径
- `file_name`: 文件名
- `duration`: 视频时长，单位秒
- `resolution`: 例如 `1920x1080`

### CandidateClip

- `candidate_start` / `candidate_end`: 系统推荐候选时间
- `review_start` / `review_end`: 人工确认后的最终时间
- `subtitle_start` / `subtitle_end`: 字幕检测块的时间范围

## 7. 当前后端可用能力

已实现：

- 导入视频并过滤不支持格式
- 读取视频时长和分辨率
- 保存和恢复项目状态

未实现：

- 调用 AI 检测
- 生成检测块
- 从检测块推导候选片段
- 导出保留片段

## 8. 下一步建议

下一阶段优先接入两个服务：

1. `DetectionService`
2. `ExportService`

其中 `DetectionService` 应首先从现有 [ocr_ai_detector.py](/Users/hu/Desktop/gymnasticvedio/ocr_ai_detector.py) 抽离。
