export interface EventMessage<TPayload = Record<string, unknown>> {
  eventId: string;
  eventType: string;
  payload: TPayload;
  occurredAt: string;
  retryCount?: number;
}

export interface NotificationMessage {
  eventId: string;
  eventType: string;
  text: string;
  occurredAt: string;
  retryCount?: number;
}
