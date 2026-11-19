/**
 * Files still carrying raw palette classes (see rawColors.ts), each with the task that migrates it.
 * The guard test fails on a dirty file missing here AND on a clean file listed here, so this list only shrinks.
 */
export const RAW_COLOR_ALLOWLIST: Record<string, string> = {
  "src/App.tsx": "migrate: task 6",
  "src/components/desktop/TitleBar.tsx": "migrate: task 6",
  "src/components/editor/EditorCanvas.tsx": "migrate: task 5",
  "src/components/editor/PageStrip.tsx": "migrate: task 5",
  "src/components/editor/PropertiesPanel.tsx": "migrate: task 5",
  "src/components/editor/TextEditOverlay.tsx": "migrate: task 5",
  "src/components/editor/Toolbar.tsx": "migrate: task 5",
  "src/components/forms/FieldControl.tsx": "migrate: task 5",
  "src/components/forms/FieldList.tsx": "migrate: task 5",
  "src/components/forms/FormCanvas.tsx": "migrate: task 5",
  "src/components/license/LicenseDialog.tsx": "migrate: task 6",
  "src/components/redact/MarksPanel.tsx": "migrate: task 6",
  "src/components/redact/RedactCanvas.tsx": "migrate: task 6",
  "src/components/redact/SearchBar.tsx": "migrate: task 6",
  "src/components/sign/PlacementCanvas.tsx": "migrate: task 5",
  "src/components/sign/SignaturePad.tsx": "migrate: task 5",
  "src/components/stamp/PositionPicker.tsx": "migrate: task 5",
  "src/components/stamp/TextStyleFields.tsx": "migrate: task 5",
  "src/pages/BatesPage.tsx": "migrate: task 5",
  "src/pages/EditPdfPage.tsx": "migrate: task 5",
  "src/pages/FillFormPage.tsx": "migrate: task 5",
  "src/pages/HeaderFooterPage.tsx": "migrate: task 5",
  "src/pages/PageNumbersPage.tsx": "migrate: task 5",
  "src/pages/RedactPage.tsx": "migrate: task 6",
  "src/pages/SignPdfPage.tsx": "migrate: task 5",
  "src/routes.tsx": "migrate: task 6",
};
