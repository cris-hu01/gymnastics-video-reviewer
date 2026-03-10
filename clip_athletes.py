#!/usr/bin/env python3
"""
视频自动剪辑工具
根据字幕检测结果，自动剪辑每个字幕片段

使用方法：
python3 clip_athletes.py                    # 自动识别视频和JSON文件
python3 clip_athletes.py --video "视频.mp4" # 指定视频文件
"""

import json
import subprocess
import os
import glob
import argparse
import re
import sys
from datetime import timedelta

# 支持的视频格式
VIDEO_EXTENSIONS = ['*.mp4', '*.avi', '*.mkv', '*.mov', '*.flv', '*.wmv']

# 默认输出目录
DEFAULT_OUTPUT_DIR = "clips"


def get_video_duration(video_path):
    """获取视频总时长（秒）"""
    try:
        result = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'default=noprint_wrappers=1:nokey=1', video_path],
            capture_output=True, text=True
        )
        return float(result.stdout.strip())
    except:
        return None


def find_video_files():
    """查找当前目录下的视频文件"""
    videos = []
    for ext in VIDEO_EXTENSIONS:
        videos.extend(glob.glob(ext))
    # 排除已剪辑的文件（clips目录下的）
    videos = [v for v in videos if not v.startswith('clips/')]
    return sorted(videos)


def find_json_for_video(video_path):
    """查找视频对应的字幕检测JSON文件"""
    # 1. 优先查找 视频名_subtitles.json
    video_name = os.path.splitext(video_path)[0]
    json_file = f"{video_name}_subtitles.json"
    if os.path.exists(json_file):
        return json_file

    # 2. 查找 视频名_smart_subtitles.json
    json_file = f"{video_name}_smart_subtitles.json"
    if os.path.exists(json_file):
        return json_file

    # 3. 查找任意 *_subtitles.json 文件
    json_files = glob.glob('*_subtitles.json')
    if json_files:
        # 优先选择最近修改的
        json_files.sort(key=lambda x: os.path.getmtime(x), reverse=True)
        return json_files[0]

    return None


def auto_detect_files():
    """自动检测视频和JSON文件"""
    # 查找视频文件
    videos = find_video_files()

    if not videos:
        return None, None

    if len(videos) == 1:
        video = videos[0]
    else:
        # 多个视频时，选择最大的（通常是主视频）
        videos.sort(key=lambda x: os.path.getsize(x), reverse=True)
        video = videos[0]

    # 查找对应的JSON文件
    json_file = find_json_for_video(video)

    return video, json_file


def parse_time_to_seconds(time_str):
    """将时间字符串转换为秒数"""
    if isinstance(time_str, (int, float)):
        return float(time_str)

    parts = time_str.split(':')
    if len(parts) == 3:
        hours, minutes, seconds = int(parts[0]), int(parts[1]), float(parts[2])
    elif len(parts) == 2:
        hours, minutes, seconds = 0, int(parts[0]), float(parts[1])
    else:
        return float(time_str)
    return hours * 3600 + minutes * 60 + seconds


def seconds_to_timestamp(seconds):
    """将秒数转换为ffmpeg使用的时间戳格式"""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = seconds % 60
    return f"{hours:02d}:{minutes:02d}:{secs:05.2f}"


def format_duration(seconds):
    """格式化时长显示"""
    minutes = int(seconds // 60)
    secs = seconds % 60
    if minutes > 0:
        return f"{minutes}分{secs:.0f}秒"
    return f"{secs:.0f}秒"


def main():
    parser = argparse.ArgumentParser(description='视频自动剪辑工具')
    parser.add_argument('--input', '-i', type=str, default=None, help='字幕检测结果JSON文件（默认自动检测）')
    parser.add_argument('--video', '-v', type=str, default=None, help='视频文件路径（默认自动检测）')
    parser.add_argument('--output', '-o', type=str, default=DEFAULT_OUTPUT_DIR, help='输出目录')
    parser.add_argument('--padding', '-p', type=float, default=2.0, help='剪辑前后留白时间(秒)')
    parser.add_argument('--fast', '-f', action='store_true', help='快速模式（较低质量，更快速度）')
    parser.add_argument('--copy', '-c', action='store_true', help='直接复制流（最快，无需重编码，但精确度略低）')
    parser.add_argument('--hwaccel', action='store_true', help='启用硬件加速（macOS VideoToolbox / NVIDIA NVENC）')

    args = parser.parse_args()

    # 自动检测视频和JSON文件
    if args.video is None or args.input is None:
        auto_video, auto_json = auto_detect_files()

        if args.video is None:
            args.video = auto_video
            if args.video:
                print(f"自动检测到视频: {args.video}")

        if args.input is None:
            args.input = auto_json
            if args.input:
                print(f"自动检测到JSON: {args.input}")

    # 检查文件
    if not args.video:
        print("错误: 未找到视频文件")
        print("请使用 -v 参数指定视频文件，或将视频放在当前目录")
        return 1

    if not args.input:
        print("错误: 未找到字幕检测结果文件")
        print("请先运行 ocr_ai_detector.py 检测字幕")
        return 1

    if not os.path.exists(args.video):
        print(f"错误: 找不到视频文件: {args.video}")
        return 1

    if not os.path.exists(args.input):
        print(f"错误: 找不到字幕检测结果文件: {args.input}")
        print("请先运行 ocr_ai_detector.py 检测字幕")
        return 1

    # 创建输出目录
    os.makedirs(args.output, exist_ok=True)

    # 读取字幕检测结果
    with open(args.input, 'r', encoding='utf-8') as f:
        data = json.load(f)

    # 获取视频文件名（不含扩展名）
    video_name = os.path.splitext(os.path.basename(args.video))[0]

    # 获取字幕列表
    if 'subtitles' in data:
        subtitles = data['subtitles']
    elif 'all_frames' in data:
        # 如果是原始帧数据，需要分组
        subtitles = data.get('subtitles', [])
    else:
        print("错误: JSON文件格式不正确")
        return 1

    if not subtitles:
        print("没有检测到字幕时间段")
        return 1

    # 获取视频总时长
    video_duration = get_video_duration(args.video)
    if video_duration:
        print(f"视频总时长: {format_duration(video_duration)}")

    # 提取每个字幕的开始时间
    subtitle_times = []
    for sub in subtitles:
        start = sub.get('start_seconds', parse_time_to_seconds(sub.get('start_time', 0)))
        subtitle_times.append({
            'start': start,
            'info': sub
        })

    # 按时间排序
    subtitle_times.sort(key=lambda x: x['start'])

    print("=" * 60)
    print("视频自动剪辑工具")
    print("=" * 60)
    print(f"视频文件: {args.video}")
    print(f"字幕检测: {args.input}")
    print(f"输出目录: {args.output}/")
    print(f"共发现 {len(subtitle_times)} 个字幕片段")
    print("-" * 60)

    # 计算每个片段的时间范围（从当前字幕到下一个字幕）
    clip_ranges = []
    for i, item in enumerate(subtitle_times):
        start = item['start']
        # 下一个字幕的开始时间和信息
        if i + 1 < len(subtitle_times):
            end = subtitle_times[i + 1]['start']
            next_info = subtitle_times[i + 1]['info']
        elif video_duration:
            end = video_duration
            next_info = None
        else:
            # 如果无法获取视频时长，使用默认时长
            end = start + 60  # 默认60秒
            next_info = None

        clip_ranges.append({
            'start': start,
            'end': end,
            'duration': end - start,
            'info': item['info'],
            'next_info': next_info
        })

    # 显示剪辑计划
    for i, clip in enumerate(clip_ranges, 1):
        timestamp = seconds_to_timestamp(clip['start'])
        print(f"[{i:02d}] {timestamp} | 时长: {format_duration(clip['duration'])}")

    print("-" * 60)

    # 显示编码模式
    if args.copy:
        print("编码模式: 直接复制 (最快，无需重编码)")
    elif args.hwaccel:
        print("编码模式: 硬件加速 (macOS VideoToolbox)")
    elif args.fast:
        print("编码模式: 快速软编码 (ultrafast)")
    else:
        print("编码模式: 标准软编码 (fast preset)")

    print("开始剪辑...")

    # 检查ffmpeg
    try:
        subprocess.run(['ffmpeg', '-version'], capture_output=True, check=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("错误: 未安装ffmpeg")
        print("安装方法:")
        print("  macOS: brew install ffmpeg")
        print("  Ubuntu: sudo apt install ffmpeg")
        return 1

    # 剪辑每个片段
    success_count = 0
    clips_info = []

    for i, clip in enumerate(clip_ranges, 1):
        start = clip['start']
        end = clip['end']
        duration = clip['duration']
        sub_info = clip['info']

        # 添加前后留白
        start_with_padding = max(0, start - args.padding)
        # 结束时间不需要加padding，因为是到下一个字幕的开始
        duration_with_padding = duration + args.padding  # 只在前面加padding

        # 生成输出文件名（结合两个运动员名字）
        timestamp_str = seconds_to_timestamp(start).replace(':', '-')
        athlete1 = sub_info.get('athlete_name', '')
        athlete2 = clip.get('next_info', {}).get('athlete_name', '') if clip.get('next_info') else ''

        # 清理文件名中的特殊字符
        def clean_name(name):
            return re.sub(r'[^\w\s-]', '', name).strip()[:15]

        if athlete1 and athlete2:
            # 有两个运动员：A-B
            name1 = clean_name(athlete1)
            name2 = clean_name(athlete2)
            output_file = f"{args.output}/{video_name}_{i:02d}_{name1}-{name2}.mp4"
        elif athlete1:
            # 只有一个运动员（最后一个片段）
            name1 = clean_name(athlete1)
            output_file = f"{args.output}/{video_name}_{i:02d}_{name1}.mp4"
        else:
            # 没有运动员名字
            output_file = f"{args.output}/{video_name}_clip{i:02d}_t{timestamp_str}.mp4"

        start_ts = seconds_to_timestamp(start_with_padding)

        # 构建 ffmpeg 命令
        if args.copy:
            # 直接复制流，最快但精确度略低
            cmd = [
                'ffmpeg',
                '-y',
                '-ss', start_ts,
                '-i', args.video,
                '-t', str(duration_with_padding),
                '-c', 'copy',  # 直接复制，不重编码
                '-avoid_negative_ts', 'make_zero',
                '-loglevel', 'warning',
                output_file
            ]
        elif args.hwaccel:
            # 硬件加速 (macOS VideoToolbox)
            cmd = [
                'ffmpeg',
                '-y',
                '-ss', start_ts,
                '-i', args.video,
                '-t', str(duration_with_padding),
                '-c:v', 'h264_videotoolbox',  # macOS 硬件编码
                '-c:a', 'aac',
                '-q:v', '65',  # 质量参数
                '-avoid_negative_ts', 'make_zero',
                '-loglevel', 'warning',
                output_file
            ]
        elif args.fast:
            # 快速模式 (ultrafast preset)
            cmd = [
                'ffmpeg',
                '-y',
                '-ss', start_ts,
                '-i', args.video,
                '-t', str(duration_with_padding),
                '-c:v', 'libx264',
                '-preset', 'ultrafast',  # 最快预设
                '-crf', '23',
                '-c:a', 'aac',
                '-avoid_negative_ts', 'make_zero',
                '-loglevel', 'warning',
                output_file
            ]
        else:
            # 默认模式 (平衡质量和速度)
            cmd = [
                'ffmpeg',
                '-y',
                '-ss', start_ts,
                '-i', args.video,
                '-t', str(duration_with_padding),
                '-c:v', 'libx264',
                '-preset', 'fast',  # 快速预设
                '-crf', '23',
                '-c:a', 'aac',
                '-avoid_negative_ts', 'make_zero',
                '-loglevel', 'warning',
                output_file
            ]

        athlete_display = f"{athlete1} - {athlete2}" if (athlete1 and athlete2) else (athlete1 if athlete1 else f"片段{i}")
        print(f"\n[{i}/{len(clip_ranges)}] 正在剪辑: {athlete_display}")

        try:
            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.returncode == 0:
                print(f"    ✓ 成功: {output_file}")
                success_count += 1
                clips_info.append({
                    'index': i,
                    'athlete1': athlete1,
                    'athlete2': athlete2,
                    'country1': sub_info.get('country', ''),
                    'country2': clip.get('next_info', {}).get('country', '') if clip.get('next_info') else '',
                    'start_time': seconds_to_timestamp(start),
                    'start_seconds': start,
                    'end_seconds': end,
                    'duration': duration,
                    'output_file': output_file
                })
            else:
                print(f"    ✗ 失败: {result.stderr.strip()}")
        except Exception as e:
            print(f"    ✗ 错误: {e}")

    print("\n" + "=" * 60)
    print(f"剪辑完成！成功: {success_count}/{len(clip_ranges)}")
    print(f"输出目录: {args.output}/")
    print("=" * 60)

    # 保存剪辑信息
    summary = {
        "video": args.video,
        "source_json": args.input,
        "total_clips": len(clip_ranges),
        "successful_clips": success_count,
        "output_directory": args.output,
        "padding_seconds": args.padding,
        "clip_mode": "subtitle_to_subtitle",
        "clips": clips_info
    }

    summary_file = f"{args.output}/clips_summary.json"
    with open(summary_file, 'w', encoding='utf-8') as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    print(f"剪辑信息已保存到: {summary_file}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
