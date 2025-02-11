import SnapLensWebCrawler from "../crawler.js";
import * as Utils from "./utils/functions.js";
import process from 'process';

const crawler = new SnapLensWebCrawler({ cacheTTL: 86400, maxRequestRetries: 1 });

const overwriteExistingBolts = false;
const overwriteExistingData = false;
const saveIncompleteLensInfo = true;

const urlRegex = /^(https?:\/\/)[^\s/$.?#].[^\s]*$/i;

const inputFile = process.argv[2];
if (!inputFile) {
    console.error('No input file specified.');
    process.exit(1);
}

try {
    const lines = await Utils.readTextFile(inputFile);
    if (lines && lines.length) {

        const urls = lines.filter(line => urlRegex.test(line));
        if (urls && urls.length) {
            try {
                for (const index in urls) {
                    const url = urls[index];
                    const n = parseInt(index) + 1;

                    const lenses = await crawler.getLensesFromUrl(url);
                    if (lenses && lenses.length) {
                        await Utils.crawlLenses(lenses, { crawler, overwriteExistingBolts, overwriteExistingData, saveIncompleteLensInfo });
                    }
                }
            } catch (e) {
                console.error(e);
            }
        }
    }
} catch (e) {
    console.error(e);
}
