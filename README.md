# Acta

> *Acta Diurna* — 私有化部署的离线优先（Offline-First）全平台日程管理系统（Web + Android），专为国内网络环境与无 GMS 依赖场景设计。

## 核心特性

- **全栈离线优先与增量同步**：Web 端（IndexedDB）与 Android 端（SQLite）均支持完全离线秒级读写；基于全局单调递增版本号（`sync_version`）实现双向增量同步（Push / Pull），配合 WebSocket 达成多端实时状态对齐。
- **标准重复日程引擎（RFC 5545）**：基于 `rrule` 动态内存展开视图窗口，数据库仅存储母事件与异常实例（`recurring_event_id` / `exdates`），完整支持「仅此日程 / 此日程及后续 / 所有日程」三种修改与删除作用域。
- **零 GMS 依赖的安卓精准提醒**：摒弃海外 FCM 与第三方厂商推送通道，通过本地滚动窗口调度器（Rolling Window Scheduler）动态计算未来 14 天内的日程提醒，直接注册系统内核级 `AlarmManager` 精确闹钟，确保国产定制 ROM 锁屏后台准时触达。
- **本土化日历深度适配**：内置 `lunar-typescript` 离线计算农历、二十四节气与干支纪年，支持按年份动态下发国务院放假调休配置（渲染「休 / 班」角标）。
- **轻量单机运维与标准互通**：服务端采用 SQLite（WAL 模式）单文件存储，内置每日 `VACUUM INTO` 零停机热备份；支持标准 `.ics` 文件导入导出与只读订阅链接。

---

## 技术栈

| 模块 | 技术选型 | 说明 |
| :--- | :--- | :--- |
| **Backend** | Node.js + TypeScript + Fastify / Express | 轻量 REST API 与 WebSocket 变更广播 |
| **Database** | SQLite (`better-sqlite3`, WAL Mode) | 单文件高性能持久化，支持定时快照热备 |
| **Web Client** | React + Vite + Tailwind CSS v4 + FullCalendar | 日/周/月/议程视图、拖拽改期、全键盘快捷键 |
| **Android App** | React Native (Expo Prebuild) + `expo-sqlite` | 本地数据库驱动、系统级精确闹钟、原生桌面小组件 |
| **Shared Core** | TypeScript + Zod + `rrule` + `lunar-typescript` | 三端共享数据校验 Schema、重复日程展开与农历算法 |

---

## 目录结构

```text
acta/
├── packages/
│   └── shared/          # 三端共享的类型定义、Zod Schema、RRULE 展开与农历计算逻辑
├── server/              # Node.js 后端服务、增量同步引擎、ICS 解析与定时备份任务
├── web/                 # React + FullCalendar 桌面端 Web 应用
├── android/             # Expo React Native 移动端应用、AlarmManager 调度器与 AppWidget
└── docker-compose.yml   # 生产环境容器编排配置

```

---

## 快速部署（Docker）

### 1. 准备配置文件

在项目根目录创建 `docker-compose.yml`：

```yaml
version: '3.8'

services:
  acta-server:
    build: .
    container_name: acta-server
    restart: always
    ports:
      - "127.0.0.1:3080:3080"
    volumes:
      - ./data:/app/data
    environment:
      - NODE_ENV=production
      - TZ=Asia/Shanghai
      - AUTH_SECRET=change_this_to_your_private_token
      - DB_PATH=/app/data/acta.db

```

### 2. 启动服务

```bash
docker compose up -d --build

```

### 3. Nginx 反向代理（HTTPS + WebSocket）

```nginx
server {
    listen 443 ssl http2;
    server_name acta.yourdomain.com;

    # SSL 证书配置略

    location / {
        proxy_pass [http://127.0.0.1:3080](http://127.0.0.1:3080);
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}

```

---

## Android 端构建与权限说明

Android 端使用 Expo Prebuild 生成原生工程，已内置日历类应用专属精确闹钟权限（`USE_EXACT_ALARM`、`SCHEDULE_EXACT_ALARM`、`RECEIVE_BOOT_COMPLETED`）。

```bash
cd android
npx expo prebuild --platform android
npx expo run:android --variant release

```

> **国产 ROM 保活提示**：安装后请在系统「应用信息」中开启**自启动**，并将省电策略设为**无限制**，以确保设备重启后本地闹钟队列自动重建。

## License

MIT

```

```
