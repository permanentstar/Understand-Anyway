/**
 * Portal client-side behavior (hover/click audio cues + footer focus glow),
 * extracted from {@link renderPortalPage}. Self-contained IIFE string with no
 * server-side interpolation, so it ships verbatim into the page.
 */

export const PORTAL_SCRIPT = `
      (() => {
        const supportsAudio = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
        let context = null;
        function beep(multiplier) {
          if (!supportsAudio) return;
          const AudioCtor = window.AudioContext || window.webkitAudioContext;
          context = context || new AudioCtor();
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          oscillator.type = "sine";
          oscillator.frequency.value = 240 + (multiplier * 40);
          gain.gain.value = 0.0001;
          oscillator.connect(gain);
          gain.connect(context.destination);
          const now = context.currentTime;
          gain.gain.exponentialRampToValueAtTime(0.06, now + 0.01);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
          oscillator.start(now);
          oscillator.stop(now + 0.18);
        }
        const scrollContainer = document.querySelector(".portal-scroll");
        const footer = document.querySelector(".portal-footer");
        let activeFooterLink = null;
        function clearFooterLinkGeometry() { if (footer) footer.style.setProperty("--footer-focus-opacity", "0"); }
        function updateFooterLinkGeometry() {
          if (!footer || !activeFooterLink) return;
          const footerRect = footer.getBoundingClientRect();
          const linkRect = activeFooterLink.getBoundingClientRect();
          const centerX = linkRect.left + (linkRect.width / 2) - footerRect.left;
          const centerY = linkRect.top + (linkRect.height / 2) - footerRect.top;
          footer.style.setProperty("--footer-focus-x", \`\${centerX}px\`);
          footer.style.setProperty("--footer-focus-y", \`\${centerY}px\`);
          footer.style.setProperty("--footer-focus-opacity", "1");
        }
        requestAnimationFrame(updateFooterLinkGeometry);
        window.addEventListener("resize", updateFooterLinkGeometry, { passive: true });
        scrollContainer?.addEventListener("scroll", updateFooterLinkGeometry, { passive: true });
        document.querySelectorAll(".project-card, .extra-project-card").forEach((card) => {
          const multiplier = Number(card.dataset.sound || "1");
          card.addEventListener("mouseenter", () => beep(multiplier));
          card.addEventListener("click", () => beep(multiplier + 2));
        });
        document.querySelectorAll(".footer-github-link").forEach((item, index) => {
          item.addEventListener("mouseenter", () => { activeFooterLink = item; updateFooterLinkGeometry(); beep(index + 6); });
          item.addEventListener("focus", () => { activeFooterLink = item; updateFooterLinkGeometry(); });
          item.addEventListener("mouseleave", () => { activeFooterLink = null; clearFooterLinkGeometry(); });
          item.addEventListener("blur", () => { activeFooterLink = null; clearFooterLinkGeometry(); });
          item.addEventListener("click", () => { activeFooterLink = item; updateFooterLinkGeometry(); beep(index + 8); });
        });
      })();
`;
