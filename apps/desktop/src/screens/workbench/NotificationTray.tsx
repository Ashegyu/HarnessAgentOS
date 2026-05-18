import { useEffect, useState } from "react";
import {
  buildTaskRunNotifications,
  loadDismissedNotificationIds,
  mergeNotifications,
  saveDismissedNotificationIds,
  type NotificationItem,
} from "./notification-tray-model";

export const NotificationTray = (): JSX.Element => {
  const [open, setOpen] = useState(false);
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(
    () => loadDismissedNotificationIds(window.localStorage),
  );
  const [items, setItems] = useState<NotificationItem[]>([]);

  useEffect(() => {
    let disposed = false;
    const unsubscribe = window.harness.events.onTaskRunChanged(({ taskRunId }) => {
      void (async () => {
        try {
          const [detail, gate] = await Promise.all([
            window.harness.conversation.getTaskRunDetail({ taskRunId }),
            window.harness.quality.getLatest({ taskRunId }).catch(() => null),
          ]);
          if (disposed) return;
          const incoming = buildTaskRunNotifications(detail, gate);
          setItems((current) =>
            mergeNotifications(current, incoming, dismissedIds),
          );
        } catch {
          // Notification derivation is advisory UI; task refresh flows continue.
        }
      })();
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [dismissedIds]);

  const dismiss = (id: string): void => {
    setDismissedIds((current) => {
      const next = new Set(current);
      next.add(id);
      saveDismissedNotificationIds(window.localStorage, next);
      return next;
    });
    setItems((current) => current.filter((item) => item.id !== id));
  };

  return (
    <div className="notification-tray">
      <button
        type="button"
        className="notification-tray__button"
        onClick={() => setOpen((value) => !value)}
        aria-label="Notifications"
        aria-expanded={open}
      >
        <BellIcon />
        {items.length > 0 ? (
          <span className="notification-tray__badge">{items.length}</span>
        ) : null}
      </button>
      {open ? (
        <div className="notification-tray__menu" role="dialog">
          <header className="notification-tray__header">
            <span>Notifications</span>
            <span>{items.length}</span>
          </header>
          {items.length === 0 ? (
            <div className="notification-tray__empty">새 알림이 없습니다.</div>
          ) : (
            <ul className="notification-tray__list">
              {items.map((item) => (
                <li key={item.id} className="notification-tray__item">
                  <div>
                    <span
                      className={`notification-tray__kind notification-tray__kind--${item.severity}`}
                    >
                      {kindLabel(item.kind)}
                    </span>
                    <strong>{item.title}</strong>
                    <p>{item.message}</p>
                    <time>{formatTimestamp(item.createdAt)}</time>
                  </div>
                  <button
                    type="button"
                    className="notification-tray__dismiss"
                    onClick={() => dismiss(item.id)}
                    aria-label={`Dismiss ${item.title}`}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
};

const kindLabel = (kind: NotificationItem["kind"]): string => {
  if (kind === "budget_blocked") return "budget";
  if (kind === "repair_failed") return "repair";
  if (kind === "quality_failed") return "quality";
  return "cancelled";
};

const formatTimestamp = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const BellIcon = (): JSX.Element => (
  <svg
    className="notification-tray__icon"
    viewBox="0 0 24 24"
    role="img"
    aria-hidden="true"
  >
    <path
      d="M6 10a6 6 0 0 1 12 0v4l2 3H4l2-3v-4Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M10 20a2 2 0 0 0 4 0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    />
  </svg>
);
