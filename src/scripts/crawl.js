import SnapLensWebCrawler from "../lib/crawler.js";
import * as Utils from "./utils/functions.js";

const crawler = new SnapLensWebCrawler({ maxRequestRetries: 2 });
const resolvedLensCache = new Set();

for (const category in crawler.TOP_CATEGORIES) {
    console.log(`[Fetching] Top Lens Category: ${category.toUpperCase()}`);

    try {
        let topLenses = await crawler.getTopLensesByCategory(category, null);
        if (topLenses && topLenses.length) {
            console.log(`[Resolving] ${topLenses.length} Lenses from Category: ${category.toUpperCase()}`);

            await Utils.crawlLenses(topLenses, { crawler, resolvedLensCache, queryRelayServer: false });

            console.log(`[Finished] ${topLenses.length} Lenses from Category: ${category.toUpperCase()}`);
            console.log(`-----`);

            topLenses.length = 0;
            topLenses = null;
        }
    } catch (e) {
        console.error(e);
    }
};

resolvedLensCache.clear();
crawler.destroy();
