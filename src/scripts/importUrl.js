import SnapLensWebCrawler from "../lib/crawler.js";
import * as Utils from "./utils/functions.js";
import process from 'process';

const crawler = new SnapLensWebCrawler({ cacheTTL: 86400, maxRequestRetries: 2 });
const resolvedLensCache = new Map();

const urlRegex = /^(https?:\/\/)[^\s/$.?#].[^\s]*$/i;

const inputFile = process.argv[2];
if (!inputFile) {
    console.error('No input file specified.');
    process.exit(1);
}

try {
    let lines = await Utils.readTextFile(inputFile);
    if (lines && lines.length) {
        let urls = lines.filter(line => urlRegex.test(line));

        lines.length = 0;
        lines = null;

        if (urls && urls.length) {
            console.log(`[Import URL] Importing ${urls.length} URL's from text file: '${inputFile}'`);

            for (const index in urls) {
                const url = urls[index];
                const n = parseInt(index) + 1;

                try {
                    console.log(`[Fetching] URL (${n}/${urls.length}): ${url}`);

                    let lenses = await crawler.getLensesFromUrl(url);
                    if (lenses && lenses.length) {
                        console.log(`[Resolving] ${lenses.length} Lenses from URL: ${url}`);

                        await Utils.crawlLenses(lenses, { crawler, resolvedLensCache });

                        console.log(`[Finished] ${lenses.length} Lenses from URL: ${url}`);
                        console.log(`-----`);

                        lenses.length = 0;
                        lenses = null;
                    }
                } catch (e) {
                    console.error(e);
                }

                if (n % 1000 === 0 && global.gc) {
                    global.gc();
                }
            }

            urls.length = 0;
            urls = null;
        }
    }
} catch (e) {
    console.error(e);
}

resolvedLensCache.clear();
crawler.destroy();
