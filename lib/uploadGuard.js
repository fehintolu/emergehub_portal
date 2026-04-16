const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const MAX_BYTES_DEFAULT = 10 * 1024 * 1024;

function sniffMime(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    return 'application/pdf';
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return 'image/png';
  }
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  return null;
}

function validateUploadedFile({ buffer, reportedMime, maxBytes }) {
  const max = maxBytes || MAX_BYTES_DEFAULT;
  if (!buffer || buffer.length > max) {
    return { ok: false, error: 'File too large' };
  }
  const sniffed = sniffMime(buffer);
  if (!sniffed) {
    return { ok: false, error: 'Unsupported or unsafe file type' };
  }
  if (reportedMime && !ALLOWED_MIME.has(reportedMime)) {
    return { ok: false, error: 'Disallowed MIME type' };
  }
  if (reportedMime && reportedMime !== sniffed) {
    return { ok: false, error: 'File content does not match declared type' };
  }
  if (!ALLOWED_MIME.has(sniffed)) {
    return { ok: false, error: 'Unsupported file type' };
  }
  return { ok: true, mime: sniffed };
}

module.exports = { validateUploadedFile, ALLOWED_MIME, MAX_BYTES_DEFAULT };
