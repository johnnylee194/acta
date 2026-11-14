import React from 'react';
import {
  FlexWidget,
  TextWidget,
  requestWidgetUpdate,
} from 'react-native-android-widget';
import {
  ExpandedEventInstance,
  expandEventsInWindow,
  fromCstComponents,
  getLunarDayInfo,
  toCstComponents,
} from '@acta/core';
import {
  getAllLocalCalendars,
  getAllLocalEvents,
} from '../db/localDb';

function formatTimeShort(ms: number, isAllDay: boolean): string {
  if (isAllDay) return '全天';
  const { hour, minute } = toCstComponents(ms);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function buildTodayTomorrowWidgetTree() {
  const now = Date.now();
  const todayCst = toCstComponents(now);
  const todayStart = fromCstComponents(todayCst.year, todayCst.month, todayCst.day, 0, 0, 0);
  const todayEnd = fromCstComponents(todayCst.year, todayCst.month, todayCst.day, 23, 59, 59);
  const tomorrowStart = todayStart + 24 * 3600 * 1000;
  const tomorrowEnd = todayEnd + 24 * 3600 * 1000;

  const calendars = getAllLocalCalendars();
  const events = getAllLocalEvents();

  const todayEvents: ExpandedEventInstance[] = expandEventsInWindow(
    events,
    todayStart,
    todayEnd,
    calendars
  ).slice(0, 4);

  const tomorrowEvents: ExpandedEventInstance[] = expandEventsInWindow(
    events,
    tomorrowStart,
    tomorrowEnd,
    calendars
  ).slice(0, 3);

  const lunarInfo = getLunarDayInfo(now);

  return (
    <FlexWidget
      style={{
        height: 'match_parent',
        width: 'match_parent',
        backgroundColor: '#FFFFFF',
        borderRadius: 16,
        padding: 12,
        flexDirection: 'column',
      }}
      clickAction="OPEN_APP"
    >
      {/* Header */}
      <FlexWidget
        style={{
          width: 'match_parent',
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 8,
        }}
      >
        <TextWidget
          text={`${todayCst.month}月${todayCst.day}日 · 农历${lunarInfo.lunarMonthInChinese}${lunarInfo.lunarDayInChinese}`}
          style={{
            fontSize: 13,
            fontWeight: 'bold',
            color: '#1E293B',
          }}
        />
        <TextWidget
          text="+ 新建"
          style={{
            fontSize: 12,
            fontWeight: 'bold',
            color: '#2563EB',
          }}
        />
      </FlexWidget>

      {/* Today Section */}
      <TextWidget
        text="今天"
        style={{
          fontSize: 11,
          fontWeight: 'bold',
          color: '#64748B',
          marginBottom: 4,
        }}
      />
      {todayEvents.length === 0 ? (
        <TextWidget
          text="今日暂无安排"
          style={{
            fontSize: 12,
            color: '#94A3B8',
            marginBottom: 6,
          }}
        />
      ) : (
        todayEvents.map((ev) => (
          <FlexWidget
            key={ev.instanceId}
            style={{
              width: 'match_parent',
              flexDirection: 'row',
              alignItems: 'center',
              marginBottom: 4,
            }}
          >
            <TextWidget
              text={`${formatTimeShort(ev.startTime, ev.isAllDay)}  ${ev.title}`}
              style={{
                fontSize: 12,
                color: '#0F172A',
              }}
              maxLines={1}
            />
          </FlexWidget>
        ))
      )}

      {/* Tomorrow Section */}
      <TextWidget
        text="明天"
        style={{
          fontSize: 11,
          fontWeight: 'bold',
          color: '#64748B',
          marginTop: 4,
          marginBottom: 4,
        }}
      />
      {tomorrowEvents.length === 0 ? (
        <TextWidget
          text="明日暂无安排"
          style={{
            fontSize: 12,
            color: '#94A3B8',
          }}
        />
      ) : (
        tomorrowEvents.map((ev) => (
          <FlexWidget
            key={ev.instanceId}
            style={{
              width: 'match_parent',
              flexDirection: 'row',
              alignItems: 'center',
              marginBottom: 3,
            }}
          >
            <TextWidget
              text={`${formatTimeShort(ev.startTime, ev.isAllDay)}  ${ev.title}`}
              style={{
                fontSize: 12,
                color: '#334155',
              }}
              maxLines={1}
            />
          </FlexWidget>
        ))
      )}
    </FlexWidget>
  );
}

export async function refreshAndroidHomeWidget(): Promise<void> {
  try {
    await requestWidgetUpdate({
      widgetName: 'ActaTodayTomorrowWidget',
      renderWidget: () => buildTodayTomorrowWidgetTree(),
    });
  } catch {
    // Widget might not be pinned on home screen yet
  }
}
