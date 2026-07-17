import { describe, expect, it } from "vitest";
import { renderPortalPage, type PortalView } from "./portal-render.js";

function baseView(overrides: Partial<PortalView> = {}): PortalView {
  return { projects: [], ...overrides };
}

function cssRule(html: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return html.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

describe("renderPortalPage", () => {
  it("renders an empty-state card when there are no projects", () => {
    const html = renderPortalPage(baseView());
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("empty-card");
    expect(html).toContain("No running projects");
    expect(html).toContain("project-deck-count-1");
    expect(html).toContain("no-overflow");
  });

  it("renders primary project cards with href, name and current marker", () => {
    const html = renderPortalPage(baseView({
      projects: [
        { id: "a", name: "Alpha", href: "/project/a/", current: true },
        { id: "b", name: "Beta", href: "/project/b/", version: "1.2.0", live: true },
      ],
    }));
    expect(html).toContain('href="/project/a/"');
    expect(html).toContain("current-project");
    expect(html).toContain(">Alpha<");
    expect(html).toContain(">1.2.0<");
    expect(html).toContain("project-deck-count-2");
  });

  it("splits projects past 5 into the overflow section", () => {
    const projects = Array.from({ length: 7 }, (_, i) => ({
      id: `p${i}`,
      name: `Project ${i}`,
      href: `/project/p${i}/`,
    }));
    const html = renderPortalPage(baseView({ projects }));
    expect(html).toContain("has-overflow");
    expect(html).toContain("overflow-section");
    expect(html).toContain("2 more runtimes");
    expect(html).toContain("project-deck-count-5");
    expect(html).toContain("extra-project-card");
  });

  it("parameterizes vendor assets and omits the stage background when absent", () => {
    const withAssets = renderPortalPage(baseView({
      assets: { background: "/portal-assets/bg.png", wordmark: "/portal-assets/wm.png" },
    }));
    expect(withAssets).toContain('url("/portal-assets/bg.png")');
    expect(withAssets).toContain('src="/portal-assets/wm.png"');

    const withoutAssets = renderPortalPage(baseView());
    expect(withoutAssets).not.toContain("url(");
    expect(withoutAssets).toContain("footer-wordmark-text");
  });

  it("paints pageBackground on the scrollable stage instead of a fixed body background", () => {
    const withPageBg = renderPortalPage(baseView({
      assets: { pageBackground: "/portal-assets/portal-background.png" },
    }));
    expect(withPageBg).toContain(
      '.stage { background: url("/portal-assets/portal-background.png") top center / 100% auto no-repeat; }',
    );
    expect(withPageBg).toContain(".page-background-layout .hero-stage { padding: 0 0 8px; }");
    expect(withPageBg).toContain(".page-background-layout .stage { width: 100vw; max-width: none; }");
    expect(withPageBg).toContain(".page-background-layout .project-deck { top: 65%; }");
    expect(withPageBg).toContain(".page-background-layout .overflow-section { margin-top: -120px; }");
    expect(withPageBg).not.toContain(".portal-scroll.page-background-layout { background:");
    expect(withPageBg).not.toContain("no-repeat fixed");

    const withoutPageBg = renderPortalPage(baseView());
    expect(withoutPageBg).not.toContain("portal-background.png");
  });

  it("uses the non-obstructing page-background layout when a body background is present", () => {
    const projects = Array.from({ length: 7 }, (_, i) => ({
      id: `p${i}`,
      name: `Project ${i}`,
      href: `/project/p${i}/`,
    }));
    const html = renderPortalPage(baseView({
      projects,
      assets: { pageBackground: "/portal-assets/portal-background.png" },
    }));

    expect(html).toContain("portal-scroll has-overflow page-background-layout");
    expect(html).toContain("project-deck project-deck-count-5 page-background-deck");
    expect(html).toContain("overflow-section page-background-overflow-section");
    expect(html).toContain(".extra-projects { margin-top: 20px; display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: 12px; }");
  });

  it("allows page-background overflow pages to scroll with the background art", () => {
    const projects = Array.from({ length: 6 }, (_, i) => ({
      id: `p${i}`,
      name: `Project ${i}`,
      href: `/project/p${i}/`,
    }));
    const html = renderPortalPage(baseView({
      projects,
      assets: { pageBackground: "/portal-assets/portal-background.png" },
    }));

    expect(html).toContain("portal-scroll has-overflow page-background-layout");
    expect(html).not.toContain(".portal-scroll.page-background-layout.has-overflow { overflow-y: hidden; }");
    expect(html).not.toContain("background-attachment: local");
  });

  it("keeps page-background overflow projects in the deploy-style wide grid area", () => {
    const projects = Array.from({ length: 12 }, (_, i) => ({
      id: `p${i}`,
      name: `Project ${i}`,
      href: `/project/p${i}/`,
    }));
    const html = renderPortalPage(baseView({
      projects,
      assets: { pageBackground: "/portal-assets/portal-background.png" },
    }));

    const overflowRule = cssRule(html, ".page-background-layout.has-overflow .page-background-overflow-section");
    expect(overflowRule).toBe("");

    const projectsRule = cssRule(html, ".page-background-layout.has-overflow .extra-projects");
    expect(projectsRule).toBe("");

    const genericOverflowRule = cssRule(html, ".overflow-section");
    expect(genericOverflowRule).toContain("width: min(1480px, calc(100vw - 32px))");
    expect(genericOverflowRule).toContain("position: relative");
    expect(genericOverflowRule).not.toContain("position: absolute");

    const extraProjectsRule = cssRule(html, ".extra-projects");
    expect(extraProjectsRule).toContain("display: grid");
    expect(extraProjectsRule).toContain("grid-template-columns: repeat(8, minmax(0, 1fr))");

    const footerRule = cssRule(html, ".portal-footer");
    expect(footerRule).toContain("margin-top: auto");
  });

  it("renders up to two footer links with provided hrefs", () => {
    const html = renderPortalPage(baseView({
      links: [
        { name: "Upstream", href: "https://example.com/up" },
        { name: "Repo", href: "https://example.com/repo" },
        { name: "Ignored", href: "https://example.com/x" },
      ],
    }));
    expect(html).toContain('href="https://example.com/up"');
    expect(html).toContain('href="https://example.com/repo"');
    expect(html).not.toContain("https://example.com/x");
  });

  it("renders the default footer links when none are configured", () => {
    const html = renderPortalPage(baseView());

    expect(html).toContain('href="https://github.com/permanentstar/Understand-Anyway"');
    expect(html).toContain('aria-label="permanentstar"');
    expect(html).toContain('href="https://github.com/Egonex-AI/Understand-Anything"');
    expect(html).toContain('aria-label="Understand-Anything"');
  });

  it("escapes untrusted project and link fields", () => {
    const html = renderPortalPage(baseView({
      projects: [{ id: "x", name: '<script>alert(1)</script>', href: '/p"q' }],
      links: [{ name: "<b>", href: 'javascript:"x"' }],
    }));
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("/p&quot;q");
  });

  it("honors custom lang and title", () => {
    const html = renderPortalPage(baseView({ lang: "zh-CN", title: "My Portal" }));
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain("<title>My Portal</title>");
  });
});
