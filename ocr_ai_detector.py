#!/usr/bin/env python3
"""
智能字幕检测器 - 优化版

改进：
1. 采样频率 2 秒
2. 一次性读取所有帧（避免重复打开视频）
3. 智能去重（合并同一运动员的重复识别）
4. 过滤非运动员姓名的干扰

使用方法：
python3 ocr_ai_detector.py --video "视频.mp4"
"""

import cv2
import numpy as np
import os
import json
import argparse
import base64
import sys
import time
from datetime import timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed

# ============================================================
# API密钥配置
# ============================================================
DEFAULT_ZHIPU_API_KEY = "ffe92f4a26d24d35b421ddf0329b2852.MAomlItVln6BvTVj"
DEFAULT_ANTHROPIC_API_KEY = ""

CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")

# 尝试导入库
try:
    from zhipuai import ZhipuAI
    HAS_ZHIPU = True
    ZHIPU_IMPORT_ERROR = None
except ImportError as e:
    HAS_ZHIPU = False
    ZHIPU_IMPORT_ERROR = e

try:
    import anthropic
    HAS_ANTHROPIC = True
    ANTHROPIC_IMPORT_ERROR = None
except ImportError as e:
    HAS_ANTHROPIC = False
    ANTHROPIC_IMPORT_ERROR = e

# 采样间隔（秒）
SAMPLE_INTERVAL = 2.0
# 合并阈值（秒）- 同一运动员在此时间内的检测视为重复
MERGE_THRESHOLD = 8.0


def load_config():
    config = {}
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                config = json.load(f)
        except:
            pass
    return config


def extract_all_frames(video_path, sample_interval):
    """一次性提取所有采样帧"""
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return [], []

    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total_frames / fps

    # 计算采样时间点
    sample_times = np.arange(0, duration, sample_interval)
    frames = []
    frame_times = []

    print(f"读取视频帧 (共 {len(sample_times)} 个采样点)...", end=" ", flush=True)
    start_time = time.time()

    for time_sec in sample_times:
        frame_number = int(time_sec * fps)
        if frame_number >= total_frames:
            break

        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_number)
        ret, frame = cap.read()

        if ret:
            frames.append(frame)
            frame_times.append(time_sec)

    cap.release()
    elapsed = time.time() - start_time
    print(f"完成 ({elapsed:.1f}秒)")

    return frames, frame_times


def quick_subtitle_check(frame, bottom_ratio=0.3):
    """快速检查帧底部是否有字幕条"""
    if frame is None:
        return False, None

    h, w = frame.shape[:2]
    bottom_start = int(h * (1 - bottom_ratio))
    bottom_region = frame[bottom_start:, :]

    # 1. 转换到灰度图
    gray = cv2.cvtColor(bottom_region, cv2.COLOR_BGR2GRAY)

    # 2. 检测边缘（文字有明显的边缘）
    edges = cv2.Canny(gray, 50, 150)
    edge_ratio = np.sum(edges > 0) / (edges.shape[0] * edges.shape[1])

    if edge_ratio < 0.015:
        return False, None

    # 3. 检测亮度变化
    brightness_std = np.std(gray)
    if brightness_std < 15:
        return False, None

    # 4. 检测颜色变化
    hsv = cv2.cvtColor(bottom_region, cv2.COLOR_BGR2HSV)
    saturation_std = np.std(hsv[:, :, 1])
    if saturation_std < 10:
        return False, None

    # 5. 检测水平条形区域
    sobel_y = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=3)
    horizontal_edges = np.sum(np.abs(sobel_y) > 50) / (gray.shape[0] * gray.shape[1])
    if horizontal_edges < 0.01:
        return False, None

    return True, bottom_region


def ai_extract_info(client, image, ai_backend):
    """使用AI从图像中提取运动员信息"""
    encode_param = [int(cv2.IMWRITE_JPEG_QUALITY), 80]
    _, buffer = cv2.imencode('.jpg', image, encode_param)
    image_base64 = base64.b64encode(buffer).decode('utf-8')

    prompt = """分析这张体育赛事视频截图的底部字幕条区域。

任务：
1. 确认是否是运动员信息字幕条（必须有运动员姓名）
2. 提取运动员姓名（通常是 大写姓氏 + 名字 的格式，如 "ZHANG Wei"、"MARQUES Marcelo"）
3. 提取国家代码（3字母，如 CHN、BRA、USA、KOR、JPN）

重要：如果不是运动员字幕条（如广告、比分、解说文字），将 is_athlete_subtitle 设为 false。

请严格按以下JSON格式返回：
{
    "is_athlete_subtitle": true/false,
    "athlete_name": "运动员姓名",
    "country": "国家代码",
    "confidence": 0.9
}

只返回JSON，不要其他文字。"""

    try:
        if ai_backend == 'zhipu':
            response = client.chat.completions.create(
                model="glm-4v-flash",
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_base64}"}},
                            {"type": "text", "text": prompt}
                        ]
                    }
                ],
            )
            response_text = response.choices[0].message.content.strip()
        else:
            message = client.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=200,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": image_base64}},
                            {"type": "text", "text": prompt}
                        ],
                    }
                ],
            )
            response_text = message.content[0].text.strip()

        # 解析JSON
        if "```" in response_text:
            parts = response_text.split("```")
            for part in parts:
                if "{" in part and "}" in part:
                    response_text = part
                    break
            if response_text.startswith("json"):
                response_text = response_text[4:]

        result = json.loads(response_text)

        # 处理AI返回列表的情况
        if isinstance(result, list):
            if result and isinstance(result[0], dict):
                result = result[0]
            else:
                result = {"is_athlete_subtitle": False}

        # 处理列表类型的字段
        for key in ['athlete_name', 'country']:
            if key in result and isinstance(result[key], list):
                result[key] = str(result[key][0]) if result[key] else ''

        return result

    except json.JSONDecodeError:
        return {"is_athlete_subtitle": False, "error": "JSON解析失败"}
    except Exception as e:
        return {"is_athlete_subtitle": False, "error": str(e)}


def is_valid_athlete_name(name):
    """检查是否是有效的运动员姓名"""
    if not name or len(name) < 3:
        return False

    # 过滤常见的干扰词
    invalid_keywords = [
        'final', 'semi', 'round', 'heat', 'group', 'stage',
        'score', 'rank', 'medal', 'gold', 'silver', 'bronze',
        'china', 'japan', 'korea', 'brazil', 'usa', 'team',
        '男子', '女子', '决赛', '半决赛', '预赛', '决赛',
        '比赛', '分数', '得分', '总分', '成绩', '排名',
        '第', '名', '分', '秒', '米', '公斤'
    ]

    name_lower = name.lower()
    for keyword in invalid_keywords:
        if keyword in name_lower:
            return False

    # 运动员姓名通常包含空格或至少2个单词部分
    # 或者是纯大写字母开头
    words = name.replace('-', ' ').split()
    if len(words) >= 2:
        return True

    # 单个词但符合姓名格式（首字母大写或全大写）
    if name[0].isupper() or name.isupper():
        return True

    return False


def merge_detections(detections, merge_threshold=MERGE_THRESHOLD):
    """合并重复检测"""
    if not detections:
        return []

    # 按时间排序
    detections = sorted(detections, key=lambda x: x['time_seconds'])

    merged = []
    current = detections[0].copy()
    current['start_seconds'] = current['time_seconds']
    current['end_seconds'] = current['time_seconds']
    current['count'] = 1

    for det in detections[1:]:
        gap = det['time_seconds'] - current['end_seconds']

        # 检查是否是同一运动员（名字相似）
        current_name = current.get('athlete_name', '').upper().strip()
        det_name = det.get('athlete_name', '').upper().strip()

        # 姓名匹配：完全相同或包含关系
        same_athlete = (current_name == det_name or
                       current_name in det_name or
                       det_name in current_name or
                       # 姓氏相同（第一个词）
                       (current_name.split()[0] if current_name.split() else '') == (det_name.split()[0] if det_name.split() else ''))

        if gap <= merge_threshold and same_athlete:
            # 合并到当前组
            current['end_seconds'] = det['time_seconds']
            current['count'] += 1
            # 保留更完整的名字
            if len(det_name) > len(current_name):
                current['athlete_name'] = det['athlete_name']
                current['country'] = det.get('country', current.get('country', ''))
        else:
            # 保存当前组，开始新组
            current['duration'] = current['end_seconds'] - current['start_seconds'] + SAMPLE_INTERVAL
            merged.append(current)
            current = det.copy()
            current['start_seconds'] = det['time_seconds']
            current['end_seconds'] = det['time_seconds']
            current['count'] = 1

    # 保存最后一组
    current['duration'] = current['end_seconds'] - current['start_seconds'] + SAMPLE_INTERVAL
    merged.append(current)

    return merged


def main():
    parser = argparse.ArgumentParser(description='智能字幕检测器（优化版）')
    parser.add_argument('--video', '-v', type=str, required=True, help='视频文件路径')
    parser.add_argument('--output', '-o', type=str, default=None, help='输出JSON文件')
    parser.add_argument('--api-key', '-k', type=str, default=None, help='API密钥')
    parser.add_argument('--ai', '-a', type=str, default='zhipu', choices=['claude', 'zhipu'])
    parser.add_argument('--interval', '-i', type=float, default=SAMPLE_INTERVAL, help='采样间隔（秒）')
    parser.add_argument('--start', '-s', type=float, default=0, help='开始时间（秒）')
    parser.add_argument('--end', '-e', type=float, default=None, help='结束时间（秒）')
    parser.add_argument('--skip-check', action='store_true', help='跳过颜色预检查')
    parser.add_argument('--threads', '-t', type=int, default=3, help='并行API调用线程数')

    args = parser.parse_args()

    if not os.path.exists(args.video):
        print(f"错误: 找不到视频文件: {args.video}")
        return 1

    # 获取视频信息
    cap = cv2.VideoCapture(args.video)
    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    duration = total_frames / fps
    cap.release()

    print("=" * 60)
    print("智能字幕检测器（优化版）")
    print("=" * 60)
    print(f"视频: {args.video}")
    print(f"分辨率: {width}x{height}")
    print(f"时长: {str(timedelta(seconds=int(duration)))} ({duration/60:.1f}分钟)")
    print(f"采样间隔: {args.interval}秒")
    print(f"并行线程: {args.threads}")

    # 初始化AI客户端
    config = load_config()
    client = None

    if args.ai == 'zhipu':
        api_key = (args.api_key or os.environ.get('ZHIPUAI_API_KEY') or
                   config.get('zhipu_api_key') or DEFAULT_ZHIPU_API_KEY)
        if not api_key:
            print("错误: 请配置智谱API密钥")
            return 1
        if not HAS_ZHIPU:
            print(f"错误: 智谱 SDK 导入失败: {ZHIPU_IMPORT_ERROR}")
            print("请先安装缺失依赖，例如: python3 -m pip install sniffio zhipuai")
            return 1
        client = ZhipuAI(api_key=api_key)
        print("AI后端: 智谱GLM-4V")
    else:
        api_key = (args.api_key or os.environ.get('ANTHROPIC_API_KEY') or
                   config.get('anthropic_api_key') or DEFAULT_ANTHROPIC_API_KEY)
        if not api_key:
            print("错误: 请配置Claude API密钥")
            return 1
        if not HAS_ANTHROPIC:
            print(f"错误: Claude SDK 导入失败: {ANTHROPIC_IMPORT_ERROR}")
            print("请先安装缺失依赖，例如: python3 -m pip install anthropic")
            return 1
        client = anthropic.Anthropic(api_key=api_key)
        print("AI后端: Claude")

    print("-" * 60)

    # 1. 一次性读取所有帧
    frames, frame_times = extract_all_frames(args.video, args.interval)

    if not frames:
        print("错误: 无法读取视频帧")
        return 1

    # 2. 预检查过滤
    print(f"预检查过滤...", end=" ", flush=True)
    check_start = time.time()

    candidates = []
    for frame, time_sec in zip(frames, frame_times):
        # 时间范围过滤
        if time_sec < args.start:
            continue
        if args.end and time_sec > args.end:
            continue

        if args.skip_check:
            h = frame.shape[0]
            bottom_region = frame[int(h*0.7):, :]
            candidates.append((time_sec, bottom_region))
        else:
            has_subtitle, bottom_region = quick_subtitle_check(frame)
            if has_subtitle:
                candidates.append((time_sec, bottom_region))

    check_elapsed = time.time() - check_start
    print(f"完成 ({check_elapsed:.1f}秒)")
    print(f"采样帧数: {len(frames)}, 预检查通过: {len(candidates)}")

    # 3. 并行AI检测
    print(f"AI检测中 ({len(candidates)} 帧, {args.threads} 线程)...")

    detections = []
    completed = 0

    def process_frame(item):
        time_sec, bottom_region = item
        result = ai_extract_info(client, bottom_region, args.ai)
        return time_sec, result

    with ThreadPoolExecutor(max_workers=args.threads) as executor:
        futures = {executor.submit(process_frame, item): item for item in candidates}

        for future in as_completed(futures):
            completed += 1
            time_sec, result = future.result()

            # 显示进度
            progress = f"[{completed}/{len(candidates)}]"
            if result.get('is_athlete_subtitle'):
                name = result.get('athlete_name', '?')
                country = result.get('country', '?')
                print(f"\r{progress} ✓ {name} [{country}]   ", end="", flush=True)

                # 验证运动员姓名
                if is_valid_athlete_name(name):
                    detections.append({
                        'time_seconds': float(time_sec),
                        'timestamp': str(timedelta(seconds=int(time_sec))),
                        'athlete_name': name,
                        'country': country,
                        'confidence': result.get('confidence', 0)
                    })
            else:
                print(f"\r{progress} 处理中...        ", end="", flush=True)

    print(f"\n{'-' * 60}")

    # 4. 合并重复检测
    print(f"合并重复检测 (阈值: {MERGE_THRESHOLD}秒)...")
    merged = merge_detections(detections, MERGE_THRESHOLD)

    # 过滤：至少被检测到2次才算有效
    filtered = [m for m in merged if m.get('count', 1) >= 2]

    print(f"原始检测: {len(detections)}, 合并后: {len(merged)}, 过滤后: {len(filtered)}")

    # 5. 保存结果
    output_file = args.output or f"{os.path.splitext(args.video)[0]}_smart_subtitles.json"

    output_data = {
        'video': os.path.basename(args.video),
        'resolution': f"{width}x{height}",
        'duration': duration,
        'sample_interval': args.interval,
        'stats': {
            'total_samples': len(frames),
            'precheck_passed': len(candidates),
            'raw_detections': len(detections),
            'after_merge': len(merged),
            'final_count': len(filtered)
        },
        'total_subtitles': len(filtered),
        'subtitles': filtered
    }

    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, ensure_ascii=False, indent=2)

    # 6. 输出结果
    print(f"\n检测完成！")
    print(f"结果保存: {output_file}")

    if filtered:
        print("\n运动员列表:")
        for sub in filtered:
            name = sub.get('athlete_name', '?')
            country = sub.get('country', '?')
            t = sub.get('timestamp', '?')
            count = sub.get('count', 1)
            dur = sub.get('duration', 0)
            print(f"  [{t}] {name} [{country}] (检测{count}次, 持续{dur:.0f}s)")

    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
