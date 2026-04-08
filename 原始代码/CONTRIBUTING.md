# Contributing

这个仓库当前最适合采用一套轻量但正规的 GitHub 工作流：`main` 保持稳定，所有开发都走分支，合并前走 PR 和基础检查。

## 分支策略

推荐分支约定：

- `main`
  - 当前稳定版本
  - 应始终保持可运行、可打包
- `codex/<topic>`
  - 由 Codex 驱动的大功能、重构或联调任务
- `feature/<topic>`
  - 常规新功能
- `fix/<topic>`
  - bug 修复
- `release/<version>`
  - 需要冻结和准备发布时再使用

建议：

- 不要直接在 `main` 上开发
- 一个分支只处理一类变更
- 分支尽量短命，做完尽快合并

## 日常开发流程

1. 更新本地 `main`

```bash
git checkout main
git pull origin main
```

2. 从 `main` 创建新分支

```bash
git checkout -b codex/export-folder-picker
```

3. 在分支上开发、验证

4. 提交变更

```bash
git add .
git commit -m "Add Electron export folder picker"
```

5. 推送到 GitHub

```bash
git push -u origin codex/export-folder-picker
```

6. 发起 Pull Request，合并回 `main`

## Commit 规范

当前阶段不需要引入很重的 Conventional Commits，但建议保持“动词 + 结果”的风格：

- `Add secure API key storage for Electron`
- `Fix clip timeline seek jitter`
- `Refactor backend media binary resolution`
- `Document GitHub workflow and release steps`

避免：

- `update`
- `fix stuff`
- `try`

## Pull Request 规范

每个 PR 尽量回答清楚这 4 件事：

- 解决了什么问题
- 为什么这样改
- 怎么验证
- 还有哪些边界或未完成项

建议：

- UI 变更附截图
- 行为变更附最小复现步骤
- 大改动拆成多个 PR，不要一次混很多目标

## Worktree 使用建议

当你需要并行处理多个任务时，用 `git worktree` 比频繁 `checkout` 更稳。

示例：

```bash
git worktree add ../gymclip-reviewer-win codex/windows-packaging
git worktree add ../gymclip-reviewer-ui codex/timeline-polish
```

适用场景：

- 一个功能还没做完，但要紧急修 bug
- 需要并行试验两个方案
- 想保留一个稳定目录继续测试，同时另开新功能

## Release 流程

当 `main` 到达一个“可试用 / 可发布”的状态时：

1. 确保 `main` 已合并所需 PR
2. 在本地重新验证关键流程
3. 打 tag

```bash
git checkout main
git pull origin main
git tag v0.1.0
git push origin v0.1.0
```

4. 在 GitHub Releases 发布安装包和更新说明

建议的版本节奏：

- `v0.x.y`
  - 产品早期阶段
- `v1.0.0`
  - 第一版稳定可对外使用

## 推荐的 GitHub 用法

- `Issues`
  - 管需求、bug、技术债、发布任务
- `Pull Requests`
  - 管代码评审和合并
- `Releases`
  - 管版本和安装包分发

建议的 issue 分类：

- `bug`
- `feature`
- `desktop`
- `backend`
- `frontend`
- `release`

## 当前 CI 范围

仓库已配置基础 CI，目标是尽早阻止明显回归：

- 前端 TypeScript 检查
- 前端生产构建
- 后端 Python 语法检查

当前 CI 还不覆盖：

- 真机视频处理回归
- Electron 打包产物验证
- Windows 构建验证

这些适合后续再补。

## 当前项目约束

- 根目录旧脚本仍保留给个人工作流使用，不强制纳入桌面端发布链路
- `desktop-app/` 是桌面客户端主线
- 任何会影响 `main` 稳定性的实验性改动，都应先放到独立分支

## 合并标准

一个分支可以合并回 `main`，至少应满足：

- 本地能跑通对应功能
- 相关构建或检查通过
- 没有把无关临时文件带进提交
- 变更范围和 PR 目标一致
