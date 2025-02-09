import SnapLensWebCrawler from "../crawler.js";
import * as Utils from "./utils/functions.js";

const crawler = new SnapLensWebCrawler();

const overwriteExistingBolts = false;
const overwriteExistingData = false;
const saveIncompleteLensInfo = false;

for (const category in crawler.TOP_CATEGORIES) {
    console.log("[Select]: Top Lens Category", category.toUpperCase());

    try {
        const topLenses = await crawler.getTopLenses(category, null);
        if (topLenses) {
            await Utils.crawlLenses(topLenses, { overwriteExistingBolts, overwriteExistingData, saveIncompleteLensInfo });
        }
    } catch (e) {
        console.error(e);
    }
};
