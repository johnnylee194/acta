import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import listPlugin from '@fullcalendar/list';
import interactionPlugin from '@fullcalendar/interaction';
import type {
  DateSelectArg,
  DatesSetArg,
  DayCellContentArg,
  EventClickArg,
  EventDropArg,
} from '@fullcalendar/core';
import type { EventResizeDoneArg } from '@fullcalendar/interaction';
import {
  CalendarRecord,
  EventRecord,
  ExpandedEventInstance,
  RecurrenceEditScope,
  SyncPullResponse,
  createLunarRRuleFromTimestamp,
  deleteRecurringEvent,
  editRecurringEvent,
  expandEventsInWindow,
  fromCstComponents,
  getLunarDayInfo,
  isLunarRRule,
  toCstComponents,
} from '@acta/core';

type RecurrencePreset =
  | 'NONE'
  | 'DAILY'
  | 'WEEKLY'
  | 'MONTHLY'
  | 'YEARLY'
  | 'LUNAR_YEARLY'
  | 'LUNAR_MONTHLY';

const WEEKDAY_RRULE_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function formatLocalDateTimeInput(ms: number): string {
  const { year, month, day, hour, minute } = toCstComponents(ms);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(
    2,
    '0'
  )}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseLocalDateTimeInput(str: string, fallbackMs: number): number {
  const m = str
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return fallbackMs;
  return fromCstComponents(
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    0
  );
}

export default function App() {
  const calendarRef = useRef<FullCalendar | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const [authToken, setAuthToken] = useState<string>(
    () => localStorage.getItem('acta_auth_token') || ''
  );
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [passwordInput, setPasswordInput] = useState<string>('');
  const [authError, setAuthError] = useState<string>('');

  const [sidebarOpen, setSidebarOpen] = useState<boolean>(true);
  const [currentView, setCurrentView] = useState<string>('timeGridWeek');
  const [headerTitle, setHeaderTitle] = useState<string>('');
  const [windowRange, setWindowRange] = useState<{ start: number; end: number }>(
    () => {
      const now = Date.now();
      return {
        start: now - 35 * 24 * 3600 * 1000,
        end: now + 65 * 24 * 3600 * 1000,
      };
    }
  );

  const [calendars, setCalendars] = useState<CalendarRecord[]>([]);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Event Modal State
  const [modalOpen, setModalOpen] = useState<boolean>(false);
  const [editingInstance, setEditingInstance] =
    useState<ExpandedEventInstance | null>(null);
  const [titleInput, setTitleInput] = useState<string>('');
  const [locationInput, setLocationInput] = useState<string>('');
  const [descriptionInput, setDescriptionInput] = useState<string>('');
  const [calendarIdInput, setCalendarIdInput] =
    useState<string>('cal-personal');
  const [startInput, setStartInput] = useState<string>('');
  const [endInput, setEndInput] = useState<string>('');
  const [isAllDayInput, setIsAllDayInput] = useState<boolean>(false);
  const [recurrencePreset, setRecurrencePreset] =
    useState<RecurrencePreset>('NONE');
  const [reminderMinutes, setReminderMinutes] = useState<number>(15);

  // Recurrence 3-Scope Dialog State
  const [scopeDialog, setScopeDialog] = useState<{
    open: boolean;
    mode: 'EDIT' | 'DELETE' | 'DRAG';
    pendingStartMs?: number;
    pendingEndMs?: number;
    pendingInstance?: ExpandedEventInstance;
  }>({ open: false, mode: 'EDIT' });

  // Subscription & Google .ics Import Modal State
  const [subModalOpen, setSubModalOpen] = useState<boolean>(false);
  const [subName, setSubName] = useState<string>('皇马赛程');
  const [subUrl, setSubUrl] = useState<string>('');
  const [subReminder, setSubReminder] = useState<number>(30);
  const [importCalName, setImportCalName] =
    useState<string>('Google 导入日历');
  const [statusMessage, setStatusMessage] = useState<string>('');

  const pullAllFromServer = useCallback(async (token: string) => {
    const res = await fetch('/api/sync/pull?since=0', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      setIsAuthenticated(false);
      return;
    }
    if (!res.ok) return;
    const data = (await res.json()) as SyncPullResponse;
    setCalendars(
      data.calendars
        .filter((c) => c.is_deleted === 0)
        .sort((a, b) => a.sort_order - b.sort_order)
    );
    setEvents(data.events.filter((e) => e.is_deleted === 0));
    setIsAuthenticated(true);
  }, []);

  const pushChangesToServer = useCallback(
    async (
      changedCalendars: CalendarRecord[],
      changedEvents: EventRecord[]
    ) => {
      if (!authToken) return;
      await fetch('/api/sync/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          calendars: changedCalendars,
          events: changedEvents,
        }),
      });
      await pullAllFromServer(authToken);
    },
    [authToken, pullAllFromServer]
  );

  // Initial auth & WebSocket live connection
  useEffect(() => {
    if (!authToken) return;
    void pullAllFromServer(authToken);

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(
      `${proto}//${window.location.host}/api/ws?token=${encodeURIComponent(
        authToken
      )}`
    );
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { type?: string };
        if (msg.type === 'SYNC_REQUIRED') {
          void pullAllFromServer(authToken);
        }
      } catch {
        // ignore
      }
    };
    return () => {
      ws.close();
    };
  }, [authToken, pullAllFromServer]);

  const openCreateModal = useCallback(
    (startMs?: number, endMs?: number, allDay = false) => {
      const baseStart = startMs ?? Date.now();
      const baseEnd = endMs ?? baseStart + 3600 * 1000;
      const writable = calendars.filter((c) => c.is_readonly === 0);
      setEditingInstance(null);
      setTitleInput('');
      setLocationInput('');
      setDescriptionInput('');
      setCalendarIdInput(writable[0]?.id || 'cal-personal');
      setStartInput(formatLocalDateTimeInput(baseStart));
      setEndInput(formatLocalDateTimeInput(baseEnd));
      setIsAllDayInput(allDay);
      setRecurrencePreset('NONE');
      setReminderMinutes(15);
      setModalOpen(true);
    },
    [calendars]
  );

  // Google Calendar single-key shortcuts: D, W, M, A, T, C, /
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (modalOpen || subModalOpen || scopeDialog.open) return;

      const api = calendarRef.current?.getApi();
      if (!api) return;

      const key = e.key.toUpperCase();
      if (key === 'D') {
        api.changeView('timeGridDay');
        setCurrentView('timeGridDay');
      } else if (key === 'W') {
        api.changeView('timeGridWeek');
        setCurrentView('timeGridWeek');
      } else if (key === 'M') {
        api.changeView('dayGridMonth');
        setCurrentView('dayGridMonth');
      } else if (key === 'A') {
        api.changeView('listMonth');
        setCurrentView('listMonth');
      } else if (key === 'T') {
        api.today();
      } else if (key === 'C') {
        e.preventDefault();
        openCreateModal();
      } else if (e.key === '/') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [modalOpen, subModalOpen, scopeDialog.open, openCreateModal]);

  const expandedInstances = useMemo(() => {
    const list = expandEventsInWindow(
      events,
      windowRange.start,
      windowRange.end,
      calendars
    );
    if (!searchQuery.trim()) return list;
    const q = searchQuery.trim().toLowerCase();
    return list.filter(
      (i) =>
        i.title.toLowerCase().includes(q) ||
        i.location.toLowerCase().includes(q) ||
        i.description.toLowerCase().includes(q)
    );
  }, [events, calendars, windowRange, searchQuery]);

  const fullCalendarEvents = useMemo(() => {
    return expandedInstances.map((inst) => ({
      id: inst.instanceId,
      title: inst.isLunarRecurring ? `🏮 ${inst.title}` : inst.title,
      start: new Date(inst.startTime),
      end: new Date(inst.endTime),
      allDay: inst.isAllDay,
      backgroundColor: inst.color,
      borderColor: inst.color,
      editable: !inst.isReadonly,
      extendedProps: {
        instance: inst,
      },
    }));
  }, [expandedInstances]);

  const handleDatesSet = (arg: DatesSetArg) => {
    setHeaderTitle(arg.view.title);
    setWindowRange({
      start: arg.start.getTime() - 7 * 24 * 3600 * 1000,
      end: arg.end.getTime() + 7 * 24 * 3600 * 1000,
    });
  };

  const handleDateSelect = (selectInfo: DateSelectArg) => {
    selectInfo.view.calendar.unselect();
    openCreateModal(
      selectInfo.start.getTime(),
      selectInfo.end.getTime(),
      selectInfo.allDay
    );
  };

  const handleEventClick = (clickInfo: EventClickArg) => {
    const inst = clickInfo.event.extendedProps
      .instance as ExpandedEventInstance;
    if (!inst) return;
    if (inst.isReadonly) {
      alert(
        `【订阅赛程/只读】${inst.title}\n时间：${formatLocalDateTimeInput(
          inst.startTime
        ).replace('T', ' ')}\n地点：${inst.location || '无'}`
      );
      return;
    }

    setEditingInstance(inst);
    setTitleInput(inst.title);
    setLocationInput(inst.location);
    setDescriptionInput(inst.description);
    setCalendarIdInput(inst.calendarId);
    setStartInput(formatLocalDateTimeInput(inst.startTime));
    setEndInput(formatLocalDateTimeInput(inst.endTime));
    setIsAllDayInput(inst.isAllDay);
    setReminderMinutes(inst.reminders[0] ?? 15);

    if (!inst.rrule) {
      setRecurrencePreset('NONE');
    } else if (isLunarRRule(inst.rrule)) {
      setRecurrencePreset(
        inst.rrule.includes('FREQ=MONTHLY') ? 'LUNAR_MONTHLY' : 'LUNAR_YEARLY'
      );
    } else if (inst.rrule.includes('FREQ=DAILY')) {
      setRecurrencePreset('DAILY');
    } else if (inst.rrule.includes('FREQ=WEEKLY')) {
      setRecurrencePreset('WEEKLY');
    } else if (inst.rrule.includes('FREQ=MONTHLY')) {
      setRecurrencePreset('MONTHLY');
    } else {
      setRecurrencePreset('YEARLY');
    }

    setModalOpen(true);
  };

  const applyDragOrResize = async (
    inst: ExpandedEventInstance,
    newStartMs: number,
    newEndMs: number,
    scope: RecurrenceEditScope = 'THIS'
  ) => {
    const now = Date.now();
    if (!inst.isRecurring || !inst.masterEventId) {
      const target = events.find((e) => e.id === inst.eventId);
      if (!target) return;
      await pushChangesToServer(
        [],
        [
          {
            ...target,
            start_time: newStartMs,
            end_time: newEndMs,
            updated_at: now,
          },
        ]
      );
      return;
    }

    const master = events.find((e) => e.id === inst.masterEventId);
    if (!master) return;
    const exceptions = events.filter((e) => e.recurring_event_id === master.id);
    const mutation = editRecurringEvent({
      masterEvent: master,
      existingExceptions: exceptions,
      instanceStartTime: inst.originalStartTime,
      scope,
      changes: {
        start_time: newStartMs,
        end_time: newEndMs,
      },
      newRecordId: crypto.randomUUID(),
      nowMs: now,
    });
    await pushChangesToServer([], [
      ...mutation.updatedRecords,
      ...mutation.createdRecords,
    ]);
  };

  const handleEventDropOrResize = (
    arg: EventDropArg | EventResizeDoneArg
  ) => {
    const inst = arg.event.extendedProps.instance as ExpandedEventInstance;
    if (!inst || !arg.event.start) return;
    const newStartMs = arg.event.start.getTime();
    const newEndMs = arg.event.end
      ? arg.event.end.getTime()
      : newStartMs + (inst.endTime - inst.startTime);

    if (inst.isRecurring) {
      setScopeDialog({
        open: true,
        mode: 'DRAG',
        pendingInstance: inst,
        pendingStartMs: newStartMs,
        pendingEndMs: newEndMs,
      });
    } else {
      void applyDragOrResize(inst, newStartMs, newEndMs);
    }
  };

  const buildRRule = (
    preset: RecurrencePreset,
    startMs: number
  ): string | null => {
    const cst = toCstComponents(startMs);
    const weekday = new Date(
      Date.UTC(cst.year, cst.month - 1, cst.day)
    ).getUTCDay();
    switch (preset) {
      case 'NONE':
        return null;
      case 'DAILY':
        return 'FREQ=DAILY';
      case 'WEEKLY':
        return `FREQ=WEEKLY;BYDAY=${WEEKDAY_RRULE_CODES[weekday]}`;
      case 'MONTHLY':
        return `FREQ=MONTHLY;BYMONTHDAY=${cst.day}`;
      case 'YEARLY':
        return `FREQ=YEARLY;BYMONTH=${cst.month};BYMONTHDAY=${cst.day}`;
      case 'LUNAR_YEARLY':
        return createLunarRRuleFromTimestamp(startMs, 'YEARLY');
      case 'LUNAR_MONTHLY':
        return createLunarRRuleFromTimestamp(startMs, 'MONTHLY');
    }
  };

  const executeSaveModal = async (scope?: RecurrenceEditScope) => {
    const now = Date.now();
    const startMs = parseLocalDateTimeInput(startInput, now);
    const endMs = Math.max(
      startMs + 15 * 60 * 1000,
      parseLocalDateTimeInput(endInput, startMs + 3600 * 1000)
    );
    const rruleStr = buildRRule(recurrencePreset, startMs);
    const remindersStr =
      reminderMinutes < 0 ? '[]' : JSON.stringify([reminderMinutes]);
    const cleanTitle = titleInput.trim() || '未命名日程';

    if (!editingInstance) {
      const created: EventRecord = {
        id: crypto.randomUUID(),
        calendar_id: calendarIdInput,
        external_uid: null,
        title: cleanTitle,
        description: descriptionInput.trim(),
        location: locationInput.trim(),
        color: null,
        start_time: startMs,
        end_time: endMs,
        is_all_day: isAllDayInput ? 1 : 0,
        timezone: 'Asia/Shanghai',
        rrule: rruleStr,
        exdates: '[]',
        recurring_event_id: null,
        original_start_time: null,
        reminders: remindersStr,
        created_at: now,
        updated_at: now,
        sync_version: 0,
        is_deleted: 0,
      };
      await pushChangesToServer([], [created]);
    } else if (!editingInstance.isRecurring || !editingInstance.masterEventId) {
      const target = events.find((e) => e.id === editingInstance.eventId);
      if (target) {
        await pushChangesToServer(
          [],
          [
            {
              ...target,
              calendar_id: calendarIdInput,
              title: cleanTitle,
              description: descriptionInput.trim(),
              location: locationInput.trim(),
              start_time: startMs,
              end_time: endMs,
              is_all_day: isAllDayInput ? 1 : 0,
              rrule: rruleStr,
              reminders: remindersStr,
              updated_at: now,
            },
          ]
        );
      }
    } else if (scope) {
      const master = events.find((e) => e.id === editingInstance.masterEventId);
      if (master) {
        const exceptions = events.filter(
          (e) => e.recurring_event_id === master.id
        );
        const mutation = editRecurringEvent({
          masterEvent: master,
          existingExceptions: exceptions,
          instanceStartTime: editingInstance.originalStartTime,
          scope,
          changes: {
            calendar_id: calendarIdInput,
            title: cleanTitle,
            description: descriptionInput.trim(),
            location: locationInput.trim(),
            start_time: startMs,
            end_time: endMs,
            is_all_day: isAllDayInput ? 1 : 0,
            rrule: scope === 'THIS' ? null : rruleStr,
            reminders: remindersStr,
          },
          newRecordId: crypto.randomUUID(),
          nowMs: now,
        });
        await pushChangesToServer([], [
          ...mutation.updatedRecords,
          ...mutation.createdRecords,
        ]);
      }
    }

    setScopeDialog({ open: false, mode: 'EDIT' });
    setModalOpen(false);
  };

  const executeDeleteModal = async (scope?: RecurrenceEditScope) => {
    if (!editingInstance) return;
    const now = Date.now();

    if (!editingInstance.isRecurring || !editingInstance.masterEventId) {
      const target = events.find((e) => e.id === editingInstance.eventId);
      if (target) {
        await pushChangesToServer(
          [],
          [{ ...target, is_deleted: 1, updated_at: now }]
        );
      }
    } else if (scope) {
      const master = events.find((e) => e.id === editingInstance.masterEventId);
      if (master) {
        const exceptions = events.filter(
          (e) => e.recurring_event_id === master.id
        );
        const mutation = deleteRecurringEvent({
          masterEvent: master,
          existingExceptions: exceptions,
          instanceStartTime: editingInstance.originalStartTime,
          scope,
          nowMs: now,
        });
        await pushChangesToServer([], [
          ...mutation.updatedRecords,
          ...mutation.createdRecords,
        ]);
      }
    }

    setScopeDialog({ open: false, mode: 'DELETE' });
    setModalOpen(false);
  };

  const renderDayCellContent = (arg: DayCellContentArg) => {
    const lunar = getLunarDayInfo(arg.date.getTime());
    return (
      <div className="flex w-full items-center justify-between px-1">
        <span className="text-xs font-semibold text-slate-800">
          {arg.dayNumberText.replace('日', '')}
        </span>
        <span
          className={`text-[11px] ${
            lunar.isHighlight
              ? 'font-semibold text-blue-600'
              : 'text-slate-400'
          }`}
        >
          {lunar.shortLabel}
        </span>
      </div>
    );
  };

  if (!isAuthenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
        <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-lg">
          <h1 className="text-2xl font-bold text-slate-900">
            Acta 个人私有日历
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            请输入服务器访问密码（AUTH_SECRET）解锁日历工作台
          </p>
          <form
            className="mt-6 space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setAuthError('');
              const res = await fetch('/api/auth/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: passwordInput.trim() }),
              });
              if (!res.ok) {
                setAuthError('访问密码错误，请重试');
                return;
              }
              const clean = passwordInput.trim();
              localStorage.setItem('acta_auth_token', clean);
              setAuthToken(clean);
              await pullAllFromServer(clean);
            }}
          >
            <input
              type="password"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              placeholder="输入访问密码..."
              className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm focus:border-blue-600 focus:outline-none"
            />
            {authError && <p className="text-xs text-red-600">{authError}</p>}
            <button
              type="submit"
              className="w-full rounded-xl bg-blue-600 py-3 text-sm font-semibold text-white hover:bg-blue-700"
            >
              进入日历
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-white">
      {/* Top Header Bar */}
      <header className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setSidebarOpen((o) => !o)}
            className="rounded-lg p-2 text-slate-600 hover:bg-slate-100"
            title="切换侧边栏"
          >
            ☰
          </button>
          <span className="text-lg font-bold text-slate-900">{headerTitle}</span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => calendarRef.current?.getApi().prev()}
              className="rounded-lg px-2.5 py-1 text-slate-600 hover:bg-slate-100"
            >
              ‹
            </button>
            <button
              onClick={() => calendarRef.current?.getApi().next()}
              className="rounded-lg px-2.5 py-1 text-slate-600 hover:bg-slate-100"
            >
              ›
            </button>
            <button
              onClick={() => calendarRef.current?.getApi().today()}
              className="ml-1 rounded-lg border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              今天 (T)
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索日程或皇马比赛 (按 / 聚焦)..."
            className="w-64 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-1.5 text-xs focus:border-blue-600 focus:bg-white focus:outline-none"
          />

          <div className="flex rounded-xl bg-slate-100 p-1 text-xs font-medium">
            {[
              ['timeGridDay', '日 (D)'],
              ['timeGridWeek', '周 (W)'],
              ['dayGridMonth', '月 (M)'],
              ['listMonth', '日程 (A)'],
            ].map(([viewKey, label]) => (
              <button
                key={viewKey}
                onClick={() => {
                  calendarRef.current?.getApi().changeView(viewKey);
                  setCurrentView(viewKey);
                }}
                className={`rounded-lg px-3 py-1 ${
                  currentView === viewKey
                    ? 'bg-white font-semibold text-blue-600 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Main Layout */}
      <div className="flex flex-1 overflow-hidden">
        {sidebarOpen && (
          <aside className="flex w-64 flex-col justify-between border-r border-slate-200 bg-slate-50/60 p-4">
            <div>
              <button
                onClick={() => openCreateModal()}
                className="flex w-full items-center justify-center gap-2 rounded-2xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-xs hover:bg-blue-700"
              >
                <span>＋ 创建日程 (C)</span>
              </button>

              <div className="mt-6">
                <div className="flex items-center justify-between">
                  <h2 className="text-xs font-bold tracking-wider text-slate-500 uppercase">
                    我的日历与赛事订阅
                  </h2>
                  <button
                    onClick={() => {
                      setStatusMessage('');
                      setSubModalOpen(true);
                    }}
                    className="text-xs font-semibold text-blue-600 hover:underline"
                  >
                    + 订阅/导入
                  </button>
                </div>

                <div className="mt-3 space-y-2">
                  {calendars.map((cal) => (
                    <div
                      key={cal.id}
                      className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-slate-100"
                    >
                      <label className="flex cursor-pointer items-center gap-2.5 text-sm text-slate-800">
                        <input
                          type="checkbox"
                          checked={cal.is_visible === 1}
                          onChange={() => {
                            void pushChangesToServer(
                              [
                                {
                                  ...cal,
                                  is_visible: cal.is_visible === 1 ? 0 : 1,
                                  updated_at: Date.now(),
                                },
                              ],
                              []
                            );
                          }}
                          style={{ accentColor: cal.color }}
                          className="h-4 w-4 rounded"
                        />
                        <span className="truncate">{cal.name}</span>
                      </label>
                      {cal.is_readonly === 1 && (
                        <button
                          onClick={async () => {
                            await fetch(
                              `/api/subscriptions/${encodeURIComponent(
                                cal.id
                              )}/refresh`,
                              {
                                method: 'POST',
                                headers: {
                                  Authorization: `Bearer ${authToken}`,
                                },
                              }
                            );
                            await pullAllFromServer(authToken);
                          }}
                          className="text-[11px] font-medium text-blue-600 hover:underline"
                          title="立即拉取最新赛程"
                        >
                          刷新
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-2 border-t border-slate-200 pt-3 text-xs text-slate-500">
              <div>快捷键：D日 / W周 / M月 / A列表 / T今天 / C新建</div>
              <a
                href={`/api/ics/export?token=${encodeURIComponent(authToken)}`}
                className="inline-block font-semibold text-blue-600 hover:underline"
              >
                导出全量 .ics 备份
              </a>
            </div>
          </aside>
        )}

        <main className="flex-1 overflow-auto p-3">
          <FullCalendar
            ref={calendarRef}
            plugins={[
              dayGridPlugin,
              timeGridPlugin,
              listPlugin,
              interactionPlugin,
            ]}
            initialView="timeGridWeek"
            locale="zh-cn"
            headerToolbar={false}
            selectable
            editable
            nowIndicator
            scrollTime="08:00:00"
            height="100%"
            events={fullCalendarEvents}
            datesSet={handleDatesSet}
            select={handleDateSelect}
            eventClick={handleEventClick}
            eventDrop={handleEventDropOrResize}
            eventResize={handleEventDropOrResize}
            dayCellContent={renderDayCellContent}
          />
        </main>
      </div>

      {/* Create / Edit Event Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h3 className="text-base font-bold text-slate-900">
                {editingInstance ? '编辑日程' : '新建日程'}
              </h3>
              <button
                onClick={() => setModalOpen(false)}
                className="text-sm text-slate-500 hover:text-slate-800"
              >
                ✕
              </button>
            </div>

            <div className="mt-4 space-y-3 text-sm">
              <input
                type="text"
                placeholder="日程或纪念日标题..."
                value={titleInput}
                onChange={(e) => setTitleInput(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3.5 py-2 font-semibold focus:border-blue-600 focus:outline-none"
              />

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-500">
                    开始时间
                  </label>
                  <input
                    type="datetime-local"
                    value={startInput}
                    onChange={(e) => setStartInput(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-1.5 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-500">
                    结束时间
                  </label>
                  <input
                    type="datetime-local"
                    value={endInput}
                    onChange={(e) => setEndInput(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-1.5 text-xs"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-500">
                    重复规则（支持公历与农历）
                  </label>
                  <select
                    value={recurrencePreset}
                    onChange={(e) =>
                      setRecurrencePreset(e.target.value as RecurrencePreset)
                    }
                    className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-xs"
                  >
                    <option value="NONE">不重复</option>
                    <option value="DAILY">每天重复</option>
                    <option value="WEEKLY">每周此日</option>
                    <option value="MONTHLY">每月公历此日</option>
                    <option value="YEARLY">每年公历此日</option>
                    <option value="LUNAR_YEARLY">
                      每年农历此日（生日/纪念日）
                    </option>
                    <option value="LUNAR_MONTHLY">每月农历此日</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-slate-500">
                    提前提醒
                  </label>
                  <select
                    value={reminderMinutes}
                    onChange={(e) =>
                      setReminderMinutes(Number(e.target.value))
                    }
                    className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-xs"
                  >
                    <option value={-1}>不提醒</option>
                    <option value={0}>准时提醒</option>
                    <option value={10}>提前 10 分钟</option>
                    <option value={15}>提前 15 分钟</option>
                    <option value={30}>提前 30 分钟</option>
                    <option value={60}>提前 1 小时</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs text-slate-500">所属日历</label>
                <select
                  value={calendarIdInput}
                  onChange={(e) => setCalendarIdInput(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-xs"
                >
                  {calendars
                    .filter((c) => c.is_readonly === 0)
                    .map((cal) => (
                      <option key={cal.id} value={cal.id}>
                        {cal.name}
                      </option>
                    ))}
                </select>
              </div>

              <input
                type="text"
                placeholder="地点（可选）"
                value={locationInput}
                onChange={(e) => setLocationInput(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3.5 py-2 text-xs"
              />

              <textarea
                placeholder="备注说明（可选）"
                value={descriptionInput}
                onChange={(e) => setDescriptionInput(e.target.value)}
                rows={3}
                className="w-full rounded-xl border border-slate-300 px-3.5 py-2 text-xs"
              />
            </div>

            <div className="mt-6 flex items-center justify-between">
              {editingInstance ? (
                <button
                  onClick={() => {
                    if (editingInstance.isRecurring) {
                      setScopeDialog({ open: true, mode: 'DELETE' });
                    } else {
                      void executeDeleteModal();
                    }
                  }}
                  className="rounded-xl bg-red-50 px-4 py-2 text-xs font-semibold text-red-600 hover:bg-red-100"
                >
                  删除日程
                </button>
              ) : (
                <div />
              )}

              <div className="flex gap-2">
                <button
                  onClick={() => setModalOpen(false)}
                  className="rounded-xl border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-600"
                >
                  取消
                </button>
                <button
                  onClick={() => {
                    if (editingInstance && editingInstance.isRecurring) {
                      setScopeDialog({ open: true, mode: 'EDIT' });
                    } else {
                      void executeSaveModal();
                    }
                  }}
                  className="rounded-xl bg-blue-600 px-5 py-2 text-xs font-semibold text-white hover:bg-blue-700"
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Recurrence 3-Scope Dialog */}
      {scopeDialog.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
            <h4 className="text-base font-bold text-slate-900">
              {scopeDialog.mode === 'DELETE'
                ? '删除重复日程作用域'
                : '修改重复日程作用域'}
            </h4>
            <div className="mt-4 space-y-2">
              {(
                [
                  ['THIS', '仅此日程 (This event)'],
                  ['THIS_AND_FOLLOWING', '此日程及后续日程 (This and following)'],
                  ['ALL', '所有日程 (All events)'],
                ] as Array<[RecurrenceEditScope, string]>
              ).map(([sc, label]) => (
                <button
                  key={sc}
                  onClick={() => {
                    if (
                      scopeDialog.mode === 'DRAG' &&
                      scopeDialog.pendingInstance &&
                      scopeDialog.pendingStartMs !== undefined &&
                      scopeDialog.pendingEndMs !== undefined
                    ) {
                      void applyDragOrResize(
                        scopeDialog.pendingInstance,
                        scopeDialog.pendingStartMs,
                        scopeDialog.pendingEndMs,
                        sc
                      );
                      setScopeDialog({ open: false, mode: 'EDIT' });
                    } else if (scopeDialog.mode === 'DELETE') {
                      void executeDeleteModal(sc);
                    } else {
                      void executeSaveModal(sc);
                    }
                  }}
                  className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-left text-xs font-semibold text-blue-600 hover:bg-blue-50"
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              onClick={() => {
                setScopeDialog({ open: false, mode: 'EDIT' });
                void pullAllFromServer(authToken);
              }}
              className="mt-4 w-full text-center text-xs text-slate-500 hover:text-slate-800"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* External iCal Subscription (Real Madrid) & Google Calendar .ics Import Modal */}
      {subModalOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h3 className="text-base font-bold text-slate-900">
                外部赛事 iCal 订阅 & Google 日历导入
              </h3>
              <button
                onClick={() => setSubModalOpen(false)}
                className="text-sm text-slate-500 hover:text-slate-800"
              >
                ✕
              </button>
            </div>

            <div className="mt-4 space-y-5 text-xs">
              {/* 1. External iCal Subscription */}
              <div className="space-y-2">
                <h4 className="font-bold text-slate-800">
                  1. 添加外部 iCal 订阅（如皇马官方赛程）
                </h4>
                <input
                  type="text"
                  value={subName}
                  onChange={(e) => setSubName(e.target.value)}
                  placeholder="日历名称（如：皇马赛程）"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2"
                />
                <input
                  type="text"
                  value={subUrl}
                  onChange={(e) => setSubUrl(e.target.value)}
                  placeholder="iCal 链接（支持 https:// 或 webcal://）"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2"
                />
                <div className="flex items-center gap-2">
                  <span className="text-slate-600">默认提前提醒（分钟）：</span>
                  <input
                    type="number"
                    value={subReminder}
                    onChange={(e) => setSubReminder(Number(e.target.value))}
                    className="w-24 rounded-xl border border-slate-300 px-3 py-1.5"
                  />
                </div>
                <button
                  onClick={async () => {
                    if (!subUrl.trim()) return;
                    setStatusMessage('正在拉取订阅日历...');
                    const res = await fetch('/api/subscriptions', {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${authToken}`,
                      },
                      body: JSON.stringify({
                        name: subName.trim() || '皇马赛程',
                        url: subUrl.trim(),
                        defaultReminders: [subReminder],
                      }),
                    });
                    const data = await res.json();
                    if (!res.ok) {
                      setStatusMessage(`订阅失败：${data.message || '请求错误'}`);
                      return;
                    }
                    setStatusMessage(
                      `订阅成功！已同步 ${data.inserted} 场比赛/日程`
                    );
                    await pullAllFromServer(authToken);
                  }}
                  className="rounded-xl bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700"
                >
                  添加并同步订阅
                </button>
              </div>

              {/* 2. Google Calendar .ics file upload */}
              <div className="space-y-2 border-t border-slate-200 pt-4">
                <h4 className="font-bold text-slate-800">
                  2. 导入 Google Calendar (.ics 文件)
                </h4>
                <input
                  type="text"
                  value={importCalName}
                  onChange={(e) => setImportCalName(e.target.value)}
                  placeholder="导入后的日历名称"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2"
                />
                <input
                  type="file"
                  accept=".ics,text/calendar"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const text = await file.text();
                    setStatusMessage('正在解析并导入 .ics 文件...');
                    const res = await fetch('/api/ics/import', {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${authToken}`,
                      },
                      body: JSON.stringify({
                        calendarName: importCalName.trim() || 'Google 导入日历',
                        icsContent: text,
                      }),
                    });
                    const data = await res.json();
                    if (!res.ok) {
                      setStatusMessage(`导入失败：${data.message || '格式错误'}`);
                      return;
                    }
                    setStatusMessage(
                      `导入完成！共导入 ${data.inserted} 条日程（更新 ${data.updated} 条）`
                    );
                    await pullAllFromServer(authToken);
                  }}
                  className="block w-full text-xs text-slate-600 file:mr-3 file:rounded-xl file:border-0 file:bg-blue-50 file:px-4 file:py-2 file:font-semibold file:text-blue-600"
                />
              </div>

              {statusMessage && (
                <div className="rounded-xl bg-slate-100 p-3 font-medium text-slate-700">
                  {statusMessage}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
