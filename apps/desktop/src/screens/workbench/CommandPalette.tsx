import { useEffect, useMemo, useRef, useState } from "react";
import {
  filterCommandPaletteItems,
  movePaletteSelection,
  type CommandPaletteItem,
  type RankedCommandPaletteItem,
} from "./command-palette-model";

interface CommandPaletteProps {
  items: readonly CommandPaletteItem[];
  onClose: () => void;
}

const GROUP_LABELS: Record<CommandPaletteItem["group"], string> = {
  tab: "Tabs",
  thread: "Threads",
  settings: "Settings",
  taskrun: "Recent TaskRuns",
};

export const CommandPalette = ({
  items,
  onClose,
}: CommandPaletteProps): JSX.Element => {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const results = useMemo(
    () => filterCommandPaletteItems(items, query),
    [items, query],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const runItem = (item: RankedCommandPaletteItem): void => {
    item.run();
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((index) =>
        movePaletteSelection(index, "down", results.length),
      );
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((index) =>
        movePaletteSelection(index, "up", results.length),
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = results[selectedIndex];
      if (item) runItem(item);
    }
  };

  return (
    <div className="command-palette" role="dialog" aria-modal="true">
      <div className="command-palette__backdrop" onClick={onClose} />
      <div className="command-palette__dialog" onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          className="command-palette__input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search commands"
          aria-label="Command search"
        />
        {results.length === 0 ? (
          <div className="command-palette__empty">일치하는 명령이 없습니다.</div>
        ) : (
          <CommandResults
            results={results}
            selectedIndex={selectedIndex}
            onSelect={setSelectedIndex}
            onRun={runItem}
          />
        )}
      </div>
    </div>
  );
};

const CommandResults = ({
  results,
  selectedIndex,
  onSelect,
  onRun,
}: {
  results: readonly RankedCommandPaletteItem[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onRun: (item: RankedCommandPaletteItem) => void;
}): JSX.Element => {
  let previousGroup: CommandPaletteItem["group"] | null = null;
  return (
    <ul className="command-palette__results" role="listbox">
      {results.map((item, index) => {
        const showGroup = previousGroup !== item.group;
        previousGroup = item.group;
        return (
          <li key={item.id}>
            {showGroup ? (
              <div className="command-palette__group">
                {GROUP_LABELS[item.group]}
              </div>
            ) : null}
            <button
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              className={
                index === selectedIndex
                  ? "command-palette__item command-palette__item--selected"
                  : "command-palette__item"
              }
              onMouseEnter={() => onSelect(index)}
              onClick={() => onRun(item)}
            >
              <span className="command-palette__item-title">{item.title}</span>
              {item.subtitle ? (
                <span className="command-palette__item-subtitle">
                  {item.subtitle}
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
};
