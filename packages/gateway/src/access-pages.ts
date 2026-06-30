/**
 * Neutral access pages rendered by the open-source gateway.
 *
 * When an AuthProvider denies access without supplying custom HTML, the gateway
 * renders these vendor-neutral pages. In-house denial copy (e.g. contact links)
 * is supplied by the overlay via {@link AuthCallbackDenied.html}.
 */

export function page(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #0b1020; color: #e8eefc; }
      .card { max-width: 30rem; padding: 2.5rem; text-align: center; }
      h1 { font-size: 1.5rem; margin: 0 0 0.75rem; }
      p { color: #9fb2d6; line-height: 1.6; margin: 0.25rem 0; }
      code { background: rgba(255,255,255,0.08); padding: 0.1rem 0.35rem; border-radius: 0.25rem; }
    </style>
  </head>
  <body><div class="card">${bodyHtml}</div></body>
</html>`;
}

export function renderDeniedPage(reason?: string): string {
  const detail = reason
    ? `<p>Reason: <code>${escapeHtml(reason)}</code></p>`
    : "";
  return page(
    "Access denied",
    `<h1>Access denied</h1>
     <p>You are not authorized to access this resource.</p>
     ${detail}`,
  );
}

export function renderLoginRequiredPage(): string {
  return page(
    "Sign-in required",
    `<h1>Sign-in required</h1>
     <p>This gateway requires authentication.</p>`,
  );
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
