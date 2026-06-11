# CLAUDE.md — GymClip Reviewer（体操比赛视频审核工具）

> 桌面 App：导入比赛长视频 → 字幕区域检测候选片段 → 人工审核/裁剪 → 批量导出。
> 不是通用剪辑器，核心是"快速定位运动员登场字幕片段并整理成可导出结果"。

## 仓库布局

| 路径 | 内容 |
|------|------|
| `desktop-app/gymclip-reviewer/` | 主应用：Electron + React 19 + Zustand + Vite + Tailwind，`electron/main.cjs` 入口 |
| `desktop-app/backend/` | Python 后端（`main.py` + `video_review_backend/`），PyInstaller 打包，`pytest` 测试 |
| `desktop-app/docs/`、`desktop-app/planning/` | 设计文档与重构计划 |
| `.github/workflows/` | `ci.yml` + `release.yml`（tag push 触发 mac+win 双平台发布） |
| `原始代码/`、`测试/`、`专利交底书/` 等根目录 | 历史/材料目录，与 App 开发无关，勿动 |

常用命令（在 `desktop-app/gymclip-reviewer/` 下）：`npm run electron:dev` 开发；`npm run lint`（tsc --noEmit）；e2e 用 Playwright；后端测试在 `desktop-app/backend/` 跑 `pytest`。

## 工作流

- **不随意建分支**：动手前先 `git status` + `git branch` 查当前分支和未提交改动；仓库长期存在多条 `feat/*`、`refactor/*` 并行分支。
- **大重构方案必须主动给回退策略**：多层回退矩阵（中途放弃 / 已合并未发 / 已 tag 未推用户 / 已推用户，每层带具体命令）+ 数据兼容性陷阱清单（localStorage / 配置 schema 等"代码能回、数据回不来"的点）。用户是单人开发者，看不到安全网不会放手做。

## UI 铁律：审片时绝不遮挡视频

任何"边看视频边填写"的表单（运动员卡片补录、片段元数据、成绩输入）：

- 内嵌在右侧卡片栏（inline form / in-place edit），**绝不使用 Modal / Dialog / Overlay**
- 不引入 `position: fixed` 全屏覆盖层，不挪动或缩小视频播放区
- 表单输入框获焦时 `stopPropagation`，防止空格/方向键与全局播放快捷键互吞——视频播放、暂停、进度条始终可用

## 成绩字段精度（文件名与一切展示位置统一）

| 字段 | 小数位 | 规则 |
|------|------|------|
| Difficulty (D) | 1 | 必填，如 `5.6` |
| Execution (E) | 3 | 必填，如 `8.100` |
| Bonus | 1 | **零值省略**，不出现在文件名 |
| Penalty | 1 | **零值省略**；后端不带负号 |
| Total | 3 | 必填，如 `13.700` |

文件名示例：`5.6+8.100=13.700`、加 Bonus `5.6+8.100+0.3=14.000`。实现在 `export_service.py::_build_score_formula`（`_format_score_precision` + `_is_zero_score`）。新增展示位置沿用同一规则。

## 发布 / CI 陷阱（已踩过，勿重犯）

- **electron-builder 发布认 `package.json` version，不认 git tag** → 打 rc/tag 前必须先 bump version，否则污染线上正式 Release
- **Windows 包只能走 CI**（PyInstaller 不交叉编译、ffmpeg.exe 须原生）：`release.yml` 的 `build-win` job，`needs: build-mac` 串行避免发布竞态
- **Win ffmpeg 不能用 `choco install ffmpeg-full`**（只放 shim，`shutil.which` 会把 shim 当真二进制打包）→ 用 gyan.dev FULL STATIC zip 加 PATH
- **win job 必须去掉 mac 的 `CSC_LINK` / `APPLE_*`**（mac 证书在 Win 上炸构建），`CSC_IDENTITY_AUTO_DISCOVERY=false` 出确定性未签名包

## 当前状态（2026-06 记，可能过时，以 git 为准）

- 分支 `feat/windows-build-win-ci`：`v1.4.0-rc.1` CI 全绿、产物已出，待真机测 .exe 后合 main
- 待决策：① AV1 弱机兜底（老 GPU 无硬解 → 审片代理流自动转 H.264，看真机测试定）② Windows 代码签名（未签名有 SmartScreen 警告 vs 买 Authenticode 证书）
