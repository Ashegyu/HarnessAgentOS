import { useState } from "react";
import {
  FEATURE_HELP_GROUPS,
  getFeatureHelp,
  type FeatureHelpId,
} from "./feature-help";

export const FeatureGuideTab = (): JSX.Element => {
  const [expandedId, setExpandedId] = useState<FeatureHelpId | null>(
    "workbench",
  );

  return (
    <div className="feature-guide-tab">
      {FEATURE_HELP_GROUPS.map((group) => (
        <section key={group.title} className="feature-guide-group">
          <h3 className="feature-guide-group__heading">{group.title}</h3>
          <ul className="feature-guide-list">
            {group.ids.map((id) => {
              const help = getFeatureHelp(id);
              const expanded = expandedId === id;
              return (
                <li key={id} className="feature-guide-item">
                  <div className="feature-guide-item__head">
                    <div className="feature-guide-item__title">
                      <strong>{help.title}</strong>
                      <span>{help.location}</span>
                    </div>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      aria-expanded={expanded}
                      onClick={() =>
                        setExpandedId((current) =>
                          current === id ? null : id,
                        )
                      }
                    >
                      {expanded ? "닫기" : "설명"}
                    </button>
                  </div>
                  {expanded && (
                    <div className="feature-guide-item__body">
                      <p>{help.summary}</p>
                      <ul>
                        {help.details.map((detail) => (
                          <li key={detail}>{detail}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
};
