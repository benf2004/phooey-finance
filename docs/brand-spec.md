# Phooey Finance and Invoicer

Use lowercase **phooey! finance**, **phooey! invoicer**, and **phooey!** for the standalone wordmark. The outlined lettering is based on Bricolage Grotesque; preserve the exclamation mark.

Reference: https://adsonbread.com/, inspected November 21, 2026. Large medium-weight sans-serif headings, warm off-white, thin rules, restrained rectangular actions, generous space, minimal ornament.

Mode: redesign while preserving Phooey's identity, routes, product features, legal copy, accessibility, invoice customization, and financial records. Signup field changes are expressly requested.

Design read: practical business software for solo operators. Familiar layouts (variance 3/10), state feedback only (motion 2/10), moderate public-page density (4/10) and compact workspace density (7/10), low image dependence (2/10), high Phooey identity fidelity (9/10). Marketing introduces the products; auth concentrates on one step; admin and workspaces prioritize scanning. Phone and laptop viewing, quiet temperature, fluid widths.

## Tokens

- Canvas #f6f5ef; paper #fffef9; Finance ink #203a32; muted #606b63; rules #d6dad1.
- Finance primary #265e49; soft sage #c8d9b6. Invoicer primary #85513b; ink #302e27; muted #68675e.
- DM Sans, locally hosted. Medium-weight headings, tabular figures. Headings 32–62px on public surfaces; 24–38px in tools. Small supporting text does not compete with actions.
- 4px spacing base; primary groups 24/32/48/64px. 3–4px corners; thin borders; no ornamental shadows. 150ms background state transitions; respect reduced motion.
- Account settings use 28–36px page headings and 18px section headings. Security settings pair descriptions and status with controls in divided rows, stacking on phones. Use one clear reauthentication prompt above locked controls. Keep provider credits and duplicate passkey banners off the sign-in page.

## Brand assets

- Finance light wordmark: public/business/assets/wordmark.svg.
- Finance dark wordmark: public/business/assets/wordmark-dark.svg.
- Phooey standalone wordmark: public/business/assets/phooey.svg; copied unchanged to invoicer/public/phooey-wordmark.svg.
- Fonts and licenses: public/business/fonts/dm-sans-latin.woff2 and DM-Sans-OFL.txt; copied into invoicer/public/fonts.
- Existing product demonstration: /dashboard-preview. Homepage cash flow is explicitly marked as example data.

## Contracts and verification

Keep the ledger and invoice editor structure, PDF themes, line-item behavior, provider sign-in callbacks, and tenant boundaries. Test verification before session issuance, retries, destination allowlisting, admin authorization, and Finance/Invoicer handoff. Review layouts in browser before releasing.
