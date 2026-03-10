#!/bin/bash
# 体育视频自动处理脚本
# 自动执行：检测字幕 → 剪辑视频 → 移动原视频到已处理文件夹

set -e

echo "============================================================"
echo "           体育视频自动处理工具"
echo "============================================================"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 查找视频文件
find_video() {
    for ext in mp4 avi mkv mov flv wmv MP4 AVI MKV MOV; do
        if ls *.$ext 2>/dev/null | head -1 > /dev/null; then
            ls *.$ext 2>/dev/null | head -1
            return 0
        fi
    done
    return 1
}

# 查找视频文件（排除 clips 和 processed 目录）
VIDEO=$(find_video | grep -v "^clips/" | grep -v "^processed/" | head -1)

if [ -z "$VIDEO" ]; then
    echo -e "${RED}错误: 当前目录没有找到视频文件${NC}"
    echo "请将视频文件放在脚本所在目录"
    echo ""
    echo "支持的视频格式: .mp4, .avi, .mkv, .mov, .flv, .wmv"
    exit 1
fi

echo -e "${GREEN}找到视频: $VIDEO${NC}"
echo ""

# 获取视频信息
DURATION=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$VIDEO" 2>/dev/null)
DURATION_MIN=$(echo "scale=1; $DURATION / 60" | bc)
echo "视频时长: ${DURATION_MIN} 分钟"
echo "------------------------------------------------------------"

# 询问是否继续
read -p "按 Enter 键开始处理，或按 Ctrl+C 取消..."

# 步骤 1: AI 检测字幕
echo ""
echo -e "${YELLOW}[步骤 1/2] AI 检测运动员字幕...${NC}"
echo "------------------------------------------------------------"

if ! python3 ocr_ai_detector.py -v "$VIDEO"; then
    echo -e "${RED}检测失败，请检查错误信息${NC}"
    exit 1
fi

# 步骤 2: 剪辑视频
echo ""
echo -e "${YELLOW}[步骤 2/2] 剪辑视频片段...${NC}"
echo "------------------------------------------------------------"

if ! python3 clip_athletes.py -c; then
    echo -e "${RED}剪辑失败，请检查错误信息${NC}"
    exit 1
fi

# 创建已处理文件夹
PROCESSED_DIR="processed"
mkdir -p "$PROCESSED_DIR"

# 移动原视频到已处理文件夹
echo ""
echo -e "${YELLOW}移动原视频到 processed 文件夹...${NC}"
mv "$VIDEO" "$PROCESSED_DIR/"

# 同时移动对应的 JSON 文件
VIDEO_NAME="${VIDEO%.*}"
for json_file in "${VIDEO_NAME}"*_subtitles.json; do
    if [ -f "$json_file" ]; then
        mv "$json_file" "$PROCESSED_DIR/"
    fi
done

echo ""
echo "============================================================"
echo -e "${GREEN}处理完成！${NC}"
echo "============================================================"
echo ""
echo "结果文件:"
echo "  - 剪辑片段: clips/"
echo "  - 原视频:   processed/$VIDEO"
echo ""
echo "现在可以放入新的视频文件，再次运行 ./run.sh"
echo "============================================================"
