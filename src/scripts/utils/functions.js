import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import SnapLensWebCrawler from "../../crawler.js";

const crawler = new SnapLensWebCrawler();
let resolvedLensCache = new Map();

async function generateSha256(filePath) {
    const data = await fs.readFile(filePath);
    return crypto.createHash("sha256").update(data).digest("hex").toUpperCase();
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
                let existingInfo = null;
                try {
                    const data = await fs.readFile(infoFilePath, "utf8");
                    existingInfo = JSON.parse(data);
                    if (existingInfo) {
                        if (overwriteExistingData) {
                            // update existing data with latest information
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

                const isLensIdMissing = (!lensInfo.unlockable_id);
                const isUserNameMissing = (!lensInfo.user_name && lensInfo.user_display_name !== 'Snapchat');
                const isCreatorTagsMissing = (lensInfo.lens_creator_search_tags.length === 0 && lensInfo.has_search_tags !== false);

                // try to resolve missing information from single page
                if (isLensIdMissing || isUserNameMissing || isCreatorTagsMissing) {
                    const liveLensInfo = await crawler.getLensByHash(lensInfo.uuid);
                    if (liveLensInfo) {
                        lensInfo = crawler.mergeLensItems(lensInfo, liveLensInfo);

                        // mark search tags as non existing (prevent unecessary re-crawl)
                        if (lensInfo.lens_creator_search_tags.length === 0) {
                            lensInfo.has_search_tags = false;
                        }
                    }
                }

                // try to resolve missing urls from archived snapshots
                if (!lensInfo.lens_url && lensInfo.has_archived_snapshots !== false) {
                    const cachedLensInfo = await crawler.getLensByArchivedSnapshot(lensInfo.uuid);
                    if (cachedLensInfo) {
                        lensInfo = crawler.mergeLensItems(lensInfo, cachedLensInfo);

                        // mark the existance of archived snapshots (prevent unecessary re-crawl)
                        if (lensInfo.lens_url) {
                            lensInfo.has_archived_snapshots = true;
                        } else {
                            lensInfo.has_archived_snapshots = false;
                        }
                    }
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
                            await crawler.downloadFile(lensInfo.lens_url, lensFilePath);

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
                        await fs.writeFile(infoFilePath, JSON.stringify(lensInfo, null, 2), "utf8");
                    } catch (err) {
                        console.error(`Error trying to save ${infoFilePath}:`, err);
                    }
                }

                // TODO: store uuid, user_name, tags, lens_name for further crawling
            } else {
                console.warn("Lens UUID is missing.", lensInfo);
            }
        } catch (e) {
            console.error("Error trying to process lens", lensInfo, e);
        }
    }
}

export { crawlLenses };
