function buildProjectLoadingOverlaySnippet(): string {
  return `<style id="ua-project-loading-overlay-style">
  #ua-project-loading-overlay {
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: radial-gradient(circle at top, rgba(15, 23, 42, 0.42), rgba(2, 6, 23, 0.82));
    color: #e5e7eb;
    opacity: 1;
    visibility: visible;
    transition: opacity 180ms ease, visibility 180ms ease;
  }
  #ua-project-loading-overlay[data-hidden="true"] {
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
  }
  #ua-project-loading-overlay .ua-project-loading-card {
    min-width: 280px;
    max-width: 420px;
    padding: 24px 28px;
    border-radius: 16px;
    border: 1px solid rgba(255,255,255,0.08);
    background: rgba(15, 23, 42, 0.72);
    box-shadow: 0 16px 48px rgba(0,0,0,0.28);
    backdrop-filter: blur(8px);
    text-align: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  #ua-project-loading-overlay .ua-project-loading-spinner {
    width: 30px;
    height: 30px;
    margin: 0 auto 14px;
    border-radius: 999px;
    border: 2px solid rgba(255,255,255,0.16);
    border-top-color: #f59e0b;
    animation: ua-project-loading-spin 0.9s linear infinite;
  }
  #ua-project-loading-overlay .ua-project-loading-title {
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0.01em;
  }
  #ua-project-loading-overlay .ua-project-loading-hint {
    margin-top: 8px;
    font-size: 12px;
    color: rgba(229, 231, 235, 0.72);
  }
  @keyframes ua-project-loading-spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
</style>
<script id="ua-project-loading-overlay-script">
  (function () {
    var overlayId = "ua-project-loading-overlay";
    var readyPollTimer = null;
    var fallbackHideTimer = null;
    var graphJsonPending = 0;
    var readyStableCount = 0;
    function ensureOverlay() {
      var existing = document.getElementById(overlayId);
      if (existing) return existing;
      var overlay = document.createElement("div");
      overlay.id = overlayId;
      overlay.innerHTML = [
        '<div class="ua-project-loading-card">',
        '<div class="ua-project-loading-spinner"></div>',
        '<div class="ua-project-loading-title">Loading project...</div>',
        '<div class="ua-project-loading-hint" data-role="hint">Preparing knowledge graph view</div>',
        "</div>"
      ].join("");
      document.body.appendChild(overlay);
      return overlay;
    }
    function showOverlay() {
      var overlay = ensureOverlay();
      overlay.removeAttribute("data-hidden");
    }
    function hideOverlay() {
      var overlay = ensureOverlay();
      overlay.setAttribute("data-hidden", "true");
      if (fallbackHideTimer) {
        window.clearTimeout(fallbackHideTimer);
        fallbackHideTimer = null;
      }
    }
    function setHint(text) {
      var overlay = ensureOverlay();
      var hint = overlay.querySelector("[data-role='hint']");
      if (hint) hint.textContent = text;
    }
    function overlayVisible() {
      var overlay = ensureOverlay();
      return !overlay.hasAttribute("data-hidden");
    }
    function dashboardReady() {
      if (!document.body) return false;
      if (document.querySelector(".react-flow__node")) return true;
      if (document.querySelector(".react-flow__edge")) return true;
      var text = document.body.textContent || "";
      if (text.indexOf("Failed to load knowledge graph") >= 0) return true;
      if (text.indexOf("Invalid knowledge graph") >= 0) return true;
      if (text.indexOf("No knowledge graph loaded") >= 0) return false;
      return false;
    }
    function trackGraphJson(response) {
      if (!response || typeof response.json !== "function") return response;
      var originalJson = response.json.bind(response);
      response.json = function () {
        graphJsonPending += 1;
        setHint("Parsing knowledge graph...");
        return originalJson().then(function (data) {
          graphJsonPending = Math.max(0, graphJsonPending - 1);
          setHint("Rendering knowledge graph...");
          scheduleOverlayHideWhenReady();
          return data;
        }, function (error) {
          graphJsonPending = Math.max(0, graphJsonPending - 1);
          hideOverlay();
          throw error;
        });
      };
      return response;
    }
    function scheduleOverlayHideWhenReady() {
      if (readyPollTimer) return;
      setHint("Rendering knowledge graph...");
      readyStableCount = 0;
      readyPollTimer = window.setInterval(function () {
        if (!overlayVisible()) {
          window.clearInterval(readyPollTimer);
          readyPollTimer = null;
          return;
        }
        if (graphJsonPending > 0) {
          readyStableCount = 0;
          return;
        }
        if (!dashboardReady()) {
          readyStableCount = 0;
          return;
        }
        readyStableCount += 1;
        if (readyStableCount < 3) return;
        window.clearInterval(readyPollTimer);
        readyPollTimer = null;
        window.requestAnimationFrame(function () {
          window.requestAnimationFrame(function () {
            hideOverlay();
          });
        });
      }, 120);
      if (fallbackHideTimer) window.clearTimeout(fallbackHideTimer);
      fallbackHideTimer = window.setTimeout(function () {
        fallbackHideTimer = null;
        if (readyPollTimer) {
          window.clearInterval(readyPollTimer);
          readyPollTimer = null;
        }
        hideOverlay();
      }, 30000);
    }
    var originalFetch = window.fetch ? window.fetch.bind(window) : null;
    if (originalFetch) {
      window.fetch = function (input, init) {
        var url = "";
        if (typeof input === "string") url = input;
        else if (input && typeof input.url === "string") url = input.url;
        var shouldTrack = /(^|\\/)knowledge-graph\\.json(\\?|$)/.test(url);
        if (shouldTrack) {
          showOverlay();
          setHint("Downloading knowledge graph...");
        }
        return Promise.resolve(originalFetch(input, init)).then(function (response) {
          if (!shouldTrack) return response;
          return trackGraphJson(response);
        }, function (error) {
          if (shouldTrack) hideOverlay();
          throw error;
        });
      };
    }
    if (document.body) {
      showOverlay();
    } else if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", showOverlay, { once: true });
    } else {
      showOverlay();
    }
    window.addEventListener("error", function () {
      hideOverlay();
    }, { once: true });
    window.addEventListener("unhandledrejection", function () {
      hideOverlay();
    }, { once: true });
    window.setTimeout(function () {
      if (overlayVisible()) {
        setHint("Still loading. The graph may take a few more seconds.");
      }
    }, 10000);
  })();
</script>`;
}

export function injectProjectLoadingOverlay(html: string): string {
  const source = String(html || "");
  if (!source || source.includes("ua-project-loading-overlay-script")) return source;
  const snippet = buildProjectLoadingOverlaySnippet();
  if (/<body[^>]*>/i.test(source)) {
    return source.replace(/<body([^>]*)>/i, `<body$1>${snippet}`);
  }
  if (/<head[^>]*>/i.test(source)) {
    return source.replace(/<\/head>/i, `${snippet}</head>`);
  }
  return `${snippet}${source}`;
}
