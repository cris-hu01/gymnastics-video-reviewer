# Sports Video Subtitle Detector & Clipper

A Python tool for automatically detecting athlete name subtitles in sports videos using AI (Zhipu GLM or Claude) and clipping video segments based on subtitle timestamps.

## Features

- **AI-powered detection**: Uses vision AI to accurately extract athlete information
- **Color precheck filtering**: Reduces API calls by filtering frames without subtitles locally
- **Multi-metric precheck**: Edge detection, brightness, saturation, and horizontal bar detection
- **Batch frame reading**: Reads all frames at once for better performance
- **Parallel API calls**: Multi-threaded AI requests for faster detection
- **Smart deduplication**: Merges duplicate detections, filters noise
- **Auto resolution adaptation**: Works with SD/HD/FHD videos
- **Auto file detection**: Automatically finds video and JSON files in current directory
- **Smart video clipping**: Clips from subtitle to subtitle for complete athlete segments
- **Fast encoding options**: Direct copy, hardware acceleration, or fast presets
- **Configurable API keys**: Multiple ways to configure (command line, environment, config file)

## Installation

### Prerequisites

- Python 3.8+
- FFmpeg (for video clipping)

### Install Dependencies

```bash
pip install opencv-python numpy

# For Zhipu GLM API (recommended, free tier available)
pip install zhipuai

# Optional: For Claude API
pip install anthropic
```

### Install FFmpeg

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg

# Windows
# Download from https://ffmpeg.org/download.html
```

## Quick Start

### One-Click Mode (Recommended)

```bash
# Place your video in the project folder, then run:
./run.sh
```

This automatically:
1. Detects athlete subtitles
2. Clips video segments
3. Moves processed video to `processed/` folder

### Manual Mode

```bash
# Step 1: Detect athlete subtitles using AI
python3 ocr_ai_detector.py -v "sports_video.mp4"

# Step 2: Clip video segments
python3 clip_athletes.py -c
```

Done! Check the output JSON and `clips/` folder for results.

## API Key Configuration

There are 4 ways to configure API keys (in priority order):

### 1. Command Line

```bash
python3 ocr_ai_detector.py -v "video.mp4" -k "your-api-key"
```

### 2. Environment Variable

```bash
# For Zhipu GLM
export ZHIPUAI_API_KEY="your-api-key"

# For Claude
export ANTHROPIC_API_KEY="your-api-key"
```

### 3. Config File

Create `config.json` in the project directory:

```json
{
    "zhipu_api_key": "your-zhipu-api-key",
    "anthropic_api_key": "your-anthropic-api-key"
}
```

### 4. Script Default

Edit the script directly to set default keys (not recommended for security).

## Usage

### AI Subtitle Detection

```bash
# Using Zhipu GLM (default, recommended)
python3 ocr_ai_detector.py -v "video.mp4"

# Using Claude API
python3 ocr_ai_detector.py -v "video.mp4" -a claude

# Adjust parallel threads for faster detection
python3 ocr_ai_detector.py -v "video.mp4" -t 5

# Skip color precheck (process all frames)
python3 ocr_ai_detector.py -v "video.mp4" --skip-check

# Custom sampling interval
python3 ocr_ai_detector.py -v "video.mp4" -i 3.0
```

#### Detection Parameters

| Parameter | Short | Default | Description |
|:---|:---|:---|:---|
| `--video` | `-v` | required | Video file path |
| `--output` | `-o` | auto | Output JSON file path |
| `--api-key` | `-k` | config | API key |
| `--ai` | `-a` | zhipu | AI backend (zhipu/claude) |
| `--interval` | `-i` | 2.0 | Sampling interval (seconds) |
| `--threads` | `-t` | 3 | Parallel API threads |
| `--start` | `-s` | 0 | Start time (seconds) |
| `--end` | `-e` | end | End time (seconds) |
| `--skip-check` | | false | Skip color precheck |

### Video Clipping

```bash
# Fastest - Direct stream copy (recommended)
python3 clip_athletes.py -c

# Hardware acceleration (macOS)
python3 clip_athletes.py --hwaccel

# Fast software encoding
python3 clip_athletes.py -f

# Standard mode (default)
python3 clip_athletes.py

# Or specify files manually
python3 clip_athletes.py -v "video.mp4" -i "result.json"
```

#### Clipping Logic

Each clip spans from the current subtitle appearance to the next subtitle appearance:
- **Clip 1**: Subtitle 1 start → Subtitle 2 start
- **Clip 2**: Subtitle 2 start → Subtitle 3 start
- **Last clip**: Last subtitle start → Video end

Output files are named with athlete info: `videoname_01_Athlete1-Athlete2.mp4`

#### Auto Detection

The tool automatically:
- Scans for video files (`.mp4`, `.avi`, `.mkv`, `.mov`, `.flv`, `.wmv`)
- Finds corresponding `*_subtitles.json` file
- Selects the largest video file if multiple exist

#### Encoding Modes

| Mode | Option | Speed | Quality | Description |
|:---|:---|:---|:---|:---|
| Copy | `-c` | ⚡⚡⚡ Fastest | Original | Direct stream copy, no re-encoding |
| Hardware | `--hwaccel` | ⚡⚡⚡ Very fast | High | macOS VideoToolbox acceleration |
| Fast | `-f` | ⚡⚡ Fast | Good | ultrafast preset |
| Standard | (default) | ⚡ Moderate | Best | fast preset |

#### Clipping Parameters

| Parameter | Short | Default | Description |
|:---|:---|:---|:---|
| `--video` | `-v` | auto | Video file path (auto-detected) |
| `--input` | `-i` | auto | Subtitle detection JSON (auto-detected) |
| `--output` | `-o` | clips | Output directory |
| `--padding` | `-p` | 2.0 | Padding before clip (seconds) |
| `--copy` | `-c` | false | Direct stream copy (fastest) |
| `--hwaccel` | | false | Hardware acceleration |
| `--fast` | `-f` | false | Fast encoding mode |

## Detection Algorithm

The detector uses an optimized 5-stage approach:

### Stage 1: Batch Frame Reading

Reads all sample frames at once (2-second intervals) instead of opening the video repeatedly.

### Stage 2: Color Precheck (Local)

Each frame is checked with 4 metrics:

| Metric | Threshold | Purpose |
|:---|:---|:---|
| Edge Ratio | > 1.5% | Text has distinct edges |
| Brightness Std | > 15 | Subtitle bar has contrast |
| Saturation Std | > 10 | Color variation in subtitle |
| Horizontal Edges | > 1% | Subtitles are horizontal |

Filters out ~90% of frames without subtitles.

### Stage 3: Parallel AI Detection

Frames passing precheck are sent to AI in parallel using thread pool:
- Confirms athlete subtitle presence
- Extracts athlete name (validated against noise keywords)
- Extracts country code

### Stage 4: Smart Deduplication

Merges duplicate detections:
- Groups by surname within 8-second window
- Keeps more complete names
- Filters results with < 2 detections (reduces false positives)

### Stage 5: Output

Saves merged results to JSON with detection statistics.

## Output Format

### Detection Result (JSON)

```json
{
  "video": "sports_video.mp4",
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
      "athlete_name": "ZHANG Wei",
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

### Clip Summary (JSON)

```json
{
  "video": "sports_video.mp4",
  "total_clips": 12,
  "successful_clips": 12,
  "output_directory": "clips",
  "clip_mode": "subtitle_to_subtitle",
  "clips": [
    {
      "index": 1,
      "athlete1": "ZHANG Wei",
      "athlete2": "LI Ming",
      "country1": "CHN",
      "country2": "CHN",
      "start_time": "0:03:32",
      "duration": 170.0,
      "output_file": "clips/sports_video_01_ZHANG Wei-LI Ming.mp4"
    }
  ]
}
```

## Project Structure

```
sports-video-subtitle-detector/
├── README.md
├── README_CN.md              # Chinese documentation
├── LICENSE
├── .gitignore
├── config.json.example       # API key configuration template
├── run.sh                    # One-click automation script
├── ocr_ai_detector.py        # Main AI detection tool
├── clip_athletes.py          # Video clipping tool
├── clips/                    # Output clips directory
└── processed/                # Processed videos directory
```

## Supported AI Backends

| Backend | Model | Pros | Cons |
|:---|:---|:---|:---|
| Zhipu GLM | glm-4v-flash | Free tier, good Chinese support | Rate limits |
| Claude | claude-sonnet-4 | High accuracy, fast | Paid only |

## Requirements

- Python 3.8+
- OpenCV
- NumPy
- FFmpeg
- zhipuai (for Zhipu GLM)
- anthropic (optional, for Claude)

## License

MIT License

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.
