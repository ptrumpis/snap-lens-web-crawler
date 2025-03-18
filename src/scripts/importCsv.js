import SnapLensWebCrawler from "../lib/crawler.js";
import * as Utils from "./utils/functions.js";
import process from 'process';

const crawler = new SnapLensWebCrawler({ cacheTTL: 86400, maxRequestRetries: 2 });
const resolvedLensCache = new Set();

const inputFile = process.argv[2];
if (!inputFile) {
    console.error('No input file specified.');
    process.exit(1);
}

try {
    let entries = await Utils.readCSV(inputFile);
    if (entries && entries.length) {
        // pass entries with UUID directly
        let lenses = entries.filter((entry) => (entry.uuid));
        if (lenses && lenses.length) {
            try {
                console.log(`[Import CSV] Importing ${lenses.length} Lenses by UUID from CSV file: '${inputFile}'`);

                await Utils.crawlLenses(lenses, { crawler, resolvedLensCache, saveIncompleteLensInfo: false });
            } catch (e) {
                console.error(e);
            }

            lenses.length = 0;
            lenses = null;
        }

        // crawl entries with creator slugs
        let slugEntries = entries.filter((entry) => (entry.obfuscated_user_slug));
        if (slugEntries && slugEntries.length) {
            console.log(`[Import CSV] Importing ${slugEntries.length} Creator slugs from CSV file: '${inputFile}'`);

            for (const index in slugEntries) {
                const creatorSlug = slugEntries[index].obfuscated_user_slug;
                const n = parseInt(index) + 1;

                try {
                    console.log(`[Fetching] Creator slug (${n}/${slugEntries.length}): ${creatorSlug}`);

                    let creatorLenses = await crawler.getLensesByCreator(creatorSlug);
                    if (creatorLenses && creatorLenses.length) {
                        console.log(`[Resolving] ${creatorLenses.length} Lenses by Creator (${n}/${slugEntries.length}): ${creatorSlug}`);

                        await Utils.crawlLenses(creatorLenses, { crawler, resolvedLensCache, saveIncompleteLensInfo: true });

                        console.log(`[Finished] ${creatorLenses.length} Lenses by Creator (${n}/${slugEntries.length}): ${creatorSlug}`);
                        console.log(`-----`);

                        creatorLenses.length = 0;
                        creatorLenses = null;
                    }
                } catch (e) {
                    console.error(e);
                }

                if (n % 1000 === 0 && global.gc) {
                    global.gc();
                }
            }

            slugEntries.length = 0;
            slugEntries = null;
        }

        entries.length = 0;
        entries = null;
    }
} catch (e) {
    console.error(e);
}

resolvedLensCache.clear();
crawler.destroy();
