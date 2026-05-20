interface SlimRailProps {
  threadCount: number;
  threadDrawerOpen: boolean;
  contextDrawerOpen: boolean;
  learningOpen: boolean;
  hasSelectedTaskRun: boolean;
  theme: "dark" | "light";
  onToggleThreadDrawer: () => void;
  onToggleContextDrawer: () => void;
  onOpenLearning: () => void;
  onNewThread: () => void;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
}

export const SlimRail = ({
  threadCount,
  threadDrawerOpen,
  contextDrawerOpen,
  learningOpen,
  hasSelectedTaskRun,
  theme,
  onToggleThreadDrawer,
  onToggleContextDrawer,
  onOpenLearning,
  onNewThread,
  onToggleTheme,
  onOpenSettings,
}: SlimRailProps): JSX.Element => {
  return (
    <nav className="slim-rail" aria-label="App navigation">
      <div className="slim-rail__brand" title="HarnessAgentOS" aria-label="HarnessAgentOS">
        <span className="slim-rail__brand-mark">H</span>
      </div>

      <button
        type="button"
        className={`slim-rail__btn${threadDrawerOpen ? " slim-rail__btn--active" : ""}`}
        onClick={onToggleThreadDrawer}
        aria-pressed={threadDrawerOpen}
        aria-label={threadDrawerOpen ? "스레드 패널 닫기" : "스레드 패널 열기"}
        title="스레드 (Ctrl+B)"
      >
        <span aria-hidden>☰</span>
        {threadCount > 0 && (
          <span className="slim-rail__badge" aria-label={`${threadCount}개 스레드`}>
            {threadCount > 99 ? "99+" : threadCount}
          </span>
        )}
      </button>

      <button
        type="button"
        className={`slim-rail__btn${contextDrawerOpen ? " slim-rail__btn--active" : ""}`}
        onClick={onToggleContextDrawer}
        aria-pressed={contextDrawerOpen}
        aria-label={contextDrawerOpen ? "컨텍스트 패널 닫기" : "컨텍스트 패널 열기"}
        title="컨텍스트 (Ctrl+J)"
        disabled={!hasSelectedTaskRun}
      >
        <span aria-hidden>▦</span>
      </button>

      <button
        type="button"
        className={`slim-rail__btn${learningOpen ? " slim-rail__btn--active" : ""}`}
        onClick={onOpenLearning}
        aria-pressed={learningOpen}
        aria-label="Learning 열기"
        title="Learning"
      >
        <span aria-hidden>※</span>
      </button>

      <div className="slim-rail__spacer" />

      <button
        type="button"
        className="slim-rail__btn"
        onClick={onToggleTheme}
        aria-label={theme === "dark" ? "라이트 모드로 전환" : "다크 모드로 전환"}
        title={theme === "dark" ? "라이트 모드" : "다크 모드"}
      >
        <span aria-hidden>{theme === "dark" ? "☀" : "☾"}</span>
      </button>

      <button
        type="button"
        className="slim-rail__btn"
        onClick={onOpenSettings}
        aria-label="설정 열기"
        title="설정 (Ctrl+,)"
      >
        <span aria-hidden>⚒</span>
      </button>

      <button
        type="button"
        className="slim-rail__fab"
        onClick={onNewThread}
        aria-label="새 스레드"
        title="새 스레드 (Ctrl+N)"
      >
        <span aria-hidden>+</span>
      </button>
    </nav>
  );
};
