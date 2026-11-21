---
name: "phooey! finance"
description: "The business statement and invoice workspace for a one-person business."
colors:
  primary: "#174b3d"
  primary-hover: "#0a3b2e"
  income: "#217040"
  expenses: "#ae4b27"
  ink: "#173c35"
  muted: "#53645d"
  canvas: "#f8f8f4"
  surface: "#fffffc"
  line: "#d7dcd4"
  sheet: "#ffffff"
typography:
  headline:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "clamp(26px, 2.15vw, 37px)"
    fontWeight: 710
    letterSpacing: "-0.04em"
  metric:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "clamp(23px, 2.25vw, 40px)"
    fontWeight: 680
    lineHeight: 1.28
    letterSpacing: "-0.04em"
  document-title:
    fontFamily: "Noto Serif, Georgia, serif"
    fontSize: "clamp(36px, 4.3vw, 68px)"
    lineHeight: 1.12
    letterSpacing: "-0.04em"
  control:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "13px"
rounded:
  field: "4px"
  sheet: "6px"
  switch: "7px"
  button: "8px"
  panel: "12px"
spacing:
  tight: "8px"
  compact: "12px"
  section: "16px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.sheet}"
    rounded: "{rounded.button}"
    padding: "10px 16px"
  button-secondary:
    backgroundColor: "{colors.sheet}"
    rounded: "{rounded.button}"
    padding: "10px 16px"
  document-field:
    backgroundColor: "{colors.sheet}"
    typography: "{typography.control}"
    rounded: "{rounded.field}"
    padding: "6px 8px"
  report-panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.panel}"
    padding: "clamp(15px, 1.6vw, 26px)"
  chart-switch:
    rounded: "{rounded.switch}"
  navigation-link:
    typography: "{typography.control}"
  draft-badge:
    padding: "4px 8px"
---

# Design System: phooey! finance

## Overview

**Creative North Star: “Business statement”**

The dashboard helps an owner read a period’s results and open the records behind an amount. Invoicer brings the same dark green ink, compact controls and aligned figures to a white document that the owner edits in place.

**Key characteristics**

- The existing lowercase wordmark identifies the suite.
- Figures align in columns and carry an explicit currency context.
- The strongest boundary separates the working surface from navigation.

## Colors

**Primary.** The deep green primary marks the main invoice action and its line-item header. The workspace uses dark green ink, with a lighter muted tone for dates and secondary labels.

**Secondary.** Income uses green and expenses use rust. These chart colors are working variants of the suite’s warm paper, green ink and rust brand palette. Finance lightens both series in dark mode.

**Neutral.** Warm canvas surrounds near-white report panels. Pure white identifies the invoice sheet and its editable fields. Thin gray-green rules divide adjacent records.

**The chart legend rule.** Give the income and expense series text labels and offer the same figures in a table.

## Typography

Inter is the locally served UI family. The page title and headline totals share tight tracking. Section titles step down to a compact weight and size. Use tabular numerals for financial comparisons, including the transaction register and invoice balance. Keep amounts right-aligned in numeric table columns.

The invoice heading uses Noto Serif with a Georgia fallback. The font selected for the exported document belongs to invoice appearance settings. The surrounding actions and workspace navigation keep their UI typography.

## Layout

On Finance desktop, the sidebar holds navigation and workspace tools. The overview pairs its period and currency selectors with the heading. Income, expenses and net sit above the chart. The register and category breakdown form the next two columns and stack at 740px.

Invoicer places its sheet beside an action rail that stays in view as the document scrolls. At 900px the suite navigation becomes a menu. At 720px the sheet and controls use a single column. Place the logo, parties, dates, items and totals in document order.

## Elevation & Depth

Contrast and borders establish depth in both workspaces. The overview panels and the editable sheet have no shadow. The invoice balance carries a double rule above and below the amount.

## Shapes

Report panels use gently rounded corners, while the invoice sheet and its fields use tighter radii. A dashed outline identifies the sheet’s logo upload area. Fine straight rules separate rows and divide adjacent headline figures.

## Components

- **Navigation.** Finance uses a green highlight for the active sidebar item. Invoicer marks the active top-navigation link with a warm underline.
- **Buttons.** Save draft is a full-width green action in the desktop rail. Preview PDF and PDF use bordered secondary buttons. Issuing has its own confirmation.
- **Chart switch.** Line, Bars and Table share one bordered group. The selected button carries a dark fill and a pressed state. Grouping has its own selector.
- **Fields.** On-sheet inputs have visible borders and reveal a green outline on focus. Optional party contact information and adjustments use disclosures.
- **Status.** A compact tinted badge names the invoice’s state in words.
- **Category rows.** Each row pairs a horizontal expense bar with the category name and amount. Selecting a row opens the corresponding transactions.

## Do's and Don'ts

- Do keep chart filters and groupings beside the report they control.
- Do preserve the document’s reading order as its editable fields reflow.
- Don't combine different currencies into a single total.
- Don't rely on color alone to distinguish financial amounts or invoice states.
