import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { getFeatureHelp, type FeatureHelpId } from "./feature-help";

interface FeatureHelpButtonProps {
  featureId: FeatureHelpId;
  className?: string;
}

interface PopoverPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

const VIEWPORT_MARGIN = 12;
const POPOVER_GAP = 8;
const POPOVER_MAX_WIDTH = 360;
const POPOVER_MIN_HEIGHT = 96;
const POPOVER_FALLBACK_HEIGHT = 220;
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max));

export const FeatureHelpButton = ({
  featureId,
  className = "",
}: FeatureHelpButtonProps): JSX.Element => {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PopoverPosition>({
    top: VIEWPORT_MARGIN,
    left: VIEWPORT_MARGIN,
    width: POPOVER_MAX_WIDTH,
    maxHeight: POPOVER_FALLBACK_HEIGHT,
  });
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLSpanElement | null>(null);
  const help = getFeatureHelp(featureId);
  const panelId = useId();
  const classNames = ["feature-help", className].filter(Boolean).join(" ");
  const updatePosition = useCallback((): void => {
    const button = buttonRef.current;
    if (!button || typeof window === "undefined") return;

    const viewportWidth =
      window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight =
      window.innerHeight || document.documentElement.clientHeight;
    const rect = button.getBoundingClientRect();
    const width = Math.min(
      POPOVER_MAX_WIDTH,
      Math.max(POPOVER_MIN_HEIGHT, viewportWidth - VIEWPORT_MARGIN * 2),
    );
    const left = clamp(
      rect.left,
      VIEWPORT_MARGIN,
      viewportWidth - VIEWPORT_MARGIN - width,
    );

    const measuredHeight =
      popoverRef.current?.offsetHeight ?? POPOVER_FALLBACK_HEIGHT;
    const belowTop = rect.bottom + POPOVER_GAP;
    const belowSpace = viewportHeight - VIEWPORT_MARGIN - belowTop;
    const aboveSpace = rect.top - POPOVER_GAP - VIEWPORT_MARGIN;
    const shouldOpenAbove =
      belowSpace < measuredHeight && aboveSpace > belowSpace;

    if (shouldOpenAbove) {
      const maxHeight = Math.max(POPOVER_MIN_HEIGHT, aboveSpace);
      const top = Math.max(
        VIEWPORT_MARGIN,
        rect.top - POPOVER_GAP - Math.min(measuredHeight, maxHeight),
      );
      setPosition({ top, left, width, maxHeight });
      return;
    }

    const top = clamp(
      belowTop,
      VIEWPORT_MARGIN,
      viewportHeight - VIEWPORT_MARGIN - POPOVER_MIN_HEIGHT,
    );
    const maxHeight = Math.max(
      POPOVER_MIN_HEIGHT,
      viewportHeight - VIEWPORT_MARGIN - top,
    );
    setPosition({ top, left, width, maxHeight });
  }, []);

  useIsomorphicLayoutEffect(() => {
    if (!open) return;
    updatePosition();

    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const popoverStyle: CSSProperties = {
    top: position.top,
    left: position.left,
    width: position.width,
    maxHeight: position.maxHeight,
  };

  const popover = (
    <span
      ref={popoverRef}
      id={panelId}
      className="feature-help__popover"
      role="dialog"
      aria-label={`${help.title} 설명`}
      style={popoverStyle}
    >
      <span className="feature-help__header">
        <strong>{help.title}</strong>
        <button
          type="button"
          className="feature-help__close"
          aria-label="설명 닫기"
          onClick={() => setOpen(false)}
        >
          x
        </button>
      </span>
      <span className="feature-help__summary">{help.summary}</span>
      <span className="feature-help__details">
        {help.details.map((detail) => (
          <span key={detail} className="feature-help__detail">
            {detail}
          </span>
        ))}
      </span>
      <span className="feature-help__location">{help.location}</span>
    </span>
  );

  return (
    <span className={classNames}>
      <button
        ref={buttonRef}
        type="button"
        className="feature-help__button"
        aria-label={`${help.title} 설명`}
        aria-expanded={open}
        aria-controls={panelId}
        title={`${help.title} 설명`}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      >
        ?
      </button>
      {open && createPortal(popover, document.body)}
    </span>
  );
};
