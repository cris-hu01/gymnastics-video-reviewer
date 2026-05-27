# GymClip Reviewer 发版手册（macOS 签名 + 公证 + 自动更新）

本文档面向**发布操作人员**，覆盖：

1. 申请 Apple Developer ID 证书 / app-specific password / team ID
2. 在 GitHub 仓库配置发版所需 Secrets
3. 首次发版（rc → 正式）流程
4. 排错与回退手册

> 工程上：tag 推上去 → `.github/workflows/release.yml` 跑 `electron-builder --mac --publish always`
> → 在 GitHub Release 自动创建带签名公证的 dmg/zip 和 `latest-mac.yml` →
> 已安装客户端通过 `electron-updater` 自动检测、下载、就绪后弹「重启更新」toast。
> 整个链路除了首次配 Secrets，**不需要手动签名/上传**。

---

## 1. 一次性准备：Apple 开发者侧

### 1.1 申请 Developer ID Application 证书

需要的前提：Apple Developer Program 个人账号已激活（USD 99/year）。

1. 打开 [https://developer.apple.com/account/resources/certificates/list](https://developer.apple.com/account/resources/certificates/list)
2. 点击右上角 `+`，在分类里选 **Developer ID Application**（不是 Mac App Distribution，也不是 Apple Development）
   - 用途：用于在 App Store 外分发的桌面 app 签名。
3. 在本地 macOS 上打开「钥匙串访问」（Keychain Access）
4. 菜单：钥匙串访问 → 证书助理 → **从证书颁发机构请求证书...**
   - 用户邮件地址：填 Apple Developer 账号邮箱
   - 常用名称：随便（例如 `Cris Hu Dev ID`）
   - CA 邮件地址：留空
   - 请求方式：选「存储到磁盘」
   - 生成 `CertificateSigningRequest.certSigningRequest` 文件
5. 回到 developer.apple.com 上传这个 CSR 文件 → 下载得到的 `developerID_application.cer`
6. 双击 `.cer` 安装到钥匙串「登录」keychain

### 1.2 导出 p12 证书

CI 不能用钥匙串里的私钥，需要导出成 `.p12` 文件（包含私钥）：

1. 钥匙串访问 → 左侧选「登录」 keychain → 上方分类选「我的证书」（My Certificates）
2. 找到 `Developer ID Application: <你的名字> (<TEAM_ID>)`
3. 右键 → 「导出 "Developer ID Application: ..."」
4. 文件格式：**个人信息交换 (.p12)**
5. 保存到本地（例如 `~/Desktop/gymclip-cert.p12`）
6. 设置一个密码（**记牢**，后面配 `CSC_KEY_PASSWORD` 用）
7. macOS 会再问一次钥匙串密码确认导出

> 安全提醒：`.p12` 文件本身和密码都是私钥，**绝不要 commit 到 git**。

### 1.3 生成 App-Specific Password（公证用）

公证服务 `notarytool` 要求用 app-specific password，而不是 Apple ID 原始密码。

1. 打开 [https://appleid.apple.com/account/manage](https://appleid.apple.com/account/manage)
2. 登录 → 「登录与安全」 → 「专用密码」（App-Specific Passwords）
3. 点击「+」生成一个新的，标签写 `gymclip-notarize`
4. 系统会给一个 `xxxx-xxxx-xxxx-xxxx` 格式的密码，**只显示这一次**
5. 这就是后面 `APPLE_APP_SPECIFIC_PASSWORD` 的值

### 1.4 查找 Apple Team ID

1. 打开 [https://developer.apple.com/account](https://developer.apple.com/account)
2. 左侧菜单 → **Membership Details**
3. 找到 `Team ID`，10 位大写字母数字（例如 `ABCDE12345`）
4. 这就是后面 `APPLE_TEAM_ID`

同时需要把这个 Team ID 写回 `desktop-app/gymclip-reviewer/package.json` 的 `build.mac.notarize.teamId`，把占位符 `REPLACE_WITH_APPLE_TEAM_ID` 替换掉。或者通过 CI env 注入也行。

---

## 2. 一次性准备：GitHub Secrets

仓库 → Settings → Secrets and variables → Actions → New repository secret

| Secret 名 | 内容 | 来源 |
|---|---|---|
| `APPLE_ID` | Apple 开发者账号邮箱 | 你自己的 Apple ID |
| `APPLE_APP_SPECIFIC_PASSWORD` | `xxxx-xxxx-xxxx-xxxx` | 第 1.3 步生成 |
| `APPLE_TEAM_ID` | 10 位大写字母数字 | 第 1.4 步查询 |
| `CSC_LINK` | p12 的 base64 文本 | 见下面命令 |
| `CSC_KEY_PASSWORD` | 导出 p12 时设置的密码 | 第 1.2 步设置 |
| `SENTRY_AUTH_TOKEN` | Sentry 上传 sourcemap 用 | sentry.io account |
| `SENTRY_ORG` | Sentry org slug | sentry.io project settings |
| `SENTRY_DSN_ELECTRON` | Electron main process DSN | sentry.io |
| `SENTRY_DSN_BACKEND` | Python backend DSN | sentry.io |
| `VITE_SENTRY_DSN_FRONTEND` | renderer DSN | sentry.io |

注：`GH_TOKEN`（electron-builder 发布到 GitHub Release 用）**不需要手动配**，workflow 里用 `${{ secrets.GITHUB_TOKEN }}` 自动注入即可。

### 把 p12 转成 base64

```bash
# 在本地 macOS 上跑
base64 -i ~/Desktop/gymclip-cert.p12 -o ~/Desktop/gymclip-cert.p12.b64
# 然后把 .b64 文件的全部内容复制粘贴到 GitHub Secret CSC_LINK
cat ~/Desktop/gymclip-cert.p12.b64 | pbcopy
```

electron-builder 看到 `CSC_LINK` 是 base64 文本会自动 decode 成 p12。如果是 https://... 链接也支持，但 Secret 直接放 base64 文本最简单。

### Sentry token 生成

1. [https://sentry.io](https://sentry.io) → User Settings → Auth Tokens → Create New Token
2. Scope 勾：`project:releases`、`org:read`、`project:read`
3. 取一个名字（例如 `gymclip-ci`），保存
4. 复制 token 到 `SENTRY_AUTH_TOKEN`

---

## 3. 首次发版流程

### 3.1 替换 Team ID 占位符

```bash
# 编辑 desktop-app/gymclip-reviewer/package.json
# 把 "teamId": "REPLACE_WITH_APPLE_TEAM_ID" 改成真实 Team ID
```

提交一个 commit：`chore(release): set apple team id`

### 3.2 打 RC tag

```bash
git checkout main
git pull
git tag v1.3.0-rc.1
git push origin v1.3.0-rc.1
```

push 后：

- 进入仓库 Actions tab，能看到 `Release` workflow 自动跑起来（trigger: tag `v*`）
- 阶段：install → build frontend → PyInstaller backend → build:media-tools → build:oss-tools → `electron-builder --mac --publish always`
- 整个流程在 macos-latest runner 上大约 15-25 分钟
- 公证阶段（notarytool submit）单独可能 5-10 分钟，是 Apple 服务端排队

### 3.3 等 Release workflow 完成

1. 完成后进 Releases 页面，能看到自动创建的 `v1.3.0-rc.1` release
2. Asset 应该包含：
   - `GymClip Reviewer-1.3.0-rc.1-arm64.dmg`
   - `GymClip Reviewer-1.3.0-rc.1-arm64-mac.zip`
   - `latest-mac.yml`（electron-updater 必须文件，描述当前最新版本）
   - `*.blockmap`（差分下载用）

### 3.4 干净 Mac 验证签名 + 公证

在一台**没有装过开发者证书**的 macOS（最好不是日常开发机），下载 dmg：

```bash
# 解压 dmg 后定位到 .app
spctl -a -vvv -t install "/Volumes/GymClip Reviewer/GymClip Reviewer.app"
# 期望输出包含 "accepted" 和 "Notarized Developer ID"
```

如果输出 `rejected` 或 `Notarized Developer ID, but ...`，去 `xcrun notarytool log <submission-id>` 看具体原因（见第 5 节）。

打开 app：双击 dmg，把 app 拖进 Applications，再双击启动 —— 应该**不弹**「无法验证开发者」对话框。如果弹了，说明签名/公证有问题。

### 3.5 跨版本 autoUpdater 联调

为了测自动更新，需要至少两个版本：

1. 装上 `v1.3.0-rc.1` 客户端
2. 把 main 分支上的 `package.json` `version` 改成 `v1.3.0-rc.2`，打 tag push
3. 等 release.yml 跑完，看 `v1.3.0-rc.2` release 出现
4. 回到装着 rc.1 的客户端，等几秒（`autoUpdater.checkForUpdatesAndNotify` 在 whenReady 后会自动跑）
5. 应该看到右下角弹 `UpdateToast`：「正在下载新版本 v1.3.0-rc.2...」 → 下载进度条 → 「新版本已下载完成，重启更新」
6. 点重启 → app 退出 → 重新打开后版本应该是 rc.2

如果 toast 没出现，看 Console.app 或开发者工具里 `[autoUpdater]` 前缀的日志；同时去 Sentry breadcrumbs 里翻 `category: autoUpdater` 的事件。

### 3.6 转正

走完 rc 验证 + 公证 + autoUpdater 联调后，删 `-rc.x` 后缀：

```bash
git tag v1.3.0
git push origin v1.3.0
```

正式 release 即上线。

---

## 4. 后续每次发版

1. 在 main 分支上 commit + push
2. 改 `package.json` 的 `version`（语义化版本：`1.3.1` / `1.4.0` / `2.0.0`...）
3. 打 tag：`git tag v<新版本> && git push origin v<新版本>`
4. 等 workflow 完成 → release 自动出现 → 老客户端自动收到更新

> 切记：tag 名一定要 `v` 开头（`v1.3.1`、`v2.0.0-beta.1`），因为 `release.yml` 的 trigger 是 `tags: ['v*']`。

---

## 5. 排错 / 回退

### 5.1 公证卡住 / 失败

`electron-builder` log 里会打印 submission ID（形如 `Submission ID: 12345678-90ab-cdef-...`）。

```bash
# 看具体某一次公证的 log（需要本地装 Xcode command line tools）
xcrun notarytool log <submission-id> \
  --apple-id "<你的 Apple ID 邮箱>" \
  --password "<app-specific password>" \
  --team-id "<APPLE_TEAM_ID>"
```

常见原因：

| 错误 | 原因 | 解决 |
|---|---|---|
| `The signature does not include a secure timestamp` | 签名时没带 `--timestamp` | electron-builder 默认带，检查 entitlements.mac.plist 是否齐全 |
| `The binary is not signed with a valid Developer ID certificate` | p12 是 Mac App Distribution 不是 Developer ID | 重新申请 Developer ID Application 证书 |
| `Hardened runtime is not enabled` | 没开 hardened runtime | 检查 `build.mac.hardenedRuntime: true` |
| `The executable does not have the hardened runtime enabled` | 子二进制（ffmpeg / backend）没签名 | 检查 `after-pack.cjs` 是否把所有可执行文件都签了；或者 `entitlements.mac.plist` 是否包含 `com.apple.security.cs.disable-library-validation` |
| 公证排队超过 30 分钟 | Apple 服务端慢 | 等。`notarytool wait` 会一直等，CI 会 timeout 后人工重跑 workflow |

### 5.2 签名跑成 ad-hoc 签名

症状：本地包出来后 `codesign -dv` 显示 `Signature=adhoc`，不是 `Developer ID Application`。

原因：`CSC_IDENTITY_AUTO_DISCOVERY=false` 被设置在 env 里（已修，但本地脚本要小心）。

排查：

```bash
# 检查 CI env 没有 CSC_IDENTITY_AUTO_DISCOVERY=false
# 检查 CSC_LINK 和 CSC_KEY_PASSWORD 是否正确
# 在 CI log 里搜 "identityName" 应该是 "Developer ID Application: ..."
```

### 5.3 autoUpdater 没生效

1. 检查 release 里有没有 `latest-mac.yml`，没有就是 `--publish always` 没生效
2. 客户端是 dev 模式（`npm run electron:dev`）跑的话 autoUpdater 会主动 skip，看 console 是否有 `[autoUpdater] skipped in non-packaged build`
3. 客户端必须**签名公证过**才能用 autoUpdater，开发未签名的 build 升级会失败
4. 网络问题：客户端跑 `curl https://github.com/cris-hu01/gymnastics-video-reviewer/releases/latest/download/latest-mac.yml` 应该返回 200
5. 看 Sentry breadcrumbs，category 为 `autoUpdater` 的事件，看 error 字段

### 5.4 撤回一次错误的发版

```bash
# 1. 在 GitHub Release 页面把对应 release 改成 draft（不要直接删，否则已经下到客户端的 latest-mac.yml 会指向 404）
# 2. 立刻打一个新的 patch tag 补上（例如 v1.3.1）
# 3. 因为 electron-updater 走的是「比较版本号取最大」逻辑，新版会覆盖掉问题版本
```

不要直接删 tag / release，会让用户客户端的 autoUpdater 卡在 404。

### 5.5 完全跳过 autoUpdater（紧急止血）

如果客户端发现严重 bug 需要阻止自动更新：

1. 临时把 `latest-mac.yml` 里的 `version` 改回老版本（手动 release edit）
2. 或者把出问题的 release 改成 draft
3. 再发布新 release 时务必把版本号 bump 高于问题版本，避免再次触发

---

## 6. 验证清单（每次发版前必过）

- [ ] `package.json` version 已 bump 且与 tag 一致
- [ ] `build.mac.notarize.teamId` 不是 `REPLACE_WITH_APPLE_TEAM_ID`
- [ ] GitHub Secrets 八项齐全（见第 2 节表格）
- [ ] tag 名 `v` 前缀，例如 `v1.3.0`
- [ ] release.yml workflow 全绿，无 retry
- [ ] release 资产含 `*.dmg` + `*.zip` + `latest-mac.yml`
- [ ] 干净 Mac `spctl -a -vvv` 输出 "accepted, Notarized Developer ID"
- [ ] 干净 Mac 双击 dmg → 装到 Applications → 双击启动**不弹**安全警告
- [ ] 从老版本（至少 prev release）测一次 autoUpdater 全链路

---

## Appendix A: 本地手动验证签名（不发版）

```bash
cd desktop-app/gymclip-reviewer
npm run build:web
npm run build:backend
npm run build:media-tools
npm run build:oss-tools

# 跑真签名（需要本机 keychain 有 Developer ID Application 证书）
APPLE_ID="<你邮箱>" \
APPLE_APP_SPECIFIC_PASSWORD="<app-pwd>" \
APPLE_TEAM_ID="<team-id>" \
npx electron-builder --mac --publish never
```

产物在 `electron-dist/`。验证：

```bash
codesign -dv --verbose=4 "electron-dist/mac-arm64/GymClip Reviewer.app"
# 期望看到 Authority=Developer ID Application: Cris Hu (TEAM_ID)
spctl -a -vvv -t install "electron-dist/mac-arm64/GymClip Reviewer.app"
```
