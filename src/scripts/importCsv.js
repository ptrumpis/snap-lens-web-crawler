import * as Utils from "./utils/functions.js";
import process from 'process';

const overwriteExistingBolts = false;
const overwriteExistingData = false;
const saveIncompleteLensInfo = false;

const inputFile = process.argv[2];
if (!inputFile) {
    console.error('No input file specified.');
    process.exit(1);
}

try {
    const lenses = await Utils.readCSV(inputFile);
    if (lenses && lenses[0]?.lens_id && lenses[0]?.uuid) {
        await Utils.crawlLenses(lenses, { overwriteExistingBolts, overwriteExistingData, saveIncompleteLensInfo });
    }
} catch (e) {
    console.error(e);
}
