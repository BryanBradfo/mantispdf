/**
 * Files still carrying raw palette classes (see rawColors.ts), each with the task that migrates it.
 * The guard test fails on a dirty file missing here AND on a clean file listed here, so this list only shrinks.
 */
export const RAW_COLOR_ALLOWLIST: Record<string, string> = {
  "src/App.tsx": "migrate: task 6",
  "src/components/desktop/TitleBar.tsx": "migrate: task 6",
  "src/components/license/LicenseDialog.tsx": "migrate: task 6",
  "src/components/redact/MarksPanel.tsx": "migrate: task 6",
  "src/components/redact/RedactCanvas.tsx": "migrate: task 6",
  "src/components/redact/SearchBar.tsx": "migrate: task 6",
  "src/pages/RedactPage.tsx": "migrate: task 6",
  "src/routes.tsx": "migrate: task 6",
};
