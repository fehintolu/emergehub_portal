const fs = require('fs').promises;
const path = require('path');
const { marked } = require('marked');

const DOCS_DIR = path.join(__dirname, '..', 'docs');

const ALLOWED_DOCS = new Set([
  'MEMBER_USER_GUIDE.md',
  'ADMIN_USER_GUIDE.md',
  'USER_GUIDE_SCREENSHOTS.md',
]);

marked.setOptions({
  gfm: true,
  breaks: false,
  mangle: false,
  headerIds: true,
});

/**
 * @param {string} filename - one of ALLOWED_DOCS
 * @returns {Promise<string>} sanitized HTML fragment
 */
async function markdownDocToHtml(filename) {
  if (!ALLOWED_DOCS.has(filename)) {
    throw new Error(`Unknown knowledge base document: ${filename}`);
  }
  const full = path.join(DOCS_DIR, filename);
  const md = await fs.readFile(full, 'utf8');
  return marked.parse(md);
}

module.exports = { markdownDocToHtml, ALLOWED_DOCS };
