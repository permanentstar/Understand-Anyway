/**
 * Neutral portal/user-event payload assembly.
 *
 * Identity is read only from the open-source {@link AuthedUser} interface
 * (`id`/`email`/`displayName`). Provider-specific identity (e.g. Feishu
 * open_id / department paths) is written into `AuthedUser.raw` by the auth
 * provider and passed through opaquely here — the gateway never interprets it.
 * Overlay record providers map `raw` into their own column layout.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { AuthSession, RecordEnvelope } from "@understand-anyway/plugin-api";

export interface PortalEventInput {
  eventType: string;
  targetType?: string;
  targetId?: string;
  targetName?: string;
  targetUrl?: string;
  authReason?: string;
  departmentPaths?: string[][];
  matchedDepartmentPath?: string[];
  targetDepartment?: string[];
  extra?: Record<string, unknown>;
}

function extractClientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (raw) {
    const first = raw.split(",")[0];
    if (first) return first.trim();
  }
  return req.socket?.remoteAddress ?? "";
}

function headerString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function pad(value: number, width = 2): string {
  return String(Math.trunc(Math.abs(value))).padStart(width, "0");
}

function formatLocalTimestamp(date = new Date()): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHours = pad(Math.floor(Math.abs(offsetMinutes) / 60));
  const offsetRemainderMinutes = pad(Math.abs(offsetMinutes) % 60);
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`,
    `${offsetSign}${offsetHours}:${offsetRemainderMinutes}`,
  ].join("");
}

function anonymousUserId(sourceIp: string): string {
  return sourceIp ? `anonymous:${sourceIp}` : "anonymous";
}

function anonymousDisplayName(sourceIp: string): string {
  return sourceIp ? `anonymous@${sourceIp}` : "anonymous";
}

export function buildUserEventPayload(
  session: AuthSession | null | undefined,
  req: IncomingMessage,
  input: PortalEventInput,
): RecordEnvelope {
  const user = session?.user;
  const sourceIp = extractClientIp(req);
  const timestamp = formatLocalTimestamp();
  return {
    kind: "user-event",
    timestamp,
    payload: {
      eventId: randomUUID(),
      eventTime: timestamp,
      eventType: input.eventType,
      userId: user ? user.id : anonymousUserId(sourceIp),
      email: user?.email ?? "",
      displayName: user ? (user.displayName ?? "") : anonymousDisplayName(sourceIp),
      sourceIp,
      userAgent: headerString(req.headers["user-agent"]),
      targetType: input.targetType ?? "",
      targetId: input.targetId ?? "",
      targetName: input.targetName ?? "",
      targetUrl: input.targetUrl ?? "",
      authReason: input.authReason ?? "",
      departmentPaths: input.departmentPaths ?? [],
      matchedDepartmentPath: input.matchedDepartmentPath ?? [],
      targetDepartment: input.targetDepartment ?? [],
      extra: input.extra ?? {},
      raw: user?.raw ?? {},
    },
  };
}
