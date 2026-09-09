import { WorkbenchShell } from "../screens/workbench/WorkbenchShell";
import { I18nProvider } from "./i18n";

export const App = (): JSX.Element => {
  return (
    <I18nProvider>
      <WorkbenchShell />
    </I18nProvider>
  );
};
