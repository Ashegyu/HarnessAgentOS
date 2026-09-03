export type WorkbenchIconName =
  | "threads"
  | "context"
  | "learning"
  | "sun"
  | "moon"
  | "settings"
  | "plus"
  | "spark"
  | "plan"
  | "agent"
  | "graph"
  | "timeline"
  | "files"
  | "quality"
  | "orchestration"
  | "cost"
  | "decisions"
  | "bell"
  | "arrow-right";

interface WorkbenchIconProps {
  name: WorkbenchIconName;
  className?: string;
}

/** Product-local line icons keep the Electron UI crisp without a runtime icon dependency. */
export const WorkbenchIcon = ({
  name,
  className,
}: WorkbenchIconProps): JSX.Element => (
  <svg
    className={`workbench-icon${className ? ` ${className}` : ""}`}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {name === "threads" && (
      <>
        <path d="M5 6h14M5 12h14M5 18h10" />
        <path d="M3 6h.01M3 12h.01M3 18h.01" />
      </>
    )}
    {name === "context" && (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2.5" />
        <path d="M15 4v16M18 8h.01M18 12h.01" />
      </>
    )}
    {name === "learning" && (
      <>
        <path d="M9 18h6M10 21h4" />
        <path d="M8.5 15.5a7 7 0 1 1 7 0c-.9.65-1.5 1.35-1.5 2.5h-4c0-1.15-.6-1.85-1.5-2.5Z" />
      </>
    )}
    {name === "sun" && (
      <>
        <circle cx="12" cy="12" r="3.5" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" />
      </>
    )}
    {name === "moon" && <path d="M20.2 15.3A8.5 8.5 0 0 1 8.7 3.8 8.5 8.5 0 1 0 20.2 15.3Z" />}
    {name === "settings" && (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.86 2.86-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.55v-.1A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.86-2.86.06-.06A1.7 1.7 0 0 0 4.1 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H2.3V9.55h.1A1.7 1.7 0 0 0 4.1 8.5a1.7 1.7 0 0 0-.34-1.88l-.06-.06L6.56 3.7l.06.06A1.7 1.7 0 0 0 8.5 4.1a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1v-.1h4.05v.1a1.7 1.7 0 0 0 1.05 1.7 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.86 2.86-.06.06A1.7 1.7 0 0 0 19.4 8.5c.16.39.37.73.6 1 .3.34.69.52 1.1.55h.1v4.05h-.1A1.7 1.7 0 0 0 19.4 15Z" />
      </>
    )}
    {name === "plus" && <path d="M12 5v14M5 12h14" />}
    {name === "spark" && (
      <>
        <path d="m12 3 1.35 4.15L17.5 8.5l-4.15 1.35L12 14l-1.35-4.15L6.5 8.5l4.15-1.35L12 3Z" />
        <path d="m18.5 14 .65 1.85L21 16.5l-1.85.65L18.5 19l-.65-1.85L16 16.5l1.85-.65L18.5 14Z" />
      </>
    )}
    {name === "plan" && (
      <>
        <rect x="4" y="3" width="16" height="18" rx="2.5" />
        <path d="M8 8h8M8 12h8M8 16h5" />
      </>
    )}
    {name === "agent" && (
      <>
        <rect x="5" y="6" width="14" height="13" rx="3" />
        <path d="M9 3h6M12 3v3M9 11h.01M15 11h.01M9 15h6" />
      </>
    )}
    {name === "graph" && (
      <>
        <circle cx="6" cy="6" r="2" />
        <circle cx="18" cy="7" r="2" />
        <circle cx="12" cy="18" r="2" />
        <path d="m7.8 6.3 8.2.4M7.2 7.7l3.7 8.5M16.9 8.6l-3.8 7.6" />
      </>
    )}
    {name === "timeline" && (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    )}
    {name === "files" && (
      <>
        <path d="M7 3h7l4 4v14H7z" />
        <path d="M14 3v5h5M10 12h5M10 16h5" />
      </>
    )}
    {name === "quality" && (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="m8 12 2.6 2.6L16.5 9" />
      </>
    )}
    {name === "orchestration" && (
      <>
        <circle cx="7" cy="5" r="2" />
        <circle cx="17" cy="12" r="2" />
        <circle cx="7" cy="19" r="2" />
        <path d="M9 5h2a3 3 0 0 1 3 3v1a3 3 0 0 0 3 3M9 19h2a3 3 0 0 0 3-3v-1a3 3 0 0 1 3-3" />
      </>
    )}
    {name === "cost" && (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M15 8.5c-.7-.7-1.7-1-3-1-1.7 0-3 .85-3 2s1.1 1.8 3 2c1.9.2 3 1 3 2.2S13.7 16 12 16c-1.3 0-2.4-.4-3-1M12 5.5v13" />
      </>
    )}
    {name === "decisions" && (
      <>
        <path d="m12 3 8 9-8 9-8-9 8-9Z" />
        <path d="m8.5 12 2.2 2.2 4.8-4.8" />
      </>
    )}
    {name === "bell" && (
      <>
        <path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 7h18s-3 0-3-7" />
        <path d="M10 20h4" />
      </>
    )}
    {name === "arrow-right" && <path d="M5 12h14M14 7l5 5-5 5" />}
  </svg>
);
