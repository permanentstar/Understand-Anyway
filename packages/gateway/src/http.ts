/**
 * Shared HTTP response primitives.
 *
 * The gateway is a plain node:http handler chain (no web framework), so these
 * tiny helpers are the single place that owns status/header/body writing.
 * Every module (data API, static, portal, project router, auth gate) routes
 * its responses through here instead of re-inlining `res.writeHead(...)`.
 */

import type { ServerResponse } from "node:http";

/**
 * Send a JSON response. A string body is treated as already-serialized JSON
 * (e.g. a config file read verbatim); anything else is JSON.stringify'd.
 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

export function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

export function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

export function sendBuffer(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "Content-Type": contentType, ...headers });
  res.end(body);
}

export function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status);
  res.end();
}

export function redirect(
  res: ServerResponse,
  location: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(302, { Location: location, ...headers });
  res.end();
}
