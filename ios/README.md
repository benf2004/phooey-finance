# phooey! finance for iPhone

Open `PhooeyFinance.xcodeproj` in Xcode. Choose the **PhooeyFinance** scheme and an iPhone simulator.

## See the designs with sample data

Open either Swift file below, then choose **Editor → Canvas**. Click **Resume** if Xcode pauses the preview. The two previews use fictional business records and open without signing in.

| Preview | File | What to try |
| --- | --- | --- |
| OverviewPreview | PhooeyFinance/FinanceViews.swift | Compare the income and expense lines, then select Figures to read each month. |
| InvoiceEditorPreview | PhooeyFinance/Invoices.swift | Change the rate on the $800 invoice and watch the balance due update. |

Run the scheme to use the actual app. Sign in through the system authorization sheet with a hosted Phooey account. Saving, issuing and exporting PDFs require a configured hosted workspace.

## Screen design

**Overview.** The first screen answers how much the business retained in the selected period. Income uses a solid green line with circles. Expenses use a dashed rust line with diamonds. Each currency has its own totals and graph. The Figures control exposes exact amounts, and View transactions opens the register for the same period and currency. [Apple guidance on charting data](https://developer.apple.com/design/human-interface-guidelines/charting-data)

**Transactions.** A searchable, paginated register opens each record’s account, posting date, category, currency and amount. Native navigation keeps the register available when the owner returns from a detail screen.

**Invoices.** A draft is a native form in document order. Business and client details come before line items, notes and the balance. Save draft and Close stay in the navigation bar. Preview PDF uses the workspace renderer to preserve the business’s fonts, logo, tax and currency settings. PDFKit displays the result, and Save PDF opens the system file exporter. Issuing requires a separate confirmation. Conflicting updates offer a reload of the saved version. [Apple guidance on entering data](https://developer.apple.com/design/human-interface-guidelines/entering-data)

## Appearance and accessibility

The workbook uses system surfaces, SF Pro text styles, aligned financial numerals and a serif invoice title. The exclamation mark on the home screen and the sign-in wordmark use the existing Phooey artwork. System typography follows Dynamic Type. Chart legends, dash patterns and the figures view distinguish income from expenses independently of color. [Apple accessibility guidance](https://developer.apple.com/design/human-interface-guidelines/accessibility)

| Chart series | Light appearance on white | Dark appearance on #1C1C1E |
| --- | --- | --- |
| Income | #145C40 · 7.97:1 | #91D6B0 · 10.09:1 |
| Expenses | #9E4021 · 6.54:1 | #FFA87D · 9.03:1 |

The iOS deployment target is 17.0. The app uses SwiftUI, Swift Charts and PDFKit. System-browser authentication preserves the existing single-use mobile code and workspace session. The native register currently supports browsing and searching. Transaction creation and advanced invoice branding settings are available in the web workspace.
