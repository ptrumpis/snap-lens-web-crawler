import SnapLensWebCrawler from "../crawler.js";
import * as Utils from "./utils/functions.js";
import process from 'process';

const crawler = new SnapLensWebCrawler({ cacheTTL: 86400, maxRequestRetries: 1 });

const overwriteExistingBolts = false;
const overwriteExistingData = false;
const saveIncompleteLensInfo = false;

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
            console.log(`[Import URL] Importing ${urls.length} URL's from text file: '${inputFile}'`);

            for (const index in urls) {
                const url = urls[index];
                const n = parseInt(index) + 1;

                try {
                    console.log(`[Fetching] URL (${n}/${urls.length}): ${url}`);

                    const lenses = await crawler.getLensesFromUrl(url);
                    if (lenses && lenses.length) {
                        console.log(`[Resolving] ${lenses.length} Lenses from URL: ${url}`);

                        await Utils.crawlLenses(lenses, { crawler, overwriteExistingBolts, overwriteExistingData, saveIncompleteLensInfo });

                        console.log(`[Finished] ${lenses.length} Lenses from URL: ${url}`);
                        console.log(`-----`);
                    }

                } catch (e) {
                    console.error(e);
                }
            }
        }
    }
} catch (e) {
    console.error(e);
}
