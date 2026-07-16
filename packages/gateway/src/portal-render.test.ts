import { describe, expect, it } from "vitest";
import { renderPortalPage, type PortalView } from "./portal-render.js";

function baseView(overrides: Partial<PortalView> = {}): PortalView {
  return { projects: [], ...overrides };
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

  it("paints pageBackground on the body (cover) and omits it when absent", () => {
    const withPageBg = renderPortalPage(baseView({
      assets: { pageBackground: "/portal-assets/portal-background.png" },
    }));
    expect(withPageBg).toContain(
      'url("/portal-assets/portal-background.png") center / cover no-repeat fixed',
    );
    expect(withPageBg).toContain("body {");

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
    expect(html).toContain(".portal-scroll.page-background-layout.no-overflow .hero-stage");
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
