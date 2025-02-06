import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import fetch from "node-fetch";
import SnapLensWebCrawler from "../crawler.js";

const crawler = new SnapLensWebCrawler();

const sleepMs = 10000;
const overwriteBolts = false;
const overwriteExistingData = false;

async function downloadFile(url, dest, timeout = 9000, headers) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: headers || {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
            }
        });

        if (!res.ok) throw new Error(`Failed to download ${url}, status: ${res.status}`);

        const buffer = await res.arrayBuffer();
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, Buffer.from(buffer));

    } catch (err) {
        console.error(`Error downloading ${url}:`, err);
    } finally {
        clearTimeout(timeoutId);
    }
}

async function generateSha256(filePath) {
    const data = await fs.readFile(filePath);
    return crypto.createHash("sha256").update(data).digest("hex").toUpperCase();
}

for (const category in crawler.TOP_CATEGORIES) {
    console.log("top lens category", category);

    try {
        const topLenses = await crawler.getTopLenses(category, null, sleepMs);
        if (topLenses) {
            for (let lensInfo of topLenses) {
                try {
                    if (lensInfo.uuid) {
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
                                    // update existing data with latest data
                                    lensInfo = crawler.mergeLensItems(lensInfo, existingInfo);
                                } else {
                                    // update missing information only
                                    lensInfo = crawler.mergeLensItems(existingInfo, lensInfo);
                                }
                            }
                        } catch (err) {
                            if (err.code !== "ENOENT") {
                                console.error(`Error trying to read ${infoFilePath}:`, err);
                            }
                        }

                        const isUserNameMissing = (!lensInfo.user_name && lensInfo.user_display_name !== 'Snapchat');
                        const isCreatorTagsMissing = (lensInfo.lens_creator_search_tags.length === 0 && lensInfo.has_search_tags !== false);

                        // try to resolve missing information from single page
                        if (!lensInfo.unlockable_id || isUserNameMissing || isCreatorTagsMissing) {
                            await crawler._sleep(3000);

                            const liveLensInfo = await crawler.getLensByHash(lensInfo.uuid);
                            if (liveLensInfo) {
                                lensInfo = crawler.mergeLensItems(lensInfo, liveLensInfo);
                            }
                        }

                        // try to resolve missing urls from cache
                        if (!lensInfo.lens_url) {
                            const cachedLensInfo = await crawler.getLensByCache(lensInfo.uuid);
                            if (cachedLensInfo) {
                                lensInfo = crawler.mergeLensItems(lensInfo, cachedLensInfo);
                            }
                        }

                        // mark search tags as non existing (prevent re-crawl)
                        if (lensInfo.lens_creator_search_tags.length === 0) {
                            lensInfo.has_search_tags = false;
                        }

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
                                    console.log(`Downloading: ${lensInfo.lens_url}`);
                                    await downloadFile(lensInfo.lens_url, lensFilePath);

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

                        try {
                            // write lens info to json file
                            await fs.writeFile(infoFilePath, JSON.stringify(lensInfo, null, 2), "utf8");
                        } catch (err) {
                            console.error(`Error trying to save ${infoFilePath}:`, err);
                        }
                    } else {
                        console.warn("Lens UUID is missing.", lensInfo);
                    }
                } catch (e) {
                    console.error("Error trying to process lens", lensInfo, e);
                }
            }
        }
    } catch (e) {
        console.error(e);
    }
};
