"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import AuthPanel from "@/components/AuthPanel";
import GitHubAppInstallationLinker from "@/components/GitHubAppInstallationLinker";
import { useIsMobileExperience } from "@/lib/device/useIsMobileExperience";

const NAV_ITEMS = [
  { key: "dashboard", href: "/", label: "Dashboard", icon: "dashboard" },
  { key: "tasks", href: "/tasks", label: "Tasks", icon: "tasks" },
];

export default function AppShell({ activeNavItem = "", hideMobileNav = false, children }) {
  const isMobileExperience = useIsMobileExperience();
  const [isNavCollapsed, setIsNavCollapsed] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (isMobileExperience) {
      setIsNavCollapsed(false);
      return;
    }

    const persistedValue = window.localStorage.getItem("fabbro:left-nav-collapsed");
    if (persistedValue === null) {
      setIsNavCollapsed(true);
      return;
    }
    setIsNavCollapsed(persistedValue === "true");
  }, [isMobileExperience]);

  useEffect(() => {
    if (typeof window === "undefined" || isMobileExperience) {
      return;
    }

    window.localStorage.setItem("fabbro:left-nav-collapsed", isNavCollapsed ? "true" : "false");
  }, [isNavCollapsed, isMobileExperience]);

  return (
    <main
      className={`page-shell ${isMobileExperience ? "is-mobile-experience" : "is-desktop-experience"}${
        !isMobileExperience && !isNavCollapsed ? " is-nav-expanded" : ""
      }${isMobileExperience && hideMobileNav ? " is-mobile-nav-hidden" : ""}`}
    >
      <GitHubAppInstallationLinker />
      <div className="page-container">
        <div className="app-layout">
          <div className={`left-rail ${isNavCollapsed ? "is-collapsed" : "is-expanded"}`}>
            <aside className="nav-modal" aria-label="Primary navigation">
              {!isMobileExperience ? (
                <div className="nav-modal-header">
                  <button
                    type="button"
                    className="nav-collapse-toggle"
                    onClick={() => setIsNavCollapsed((current) => !current)}
                    aria-label={isNavCollapsed ? "Expand navigation" : "Collapse navigation"}
                    title={isNavCollapsed ? "Expand navigation" : "Collapse navigation"}
                    aria-expanded={!isNavCollapsed}
                  >
                    <span className="nav-collapse-toggle-glyph" aria-hidden="true">
                      {isNavCollapsed ? "\u203A" : "\u2039"}
                    </span>
                  </button>
                </div>
              ) : null}
              <nav className="nav-modal-body">
                {NAV_ITEMS.map((item) => (
                  <Link
                    key={item.key}
                    href={item.href}
                    className={`nav-link ${activeNavItem === item.key ? "is-active" : ""}${
                      item.mobileHidden ? " mobile-hidden-nav" : ""
                    }`}
                    aria-label={item.label}
                    title={item.label}
                  >
                    <span className="nav-link-icon" aria-hidden="true">
                      <NavIcon icon={item.icon} />
                    </span>
                    <span className="nav-link-label">{item.label}</span>
                  </Link>
                ))}
              </nav>
              <a
                href="#mobile-settings"
                className="nav-link nav-settings-trigger"
                aria-label="Settings"
                title="Settings"
              >
                <span className="nav-link-icon" aria-hidden="true">
                  <NavIcon icon="settings" />
                </span>
              </a>
              <AuthPanel compact={false} />
            </aside>
            <div id="mobile-settings" className="mobile-settings-modal" role="dialog" aria-modal="true" aria-label="Settings">
                <div className="mobile-settings-backdrop" aria-hidden="true" />
                <section className="mobile-settings-panel">
                  <div className="mobile-settings-header">
                    <h2 className="mobile-settings-title">Settings</h2>
                    <a href="#" className="mobile-settings-close-btn" aria-label="Close settings">
                      Close
                    </a>
                  </div>
                  <AuthPanel compact />
                </section>
              </div>
          </div>
          {!isMobileExperience ? (
            <button
              type="button"
              className={`left-rail-backdrop ${isNavCollapsed ? "" : "is-visible"}`}
              onClick={() => setIsNavCollapsed(true)}
              aria-label="Collapse navigation"
              aria-hidden={isNavCollapsed}
              tabIndex={isNavCollapsed ? -1 : 0}
            />
          ) : null}

          <div className="page-content">{children}</div>
        </div>
      </div>
    </main>
  );
}

function NavIcon({ icon }) {
  const commonProps = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.8",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  };

  if (icon === "dashboard") {
    return (
      <svg {...commonProps}>
        <rect x="3.5" y="3.5" width="7" height="7" rx="1.2" />
        <rect x="13.5" y="3.5" width="7" height="4.5" rx="1.2" />
        <rect x="13.5" y="10.5" width="7" height="10" rx="1.2" />
        <rect x="3.5" y="13" width="7" height="7.5" rx="1.2" />
      </svg>
    );
  }

  if (icon === "tasks") {
    return (
      <svg {...commonProps}>
        <path d="M9 7h10M9 12h10M9 17h10" />
        <path d="m4.2 7 1.3 1.3 2.2-2.2M4.2 12 5.5 13.3 7.7 11.1M4.2 17 5.5 18.3 7.7 16.1" />
      </svg>
    );
  }

  if (icon === "settings") {
    return (
      <svg {...commonProps}>
        <path d="M12 8.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4Z" />
        <path d="m19.4 12 .9 1.6-1.8 3.1-1.8-.2a6.7 6.7 0 0 1-1.4.8l-.7 1.6H9.4l-.7-1.6a6.7 6.7 0 0 1-1.4-.8l-1.8.2-1.8-3.1.9-1.6-.9-1.6 1.8-3.1 1.8.2c.4-.3.9-.6 1.4-.8l.7-1.6h4.2l.7 1.6c.5.2 1 .5 1.4.8l1.8-.2 1.8 3.1-.9 1.6Z" />
      </svg>
    );
  }

  return (
    <svg {...commonProps}>
      <path d="M7 8.5 4.5 12 7 15.5M17 8.5l2.5 3.5-2.5 3.5M13.5 5.5 10.5 18.5" />
    </svg>
  );
}
