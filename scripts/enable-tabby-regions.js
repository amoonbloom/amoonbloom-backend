require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  const result = await prisma.region.updateMany({
    where: { OR: [{ code: { in: ['SA', 'AE'] } }, { isDefault: true }] },
    data: { tabbyEnabled: true },
  });
  console.log('Enabled Tabby on regions:', result);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
