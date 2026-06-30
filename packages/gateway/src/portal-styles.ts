/**
 * Portal page styles, extracted from {@link renderPortalPage} so the render
 * module stays focused on the view → HTML mapping. Pure CSS, no interpolation.
 */

export const PORTAL_STYLES = `
      :root {
        color-scheme: dark;
        --text-main: #f8fbff;
        --text-sub: rgba(182, 220, 255, 0.78);
        --footer-focus-x: 50%;
        --footer-focus-y: 50%;
        --footer-focus-opacity: 0;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        overflow: hidden;
        font-family: Inter, -apple-system, BlinkMacSystemFont, sans-serif;
        color: var(--text-main);
        background:
          radial-gradient(circle at top, rgba(49, 97, 203, 0.18), transparent 24%),
          linear-gradient(180deg, #01060f, #020816 54%, #040a18);
      }
      .shell { position: relative; width: 100vw; height: 100vh; overflow: hidden; }
      .portal-scroll {
        position: relative; z-index: 1; width: 100%; height: 100%; min-height: 100vh;
        overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column;
      }
      .portal-scroll.no-overflow { overflow-y: hidden; }
      .scene-overlay {
        position: absolute; inset: 0;
        background:
          radial-gradient(circle at 50% 56%, rgba(34, 82, 255, 0.08), transparent 24%),
          linear-gradient(180deg, rgba(2, 6, 18, 0.02), rgba(2, 6, 18, 0.01) 36%, rgba(2, 6, 18, 0.03));
        pointer-events: none; z-index: 0;
      }
      .hero-stage {
        position: relative; flex: 0 0 auto; min-height: clamp(420px, 62vh, 820px);
        padding: 12px 16px 8px; display: flex; align-items: center; justify-content: center;
      }
      .portal-scroll.no-overflow .hero-stage {
        flex: 0 0 auto; min-height: clamp(420px, 62vh, 820px); padding-top: 12px; padding-bottom: 8px;
      }
      .stage {
        position: relative; width: min(1536px, calc(100vw - 32px));
        aspect-ratio: 1536 / 1024; max-width: 1536px;
      }
      .portal-scroll.no-overflow .stage { width: min(1536px, calc(100vw - 32px)); }
      .project-deck {
        position: absolute; left: 50%; top: 55.6%; transform: translate(-50%, -50%);
        display: grid; grid-template-columns: repeat(var(--primary-count), minmax(0, 1fr));
        justify-content: center; align-items: stretch; gap: clamp(16px, 1.7vw, 28px);
        z-index: 2; width: min(74%, 1080px);
      }
      .portal-scroll.no-overflow .project-deck { top: 55.6%; }
      .project-deck-count-1 { --primary-count: 1; width: min(210px, 74%); }
      .project-deck-count-2 { --primary-count: 2; width: min(430px, 74%); }
      .project-deck-count-3 { --primary-count: 3; width: min(670px, 74%); }
      .project-deck-count-4 { --primary-count: 4; width: min(890px, 74%); }
      .project-deck-count-5 { --primary-count: 5; width: min(1080px, 74%); }
      .project-card {
        position: relative; overflow: hidden; min-width: 0; min-height: 252px;
        padding: 12px 18px 14px; display: flex; flex-direction: column; align-items: center;
        justify-content: flex-start; gap: 4px; border-radius: 30px;
        border: 1px solid rgba(135, 218, 255, 0.4);
        background:
          linear-gradient(180deg, rgba(172, 220, 255, 0.12), rgba(17, 42, 95, 0.16) 16%, rgba(5, 10, 28, 0.34) 46%, rgba(5, 10, 28, 0.5)),
          rgba(6, 14, 34, 0.22);
        color: inherit; text-decoration: none;
        box-shadow:
          inset 0 0 0 1px rgba(195, 232, 255, 0.1), inset 0 18px 36px rgba(255, 255, 255, 0.06),
          inset 0 -26px 34px rgba(4, 8, 20, 0.24), 0 0 34px rgba(41, 135, 255, 0.32),
          0 20px 56px rgba(0, 0, 0, 0.26);
        backdrop-filter: blur(24px) saturate(145%);
        transition: transform 220ms ease, border-color 220ms ease, box-shadow 220ms ease;
      }
      .project-card::before {
        content: ""; position: absolute; inset: 0;
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0.06) 18%, transparent 34%),
          radial-gradient(circle at 50% 0%, rgba(124, 217, 255, 0.18), transparent 32%),
          radial-gradient(circle at 50% 100%, rgba(82, 86, 255, 0.14), transparent 38%);
        pointer-events: none;
      }
      .project-card::after {
        content: ""; position: absolute; inset: 0; border-radius: inherit;
        border: 1px solid rgba(201, 233, 255, 0.12);
        box-shadow: inset 0 0 30px rgba(0, 143, 255, 0.16), inset 0 -18px 28px rgba(7, 13, 30, 0.22);
        pointer-events: none;
      }
      .project-card:hover, .extra-project-card:hover { transform: translateY(-8px) scale(1.02); }
      .project-card:hover {
        border-color: rgba(120, 230, 255, 0.68);
        box-shadow:
          inset 0 0 0 1px rgba(180, 224, 255, 0.16), inset 0 22px 40px rgba(255, 255, 255, 0.08),
          0 0 40px rgba(47, 153, 255, 0.48), 0 26px 58px rgba(0, 0, 0, 0.28);
      }
      .current-project {
        border-color: rgba(31, 241, 255, 0.82);
        box-shadow:
          inset 0 0 0 1px rgba(31, 241, 255, 0.18), inset 0 22px 40px rgba(255, 255, 255, 0.08),
          0 0 34px rgba(31, 241, 255, 0.34), 0 24px 58px rgba(0, 0, 0, 0.28);
      }
      .project-card strong, .project-card small { position: relative; z-index: 1; text-align: center; }
      .project-card strong {
        margin-top: 0; font-size: 16px; line-height: 1.2; font-weight: 600;
        text-shadow: 0 0 18px rgba(95, 163, 255, 0.12);
      }
      .project-card small { color: #8cd8ff; letter-spacing: 0.03em; font-size: 11px; text-transform: none; }
      .project-build-version { color: rgba(182, 220, 255, 0.72); }
      .project-build-version-unstable { font-style: italic; }
      .project-logo {
        position: relative; z-index: 1; width: 120px; height: 120px; margin: 10px auto 6px;
        border-radius: 24px; display: grid; place-items: center; overflow: visible;
        background: transparent; box-shadow: 0 0 16px rgba(31, 142, 255, 0.08);
      }
      .project-logo.compact { width: 40px; height: 40px; margin: 0; }
      .project-logo-image {
        width: 92px; height: 92px; display: block; padding: 0; border-radius: 0;
        object-fit: contain; background: transparent; mix-blend-mode: normal;
        filter: saturate(1.04) drop-shadow(0 0 16px rgba(81, 198, 255, 0.16));
      }
      .project-logo.compact .project-logo-image { width: 28px; height: 28px; }
      .overflow-section {
        position: relative; z-index: 2; width: min(1480px, calc(100vw - 32px));
        margin: clamp(-188px, -14vw, -104px) auto 0; padding: 18px; border-radius: 18px;
        border: 1px solid rgba(98, 196, 255, 0.14); background: rgba(4, 11, 29, 0.06);
        box-shadow: 0 14px 34px rgba(0, 0, 0, 0.12); backdrop-filter: blur(4px) saturate(118%);
      }
      .overflow-header { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 14px; }
      .overflow-header h2 { margin: 0; font-size: 14px; letter-spacing: 0.18em; text-transform: uppercase; color: rgba(179, 235, 255, 0.92); }
      .overflow-header span { color: var(--text-sub); font-size: 12px; }
      .extra-projects { margin-top: 20px; display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: 12px; }
      .extra-project-card {
        display: flex; flex-direction: column; align-items: flex-start; justify-content: flex-start;
        gap: 10px; min-width: 0; min-height: 122px; padding: 12px 10px; border-radius: 16px;
        border: 1px solid rgba(90, 184, 255, 0.16); background: rgba(5, 14, 34, 0.08);
        color: inherit; text-decoration: none; backdrop-filter: blur(3px) saturate(112%);
        transition: transform 220ms ease, border-color 220ms ease, box-shadow 220ms ease;
      }
      .extra-project-card:hover { border-color: rgba(120, 230, 255, 0.56); box-shadow: 0 10px 20px rgba(0, 0, 0, 0.12), 0 0 20px rgba(41, 135, 255, 0.14); }
      .extra-project-copy { min-width: 0; width: 100%; }
      .extra-project-copy strong, .extra-project-copy span { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .extra-project-copy span, .extra-project-card em { color: var(--text-sub); font-size: 12px; }
      .extra-project-card em { margin-top: auto; align-self: flex-end; }
      .extra-project-build-version { color: rgba(182, 220, 255, 0.72); }
      .extra-project-build-version-unstable { font-style: italic; }
      .empty-card { justify-content: center; }
      .portal-footer { position: relative; z-index: 2; margin-top: auto; padding: 18px 16px 20px; }
      .portal-scroll.no-overflow .portal-footer {
        position: absolute; left: 0; right: 0; bottom: 8px; margin-top: 0; padding-top: 0; padding-bottom: 0; transform: none;
      }
      .portal-footer::after {
        content: ""; position: absolute; inset: 0; pointer-events: none; opacity: var(--footer-focus-opacity);
        background: radial-gradient(circle at var(--footer-focus-x) var(--footer-focus-y), rgba(92, 212, 255, 0.24), rgba(38, 118, 255, 0.14) 26%, transparent 50%);
        transition: opacity 180ms ease;
      }
      .portal-footer-inner {
        position: relative; width: min(720px, 100%); margin: 0 auto; display: flex;
        align-items: center; justify-content: center; gap: 14px; min-height: 88px;
      }
      .portal-scroll.no-overflow .portal-footer-inner { min-height: 76px; }
      .footer-wordmark { display: block; width: auto; height: min(72px, 8vw); flex: 0 1 auto; filter: drop-shadow(0 0 18px rgba(61, 172, 255, 0.16)); }
      .footer-wordmark-text { font-size: 14px; letter-spacing: 0.08em; color: var(--text-sub); }
      .footer-github-links { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; transform: translateY(6px); }
      .footer-github-link {
        position: relative; display: inline-flex; align-items: center; justify-content: center;
        width: 54px; height: 54px; border-radius: 999px; text-decoration: none; outline: none;
        cursor: pointer; transition: transform 180ms ease;
      }
      .footer-github-link::before {
        content: ""; position: absolute; inset: -10px; border-radius: inherit; opacity: 0; pointer-events: none;
        background: radial-gradient(circle, rgba(118, 227, 255, 0.2) 0%, rgba(68, 142, 255, 0.14) 52%, transparent 76%);
        box-shadow: inset 0 0 0 1px rgba(168, 237, 255, 0.4), 0 0 18px rgba(78, 156, 255, 0.28), 0 0 36px rgba(42, 109, 255, 0.18);
        transform: scale(0.88); transition: opacity 180ms ease, transform 180ms ease, box-shadow 180ms ease;
      }
      .footer-github-link:hover, .footer-github-link:focus-visible { transform: translateY(-2px) scale(1.02); }
      .footer-github-link:hover::before, .footer-github-link:focus-visible::before { opacity: 1; transform: scale(1.05); }
      .footer-github-link img { position: relative; z-index: 1; display: block; width: 100%; height: 100%; object-fit: contain; }
      .footer-github-link-left { margin-left: 6px; margin-right: -6px; }
      .footer-github-link-right { margin-left: -6px; }
      @media (max-width: 1480px) { .extra-projects { grid-template-columns: repeat(6, minmax(0, 1fr)); } }
      @media (max-width: 1280px) {
        .project-deck { width: min(78%, 960px); }
        .project-deck-count-5 { width: min(960px, 78%); }
        .project-card { min-height: 236px; }
      }
      @media (max-width: 1180px) {
        .stage { width: min(1400px, calc(100vw - 24px)); }
        .extra-projects { grid-template-columns: repeat(4, minmax(0, 1fr)); }
        .footer-wordmark { height: min(64px, 8.8vw); }
        .overflow-section { margin-top: clamp(-132px, -11vw, -56px); }
      }
      @media (max-width: 960px) {
        .hero-stage { min-height: auto; padding-top: 18px; padding-bottom: 0; }
        .stage { width: min(100%, calc(100vw - 20px)); }
        .project-deck { top: 56%; gap: 12px; width: min(88%, 680px); }
        .project-card { min-height: 210px; padding-inline: 12px; }
        .extra-projects { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        .overflow-section { margin-top: -56px; }
        .portal-footer-inner { gap: 12px; }
        .footer-github-link { width: 45px; height: 45px; }
        .portal-scroll.no-overflow .portal-footer { bottom: 6px; }
      }
      @media (max-width: 820px) {
        .project-deck {
          position: static; transform: none; width: min(100%, 520px);
          grid-template-columns: 1fr; gap: 14px; margin: 0 auto; padding-top: 24%;
        }
        .project-deck-count-1, .project-deck-count-2, .project-deck-count-3,
        .project-deck-count-4, .project-deck-count-5 { width: min(100%, 520px); }
        .project-card { min-height: 220px; }
        .extra-projects { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .portal-footer-inner { flex-direction: column; }
        .footer-wordmark { height: auto; width: min(320px, 72vw); }
      }
      @media (max-width: 560px) { .extra-projects { grid-template-columns: 1fr; } }
`;
