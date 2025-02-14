import SnapLensWebCrawler from "../crawler.js";
import * as Utils from "./utils/functions.js";

const crawler = new SnapLensWebCrawler();

const overwriteExistingBolts = false;
const overwriteExistingData = false;
const saveIncompleteLensInfo = false;

for (const category in crawler.TOP_CATEGORIES) {
    console.log(`[Fetching] Top Lens Category: ${category.toUpperCase()}`);

    try {
        const topLenses = await crawler.getTopLensesByCategory(category, null);
        if (topLenses && topLenses.length) {
            console.log(`[Resolving] ${topLenses.length} Lenses from Category: ${category.toUpperCase()}`);

            await Utils.crawlLenses(topLenses, { crawler, overwriteExistingBolts, overwriteExistingData, saveIncompleteLensInfo });
        }
    } catch (e) {
        console.error(e);
    }
};
