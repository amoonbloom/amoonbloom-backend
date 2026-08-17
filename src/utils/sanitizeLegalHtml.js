/**
 * Sanitizes admin-authored rich-text HTML for the storefront legal pages.
 *
 * The legal-page content is authored in an admin WYSIWYG editor and rendered on
 * the storefront via dangerouslySetInnerHTML, so it MUST be sanitized before it
 * is stored (and the frontend sanitizes again on render — defense in depth). We
 * allow only the small set of tags the editor can produce (headings, paragraphs,
 * lists, bold/italic/underline, highlight via <mark>, links, blockquotes, line
 * breaks) and strip everything else — no <script>, <style>, <iframe>, event
 * handlers, or javascript: URLs can survive.
 */
const sanitizeHtml = require('sanitize-html');

const OPTIONS = {
  allowedTags: [
    'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'mark',
    'h2', 'h3', 'h4',
    'ul', 'ol', 'li',
    'blockquote', 'a', 'span',
  ],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
    // The editor emits highlight as <mark> and occasionally colored spans — allow
    // a class hook and the data-color the highlight extension may set. No inline
    // style (would let url()/expression() through).
    mark: ['class', 'data-color'],
    span: ['class'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  // Force safe link behavior — external links open in a new tab without leaking
  // the referrer or window.opener.
  transformTags: {
    a: (tagName, attribs) => {
      const href = attribs.href || '';
      const isExternal = /^https?:\/\//i.test(href);
      return {
        tagName: 'a',
        attribs: {
          ...attribs,
          ...(isExternal ? { target: '_blank', rel: 'noopener noreferrer' } : {}),
        },
      };
    },
  },
  // Drop the contents of any disallowed tag entirely for these (so a stripped
  // <script> doesn't leave its JS as visible text).
  nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript'],
};

/**
 * @param {unknown} html
 * @returns {string} sanitized HTML, or '' for empty/blank/non-string input.
 */
function sanitizeLegalHtml(html) {
  if (html == null) return '';
  const str = String(html);
  if (!str.trim()) return '';
  return sanitizeHtml(str, OPTIONS).trim();
}

module.exports = { sanitizeLegalHtml };
