// Vendor fonts from the upstream Noto repository; this is only run by maintainers.
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('public/fonts', { recursive: true });
for (const family of ['NotoSans', 'NotoSerif', 'NotoSansMono']) {
  for (const weight of ['Regular', 'Bold']) {
    const name = `${family}-${weight}.ttf`;
    const response = await fetch(`https://raw.githubusercontent.com/notofonts/noto-fonts/main/hinted/ttf/${family}/${name}`);
    if (!response.ok) throw new Error(`Font download failed: ${name}: ${response.status}`);
    await writeFile(`public/fonts/${name}`, new Uint8Array(await response.arrayBuffer()));
  }
}
const license = await fetch('https://raw.githubusercontent.com/notofonts/noto-fonts/main/LICENSE');
if (!license.ok) throw new Error('Font license download failed');
await writeFile('public/fonts/OFL.txt', await license.text());
