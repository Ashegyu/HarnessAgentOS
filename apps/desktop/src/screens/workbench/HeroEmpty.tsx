interface SuggestionChipProps {
  label: string;
  onPick: () => void;
}

const SuggestionChip = ({ label, onPick }: SuggestionChipProps): JSX.Element => (
  <button type="button" className="suggestion-chip" onClick={onPick}>
    {label}
  </button>
);

interface HeroEmptyProps {
  variant: "no-thread" | "no-tasks" | "no-thread-selected";
  onSuggest?: (text: string) => void;
  onCreateThread?: () => void;
  onOpenDrawer?: () => void;
}

const SUGGESTIONS: ReadonlyArray<string> = [
  "이 폴더의 구조를 분석해줘",
  "테스트를 추가하고 싶어",
  "최근 변경사항을 리뷰해줘",
  "리팩토링 후보를 찾아줘",
  "의존성 업그레이드 검토",
];

export const HeroEmpty = ({
  variant,
  onSuggest,
  onCreateThread,
  onOpenDrawer,
}: HeroEmptyProps): JSX.Element => {
  if (variant === "no-thread") {
    return (
      <div className="hero-empty" role="region" aria-label="시작 화면">
        <div className="hero-empty__mark" aria-hidden="true">
          <WorkbenchIcon name="spark" />
        </div>
        <span className="hero-empty__eyebrow">SUPERVISED AI WORKBENCH</span>
        <h1 className="hero-empty__title">Harness Agent OS</h1>
        <p className="hero-empty__subtitle">
          계획부터 승인, 실행, 검증까지 한 흐름 안에서 안전하게 다루세요.
        </p>
        {onCreateThread && (
          <button
            type="button"
            className="hero-empty__cta"
            onClick={onCreateThread}
          >
            <span>새 스레드 만들기</span>
            <WorkbenchIcon name="arrow-right" />
          </button>
        )}
        <span className="hero-empty__shortcut">
          <kbd>Ctrl</kbd><span>+</span><kbd>N</kbd>으로 바로 시작
        </span>
      </div>
    );
  }

  if (variant === "no-thread-selected") {
    return (
      <div className="hero-empty" role="region" aria-label="스레드 미선택">
        <div className="hero-empty__mark" aria-hidden="true">
          <WorkbenchIcon name="threads" />
        </div>
        <span className="hero-empty__eyebrow">THREADS</span>
        <h1 className="hero-empty__title">스레드를 선택하세요</h1>
        <p className="hero-empty__subtitle">
          왼쪽 패널에서 작업할 스레드를 고르거나 새로 만들어 시작하세요.
        </p>
        {onOpenDrawer && (
          <button
            type="button"
            className="hero-empty__cta"
            onClick={onOpenDrawer}
          >
            <span>스레드 패널 열기</span>
            <WorkbenchIcon name="arrow-right" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="hero-empty" role="region" aria-label="새 대화 시작">
      <div className="hero-empty__mark" aria-hidden="true">
        <WorkbenchIcon name="spark" />
      </div>
      <span className="hero-empty__eyebrow">READY TO BUILD</span>
      <h1 className="hero-empty__title">무엇을 해볼까요?</h1>
      <p className="hero-empty__subtitle">
        아래 제안을 클릭하거나 작성창에 직접 요청을 입력하세요.
      </p>
      {onSuggest && (
        <div className="hero-empty__chips" role="group" aria-label="제안 목록">
          {SUGGESTIONS.map((text) => (
            <SuggestionChip
              key={text}
              label={text}
              onPick={() => onSuggest(text)}
            />
          ))}
        </div>
      )}
    </div>
  );
};
import { WorkbenchIcon } from "./WorkbenchIcon";
