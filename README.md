# Acta — 个人私有化日历系统 (Android 离线优先 + 服务端 + Web 端)

专为国内网络环境设计的私有化类 Google Calendar 系统，零 GMS/FCM 依赖，支持**公历与农历生日重复日程**、**外部 iCal 动态赛事订阅（如皇马官方比赛日历）**、**Google Calendar `.ics` 备份导入**、**Android 本地 SQLite 离线秒开**以及**国产定制系统（HyperOS / OriginOS / ColorOS）14 天滚动窗口精确闹钟锁屏提醒**。

---

## 一、 工程目录结构

```text
acta/
├── .github/workflows/
│   └── build-android-apk.yml     # GitHub Actions 云端自动编译 Android Release APK
├── packages/
│   └── core/                     # 三端共享核心引擎（Zod Schema、公历/农历重复与异常分裂、ICS解析、提醒计算）
├── apps/
│   ├── server/                   # Node.js + Fastify + better-sqlite3 (WAL) + WebSocket 服务端
│   ├── mobile/                   # Expo React Native + expo-sqlite + AlarmManager + 桌面小组件 Android 端
│   └── web/                      # React + Vite + Tailwind CSS v4 + FullCalendar 桌面端
├── deploy/
│   └── nginx.conf.example        # Nginx HTTPS + WebSocket 反向代理配置模板
├── Dockerfile                    # 服务端 + Web 静态产物多阶段构建镜像
└── docker-compose.yml            # 单机一键部署编排
```

---

## 二、 服务端一键部署指南（Docker Compose + Nginx）

1. **配置访问密码**：
   ```bash
   cp .env.example .env
   # 编辑 .env，将 AUTH_SECRET 修改为您个人的高强度访问密码
   ```

2. **启动容器**：
   ```bash
   docker compose up -d --build
   ```
   - SQLite 数据库文件自动持久化在 `./data/calendar.db`（WAL 模式）。
   - 每日凌晨 `03:30` 自动执行 `VACUUM INTO` 零停机热备份至 `./data/backups/` 并保留最近 30 天快照。
   - 后台每 4 小时自动拉取并增量更新所有外部 iCal 订阅源（如皇马最新赛程时间变动）。

3. **配置 Nginx HTTPS 反向代理**：
   参考 `deploy/nginx.conf.example` 配置域名 SSL 证书与 WebSocket Upgrade 转发。

---

## 三、 Android 手机端打包与使用指南

### 1. 自动获取 APK 安装包（推荐，免本地配环境）
将仓库推送到 GitHub 后，GitHub Actions（`.github/workflows/build-android-apk.yml`）会自动在云端执行 `expo prebuild` 与 Gradle 编译，直接在 GitHub Actions 页面的 **Artifacts** 中下载 `acta-calendar-android-release-apk` 安装到手机即可。

### 2. 手机端首次设置与国产 ROM 锁屏准时提醒配置
1. 打开 App 点击右上角 **「设置/订阅」**：
   - 填入您的服务器 `https://域名` 与访问密码，点击 **「保存并立即同步」**。
   - 可在设置页直接添加 **皇马官方赛程等 iCal 订阅链接**（支持 `https://` 与 `webcal://`），并设置开球前默认提前提醒分钟数（如提前 30 分钟）。
   - 可直接粘贴或导入从 Google Calendar 导出的 `.ics` 备份文件。
2. **国产手机锁屏保活一次性设置（以小米 HyperOS 为例）**：
   - 在系统「应用设置 -> Acta 日历」中开启 **「自启动」**，并将省电策略设为 **「无限制」**。
   - 点击 App 设置页中的 **「🔔 测试 10 秒后锁屏横幅提醒」** 并立即按电源键锁屏，验证 10 秒后锁屏通知横幅与提示音。
