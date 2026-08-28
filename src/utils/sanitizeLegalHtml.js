/**
 * Sanitizes admin-authored rich-text HTML for the storefront (legal pages and
 * product descriptions — both authored in the same WYSIWYG editor).
 *
 * The content is rendered on the storefront via dangerouslySetInnerHTML, so it
 * MUST be sanitized before it is stored (and the frontend sanitizes again on
 * render — defense in depth). We allow only the small set of tags the editor can
 * produce (headings, paragraphs, lists, bold/italic/underline, highlight via
 * <mark>, links, blockquotes, line breaks) plus the two inline styles it sets
 * (text-align, font-size), and strip everything else — no <script>, <style>,
 * <iframe>, event handlers, or javascript: URLs can survive.
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
    // a class hook and the data-color the highlight extension may set.
    mark: ['class', 'data-color'],
    span: ['class', 'style'],
    // `style` is allowed on every tag but hard-filtered by `allowedStyles` below
    // to ONLY text-align / font-size — nothing else (url(), expression(), …) can
    // survive. Without listing `style` here, allowedStyles never runs.
    '*': ['style'],
  },
  // The editor can set text alignment and font size as inline styles. Allow ONLY
  // those two properties (with a constrained value grammar) — no url(), position,
  // or anything else can ride in on the style attribute.
  allowedStyles: {
    '*': {
      'text-align': [/^(left|right|center|justify)$/],
      'font-size': [/^\d+(?:\.\d+)?(px|em|rem|%)$/],
    },
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
