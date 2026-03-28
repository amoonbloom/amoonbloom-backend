/**
 * Landing page banner images. Admin adds/reorders/deletes; public gets ordered list.
 * Images stored by URL in DB (Bunny CDN URLs can be used later).
 */
const prisma = require('../config/db');

async function getBanners() {
  return prisma.bannerImage.findMany({
    orderBy: { sortOrder: 'asc' },
    select: {
      id: true,
      url: true,
      sortOrder: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

/**
 * Add one or more banner images. New items get sortOrder at the end.
 * @param {string | string[]} urlOrUrls - Single URL or array of URLs
 * @returns {Promise<{ count: number, items: object[] }>}
 */
async function addBanners(urlOrUrls) {
  const urls = Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls];
  if (urls.length === 0) {
    return { count: 0, items: [] };
  }

  const maxOrder = await prisma.bannerImage
    .aggregate({ _max: { sortOrder: true } })
    .then((r) => (r._max.sortOrder ?? -1) + 1);

  const data = urls.map((url, i) => ({
    url: String(url).trim(),
    sortOrder: maxOrder + i,
  }));

  const created = await prisma.bannerImage.createManyAndReturn({ data });
  created.sort((a, b) => a.sortOrder - b.sortOrder);
  return { count: created.length, items: created };
}

/**
 * Reorder banners by providing the desired order of IDs. First id = sortOrder 0, etc.
 * @param {string[]} orderedIds - Array of banner IDs in display order
 * @returns {Promise<object[]>}
 */
async function updateOrder(orderedIds) {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    return getBanners();
  }

  const updates = orderedIds.map((id, index) =>
    prisma.bannerImage.update({
      where: { id },
      data: { sortOrder: index },
    })
  );

  await prisma.$transaction(updates);
  return getBanners();
}

async function deleteBanner(id) {
  await prisma.bannerImage.delete({ where: { id } });
  return getBanners();
}

module.exports = {
  getBanners,
  addBanners,
  updateOrder,
  deleteBanner,
};
