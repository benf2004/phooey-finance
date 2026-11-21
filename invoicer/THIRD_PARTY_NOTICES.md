# Third-party notices

This edition is AGPL-3.0-only. The original Invoicer MIT notice is preserved in public/licenses/original-invoicer-MIT.txt. Third-party libraries retain their licenses; complete package notices are distributed by their npm packages and listed in the lockfile.

| Dependency | License | Upstream |
| --- | --- | --- |
| React / React DOM | MIT | https://github.com/facebook/react |
| Hono | MIT | https://github.com/honojs/hono |
| Zod | MIT | https://github.com/colinhacks/zod |
| decimal.js | MIT | https://github.com/MikeMcl/decimal.js |
| pdf-lib | MIT | https://github.com/Hopding/pdf-lib |
| @pdf-lib/fontkit | MIT | https://github.com/Hopding/fontkit |
| PDF.js (`pdfjs-dist`) | Apache-2.0 | https://github.com/mozilla/pdf.js |
| Lucide icons | ISC | https://github.com/lucide-icons/lucide |
| Vite, Vitest, TypeScript, Wrangler and associated development packages | See individual package licenses | Installed only as development tooling |
| Noto Sans, Noto Serif, Noto Sans Mono fonts | SIL Open Font License 1.1 | https://github.com/notofonts/noto-fonts |

The Noto font license is preserved beside the bundled files at `public/fonts/OFL.txt`. These fonts are neither rebranded nor sold independently.

The fontkit package declares MIT licensing in its upstream README; that declaration is preserved at `public/licenses/fontkit-UPSTREAM-README.md` because the published package does not contain a separate license file. Other runtime package license files are preserved under `public/licenses`.

PDF.js copyright and Apache-2.0 license: https://github.com/mozilla/pdf.js/blob/master/LICENSE. The shipped worker bundle retains the upstream license banner. A full copy is included at `public/licenses/pdfjs-LICENSE`.

No proprietary Invoice Generator code or artwork is included. Minvoice and worker-generate-invoice-pdf are architectural references; their source code is not included in this implementation.
