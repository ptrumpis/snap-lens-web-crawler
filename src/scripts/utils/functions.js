import crypto from 'crypto';
import csv from 'csv-parser';
import fs from 'fs/promises';
import path from 'path';
import { createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import SnapLensWebCrawler from "../../crawler.js";

const crawler = new SnapLensWebCrawler();
let resolvedLensCache = new Map();

async function detectSeparator(filePath) {
    const separators = [',', ';', '\t', '|'];
    const data = await fs.readFile(filePath, 'utf8');
    const firstLine = data.split('\n')[0];

    return separators.find(sep => firstLine.includes(sep)) || ',';
}

async function readCSV(filePath) {
    const separator = await detectSeparator(filePath);
    const results = [];
    await pipeline(
        createReadStream(filePath, { encoding: 'utf8' })
            .pipe(csv({
                // remove UTF-8 BOM
                mapHeaders: ({ header, index }) => header.trim().toLowerCase(),
                separator: separator,
            })),
        async function* (source) {
            for await (const row of source) {
                const cleanedRow = Object.fromEntries(
                    Object.entries(row).map(([key, value]) => [key.trim(), value.trim()])
                );
                results.push(cleanedRow);
            }
        }
    );
    return results;
}

async function generateSha256(filePath) {
    const data = await fs.readFile(filePath);
    return crypto.createHash("sha256").update(data).digest("hex").toUpperCase();
}

function getLensInfoTemplate() {
    return Object.assign(crawler._formatLensItem({}), {
        lens_id: "",
        lens_url: "",
        signature: "",
        sha256: "",
        last_updated: ""
    });
}

function isLensInfoMissing(lensInfo) {
    const isLensIdMissing = (!lensInfo.unlockable_id);
    const isLensNameMissing = (!lensInfo.lens_name);
    const isUserNameMissing = (!lensInfo.user_name && lensInfo.user_display_name !== 'Snapchat');
    const isCreatorTagsMissing = (lensInfo.lens_creator_search_tags?.length === 0 && lensInfo.has_search_tags !== false);

    return (isLensIdMissing || isLensNameMissing || isUserNameMissing || isCreatorTagsMissing);
}

async function crawlLenses(lenses, { overwriteBolts = false, overwriteExistingData = false, saveIncompleteLensInfo = false } = {}) {
    for (let lensInfo of lenses) {
        try {
            if (lensInfo.uuid) {
                if (resolvedLensCache.has(lensInfo.uuid)) {
                    continue;
                }

                const infoFolderPath = path.resolve(`./output/info/${lensInfo.uuid}`);
                const infoFilePath = path.join(infoFolderPath, "lens.json");

                await fs.mkdir(infoFolderPath, { recursive: true });

                // read existing lens info from file
                try {
                    const data = await fs.readFile(infoFilePath, "utf8");

                    const existingInfo = JSON.parse(data);
                    if (existingInfo) {
                        if (overwriteExistingData) {
                            // keep latest information and overwrite existing data 
                            lensInfo = crawler.mergeLensItems(lensInfo, existingInfo);
                        } else {
                            // keep existing data and add missing information only
                            lensInfo = crawler.mergeLensItems(existingInfo, lensInfo);
                        }
                    }
                } catch (err) {
                    if (err.code !== "ENOENT") {
                        console.error(`Error trying to read ${infoFilePath}:`, err);
                    }
                }

                // try to resolve missing information from single page
                // lens URL's are no longer available
                if (isLensInfoMissing(lensInfo)) {
                    const liveLensInfo = await crawler.getLensByHash(lensInfo.uuid);
                    if (liveLensInfo) {
                        lensInfo = crawler.mergeLensItems(lensInfo, liveLensInfo);

                        // mark search tags as non existing (prevent unecessary re-crawl)
                        if (lensInfo.lens_creator_search_tags.length === 0) {
                            lensInfo.has_search_tags = false;
                        }
                    }
                }

                // try to resolve missing URL's from archived snapshots
                const isLensUrlMissing = (!lensInfo.lens_url && lensInfo.has_archived_snapshots !== false);
                if (isLensUrlMissing) {
                    const cachedLensInfo = await crawler.getLensByArchivedSnapshot(lensInfo.uuid);
                    if (cachedLensInfo) {
                        lensInfo = crawler.mergeLensItems(lensInfo, cachedLensInfo);

                        // mark the existance of archived snapshots (prevent unecessary re-crawl)
                        if (cachedLensInfo.lens_url) {
                            lensInfo.has_archived_snapshots = true;
                        } else {
                            lensInfo.has_archived_snapshots = false;
                        }
                    }
                }

                // fix missing lens ID
                if (!lensInfo.lens_id && lensInfo.unlockable_id) {
                    lensInfo.lens_id = lensInfo.unlockable_id;
                }

                // fix missing unlockable ID
                if (!lensInfo.unlockable_id && lensInfo.lens_id) {
                    lensInfo.unlockable_id = lensInfo.lens_id;
                }

                // unlock URL and snapcode URL can be set manually
                if (!lensInfo.deeplink) {
                    lensInfo.deeplink = crawler._deeplinkUrl(lensInfo.uuid);
                }

                if (!lensInfo.snapcode_url) {
                    lensInfo.snapcode_url = crawler._snapcodeUrl(lensInfo.uuid);
                }

                // mark lens as resolved for the current crawl iteration since there are no more sources to query
                resolvedLensCache.set(lensInfo.uuid, true);

                // download and write lens bolt to file and generate a checksum and signature file
                if (lensInfo.lens_url) {
                    const boltFolderPath = path.resolve(`./output/bolts/${lensInfo.uuid}`);
                    const lensFilePath = path.join(boltFolderPath, "lens.lns");
                    const sha256FilePath = path.join(boltFolderPath, "lens.sha256");
                    const sigFilePath = path.join(boltFolderPath, "lens.sig");

                    let fileExists = false;
                    try {
                        // check if file was previously downloaded
                        await fs.access(lensFilePath);
                        fileExists = true;
                    } catch { }

                    // check if file is does not exist otherwise overwrite existing file if flag is set
                    if (!fileExists || overwriteBolts) {
                        await crawler._sleep(1000);

                        try {
                            // actually download the lens bolt
                            const downloadSuccess = await crawler.downloadFile(lensInfo.lens_url, lensFilePath);
                            if (downloadSuccess) {
                                // generate file checksum and write to file
                                const generatedSha256 = await generateSha256(lensFilePath);
                                await fs.writeFile(sha256FilePath, generatedSha256, "utf8");

                                // show warning if checksum is mismatching with crawled info
                                if (lensInfo.sha256 && lensInfo.sha256.toUpperCase() !== generatedSha256) {
                                    console.warn(`SHA256 mismatch for bolt ${lensInfo.uuid}: expected ${lensInfo.sha256}, got ${generatedSha256}`);

                                    // update lens info with actual checksum on mismatch
                                    lensInfo.sha256 = generatedSha256;
                                }

                                // write signature to file
                                if (lensInfo.signature) {
                                    await fs.writeFile(sigFilePath, lensInfo.signature, "utf8");
                                }
                            }
                        } catch (e) {
                            console.error(e);
                        }
                    }
                } else {
                    // print warning for missing lens urls
                    console.warn("URL missing for lens", lensInfo.uuid);
                }

                // write lens info to json file
                if (lensInfo.lens_url || saveIncompleteLensInfo) {
                    try {
                        lensInfo = crawler.mergeLensItems(lensInfo, getLensInfoTemplate());

                        await fs.writeFile(infoFilePath, JSON.stringify(lensInfo, null, 2), "utf8");
                    } catch (err) {
                        console.error(`Error trying to save ${infoFilePath}:`, err);
                    }
                }
            } else {
                console.warn("Lens UUID is missing.", lensInfo);
            }
        } catch (e) {
            console.error("Error trying to process lens", lensInfo, e);
        }
    }
}

export { readCSV, crawlLenses };
