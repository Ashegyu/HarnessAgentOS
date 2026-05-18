interface ShortcutRow {
  scope: string;
  keys: string;
  action: string;
}

const SHORTCUTS: readonly ShortcutRow[] = [
  {
    scope: "Global",
    keys: "Cmd/Ctrl + K",
    action: "Command Palette",
  },
  {
    scope: "Global",
    keys: "Cmd/Ctrl + ,",
    action: "Settings",
  },
  {
    scope: "Workbench",
    keys: "Cmd/Ctrl + B",
    action: "Threads drawer",
  },
  {
    scope: "Workbench",
    keys: "Cmd/Ctrl + J",
    action: "Context drawer",
  },
  {
    scope: "Workbench",
    keys: "Cmd/Ctrl + N",
    action: "New thread",
  },
  {
    scope: "Modal",
    keys: "Esc",
    action: "Close active surface",
  },
  {
    scope: "Command Palette",
    keys: "Enter",
    action: "Run selected command",
  },
  {
    scope: "Command Palette",
    keys: "Up / Down",
    action: "Move selection",
  },
];

export const KeyboardShortcutsTab = (): JSX.Element => (
  <div className="keyboard-shortcuts">
    <header className="keyboard-shortcuts__header">
      <h3>Keyboard Shortcuts</h3>
      <span>{SHORTCUTS.length} shortcuts</span>
    </header>
    <div className="keyboard-shortcuts__table-wrap">
      <table className="keyboard-shortcuts__table">
        <thead>
          <tr>
            <th>Scope</th>
            <th>Keys</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {SHORTCUTS.map((shortcut) => (
            <tr key={`${shortcut.scope}:${shortcut.keys}`}>
              <td>{shortcut.scope}</td>
              <td>
                <kbd>{shortcut.keys}</kbd>
              </td>
              <td>{shortcut.action}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
);
