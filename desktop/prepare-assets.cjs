const fs = require('node:fs/promises');
const path = require('node:path');

async function prepareAssets() {
  const target = path.join(__dirname, 'extension/vendor');
  await fs.mkdir(target, { recursive: true });
  const assets = [
    ['marked/lib/marked.umd.js', 'marked.js'],
    ['dompurify/dist/purify.min.js', 'purify.js'],
    ['katex/dist/katex.min.js', 'katex.js'],
    ['katex/dist/katex.min.css', 'katex.css'],
    ['katex/dist/fonts', 'fonts'],
    ['marked/LICENSE', 'MARKED-LICENSE'],
    ['dompurify/LICENSE', 'DOMPURIFY-LICENSE'],
    ['katex/LICENSE', 'KATEX-LICENSE']
  ];
  for (const [source, destination] of assets) {
    await fs.cp(path.join(__dirname, 'node_modules', source), path.join(target, destination), { recursive: true });
  }
}

if (require.main === module) prepareAssets().catch(error => { console.error(error.message); process.exit(1); });
module.exports = { prepareAssets };
