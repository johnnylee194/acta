import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import {
  computeUpcomingReminderTriggers,
  toCstComponents,
} from '@acta/core';
import {
  getAllLocalCalendars,
  getAllLocalEvents,
} from '../db/localDb';

export const REMINDER_CHANNEL_ID = 'acta-exact-reminders';

// Configure foreground notification display behavior (banner + single sound/vibration)
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export async function ensureNotificationChannelAndPermissions(): Promise<boolean> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(REMINDER_CHANNEL_ID, {
      name: '日程与比赛准时提醒',
      description: '用于日程开始前及订阅赛程（如皇马比赛）开球前的锁屏横幅提醒',
      importance: Notifications.AndroidImportance.MAX,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      enableVibrate: true,
      vibrationPattern: [0, 250, 200, 250],
      sound: 'default',
    });
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  return finalStatus === 'granted';
}

function formatEventStartTimeLabel(startTimeMs: number, isAllDay: boolean): string {
  const { month, day, hour, minute } = toCstComponents(startTimeMs);
  if (isAllDay) {
    return `${month}月${day}日 全天`;
  }
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return `${month}月${day}日 ${hh}:${mm}`;
}

/**
 * Rolling Window Local Alarm Scheduler:
 * 1. Cancels all previously queued notifications
 * 2. Expands local SQLite events over the next 14 days
 * 3. Registers up to the earliest 50 exact-timestamp notifications via Android AlarmManager
 */
export async function rescheduleRollingWindowAlarms(): Promise<{
  scheduledCount: number;
  nextTriggerTime: number | null;
}> {
  const granted = await ensureNotificationChannelAndPermissions();
  if (!granted) {
    return { scheduledCount: 0, nextTriggerTime: null };
  }

  await Notifications.cancelAllScheduledNotificationsAsync();

  const events = getAllLocalEvents();
  const calendars = getAllLocalCalendars();
  const triggers = computeUpcomingReminderTriggers({
    events,
    calendars,
    nowMs: Date.now(),
    windowDays: 14,
    maxAlarms: 50,
  });

  for (const item of triggers) {
    const timeLabel = formatEventStartTimeLabel(item.eventStartTime, item.isAllDay);
    const prefix =
      item.reminderMinutes === 0
        ? '现在开始'
        : item.reminderMinutes % 60 === 0
        ? `${item.reminderMinutes / 60}小时后开始`
        : `${item.reminderMinutes}分钟后开始`;

    const bodyParts = [`${prefix} · ${timeLabel}`];
    if (item.location) {
      bodyParts.push(`📍 ${item.location}`);
    }

    await Notifications.scheduleNotificationAsync({
      identifier: item.triggerId,
      content: {
        title: item.title,
        body: bodyParts.join('  '),
        sound: 'default',
        priority: Notifications.AndroidNotificationPriority.MAX,
        data: {
          eventId: item.eventId,
          instanceId: item.instanceId,
          startTime: item.eventStartTime,
        },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: new Date(item.triggerTime),
        channelId: REMINDER_CHANNEL_ID,
      },
    });
  }

  return {
    scheduledCount: triggers.length,
    nextTriggerTime: triggers.length > 0 ? triggers[0].triggerTime : null,
  };
}

/**
 * Self-diagnostic test for domestic Android ROMs (HyperOS / OriginOS / ColorOS):
 * Schedules an exact notification `delaySeconds` in the future so the user can lock the screen and test.
 */
export async function scheduleSelfTestReminder(delaySeconds = 10): Promise<boolean> {
  const granted = await ensureNotificationChannelAndPermissions();
  if (!granted) return false;

  const targetDate = new Date(Date.now() + delaySeconds * 1000);
  await Notifications.scheduleNotificationAsync({
    identifier: `self_test_${Date.now()}`,
    content: {
      title: '🔔 Acta 锁屏精准提醒自检成功',
      body: '您的系统通知权限与精确闹钟（AlarmManager）工作正常！',
      sound: 'default',
      priority: Notifications.AndroidNotificationPriority.MAX,
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: targetDate,
      channelId: REMINDER_CHANNEL_ID,
    },
  });

  return true;
}
