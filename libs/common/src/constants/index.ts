export const QUEUE_NAMES = {
  EVENTS: 'events_queue',
  NOTIFICATIONS: 'notifications_queue',
} as const;

export const RMQ_CLIENTS = {
  EVENTS: 'EVENTS_RMQ_CLIENT',
  NOTIFICATIONS: 'NOTIFICATIONS_RMQ_CLIENT',
} as const;

export const MESSAGE_PATTERNS = {
  EVENT_CREATED: 'event.created',
  NOTIFICATION_SEND: 'notification.send',
} as const;
