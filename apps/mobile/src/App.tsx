import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AppState,
  Modal,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  CalendarRecord,
  EventRecord,
  ExpandedEventInstance,
  RecurrenceEditScope,
  createLunarRRuleFromTimestamp,
  deleteRecurringEvent,
  editRecurringEvent,
  expandEventsInWindow,
  fromCstComponents,
  getLunarDayInfo,
  isLunarRRule,
  toCstComponents,
} from '@acta/core';
import {
  getAllLocalCalendars,
  getAllLocalEvents,
  getLocalEventById,
  getLocalExceptionsForMaster,
  getServerConfig,
  saveLocalCalendar,
  saveLocalEventMutations,
  saveServerConfig,
} from './db/localDb';
import { syncEngine } from './sync/SyncEngine';
import {
  rescheduleRollingWindowAlarms,
  scheduleSelfTestReminder,
} from './reminders/ReminderScheduler';

type ViewMode = 'MONTH_SPLIT' | 'THREE_DAY' | 'WEEK';
type RecurrencePreset =
  | 'NONE'
  | 'DAILY'
  | 'WEEKLY'
  | 'MONTHLY'
  | 'YEARLY'
  | 'LUNAR_YEARLY'
  | 'LUNAR_MONTHLY';

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];
const WEEKDAY_RRULE_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function makeUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function getNextHalfHourTimestamp(baseDateMs: number): number {
  const cst = toCstComponents(baseDateMs);
  const nowCst = toCstComponents(Date.now());
  let hour = nowCst.hour;
  let minute = nowCst.minute < 30 ? 30 : 0;
  if (minute === 0) {
    hour = (hour + 1) % 24;
  }
  return fromCstComponents(cst.year, cst.month, cst.day, hour, minute, 0);
}

function formatHm(ms: number): string {
  const { hour, minute } = toCstComponents(ms);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function formatDateTimeInput(ms: number): string {
  const { year, month, day, hour, minute } = toCstComponents(ms);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(
    hour
  ).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseDateTimeInput(str: string, fallbackMs: number): number {
  const m = str
    .trim()
    .match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2}))?$/);
  if (!m) return fallbackMs;
  return fromCstComponents(
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4] ?? 9),
    Number(m[5] ?? 0),
    0
  );
}

export default function App() {
  const [viewMode, setViewMode] = useState<ViewMode>('MONTH_SPLIT');
  const [selectedDayStartMs, setSelectedDayStartMs] = useState<number>(() => {
    const nowCst = toCstComponents(Date.now());
    return fromCstComponents(nowCst.year, nowCst.month, nowCst.day, 0, 0, 0);
  });

  const [calendars, setCalendars] = useState<CalendarRecord[]>([]);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [syncStatusText, setSyncStatusText] = useState<string>('本地离线就绪');

  // Quick Create / Edit Bottom Sheet state
  const [editorVisible, setEditorVisible] = useState(false);
  const [editingInstance, setEditingInstance] =
    useState<ExpandedEventInstance | null>(null);
  const [titleInput, setTitleInput] = useState('');
  const [locationInput, setLocationInput] = useState('');
  const [descriptionInput, setDescriptionInput] = useState('');
  const [calendarIdInput, setCalendarIdInput] = useState('cal-personal');
  const [startTimeMs, setStartTimeMs] = useState<number>(() =>
    getNextHalfHourTimestamp(Date.now())
  );
  const [durationMinutes, setDurationMinutes] = useState<number>(60);
  const [startInputText, setStartInputText] = useState<string>('');
  const [recurrencePreset, setRecurrencePreset] =
    useState<RecurrencePreset>('NONE');
  const [reminderMinutes, setReminderMinutes] = useState<number>(15);

  // Recurrence 3-scope prompt state
  const [scopePromptVisible, setScopePromptVisible] = useState(false);
  const [scopePromptAction, setScopePromptAction] = useState<'EDIT' | 'DELETE'>(
    'EDIT'
  );

  // Settings / Subscriptions / Import Modal state
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [serverUrlInput, setServerUrlInput] = useState('');
  const [authTokenInput, setAuthTokenInput] = useState('');
  const [subNameInput, setSubNameInput] = useState('皇马赛程');
  const [subUrlInput, setSubUrlInput] = useState('');
  const [subReminderInput, setSubReminderInput] = useState('30');
  const [icsImportNameInput, setIcsImportNameInput] = useState('Google 导入日历');
  const [icsImportContentInput, setIcsImportContentInput] = useState('');

  const reloadFromLocalDb = useCallback(() => {
    const cals = getAllLocalCalendars();
    const evs = getAllLocalEvents();
    setCalendars(cals);
    setEvents(evs);
  }, []);

  useEffect(() => {
    reloadFromLocalDb();
    const cfg = getServerConfig();
    setServerUrlInput(cfg.serverUrl);
    setAuthTokenInput(cfg.authToken);

    const unsubscribe = syncEngine.subscribe(() => {
      reloadFromLocalDb();
    });

    void rescheduleRollingWindowAlarms();
    if (cfg.serverUrl && cfg.authToken) {
      syncEngine.connectWebSocket();
      void syncEngine.syncNow().then((res) => {
        if (res.ok) setSyncStatusText('已同步');
      });
    }

    const appStateSub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        void rescheduleRollingWindowAlarms();
        void syncEngine.syncNow();
      }
    });

    return () => {
      unsubscribe();
      appStateSub.remove();
      syncEngine.disconnectWebSocket();
    };
  }, [reloadFromLocalDb]);

  const selectedCst = useMemo(
    () => toCstComponents(selectedDayStartMs),
    [selectedDayStartMs]
  );

  // Calculate 42-day grid for current month
  const monthGridDays = useMemo(() => {
    const firstDayUtc = new Date(
      Date.UTC(selectedCst.year, selectedCst.month - 1, 1)
    );
    const startWeekday = firstDayUtc.getUTCDay(); // 0 (Sun) .. 6 (Sat)
    const gridStartMs =
      fromCstComponents(selectedCst.year, selectedCst.month, 1, 0, 0, 0) -
      startWeekday * 24 * 3600 * 1000;

    const days: Array<{
      dayStartMs: number;
      year: number;
      month: number;
      day: number;
      isCurrentMonth: boolean;
      lunarShort: string;
      isLunarHighlight: boolean;
    }> = [];

    for (let i = 0; i < 42; i++) {
      const ms = gridStartMs + i * 24 * 3600 * 1000;
      const cst = toCstComponents(ms);
      const lunar = getLunarDayInfo(ms);
      days.push({
        dayStartMs: ms,
        year: cst.year,
        month: cst.month,
        day: cst.day,
        isCurrentMonth: cst.month === selectedCst.month,
        lunarShort: lunar.shortLabel,
        isLunarHighlight: lunar.isHighlight,
      });
    }
    return days;
  }, [selectedCst.year, selectedCst.month]);

  // Expand all events across the visible month grid
  const monthExpandedInstances = useMemo(() => {
    if (monthGridDays.length === 0) return [];
    const startMs = monthGridDays[0].dayStartMs;
    const endMs =
      monthGridDays[monthGridDays.length - 1].dayStartMs +
      24 * 3600 * 1000 -
      1;
    return expandEventsInWindow(events, startMs, endMs, calendars);
  }, [events, calendars, monthGridDays]);

  const instancesByDayStart = useMemo(() => {
    const map = new Map<number, ExpandedEventInstance[]>();
    for (const d of monthGridDays) {
      const dayStart = d.dayStartMs;
      const dayEnd = dayStart + 24 * 3600 * 1000 - 1;
      const list = monthExpandedInstances.filter(
        (inst) => inst.endTime >= dayStart && inst.startTime <= dayEnd
      );
      map.set(dayStart, list);
    }
    return map;
  }, [monthGridDays, monthExpandedInstances]);

  const selectedDayInstances = useMemo(() => {
    const dayEnd = selectedDayStartMs + 24 * 3600 * 1000 - 1;
    return expandEventsInWindow(events, selectedDayStartMs, dayEnd, calendars);
  }, [events, calendars, selectedDayStartMs]);

  // Columns for 3-Day or Week TimeGrid view
  const timeGridColumns = useMemo(() => {
    const count = viewMode === 'THREE_DAY' ? 3 : 7;
    let baseStartMs = selectedDayStartMs;
    if (viewMode === 'WEEK') {
      const cst = toCstComponents(selectedDayStartMs);
      const weekday = new Date(
        Date.UTC(cst.year, cst.month - 1, cst.day)
      ).getUTCDay();
      baseStartMs = selectedDayStartMs - weekday * 24 * 3600 * 1000;
    }

    const cols: Array<{
      dayStartMs: number;
      day: number;
      weekdayLabel: string;
      lunarShort: string;
      instances: ExpandedEventInstance[];
    }> = [];

    for (let i = 0; i < count; i++) {
      const ms = baseStartMs + i * 24 * 3600 * 1000;
      const cst = toCstComponents(ms);
      const weekday = new Date(
        Date.UTC(cst.year, cst.month - 1, cst.day)
      ).getUTCDay();
      const lunar = getLunarDayInfo(ms);
      const instances = expandEventsInWindow(
        events,
        ms,
        ms + 24 * 3600 * 1000 - 1,
        calendars
      );
      cols.push({
        dayStartMs: ms,
        day: cst.day,
        weekdayLabel: WEEKDAY_LABELS[weekday],
        lunarShort: lunar.shortLabel,
        instances,
      });
    }
    return cols;
  }, [viewMode, selectedDayStartMs, events, calendars]);

  const jumpToToday = () => {
    const nowCst = toCstComponents(Date.now());
    setSelectedDayStartMs(
      fromCstComponents(nowCst.year, nowCst.month, nowCst.day, 0, 0, 0)
    );
  };

  const navigatePeriod = (direction: -1 | 1) => {
    if (viewMode === 'MONTH_SPLIT') {
      let nextMonth = selectedCst.month + direction;
      let nextYear = selectedCst.year;
      if (nextMonth < 1) {
        nextMonth = 12;
        nextYear -= 1;
      } else if (nextMonth > 12) {
        nextMonth = 1;
        nextYear += 1;
      }
      setSelectedDayStartMs(fromCstComponents(nextYear, nextMonth, 1, 0, 0, 0));
    } else {
      const stepDays = viewMode === 'THREE_DAY' ? 3 : 7;
      setSelectedDayStartMs(
        selectedDayStartMs + direction * stepDays * 24 * 3600 * 1000
      );
    }
  };

  const openQuickCreateSheet = () => {
    const defaultStart = getNextHalfHourTimestamp(selectedDayStartMs);
    const writableCals = calendars.filter((c) => c.is_readonly === 0);
    setEditingInstance(null);
    setTitleInput('');
    setLocationInput('');
    setDescriptionInput('');
    setCalendarIdInput(writableCals[0]?.id || 'cal-personal');
    setStartTimeMs(defaultStart);
    setStartInputText(formatDateTimeInput(defaultStart));
    setDurationMinutes(60);
    setRecurrencePreset('NONE');
    setReminderMinutes(15);
    setEditorVisible(true);
  };

  const openEditInstanceSheet = (inst: ExpandedEventInstance) => {
    if (inst.isReadonly) {
      Alert.alert(
        inst.title,
        `时间：${formatDateTimeInput(inst.startTime)} - ${formatHm(
          inst.endTime
        )}\n地点：${inst.location || '无'}\n备注：${
          inst.description || '外部订阅日历（只读）'
        }`
      );
      return;
    }
    setEditingInstance(inst);
    setTitleInput(inst.title);
    setLocationInput(inst.location);
    setDescriptionInput(inst.description);
    setCalendarIdInput(inst.calendarId);
    setStartTimeMs(inst.startTime);
    setStartInputText(formatDateTimeInput(inst.startTime));
    setDurationMinutes(
      Math.max(15, Math.round((inst.endTime - inst.startTime) / 60000))
    );
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

    setEditorVisible(true);
  };

  const applyQuickTimePill = (
    type: 'TODAY_15' | 'TONIGHT_20' | 'TOMORROW_10' | 'PLUS_30M' | 'PLUS_60M'
  ) => {
    const nowCst = toCstComponents(Date.now());
    let nextStart = startTimeMs;
    if (type === 'TODAY_15') {
      nextStart = fromCstComponents(
        nowCst.year,
        nowCst.month,
        nowCst.day,
        15,
        0,
        0
      );
    } else if (type === 'TONIGHT_20') {
      nextStart = fromCstComponents(
        nowCst.year,
        nowCst.month,
        nowCst.day,
        20,
        0,
        0
      );
    } else if (type === 'TOMORROW_10') {
      nextStart =
        fromCstComponents(nowCst.year, nowCst.month, nowCst.day, 10, 0, 0) +
        24 * 3600 * 1000;
    } else if (type === 'PLUS_30M') {
      setDurationMinutes((d) => d + 30);
      return;
    } else if (type === 'PLUS_60M') {
      setDurationMinutes((d) => d + 60);
      return;
    }
    setStartTimeMs(nextStart);
    setStartInputText(formatDateTimeInput(nextStart));
  };

  const buildRRuleFromPreset = (
    preset: RecurrencePreset,
    eventStartMs: number
  ): string | null => {
    const cst = toCstComponents(eventStartMs);
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
        return createLunarRRuleFromTimestamp(eventStartMs, 'YEARLY');
      case 'LUNAR_MONTHLY':
        return createLunarRRuleFromTimestamp(eventStartMs, 'MONTHLY');
    }
  };

  const commitSaveWithScope = async (scope?: RecurrenceEditScope) => {
    const cleanTitle = titleInput.trim() || '未命名日程';
    const parsedStart = parseDateTimeInput(startInputText, startTimeMs);
    const parsedEnd = parsedStart + durationMinutes * 60 * 1000;
    const rruleStr = buildRRuleFromPreset(recurrencePreset, parsedStart);
    const remindersStr = reminderMinutes < 0 ? '[]' : JSON.stringify([reminderMinutes]);
    const now = Date.now();

    if (!editingInstance) {
      const newEvent: EventRecord = {
        id: makeUuid(),
        calendar_id: calendarIdInput,
        external_uid: null,
        title: cleanTitle,
        description: descriptionInput.trim(),
        location: locationInput.trim(),
        color: null,
        start_time: parsedStart,
        end_time: parsedEnd,
        is_all_day: 0,
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
        sync_status: 'DIRTY',
      };
      saveLocalEventMutations([], [newEvent]);
    } else if (!editingInstance.isRecurring || !editingInstance.masterEventId) {
      const existing = getLocalEventById(editingInstance.eventId);
      if (existing) {
        saveLocalEventMutations(
          [
            {
              ...existing,
              calendar_id: calendarIdInput,
              title: cleanTitle,
              description: descriptionInput.trim(),
              location: locationInput.trim(),
              start_time: parsedStart,
              end_time: parsedEnd,
              rrule: rruleStr,
              reminders: remindersStr,
              updated_at: now,
              sync_status: 'DIRTY',
            },
          ],
          []
        );
      }
    } else {
      const master = getLocalEventById(editingInstance.masterEventId);
      if (master && scope) {
        const exceptions = getLocalExceptionsForMaster(master.id);
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
            start_time: parsedStart,
            end_time: parsedEnd,
            rrule: scope === 'THIS' ? null : rruleStr,
            reminders: remindersStr,
          },
          newRecordId: makeUuid(),
          nowMs: now,
        });
        saveLocalEventMutations(mutation.updatedRecords, mutation.createdRecords);
      }
    }

    setScopePromptVisible(false);
    setEditorVisible(false);
    await syncEngine.onLocalMutation();
  };

  const commitDeleteWithScope = async (scope?: RecurrenceEditScope) => {
    if (!editingInstance) return;
    const now = Date.now();

    if (!editingInstance.isRecurring || !editingInstance.masterEventId) {
      const existing = getLocalEventById(editingInstance.eventId);
      if (existing) {
        saveLocalEventMutations(
          [
            {
              ...existing,
              is_deleted: 1,
              updated_at: now,
              sync_status: 'DIRTY',
            },
          ],
          []
        );
      }
    } else {
      const master = getLocalEventById(editingInstance.masterEventId);
      if (master && scope) {
        const exceptions = getLocalExceptionsForMaster(master.id);
        const mutation = deleteRecurringEvent({
          masterEvent: master,
          existingExceptions: exceptions,
          instanceStartTime: editingInstance.originalStartTime,
          scope,
          nowMs: now,
        });
        saveLocalEventMutations(mutation.updatedRecords, mutation.createdRecords);
      }
    }

    setScopePromptVisible(false);
    setEditorVisible(false);
    await syncEngine.onLocalMutation();
  };

  const handleSavePress = () => {
    if (editingInstance && editingInstance.isRecurring) {
      setScopePromptAction('EDIT');
      setScopePromptVisible(true);
    } else {
      void commitSaveWithScope();
    }
  };

  const handleDeletePress = () => {
    if (!editingInstance) return;
    if (editingInstance.isRecurring) {
      setScopePromptAction('DELETE');
      setScopePromptVisible(true);
    } else {
      void commitDeleteWithScope();
    }
  };

  const selectedDayLunar = useMemo(
    () => getLunarDayInfo(selectedDayStartMs),
    [selectedDayStartMs]
  );

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#FFFFFF" />

      {/* Top Navigation Bar */}
      <View style={styles.topBar}>
        <View style={styles.topBarLeft}>
          <TouchableOpacity
            onPress={() => navigatePeriod(-1)}
            style={styles.navArrowBtn}
          >
            <Text style={styles.navArrowText}>‹</Text>
          </TouchableOpacity>
          <View>
            <Text style={styles.monthTitle}>
              {selectedCst.year}年{selectedCst.month}月
            </Text>
            <Text style={styles.lunarSubtitle}>
              {selectedDayLunar.lunarYearInGanZhi}年 · 农历
              {selectedDayLunar.lunarMonthInChinese}
              {selectedDayLunar.lunarDayInChinese}
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => navigatePeriod(1)}
            style={styles.navArrowBtn}
          >
            <Text style={styles.navArrowText}>›</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.topBarRight}>
          <TouchableOpacity onPress={jumpToToday} style={styles.todayChip}>
            <Text style={styles.todayChipText}>今</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() =>
              setViewMode((m) =>
                m === 'MONTH_SPLIT'
                  ? 'THREE_DAY'
                  : m === 'THREE_DAY'
                  ? 'WEEK'
                  : 'MONTH_SPLIT'
              )
            }
            style={styles.viewChip}
          >
            <Text style={styles.viewChipText}>
              {viewMode === 'MONTH_SPLIT'
                ? '月视图'
                : viewMode === 'THREE_DAY'
                ? '三日'
                : '周视图'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setSettingsVisible(true)}
            style={styles.settingsChip}
          >
            <Text style={styles.settingsChipText}>设置/订阅</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Main Content Area: Split Month View OR TimeGrid View */}
      {viewMode === 'MONTH_SPLIT' ? (
        <View style={styles.splitContainer}>
          {/* Upper Half: Compact Lunar Month Grid */}
          <View style={styles.monthGridCard}>
            <View style={styles.weekdayHeaderRow}>
              {WEEKDAY_LABELS.map((w) => (
                <Text key={w} style={styles.weekdayHeaderText}>
                  {w}
                </Text>
              ))}
            </View>

            <View style={styles.monthCellsWrap}>
              {monthGridDays.map((cell) => {
                const isSelected = cell.dayStartMs === selectedDayStartMs;
                const dayEvents = instancesByDayStart.get(cell.dayStartMs) || [];
                return (
                  <TouchableOpacity
                    key={cell.dayStartMs}
                    style={[
                      styles.dayCell,
                      isSelected && styles.dayCellSelected,
                    ]}
                    onPress={() => setSelectedDayStartMs(cell.dayStartMs)}
                  >
                    <Text
                      style={[
                        styles.dayNumberText,
                        !cell.isCurrentMonth && styles.dayNumberMuted,
                        isSelected && styles.dayNumberSelected,
                      ]}
                    >
                      {cell.day}
                    </Text>
                    <Text
                      style={[
                        styles.dayLunarText,
                        cell.isLunarHighlight && styles.dayLunarHighlight,
                        isSelected && styles.dayNumberSelected,
                      ]}
                      numberOfLines={1}
                    >
                      {cell.lunarShort}
                    </Text>
                    <View style={styles.dotRow}>
                      {dayEvents.slice(0, 3).map((ev) => (
                        <View
                          key={ev.instanceId}
                          style={[
                            styles.eventDot,
                            {
                              backgroundColor: isSelected
                                ? '#FFFFFF'
                                : ev.color,
                            },
                          ]}
                        />
                      ))}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* Lower Half: Selected Day Instant Agenda Stream */}
          <View style={styles.agendaListContainer}>
            <View style={styles.agendaHeaderBar}>
              <Text style={styles.agendaDateTitle}>
                {selectedCst.month}月{selectedCst.day}日 · 农历
                {selectedDayLunar.lunarMonthInChinese}
                {selectedDayLunar.lunarDayInChinese}
                {selectedDayLunar.solarTerm
                  ? ` · ${selectedDayLunar.solarTerm}`
                  : ''}
              </Text>
              <Text style={styles.syncBadgeText}>{syncStatusText}</Text>
            </View>

            <ScrollView contentContainerStyle={styles.agendaScrollContent}>
              {selectedDayInstances.length === 0 ? (
                <View style={styles.emptyAgendaBox}>
                  <Text style={styles.emptyAgendaText}>
                    当天暂无日程或比赛，点击右下角 + 极速录入
                  </Text>
                </View>
              ) : (
                selectedDayInstances.map((inst) => (
                  <TouchableOpacity
                    key={inst.instanceId}
                    style={[
                      styles.agendaCard,
                      { borderLeftColor: inst.color },
                    ]}
                    onPress={() => openEditInstanceSheet(inst)}
                  >
                    <View style={styles.agendaCardMain}>
                      <Text style={styles.agendaCardTitle}>{inst.title}</Text>
                      <View style={styles.agendaMetaRow}>
                        <Text style={styles.agendaCardTime}>
                          {inst.isAllDay
                            ? '全天'
                            : `${formatHm(inst.startTime)} - ${formatHm(
                                inst.endTime
                              )}`}
                        </Text>
                        {inst.isLunarRecurring && (
                          <Text style={styles.lunarTag}>农历重复</Text>
                        )}
                        {inst.isReadonly && (
                          <Text style={styles.subTag}>订阅赛程</Text>
                        )}
                      </View>
                      {inst.location ? (
                        <Text style={styles.agendaLocationText}>
                          📍 {inst.location}
                        </Text>
                      ) : null}
                    </View>
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
          </View>
        </View>
      ) : (
        /* Three-Day / Week TimeGrid View */
        <View style={styles.timeGridContainer}>
          <View style={styles.timeGridHeaderRow}>
            {timeGridColumns.map((col) => {
              const isSelected = col.dayStartMs === selectedDayStartMs;
              return (
                <TouchableOpacity
                  key={col.dayStartMs}
                  style={[
                    styles.timeGridDayHeader,
                    isSelected && styles.timeGridDayHeaderActive,
                  ]}
                  onPress={() => setSelectedDayStartMs(col.dayStartMs)}
                >
                  <Text style={styles.timeGridWeekdayText}>
                    周{col.weekdayLabel}
                  </Text>
                  <Text style={styles.timeGridDayNumText}>{col.day}</Text>
                  <Text style={styles.timeGridLunarText}>{col.lunarShort}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <ScrollView contentContainerStyle={styles.timeGridColumnsScroll}>
            <View style={styles.timeGridColumnsRow}>
              {timeGridColumns.map((col) => (
                <View key={col.dayStartMs} style={styles.timeGridCol}>
                  {col.instances.length === 0 ? (
                    <Text style={styles.timeGridEmptyColText}>无</Text>
                  ) : (
                    col.instances.map((inst) => (
                      <TouchableOpacity
                        key={inst.instanceId}
                        style={[
                          styles.timeGridBlock,
                          { backgroundColor: inst.color },
                        ]}
                        onPress={() => openEditInstanceSheet(inst)}
                      >
                        <Text
                          style={styles.timeGridBlockTime}
                          numberOfLines={1}
                        >
                          {inst.isAllDay ? '全天' : formatHm(inst.startTime)}
                        </Text>
                        <Text
                          style={styles.timeGridBlockTitle}
                          numberOfLines={2}
                        >
                          {inst.title}
                        </Text>
                      </TouchableOpacity>
                    ))
                  )}
                </View>
              ))}
            </View>
          </ScrollView>
        </View>
      )}

      {/* Floating Action Button (FAB) */}
      <TouchableOpacity
        style={styles.fabButton}
        onPress={openQuickCreateSheet}
      >
        <Text style={styles.fabButtonText}>＋</Text>
      </TouchableOpacity>

      {/* Quick Create / Edit Bottom Sheet Modal */}
      <Modal
        visible={editorVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setEditorVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.bottomSheetCard}>
            <View style={styles.sheetHeaderRow}>
              <Text style={styles.sheetHeaderTitle}>
                {editingInstance ? '编辑日程' : '极速新建日程'}
              </Text>
              <TouchableOpacity onPress={() => setEditorVisible(false)}>
                <Text style={styles.sheetCloseText}>关闭</Text>
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.sheetScroll}>
              <TextInput
                style={styles.titleTextInput}
                placeholder="输入日程或纪念日标题..."
                value={titleInput}
                onChangeText={setTitleInput}
              />

              {/* Quick Time Capsules */}
              <Text style={styles.sectionLabel}>快捷时间胶囊</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.capsuleRow}
              >
                <TouchableOpacity
                  style={styles.capsuleBtn}
                  onPress={() => applyQuickTimePill('TODAY_15')}
                >
                  <Text style={styles.capsuleBtnText}>今天下午3点</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.capsuleBtn}
                  onPress={() => applyQuickTimePill('TONIGHT_20')}
                >
                  <Text style={styles.capsuleBtnText}>今晚8点</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.capsuleBtn}
                  onPress={() => applyQuickTimePill('TOMORROW_10')}
                >
                  <Text style={styles.capsuleBtnText}>明天上午10点</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.capsuleBtn}
                  onPress={() => applyQuickTimePill('PLUS_30M')}
                >
                  <Text style={styles.capsuleBtnText}>时长+30分</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.capsuleBtn}
                  onPress={() => applyQuickTimePill('PLUS_60M')}
                >
                  <Text style={styles.capsuleBtnText}>时长+1小时</Text>
                </TouchableOpacity>
              </ScrollView>

              <Text style={styles.sectionLabel}>
                开始时间（格式 YYYY-MM-DD HH:mm）与时长（{durationMinutes} 分钟）
              </Text>
              <TextInput
                style={styles.fieldInput}
                value={startInputText}
                onChangeText={setStartInputText}
                placeholder="2026-11-13 15:00"
              />

              {/* Recurrence Rules (including Lunar Yearly/Monthly!) */}
              <Text style={styles.sectionLabel}>重复规则（支持公历与农历生日）</Text>
              <View style={styles.wrapChipsRow}>
                {(
                  [
                    ['NONE', '不重复'],
                    ['DAILY', '每天'],
                    ['WEEKLY', '每周'],
                    ['MONTHLY', '每月公历'],
                    ['YEARLY', '每年公历'],
                    ['LUNAR_YEARLY', '每年农历（生日/纪念日）'],
                    ['LUNAR_MONTHLY', '每月农历'],
                  ] as Array<[RecurrencePreset, string]>
                ).map(([key, label]) => (
                  <TouchableOpacity
                    key={key}
                    style={[
                      styles.optionChip,
                      recurrencePreset === key && styles.optionChipActive,
                    ]}
                    onPress={() => setRecurrencePreset(key)}
                  >
                    <Text
                      style={[
                        styles.optionChipText,
                        recurrencePreset === key && styles.optionChipTextActive,
                      ]}
                    >
                      {label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* Reminder Options */}
              <Text style={styles.sectionLabel}>锁屏横幅提醒</Text>
              <View style={styles.wrapChipsRow}>
                {[
                  [-1, '不提醒'],
                  [0, '准时提醒'],
                  [10, '提前10分钟'],
                  [15, '提前15分钟'],
                  [30, '提前30分钟'],
                  [60, '提前1小时'],
                ].map(([mins, label]) => (
                  <TouchableOpacity
                    key={String(mins)}
                    style={[
                      styles.optionChip,
                      reminderMinutes === mins && styles.optionChipActive,
                    ]}
                    onPress={() => setReminderMinutes(Number(mins))}
                  >
                    <Text
                      style={[
                        styles.optionChipText,
                        reminderMinutes === mins && styles.optionChipTextActive,
                      ]}
                    >
                      {label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* Calendar Category Picker */}
              <Text style={styles.sectionLabel}>所属日历分类</Text>
              <View style={styles.wrapChipsRow}>
                {calendars
                  .filter((c) => c.is_readonly === 0)
                  .map((cal) => (
                    <TouchableOpacity
                      key={cal.id}
                      style={[
                        styles.optionChip,
                        calendarIdInput === cal.id && {
                          backgroundColor: cal.color,
                          borderColor: cal.color,
                        },
                      ]}
                      onPress={() => setCalendarIdInput(cal.id)}
                    >
                      <Text
                        style={[
                          styles.optionChipText,
                          calendarIdInput === cal.id &&
                            styles.optionChipTextActive,
                        ]}
                      >
                        {cal.name}
                      </Text>
                    </TouchableOpacity>
                  ))}
              </View>

              <Text style={styles.sectionLabel}>地点与备注</Text>
              <TextInput
                style={styles.fieldInput}
                placeholder="地点（可选）"
                value={locationInput}
                onChangeText={setLocationInput}
              />
              <TextInput
                style={[styles.fieldInput, { marginTop: 8 }]}
                placeholder="备注说明（可选）"
                value={descriptionInput}
                onChangeText={setDescriptionInput}
              />
            </ScrollView>

            <View style={styles.sheetFooterRow}>
              {editingInstance && (
                <TouchableOpacity
                  style={styles.deleteBtn}
                  onPress={handleDeletePress}
                >
                  <Text style={styles.deleteBtnText}>删除</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={styles.savePrimaryBtn}
                onPress={handleSavePress}
              >
                <Text style={styles.savePrimaryBtnText}>保存日程</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Recurring Event 3-Scope Selection Modal */}
      <Modal
        visible={scopePromptVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setScopePromptVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.scopeDialogCard}>
            <Text style={styles.scopeDialogTitle}>
              {scopePromptAction === 'EDIT'
                ? '修改重复日程作用域'
                : '删除重复日程作用域'}
            </Text>
            <TouchableOpacity
              style={styles.scopeOptionBtn}
              onPress={() =>
                scopePromptAction === 'EDIT'
                  ? void commitSaveWithScope('THIS')
                  : void commitDeleteWithScope('THIS')
              }
            >
              <Text style={styles.scopeOptionText}>仅此日程（This event）</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.scopeOptionBtn}
              onPress={() =>
                scopePromptAction === 'EDIT'
                  ? void commitSaveWithScope('THIS_AND_FOLLOWING')
                  : void commitDeleteWithScope('THIS_AND_FOLLOWING')
              }
            >
              <Text style={styles.scopeOptionText}>
                此日程及后续日程（This and following）
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.scopeOptionBtn}
              onPress={() =>
                scopePromptAction === 'EDIT'
                  ? void commitSaveWithScope('ALL')
                  : void commitDeleteWithScope('ALL')
              }
            >
              <Text style={styles.scopeOptionText}>所有日程（All events）</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.scopeOptionBtn, { borderBottomWidth: 0 }]}
              onPress={() => setScopePromptVisible(false)}
            >
              <Text style={[styles.scopeOptionText, { color: '#64748B' }]}>
                取消
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Settings, Subscriptions (Real Madrid iCal), Google .ics Import & Alarm Self-Test Modal */}
      <Modal
        visible={settingsVisible}
        animationType="slide"
        onRequestClose={() => setSettingsVisible(false)}
      >
        <SafeAreaView style={styles.settingsContainer}>
          <View style={styles.sheetHeaderRow}>
            <Text style={styles.sheetHeaderTitle}>
              服务器连接 · 赛事订阅 · 提醒自检
            </Text>
            <TouchableOpacity onPress={() => setSettingsVisible(false)}>
              <Text style={styles.sheetCloseText}>完成</Text>
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.settingsScroll}>
            {/* 1. Server Connection */}
            <Text style={styles.settingsGroupTitle}>1. 私有服务器连接配置</Text>
            <TextInput
              style={styles.fieldInput}
              placeholder="服务器域名（如 https://cal.yourdomain.com）"
              value={serverUrlInput}
              onChangeText={setServerUrlInput}
              autoCapitalize="none"
            />
            <TextInput
              style={[styles.fieldInput, { marginTop: 8 }]}
              placeholder="访问密码（AUTH_SECRET）"
              value={authTokenInput}
              onChangeText={setAuthTokenInput}
              secureTextEntry
            />
            <TouchableOpacity
              style={[styles.savePrimaryBtn, { marginTop: 10 }]}
              onPress={async () => {
                saveServerConfig(serverUrlInput, authTokenInput);
                const verify = await syncEngine.verifyServerConnection(
                  serverUrlInput,
                  authTokenInput
                );
                if (verify.ok) {
                  syncEngine.connectWebSocket();
                  await syncEngine.syncNow();
                  setSyncStatusText('已同步');
                }
                Alert.alert('连接状态', verify.message);
              }}
            >
              <Text style={styles.savePrimaryBtnText}>保存并立即同步</Text>
            </TouchableOpacity>

            {/* 2. External iCal Subscription (e.g. Real Madrid matches) */}
            <Text style={styles.settingsGroupTitle}>
              2. 外部 iCal 日历订阅（如皇马官方比赛日历）
            </Text>
            <TextInput
              style={styles.fieldInput}
              placeholder="订阅名称（如：皇马赛程）"
              value={subNameInput}
              onChangeText={setSubNameInput}
            />
            <TextInput
              style={[styles.fieldInput, { marginTop: 8 }]}
              placeholder="iCal 链接（支持 https:// 或 webcal://）"
              value={subUrlInput}
              onChangeText={setSubUrlInput}
              autoCapitalize="none"
            />
            <TextInput
              style={[styles.fieldInput, { marginTop: 8 }]}
              placeholder="默认提前提醒分钟数（如 30 代表开球前30分钟）"
              value={subReminderInput}
              onChangeText={setSubReminderInput}
              keyboardType="numeric"
            />
            <TouchableOpacity
              style={[styles.savePrimaryBtn, { marginTop: 10 }]}
              onPress={async () => {
                if (!subUrlInput.trim()) {
                  Alert.alert('提示', '请输入外部 iCal 订阅 URL');
                  return;
                }
                const remMins = Number(subReminderInput) || 30;
                const res = await syncEngine.addExternalSubscription({
                  name: subNameInput.trim() || '皇马赛程',
                  url: subUrlInput.trim(),
                  defaultReminders: [remMins],
                });
                Alert.alert('订阅结果', res.message);
              }}
            >
              <Text style={styles.savePrimaryBtnText}>添加并拉取赛程订阅</Text>
            </TouchableOpacity>

            {/* Existing Calendars & Subscriptions List */}
            <Text style={styles.settingsGroupTitle}>3. 我的日历与已订阅列表</Text>
            {calendars.map((cal) => (
              <View key={cal.id} style={styles.calManageRow}>
                <TouchableOpacity
                  style={styles.calToggleArea}
                  onPress={() => {
                    saveLocalCalendar({
                      ...cal,
                      is_visible: cal.is_visible === 1 ? 0 : 1,
                      updated_at: Date.now(),
                    });
                    void syncEngine.onLocalMutation();
                  }}
                >
                  <View
                    style={[
                      styles.calColorBox,
                      {
                        backgroundColor:
                          cal.is_visible === 1 ? cal.color : '#CBD5E1',
                      },
                    ]}
                  />
                  <Text style={styles.calManageName}>
                    {cal.name} {cal.is_readonly === 1 ? '(订阅)' : ''}
                  </Text>
                </TouchableOpacity>
                {cal.is_readonly === 1 && (
                  <TouchableOpacity
                    style={styles.refreshMiniBtn}
                    onPress={async () => {
                      const r = await syncEngine.refreshSubscription(cal.id);
                      Alert.alert('刷新订阅', r.message);
                    }}
                  >
                    <Text style={styles.refreshMiniBtnText}>刷新</Text>
                  </TouchableOpacity>
                )}
              </View>
            ))}

            {/* 4. Domestic ROM Lockscreen Alarm Self-Test */}
            <Text style={styles.settingsGroupTitle}>
              4. 国产系统（HyperOS / OriginOS / ColorOS）锁屏精准提醒自检
            </Text>
            <Text style={styles.helperNoteText}>
              建议在系统「应用设置」中为本应用开启「自启动」并将省电策略设为「无限制」。点击下方按钮后立即锁屏，10 秒后将触发系统级精确闹钟通知。
            </Text>
            <TouchableOpacity
              style={[
                styles.savePrimaryBtn,
                { backgroundColor: '#059669', marginTop: 8 },
              ]}
              onPress={async () => {
                const ok = await scheduleSelfTestReminder(10);
                if (ok) {
                  Alert.alert(
                    '已注册 10 秒后精确提醒',
                    '请现在按电源键锁屏，10 秒后验证锁屏横幅与震动提示音！'
                  );
                } else {
                  Alert.alert('权限不足', '请先在系统设置中授予通知权限');
                }
              }}
            >
              <Text style={styles.savePrimaryBtnText}>
                🔔 测试 10 秒后锁屏横幅提醒
              </Text>
            </TouchableOpacity>

            {/* 5. Google Calendar .ics Import */}
            <Text style={styles.settingsGroupTitle}>
              5. 导入 Google Calendar (.ics) 备份
            </Text>
            <TextInput
              style={styles.fieldInput}
              placeholder="导入目标日历名称"
              value={icsImportNameInput}
              onChangeText={setIcsImportNameInput}
            />
            <TextInput
              style={[styles.fieldInput, { height: 90, marginTop: 8 }]}
              placeholder="在此粘贴从 Google Calendar 导出的 .ics 文件文本内容..."
              multiline
              value={icsImportContentInput}
              onChangeText={setIcsImportContentInput}
            />
            <TouchableOpacity
              style={[styles.savePrimaryBtn, { marginTop: 10 }]}
              onPress={async () => {
                if (!icsImportContentInput.trim()) {
                  Alert.alert('提示', '请粘贴 .ics 文件内容');
                  return;
                }
                const res = await syncEngine.importGoogleIcs({
                  calendarName: icsImportNameInput.trim() || 'Google 导入日历',
                  icsContent: icsImportContentInput,
                });
                Alert.alert('导入结果', res.message);
              }}
            >
              <Text style={styles.savePrimaryBtnText}>一键导入 .ics 数据</Text>
            </TouchableOpacity>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
  },
  topBarLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  navArrowBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  navArrowText: {
    fontSize: 22,
    fontWeight: '600',
    color: '#334155',
  },
  monthTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#0F172A',
  },
  lunarSubtitle: {
    fontSize: 11,
    color: '#64748B',
  },
  topBarRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  todayChip: {
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
  },
  todayChipText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#2563EB',
  },
  viewChip: {
    backgroundColor: '#F1F5F9',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
  },
  viewChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#334155',
  },
  settingsChip: {
    backgroundColor: '#0F172A',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
  },
  settingsChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  splitContainer: {
    flex: 1,
  },
  monthGridCard: {
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 8,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
  },
  weekdayHeaderRow: {
    flexDirection: 'row',
    paddingVertical: 6,
  },
  weekdayHeaderText: {
    flex: 1,
    textAlign: 'center',
    fontSize: 12,
    fontWeight: '600',
    color: '#64748B',
  },
  monthCellsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  dayCell: {
    width: '14.2857%',
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
  },
  dayCellSelected: {
    backgroundColor: '#2563EB',
  },
  dayNumberText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#0F172A',
  },
  dayNumberMuted: {
    color: '#CBD5E1',
  },
  dayNumberSelected: {
    color: '#FFFFFF',
  },
  dayLunarText: {
    fontSize: 10,
    color: '#64748B',
    marginTop: 1,
  },
  dayLunarHighlight: {
    color: '#2563EB',
    fontWeight: '700',
  },
  dotRow: {
    flexDirection: 'row',
    gap: 3,
    marginTop: 2,
    height: 5,
  },
  eventDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  agendaListContainer: {
    flex: 1,
    paddingHorizontal: 14,
    paddingTop: 10,
  },
  agendaHeaderBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  agendaDateTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1E293B',
  },
  syncBadgeText: {
    fontSize: 11,
    color: '#64748B',
  },
  agendaScrollContent: {
    paddingBottom: 90,
  },
  emptyAgendaBox: {
    paddingVertical: 32,
    alignItems: 'center',
  },
  emptyAgendaText: {
    fontSize: 13,
    color: '#94A3B8',
  },
  agendaCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderLeftWidth: 4,
    shadowColor: '#000',
    shadowOpacity: 0.03,
    shadowRadius: 4,
    elevation: 1,
  },
  agendaCardMain: {
    flexDirection: 'column',
  },
  agendaCardTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#0F172A',
  },
  agendaMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  agendaCardTime: {
    fontSize: 12,
    color: '#475569',
  },
  lunarTag: {
    fontSize: 10,
    color: '#BE185D',
    backgroundColor: '#FCE7F3',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  subTag: {
    fontSize: 10,
    color: '#1D4ED8',
    backgroundColor: '#DBEAFE',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  agendaLocationText: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 4,
  },
  timeGridContainer: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  timeGridHeaderRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
  },
  timeGridDayHeader: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
  },
  timeGridDayHeaderActive: {
    backgroundColor: '#EFF6FF',
  },
  timeGridWeekdayText: {
    fontSize: 11,
    color: '#64748B',
  },
  timeGridDayNumText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0F172A',
  },
  timeGridLunarText: {
    fontSize: 10,
    color: '#64748B',
  },
  timeGridColumnsScroll: {
    padding: 8,
    paddingBottom: 90,
  },
  timeGridColumnsRow: {
    flexDirection: 'row',
    gap: 6,
  },
  timeGridCol: {
    flex: 1,
    minHeight: 400,
    backgroundColor: '#F8FAFC',
    borderRadius: 8,
    padding: 4,
  },
  timeGridEmptyColText: {
    fontSize: 11,
    color: '#CBD5E1',
    textAlign: 'center',
    marginTop: 20,
  },
  timeGridBlock: {
    borderRadius: 6,
    padding: 6,
    marginBottom: 6,
  },
  timeGridBlockTime: {
    fontSize: 10,
    color: '#FFFFFF',
    opacity: 0.9,
  },
  timeGridBlockTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  fabButton: {
    position: 'absolute',
    right: 20,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#2563EB',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 5,
  },
  fabButtonText: {
    fontSize: 28,
    color: '#FFFFFF',
    lineHeight: 32,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: 'flex-end',
  },
  bottomSheetCard: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 16,
    maxHeight: '88%',
  },
  sheetHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
  },
  sheetHeaderTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0F172A',
  },
  sheetCloseText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#2563EB',
  },
  sheetScroll: {
    marginVertical: 10,
  },
  titleTextInput: {
    fontSize: 18,
    fontWeight: '600',
    color: '#0F172A',
    borderBottomWidth: 1,
    borderBottomColor: '#CBD5E1',
    paddingVertical: 8,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#475569',
    marginTop: 14,
    marginBottom: 6,
  },
  capsuleRow: {
    flexDirection: 'row',
  },
  capsuleBtn: {
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    marginRight: 8,
  },
  capsuleBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1D4ED8',
  },
  fieldInput: {
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    color: '#0F172A',
    backgroundColor: '#FFFFFF',
  },
  wrapChipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  optionChip: {
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  optionChipActive: {
    backgroundColor: '#2563EB',
    borderColor: '#2563EB',
  },
  optionChipText: {
    fontSize: 12,
    color: '#334155',
  },
  optionChipTextActive: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  sheetFooterRow: {
    flexDirection: 'row',
    gap: 10,
    paddingTop: 8,
  },
  deleteBtn: {
    flex: 1,
    backgroundColor: '#FEE2E2',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  deleteBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#DC2626',
  },
  savePrimaryBtn: {
    flex: 2,
    backgroundColor: '#2563EB',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  savePrimaryBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  scopeDialogCard: {
    backgroundColor: '#FFFFFF',
    margin: 20,
    borderRadius: 16,
    padding: 16,
  },
  scopeDialogTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0F172A',
    marginBottom: 10,
  },
  scopeOptionBtn: {
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
  },
  scopeOptionText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#2563EB',
  },
  settingsContainer: {
    flex: 1,
    backgroundColor: '#F8FAFC',
    paddingHorizontal: 16,
  },
  settingsScroll: {
    paddingBottom: 60,
  },
  settingsGroupTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0F172A',
    marginTop: 20,
    marginBottom: 8,
  },
  calManageRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    padding: 12,
    borderRadius: 10,
    marginBottom: 6,
  },
  calToggleArea: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  calColorBox: {
    width: 16,
    height: 16,
    borderRadius: 4,
  },
  calManageName: {
    fontSize: 14,
    color: '#1E293B',
    fontWeight: '500',
  },
  refreshMiniBtn: {
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  refreshMiniBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#2563EB',
  },
  helperNoteText: {
    fontSize: 12,
    color: '#475569',
    lineHeight: 18,
  },
});
