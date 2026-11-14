import {
  SyncPullResponse,
  SyncPushResponse,
} from '@acta/core';
import {
  applyRemoteSyncPull,
  getDirtySyncPayload,
  getServerConfig,
  markDirtyRecordsAsSynced,
} from '../db/localDb';
import { rescheduleRollingWindowAlarms } from '../reminders/ReminderScheduler';
import { refreshAndroidHomeWidget } from '../widget/TodayTomorrowWidget';

type SyncListener = () => void;

class MobileSyncEngine {
  private isSyncing = false;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<SyncListener>();

  public subscribe(listener: SyncListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners() {
    for (const fn of this.listeners) {
      fn();
    }
  }

  /**
   * Perform local reminder + widget refresh immediately after a local DB write,
   * then attempt background Push -> Pull sync if server is configured.
   */
  public async onLocalMutation(): Promise<void> {
    this.notifyListeners();
    await rescheduleRollingWindowAlarms();
    await refreshAndroidHomeWidget();
    void this.syncNow();
  }

  /**
   * Execute bidirectional Push -> Pull incremental sync.
   */
  public async syncNow(): Promise<{
    ok: boolean;
    error?: string;
    serverSyncVersion?: number;
  }> {
    const { serverUrl, authToken, lastSyncVersion } = getServerConfig();
    if (!serverUrl || !authToken) {
      return { ok: false, error: '尚未配置服务器地址或访问密码' };
    }
    if (this.isSyncing) {
      return { ok: true };
    }

    this.isSyncing = true;
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      };

      // 1. Push dirty local records
      const dirty = getDirtySyncPayload();
      if (dirty.calendars.length > 0 || dirty.events.length > 0) {
        const pushRes = await fetch(`${serverUrl}/api/sync/push`, {
          method: 'POST',
          headers,
          body: JSON.stringify(dirty),
        });
        if (!pushRes.ok) {
          throw new Error(`Push 失败 (HTTP ${pushRes.status})`);
        }
        const pushData = (await pushRes.json()) as SyncPushResponse;
        markDirtyRecordsAsSynced(
          pushData.appliedCalendarIds,
          pushData.appliedEventIds
        );
      }

      // 2. Pull remote changes since lastSyncVersion
      const pullRes = await fetch(
        `${serverUrl}/api/sync/pull?since=${lastSyncVersion}`,
        {
          method: 'GET',
          headers,
        }
      );
      if (!pullRes.ok) {
        throw new Error(`Pull 失败 (HTTP ${pullRes.status})`);
      }
      const pullData = (await pullRes.json()) as SyncPullResponse;

      if (
        pullData.calendars.length > 0 ||
        pullData.events.length > 0 ||
        pullData.serverSyncVersion !== lastSyncVersion
      ) {
        applyRemoteSyncPull(pullData);
        this.notifyListeners();
        await rescheduleRollingWindowAlarms();
        await refreshAndroidHomeWidget();
      }

      return { ok: true, serverSyncVersion: pullData.serverSyncVersion };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : '网络同步异常',
      };
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Connect to server WebSocket (/api/ws) for real-time wake-up notifications.
   */
  public connectWebSocket(): void {
    this.disconnectWebSocket();
    const { serverUrl, authToken } = getServerConfig();
    if (!serverUrl || !authToken) return;

    const wsUrl =
      serverUrl.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://') +
      `/api/ws?token=${encodeURIComponent(authToken)}`;

    try {
      const socket = new WebSocket(wsUrl);
      this.ws = socket;

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as {
            type?: string;
            version?: number;
          };
          if (msg.type === 'SYNC_REQUIRED') {
            void this.syncNow();
          }
        } catch {
          // ignore malformed ws message
        }
      };

      socket.onclose = () => {
        this.ws = null;
        this.reconnectTimer = setTimeout(() => {
          this.connectWebSocket();
        }, 8000);
      };
    } catch {
      // ignore ws connection errors when offline
    }
  }

  public disconnectWebSocket(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  public async verifyServerConnection(
    serverUrl: string,
    authToken: string
  ): Promise<{ ok: boolean; message: string }> {
    const cleanUrl = serverUrl.trim().replace(/\/+$/, '');
    try {
      const res = await fetch(`${cleanUrl}/api/auth/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken.trim()}`,
        },
        body: JSON.stringify({ token: authToken.trim() }),
      });
      if (!res.ok) {
        return { ok: false, message: '访问密码错误或服务器拒绝访问' };
      }
      return { ok: true, message: '服务器连接成功！' };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : '无法连接到服务器，请检查域名与网络',
      };
    }
  }

  /**
   * Add an external iCal subscription (e.g. Real Madrid matches) directly from the phone.
   */
  public async addExternalSubscription(params: {
    name: string;
    url: string;
    color?: string;
    defaultReminders?: number[];
  }): Promise<{ ok: boolean; message: string }> {
    const { serverUrl, authToken } = getServerConfig();
    if (!serverUrl || !authToken) {
      return { ok: false, message: '请先配置并连接服务器' };
    }

    try {
      const res = await fetch(`${serverUrl}/api/subscriptions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          name: params.name,
          url: params.url,
          color: params.color ?? '#2563EB',
          defaultReminders: params.defaultReminders ?? [30],
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { ok: false, message: data.message || '订阅拉取失败' };
      }
      await this.syncNow();
      return {
        ok: true,
        message: `订阅成功！已导入 ${data.inserted} 场比赛/日程`,
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : '请求失败',
      };
    }
  }

  public async refreshSubscription(
    calendarId: string
  ): Promise<{ ok: boolean; message: string }> {
    const { serverUrl, authToken } = getServerConfig();
    if (!serverUrl || !authToken) {
      return { ok: false, message: '请先配置服务器' };
    }
    try {
      const res = await fetch(
        `${serverUrl}/api/subscriptions/${encodeURIComponent(calendarId)}/refresh`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${authToken}` },
        }
      );
      const data = await res.json();
      if (!res.ok) {
        return { ok: false, message: data.message || '刷新失败' };
      }
      await this.syncNow();
      return {
        ok: true,
        message: `刷新完成（新增 ${data.inserted} 条，更新 ${data.updated} 条）`,
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : '刷新请求异常',
      };
    }
  }

  /**
   * Import Google Calendar .ics content directly from the phone.
   */
  public async importGoogleIcs(params: {
    calendarName: string;
    icsContent: string;
  }): Promise<{ ok: boolean; message: string }> {
    const { serverUrl, authToken } = getServerConfig();
    if (!serverUrl || !authToken) {
      return { ok: false, message: '请先配置服务器' };
    }
    try {
      const res = await fetch(`${serverUrl}/api/ics/import`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify(params),
      });
      const data = await res.json();
      if (!res.ok) {
        return { ok: false, message: data.message || '导入 .ics 失败' };
      }
      await this.syncNow();
      return {
        ok: true,
        message: `成功导入至「${data.calendarName}」：新增 ${data.inserted} 条，更新 ${data.updated} 条`,
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : '导入请求异常',
      };
    }
  }
}

export const syncEngine = new MobileSyncEngine();
