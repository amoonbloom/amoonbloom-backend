/** Disable Tabby on regions whose currency Tabby merchant keys don't support (default SAR-only). */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { supportedCurrencies } = require('../src/services/tabby.service');

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  const allowed = supportedCurrencies();
  const regions = await prisma.region.findMany({
    select: { id: true, code: true, currency: true, tabbyEnabled: true },
  });
  for (const r of regions) {
    const ok = allowed.includes(String(r.currency || '').toUpperCase());
    if (!ok && r.tabbyEnabled) {
      await prisma.region.update({ where: { id: r.id }, data: { tabbyEnabled: false } });
      console.log(`Disabled Tabby on ${r.code} (${r.currency}) — not in ${allowed.join(',')}`);
    } else {
      console.log(`Keep ${r.code} (${r.currency}) tabby=${r.tabbyEnabled}`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
