import { PrismaClient, type ProviderCategory } from "@prisma/client";
import { SEED_SITES } from "./seed-data";

const prisma = new PrismaClient();

async function main() {
  let created = 0;
  for (const site of SEED_SITES) {
    await prisma.referralSite.create({
      data: {
        name: site.name,
        category: site.category as ProviderCategory,
        specialty: site.specialty,
        address: site.address,
        verificationStatus: "UNVERIFIED",
        acceptsUninsured: false,
        freeCareEligible: false,
        slidingScale: false,
        languages: [],
        referralSteps: [],
        providers: {
          create: site.doctors.map(([name, specialty]) => ({ name, specialty })),
        },
      },
    });
    created++;
    if (created % 50 === 0) console.log(`${created} / ${SEED_SITES.length} sites created...`);
  }
  console.log(`\nDone. ${created} sites loaded from YNHH roster.`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });