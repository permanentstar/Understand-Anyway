export function urlHostFor(host: string): string {
  const trimmed = String(host || "").trim();
  if (trimmed === "0.0.0.0" || trimmed === "::" || trimmed === "::0" || trimmed === "[::]") {
    return "127.0.0.1";
  }
  return trimmed;
}

/**
 * Redact the value of any `token=<...>` (or `?token=<...>`) substring in a
 * URL or URL-like string before printing it.
 *
 * The dashboard's runtime token is the only credential gating the data API,
 * and `dashboard start` writes its stdout into `<stateRoot>/.understand-anything/dashboard.log`
 * via `stdio: [..., outFd, outFd, "ipc"]`. Printing the raw URL with the
 * token in query string makes the token persist in dashboard.log and in any
 * reverse-proxy access log — a single log read = data API takeover.
 *
 * The browser still receives the un-redacted URL (we redact for log only); the
 * cookie / header path is unaffected.
 */
export function redactTokenInUrl(url: string): string {
  return String(url || "").replace(/([?&]token=)[^&#\s]+/gi, "$1***");
}
