/**
 * Open-source portal page renderer.
 *
 * Pure function over a neutral {@link PortalView} model — no filesystem,
 * registry, or in-house multi-project coupling. The caller (a later milestone)
 * is responsible for assembling the view from whatever project source it has;
 * this module only turns that view into HTML.
 *
 * Vendor assets (background / wordmark / footer avatars) are parameterized as
 * URLs on {@link PortalAssets}; in-house "nebula" art is injected by the
 * overlay, not hardcoded here. Each element is omitted when its URL is absent.
 *
 * The page's static CSS and client script live in sibling modules
 * ({@link PORTAL_STYLES} / {@link PORTAL_SCRIPT}); this module owns only the
 * view → HTML mapping.
 */

import { PORTAL_STYLES } from "./portal-styles.js";
import { PORTAL_SCRIPT } from "./portal-script.js";
import type { PortalAssets } from "@understand-anyway/plugin-api";

export type { PortalAssets };

export interface PortalProjectView {
  id: string;
  name: string;
  /** Link target for the project card. */
  href: string;
  /** Icon image URL; falls back to a neutral placeholder when empty. */
  iconUrl?: string;
  version?: string;
  buildVersion?: string;
  buildVersionIsStable?: boolean;
  live?: boolean;
  /** Marks the card representing the currently active project. */
  current?: boolean;
}

export interface PortalLinkView {
  name: string;
  href: string;
  /** Avatar/icon URL; falls back to {@link PortalAssets} footer art. */
  iconUrl?: string;
}

export interface PortalView {
  title?: string;
  projects: PortalProjectView[];
  links?: PortalLinkView[];
  assets?: PortalAssets;
  /** Alt text for the footer wordmark image. */
  wordmarkAlt?: string;
  /** Lang attribute on <html>; defaults to "en". */
  lang?: string;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatBuildVersionDisplay(value: string | undefined): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d{8,}$/.test(raw)) return raw.slice(0, 8);
  return raw;
}

function renderProjectCard(project: PortalProjectView, index: number): string {
  const version = project.version || "";
  const buildVersion = formatBuildVersionDisplay(project.buildVersion);
  const iconUrl = project.iconUrl || PLACEHOLDER_ICON;
  return `<a class="project-card${project.current ? " current-project" : ""}" data-project-id="${escapeHtml(project.id)}" href="${escapeHtml(project.href)}" data-sound="${index + 1}" aria-label="${escapeHtml(project.name)}">
        <div class="project-logo" aria-hidden="true">
          <img class="project-logo-image" src="${escapeHtml(iconUrl)}" alt="" loading="lazy" />
        </div>
        <strong>${escapeHtml(project.name)}</strong>
        ${version ? `<small>${escapeHtml(version)}</small>` : `<small>${project.live ? "live runtime" : "offline runtime"}</small>`}
        ${buildVersion ? `<small class="project-build-version${project.buildVersionIsStable ? "" : " project-build-version-unstable"}">${escapeHtml(buildVersion)}</small>` : ""}
      </a>`;
}

function renderExtraProjectCard(project: PortalProjectView, soundOffset: number): string {
  const version = project.version || "";
  const buildVersion = formatBuildVersionDisplay(project.buildVersion);
  const iconUrl = project.iconUrl || PLACEHOLDER_ICON;
  return `<a class="extra-project-card" href="${escapeHtml(project.href)}" data-sound="${soundOffset}" aria-label="${escapeHtml(project.name)}">
      <div class="project-logo compact" aria-hidden="true">
        <img class="project-logo-image" src="${escapeHtml(iconUrl)}" alt="" loading="lazy" />
      </div>
      <div class="extra-project-copy">
        <strong>${escapeHtml(project.name)}</strong>
        <span>${escapeHtml(version || project.id)}</span>
        ${buildVersion ? `<span class="extra-project-build-version${project.buildVersionIsStable ? "" : " extra-project-build-version-unstable"}">${escapeHtml(buildVersion)}</span>` : ""}
      </div>
      <em>${project.live ? "live" : "offline"}</em>
    </a>`;
}

const PLACEHOLDER_ICON =
  "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2092%2092'%3E%3Crect%20width='92'%20height='92'%20rx='20'%20fill='%23123'/%3E%3Ccircle%20cx='46'%20cy='46'%20r='22'%20fill='none'%20stroke='%235cd4ff'%20stroke-width='4'/%3E%3C/svg%3E";

const DEFAULT_PORTAL_LINKS: PortalLinkView[] = [
  { name: "permanentstar", href: "https://github.com/permanentstar/Understand-Anyway" },
  { name: "Understand-Anything", href: "https://github.com/Egonex-AI/Understand-Anything" },
];

export function renderPortalPage(view: PortalView): string {
  const projects = Array.isArray(view.projects) ? view.projects : [];
  const links = Array.isArray(view.links) ? view.links : [];
  const footerLinkViews = links.length > 0 ? links : DEFAULT_PORTAL_LINKS;
  const assets = view.assets || {};
  const title = view.title || "Understand Portal";
  const lang = view.lang || "en";
  const wordmarkAlt = view.wordmarkAlt || "Powered by Understand-Anything";

  const primaryProjects = projects.slice(0, 5);
  const overflowProjects = projects.slice(5);
  const primaryCount = Math.max(1, Math.min(primaryProjects.length || 1, 5));
  const deckCountClass = `project-deck-count-${primaryCount}`;
  const hasPageBackground = Boolean(assets.pageBackground);
  const layoutClass = [
    overflowProjects.length > 0 ? "has-overflow" : "no-overflow",
    hasPageBackground ? "page-background-layout" : "",
  ].filter(Boolean).join(" ");
  const deckClass = [
    "project-deck",
    deckCountClass,
    hasPageBackground ? "page-background-deck" : "",
  ].filter(Boolean).join(" ");
  const overflowSectionClass = [
    "overflow-section",
    hasPageBackground ? "page-background-overflow-section" : "",
  ].filter(Boolean).join(" ");

  const projectCards = primaryProjects.length > 0
    ? primaryProjects.map((project, index) => renderProjectCard(project, index)).join("\n")
    : `<div class="project-card empty-card">
      <span class="project-badge">No Runtime</span>
      <div class="project-logo" aria-hidden="true"><img class="project-logo-image" src="${PLACEHOLDER_ICON}" alt="" loading="lazy" /></div>
      <strong>No running projects</strong>
      <small>start a project runtime to populate this portal</small>
    </div>`;
  const extraProjectCards = overflowProjects
    .map((project, index) => renderExtraProjectCard(project, primaryProjects.length + index + 1))
    .join("\n");

  const stageBackgroundCss = assets.pageBackground
    ? `\n      .stage { background: url("${assets.pageBackground}") top center / 100% auto no-repeat; }`
    : assets.background
      ? `\n      .stage { background: url("${assets.background}") center / contain no-repeat; }`
      : "";

  const footerAvatars = [assets.footerLeft, assets.footerRight];
  const footerLinks = footerLinkViews.slice(0, 2).map((link, index) => {
    const side = index === 0 ? "left" : "right";
    const imageUrl = link.iconUrl || footerAvatars[index] || PLACEHOLDER_ICON;
    return `<a class="footer-github-link footer-github-link-${side}" data-footer-link="${side}" href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(link.name)}" title="${escapeHtml(link.name)}">
      <img src="${escapeHtml(imageUrl)}" alt="" loading="lazy" />
    </a>`;
  }).join("\n");

  const wordmark = assets.wordmark
    ? `<img class="footer-wordmark" src="${escapeHtml(assets.wordmark)}" alt="${escapeHtml(wordmarkAlt)}" loading="lazy" />`
    : `<span class="footer-wordmark-text">${escapeHtml(wordmarkAlt)}</span>`;

  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>${PORTAL_STYLES}${stageBackgroundCss}
    </style>
  </head>
  <body>
    <main class="shell">
      <div class="scene-overlay" aria-hidden="true"></div>
      <div class="portal-scroll ${layoutClass}">
        <section class="hero-stage">
          <div class="stage">
            <section class="${deckClass}">
              ${projectCards}
            </section>
          </div>
        </section>
        ${overflowProjects.length > 0 ? `<section class="${overflowSectionClass}">
          <div class="overflow-header">
            <h2>Additional Projects</h2>
            <span>${overflowProjects.length} more runtime${overflowProjects.length > 1 ? "s" : ""}</span>
          </div>
          <div class="extra-projects">
            ${extraProjectCards}
          </div>
        </section>` : ""}
        <footer class="portal-footer">
          <div class="portal-footer-inner">
            ${wordmark}
            <div class="footer-github-links">
              ${footerLinks}
            </div>
          </div>
        </footer>
      </div>
    </main>
    <script>${PORTAL_SCRIPT}
    </script>
  </body>
</html>`;
}
