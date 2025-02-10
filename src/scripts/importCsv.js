import SnapLensWebCrawler from "../crawler.js";
import * as Utils from "./utils/functions.js";
import process from 'process';

const crawler = new SnapLensWebCrawler({ cacheTTL: 86400, maxRequestRetries: 1 });

const overwriteExistingBolts = false;
const overwriteExistingData = false;
const saveIncompleteLensInfo = true;

const inputFile = process.argv[2];
if (!inputFile) {
    console.error('No input file specified.');
    process.exit(1);
}

try {
    const entries = await Utils.readCSV(inputFile);
    if (entries) {

        // pass entries with UUID directly
        const lenses = entries.filter((entry) => (entry.uuid));
        if (lenses && lenses.length) {
            try {
                console.log(`[CSV]: Importing ${lenses.length} Lenses by UUID`);
                await Utils.crawlLenses(lenses, { crawler, overwriteExistingBolts, overwriteExistingData, saveIncompleteLensInfo });
            } catch (e) {
                console.error(e);
            }
        }

        // crawl entries with creator slugs
        const slugEntries = entries.filter((entry) => (entry.obfuscated_user_slug));
        if (slugEntries && slugEntries.length) {

            console.log(`[CSV]: Importing ${slugEntries.length} Creator slugs`);

            for (const index in slugEntries) {
                const creatorSlug = slugEntries[index].obfuscated_user_slug;
                const n = parseInt(index) + 1;
                try {
                    console.log(`[Select]: Creator slug (${n}/${slugEntries.length}) - ${creatorSlug}`);

                    const creatorLenses = await crawler.getAllLensesByCreator(creatorSlug);

                    console.log(`[Import]: ${creatorLenses.length} Lenses by Creator - ${creatorSlug}`);
                    await Utils.crawlLenses(creatorLenses, { crawler, overwriteExistingBolts, overwriteExistingData, saveIncompleteLensInfo });
                } catch (e) {
                    console.error(e);
                }
            }
        }

    }
} catch (e) {
    console.error(e);
}
