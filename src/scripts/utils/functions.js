import crypto from 'crypto';
import csv from 'csv-parser';
import fs from 'fs/promises';
import path from 'path';
import { createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import SnapLensWebCrawler from "../../crawler.js";

const defaultCrawler = new SnapLensWebCrawler();

const resolvedLensCache = new Map();

const boltBasePath = "./output/bolts/";
const infoBasePath = "./output/info/";

async function detectSeparator(filePath) {
    const separators = [',', ';', '\t', '|'];
    const data = await fs.readFile(filePath, 'utf8');
    const firstLine = data.split('\n')[0];

    return separators.find(sep => firstLine.includes(sep)) || ',';
}

async function readCSV(filePath) {
    const rows = [];
    try {
        const separator = await detectSeparator(filePath);
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
                    rows.push(cleanedRow);
                }
            }
        );
    } catch (e) {
        console.error(e);
    }

    return rows;
}

async function generateSha256(filePath) {
    const data = await fs.readFile(filePath);
    return crypto.createHash("sha256").update(data).digest("hex").toUpperCase();
}

function getLensInfoTemplate() {
    return Object.assign(defaultCrawler._formatLensItem({}), {
        lens_id: "",
        lens_url: "",
        lens_mirrored: "",
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

async function crawlLenses(lenses, { overwriteExistingBolts = false, overwriteExistingData = false, saveIncompleteLensInfo = false, crawler = null } = {}) {
    if (!(crawler instanceof SnapLensWebCrawler)) {
        crawler = defaultCrawler;
    }

    for (let lensInfo of lenses) {
        try {
            if (lensInfo.uuid) {
                if (resolvedLensCache.has(lensInfo.uuid)) {
                    continue;
                }

                const infoFolderPath = path.resolve(`${infoBasePath}${lensInfo.uuid}`);
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
                    const archivedLensInfo = await crawler.getLensByArchivedSnapshot(lensInfo.uuid);
                    if (archivedLensInfo) {
                        lensInfo = crawler.mergeLensItems(lensInfo, archivedLensInfo);

                        // mark the non-existence of archived snapshots (prevent unecessary re-crawl)
                        if (!archivedLensInfo.lens_url && archivedLensInfo.archived_snapshot_failures === 0) {
                            lensInfo.has_archived_snapshots = false;
                        }

                        // do not store failures
                        delete lensInfo.archived_snapshot_failures;
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
                    const boltFolderPath = path.resolve(`${boltBasePath}${lensInfo.uuid}`);
                    const lensFilePath = path.join(boltFolderPath, "lens.lns");
                    const sha256FilePath = path.join(boltFolderPath, "lens.sha256");
                    const sigFilePath = path.join(boltFolderPath, "lens.sig");

                    let boltFileExists = false;
                    try {
                        // check if file was previously downloaded
                        await fs.access(lensFilePath);
                        boltFileExists = true;
                    } catch { }

                    // check if file is does not exist
                    // otherwise overwrite existing file if flag is set
                    if (!boltFileExists || overwriteExistingBolts) {
                        try {
                            // actually download the lens bolt
                            if (await crawler.downloadFile(lensInfo.lens_url, lensFilePath)) {
                                boltFileExists = true;

                                // generate new file checksum
                                lensInfo.sha256 = await generateSha256(lensFilePath);
                            }
                        } catch (e) {
                            console.error(e);
                        }

                        if (boltFileExists) {
                            // write sha256 checksum to file
                            if (lensInfo.sha256) {
                                try {
                                    await fs.writeFile(sha256FilePath, lensInfo.sha256, "utf8");
                                } catch (e) {
                                    console.error(e);
                                }
                            }

                            // write signature to file
                            if (lensInfo.signature) {
                                try {
                                    await fs.writeFile(sigFilePath, lensInfo.signature, "utf8");
                                } catch (e) {
                                    console.error(e);
                                }
                            }
                        }
                    }
                    lensInfo.lens_mirrored = boltFileExists;
                } else {
                    // print warning for missing lens urls
                    console.warn("URL missing for lens", lensInfo.uuid);
                }

                // write lens info to json file
                if (lensInfo.lens_url || saveIncompleteLensInfo) {
                    try {
                        // use template to create uniform property order
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
            console.error("Error trying to process lens", lensInfo.uuid, e);
        }
    }
}

export { readCSV, crawlLenses };
