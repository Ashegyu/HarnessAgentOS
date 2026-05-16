import { useId, useState } from "react";
import { getFeatureHelp, type FeatureHelpId } from "./feature-help";

interface FeatureHelpButtonProps {
  featureId: FeatureHelpId;
  className?: string;
}

export const FeatureHelpButton = ({
  featureId,
  className = "",
}: FeatureHelpButtonProps): JSX.Element => {
  const [open, setOpen] = useState(false);
  const help = getFeatureHelp(featureId);
  const panelId = useId();
  const classNames = ["feature-help", className].filter(Boolean).join(" ");

  return (
    <span className={classNames}>
      <button
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
      {open && (
        <span
          id={panelId}
          className="feature-help__popover"
          role="dialog"
          aria-label={`${help.title} 설명`}
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
      )}
    </span>
  );
};
