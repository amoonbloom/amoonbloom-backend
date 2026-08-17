/**
 * Per-region, admin-authored legal pages (the 5 footer pages). Replaces the
 * previously-hardcoded storefront templates. A page is served to the storefront
 * ONLY when a published row exists with content for the requested locale —
 * otherwise the storefront 404s and the footer omits the link ("hidden until
 * set"). Content is sanitized HTML (see utils/sanitizeLegalHtml) authored in the
 * admin rich-text editor; it is sanitized again on render for defense in depth.
 *
 * The set of pages is fixed (LegalPageSlug enum), each mapping to a storefront
 * URL segment (terms, privacy, refund-policy, shipping-policy, product-disclaimer).
 */
const prisma = require('../config/db');
const regionService = require('./region.service');
const { sanitizeLegalHtml } = require('../utils/sanitizeLegalHtml');

/** Enum value -> storefront URL segment. */
const SLUG_TO_URL = {
  TERMS: 'terms',
  PRIVACY: 'privacy',
  REFUND_POLICY: 'refund-policy',
  SHIPPING_POLICY: 'shipping-policy',
  PRODUCT_DISCLAIMER: 'product-disclaimer',
};
const URL_TO_SLUG = Object.fromEntries(Object.entries(SLUG_TO_URL).map(([k, v]) => [v, k]));
const LEGAL_PAGE_SLUGS = Object.keys(SLUG_TO_URL);

const PAGE_SELECT = {
  id: true,
  regionId: true,
  slug: true,
  title: true,
  title_ar: true,
  content: true,
  content_ar: true,
  isPublished: true,
  createdAt: true,
  updatedAt: true,
};

/**
 * Accepts either the enum value ("TERMS") or the URL segment ("terms",
 * "refund-policy") and returns the canonical enum value, or null if unknown.
 */
function normalizeSlug(input) {
  if (!input) return null;
  const raw = String(input).trim();
  if (SLUG_TO_URL[raw]) return raw; // already an enum value
  const lower = raw.toLowerCase();
  return URL_TO_SLUG[lower] || null;
}

function trimOrNull(value) {
  return value != null ? String(value).trim() || null : null;
}

/** A page counts as "set" when it has content in at least one language. */
function pageHasContent(page) {
  return !!(page && ((page.content && page.content.trim()) || (page.content_ar && page.content_ar.trim())));
}

// ---- Public (storefront) ----

/**
 * Resolve a single published, content-bearing page for the storefront. Returns
 * the locale-agnostic payload (both languages; the client picks) or null when
 * the region/page doesn't exist, is unpublished, or has no content in either
 * language — the storefront treats null as a 404.
 */
async function getPublicPage(regionCode, slugInput) {
  const slug = normalizeSlug(slugInput);
  if (!slug) return null;
  const region = await regionService.resolveRegion(regionCode);
  if (!region) return null;
  const page = await prisma.regionLegalPage.findUnique({
    where: { regionId_slug: { regionId: region.id, slug } },
    select: PAGE_SELECT,
  });
  if (!page || !page.isPublished || !pageHasContent(page)) return null;
  return {
    slug: SLUG_TO_URL[slug],
    title: page.title,
    title_ar: page.title_ar,
    content: page.content,
    content_ar: page.content_ar,
    updatedAt: page.updatedAt,
  };
}

/**
 * The URL segments of every published, content-bearing page for the given
 * region ids, keyed by region id — powers the footer, which only links pages
 * that actually exist. Returns { [regionId]: ["terms", "privacy", ...] }.
 */
async function publishedSlugMapForRegions(regionIds) {
  const ids = [...new Set((regionIds || []).filter(Boolean))];
  if (ids.length === 0) return {};
  const rows = await prisma.regionLegalPage.findMany({
    where: {
      regionId: { in: ids },
      isPublished: true,
      OR: [{ content: { not: null } }, { content_ar: { not: null } }],
    },
    select: { regionId: true, slug: true },
  });
  const map = {};
  for (const id of ids) map[id] = [];
  for (const r of rows) {
    if (!map[r.regionId]) map[r.regionId] = [];
    map[r.regionId].push(SLUG_TO_URL[r.slug]);
  }
  return map;
}

// ---- Admin ----

/** All authored pages for a region (any publish state). Frontend merges these
 *  against the fixed 5 slugs to show "Published / Draft / Not set". */
async function listForRegion(regionId) {
  return prisma.regionLegalPage.findMany({
    where: { regionId },
    orderBy: { slug: 'asc' },
    select: PAGE_SELECT,
  });
}

async function getForRegion(regionId, slugInput) {
  const slug = normalizeSlug(slugInput);
  if (!slug) return null;
  return prisma.regionLegalPage.findUnique({
    where: { regionId_slug: { regionId, slug } },
    select: PAGE_SELECT,
  });
}

/**
 * Create or update the page for (region, slug). Content is sanitized to the
 * allowed rich-text tag set. Returns null if the region doesn't exist (→ 404).
 * Empty content is stored as null so "not set" is unambiguous.
 */
async function upsertPage(regionId, slugInput, data) {
  const slug = normalizeSlug(slugInput);
  if (!slug) throw Object.assign(new Error('Unknown legal page'), { code: 'VALIDATION' });
  const region = await prisma.region.findUnique({ where: { id: regionId }, select: { id: true } });
  if (!region) return null;

  const content = sanitizeLegalHtml(data.content) || null;
  const content_ar = sanitizeLegalHtml(data.content_ar) || null;
  const payload = {
    title: trimOrNull(data.title),
    title_ar: trimOrNull(data.title_ar),
    content,
    content_ar,
    isPublished: data.isPublished === undefined ? true : !!data.isPublished,
  };

  return prisma.regionLegalPage.upsert({
    where: { regionId_slug: { regionId, slug } },
    create: { regionId, slug, ...payload },
    update: payload,
    select: PAGE_SELECT,
  });
}

/** Delete the page (reverts the region+slug back to "not set" → hidden). */
async function deletePage(regionId, slugInput) {
  const slug = normalizeSlug(slugInput);
  if (!slug) return null;
  const existing = await prisma.regionLegalPage.findUnique({
    where: { regionId_slug: { regionId, slug } },
    select: { id: true },
  });
  if (!existing) return null;
  await prisma.regionLegalPage.delete({ where: { regionId_slug: { regionId, slug } } });
  return { slug: SLUG_TO_URL[slug] };
}

module.exports = {
  LEGAL_PAGE_SLUGS,
  SLUG_TO_URL,
  URL_TO_SLUG,
  normalizeSlug,
  getPublicPage,
  publishedSlugMapForRegions,
  listForRegion,
  getForRegion,
  upsertPage,
  deletePage,
};
