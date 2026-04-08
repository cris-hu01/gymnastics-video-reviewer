# 体育视频字幕检测与剪辑工具

一个使用 AI（智谱 GLM 或 Claude）自动检测体育视频中运动员姓名字幕，并根据字幕时间戳剪辑视频片段的 Python 工具。

## 功能特性

- **AI 智能检测**：使用视觉 AI 准确提取运动员信息
- **颜色预检过滤**：本地过滤无字幕帧，减少 API 调用
- **多指标预检**：边缘检测、亮度、饱和度、水平条检测
- **批量帧读取**：一次性读取所有帧，提升性能
- **并行 API 调用**：多线程 AI 请求，加快检测速度
- **智能去重**：合并重复检测，过滤干扰信息
- **自动分辨率适配**：支持 SD/HD/FHD 视频
- **自动文件检测**：自动查找当前目录的视频和 JSON 文件
- **智能视频剪辑**：从字幕到字幕剪辑完整运动员片段
- **快速编码选项**：直接复制、硬件加速或快速预设
- **灵活的 API 密钥配置**：支持命令行、环境变量、配置文件

## 安装

### 前置条件

- Python 3.8+
- FFmpeg（用于视频剪辑）

### 安装依赖

```bash
pip install opencv-python numpy

# 智谱 GLM API（推荐，有免费额度）
pip install zhipuai

# 可选：Claude API
pip install anthropic
```

### 安装 FFmpeg

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg

# Windows
# 从 https://ffmpeg.org/download.html 下载
```

## 快速开始

### 一键模式（推荐）

```bash
# 将视频放入项目文件夹，然后运行：
./run.sh
```

自动执行：
1. 检测运动员字幕
2. 剪辑视频片段
3. 将处理完的视频移动到 `processed/` 文件夹

### 手动模式

```bash
# 步骤 1：使用 AI 检测运动员字幕
python3 ocr_ai_detector.py -v "体育视频.mp4"

# 步骤 2：剪辑视频片段
python3 clip_athletes.py -c
```

完成！查看输出的 JSON 文件和 `clips/` 文件夹获取结果。

## API 密钥配置

有 4 种方式配置 API 密钥（按优先级排序）：

### 1. 命令行

```bash
python3 ocr_ai_detector.py -v "视频.mp4" -k "你的API密钥"
```

### 2. 环境变量

```bash
# 智谱 GLM
export ZHIPUAI_API_KEY="你的API密钥"

# Claude
export ANTHROPIC_API_KEY="你的API密钥"
```

### 3. 配置文件

在项目目录创建 `config.json`：

```json
{
    "zhipu_api_key": "你的智谱API密钥",
    "anthropic_api_key": "你的Anthropic API密钥"
}
```

### 4. 脚本默认值

直接编辑脚本设置默认密钥（不推荐，存在安全风险）。

## 使用方法

### AI 字幕检测

```bash
# 使用智谱 GLM（默认，推荐）
python3 ocr_ai_detector.py -v "2026 Baku World Cup. HB.mp4"

# 使用 Claude API
python3 ocr_ai_detector.py -v "视频.mp4" -a claude

# 调整并行线程数以加快检测
python3 ocr_ai_detector.py -v "视频.mp4" -t 5

# 跳过颜色预检（处理所有帧）
python3 ocr_ai_detector.py -v "视频.mp4" --skip-check

# 自定义采样间隔
python3 ocr_ai_detector.py -v "视频.mp4" -i 3.0
```

#### 检测参数

| 参数 | 简写 | 默认值 | 说明 |
|:---|:---|:---|:---|
| `--video` | `-v` | 必填 | 视频文件路径 |
| `--output` | `-o` | 自动 | 输出 JSON 文件路径 |
| `--api-key` | `-k` | 配置 | API 密钥 |
| `--ai` | `-a` | zhipu | AI 后端（zhipu/claude） |
| `--interval` | `-i` | 2.0 | 采样间隔（秒） |
| `--threads` | `-t` | 3 | 并行 API 线程数 |
| `--start` | `-s` | 0 | 开始时间（秒） |
| `--end` | `-e` | 结束 | 结束时间（秒） |
| `--skip-check` | | false | 跳过颜色预检 |

### 视频剪辑

```bash
# 最快 - 直接流复制（推荐）
python3 clip_athletes.py -c

# 硬件加速（macOS）
python3 clip_athletes.py --hwaccel

# 快速软件编码
python3 clip_athletes.py -f

# 标准模式（默认）
python3 clip_athletes.py

# 或手动指定文件
python3 clip_athletes.py -v "视频.mp4" -i "结果.json"
```

#### 剪辑逻辑

每个片段从当前字幕出现延续到下一个字幕出现：
- **片段 1**：字幕 1 开始 → 字幕 2 开始
- **片段 2**：字幕 2 开始 → 字幕 3 开始
- **最后片段**：最后一个字幕开始 → 视频结束

输出文件以运动员信息命名：`视频名_01_运动员1-运动员2.mp4`

#### 自动检测

工具自动：
- 扫描视频文件（`.mp4`、`.avi`、`.mkv`、`.mov`、`.flv`、`.wmv`）
- 查找对应的 `*_subtitles.json` 文件
- 多个视频时选择最大的文件

#### 编码模式

| 模式 | 选项 | 速度 | 质量 | 说明 |
|:---|:---|:---|:---|:---|
| 复制 | `-c` | ⚡⚡⚡ 最快 | 原始 | 直接流复制，无需重编码 |
| 硬件 | `--hwaccel` | ⚡⚡⚡ 很快 | 高 | macOS VideoToolbox 加速 |
| 快速 | `-f` | ⚡⚡ 快 | 良好 | ultrafast 预设 |
| 标准 | (默认) | ⚡ 中等 | 最佳 | fast 预设 |

#### 剪辑参数

| 参数 | 简写 | 默认值 | 说明 |
|:---|:---|:---|:---|
| `--video` | `-v` | 自动 | 视频文件路径（自动检测） |
| `--input` | `-i` | 自动 | 字幕检测 JSON（自动检测） |
| `--output` | `-o` | clips | 输出目录 |
| `--padding` | `-p` | 2.0 | 片段前留白时间（秒） |
| `--copy` | `-c` | false | 直接流复制（最快） |
| `--hwaccel` | | false | 硬件加速 |
| `--fast` | `-f` | false | 快速编码模式 |

## 检测算法

检测器使用优化的 5 阶段方法：

### 阶段 1：批量帧读取

一次性读取所有采样帧（2 秒间隔），避免重复打开视频。

### 阶段 2：颜色预检（本地）

每帧通过 4 个指标检查：

| 指标 | 阈值 | 目的 |
|:---|:---|:---|
| 边缘比例 | > 1.5% | 文字有明显边缘 |
| 亮度标准差 | > 15 | 字幕条有对比度 |
| 饱和度标准差 | > 10 | 字幕有颜色变化 |
| 水平边缘 | > 1% | 字幕是水平的 |

过滤掉约 90% 无字幕的帧。

### 阶段 3：并行 AI 检测

通过预检的帧使用线程池并行发送给 AI：
- 确认运动员字幕存在
- 提取运动员姓名（验证过滤干扰词）
- 提取国家代码

### 阶段 4：智能去重

合并重复检测结果：
- 按姓氏在 8 秒窗口内分组
- 保留更完整的名字
- 过滤检测次数 < 2 的结果（减少误报）

### 阶段 5：输出

保存合并后的结果到 JSON，包含检测统计信息。

## 输出格式

### 检测结果（JSON）

```json
{
  "video": "体育视频.mp4",
  "resolution": "1920x1080",
  "duration": 1234.56,
  "sample_interval": 2.0,
  "stats": {
    "total_samples": 618,
    "precheck_passed": 45,
    "raw_detections": 32,
    "after_merge": 15,
    "final_count": 12
  },
  "total_subtitles": 12,
  "subtitles": [
    {
      "time_seconds": 214.0,
      "timestamp": "0:03:34",
      "athlete_name": "张伟",
      "country": "CHN",
      "confidence": 0.95,
      "start_seconds": 214.0,
      "end_seconds": 226.0,
      "duration": 14.0,
      "count": 5
    }
  ]
}
```

### 剪辑摘要（JSON）

```json
{
  "video": "体育视频.mp4",
  "total_clips": 12,
  "successful_clips": 12,
  "output_directory": "clips",
  "clip_mode": "subtitle_to_subtitle",
  "clips": [
    {
      "index": 1,
      "athlete1": "张伟",
      "athlete2": "李明",
      "country1": "CHN",
      "country2": "CHN",
      "start_time": "0:03:32",
      "duration": 170.0,
      "output_file": "clips/体育视频_01_张伟-李明.mp4"
    }
  ]
}
```

## 项目结构

```
sports-video-subtitle-detector/
├── README.md
├── README_CN.md              # 中文文档
├── LICENSE
├── .gitignore
├── config.json.example       # API 密钥配置模板
├── run.sh                    # 一键自动化脚本
├── ocr_ai_detector.py        # 主检测工具
├── clip_athletes.py          # 视频剪辑工具
├── clips/                    # 输出剪辑目录
└── processed/                # 已处理视频目录
```

## 支持的 AI 后端

| 后端 | 模型 | 优点 | 缺点 |
|:---|:---|:---|:---|
| 智谱 GLM | glm-4v-flash | 免费额度，中文支持好 | 有速率限制 |
| Claude | claude-sonnet-4 | 准确率高，速度快 | 仅付费 |

## 系统要求

- Python 3.8+
- OpenCV
- NumPy
- FFmpeg
- zhipuai（智谱 GLM）
- anthropic（可选，用于 Claude）

## 许可证

MIT License

## 贡献

欢迎提交 Pull Request。如有重大更改，请先开 Issue 讨论。
