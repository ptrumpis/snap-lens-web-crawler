import crypto from 'crypto';
import csv from 'csv-parser';
import fs from 'fs/promises';
import path from 'path';
import { createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import RelayServer from '../../lib/relay.js';
import SnapLensWebCrawler from "../../lib/crawler.js";
import { CrawlerFailure, CrawlerNotFoundFailure } from '../../lib/failure.js';

const relayServer = new RelayServer();
const defaultCrawler = new SnapLensWebCrawler();

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

async function readTextFile(filePath) {
    const data = await fs.readFile(filePath, 'utf8');
    return data.split(/\r?\n/).filter(line => line.trim() !== '');
}

async function generateSha256(filePath) {
    const data = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(data).digest('hex').toUpperCase();
}

async function writeSha256ToFile(sha256, filePath) {
    if (sha256) {
        try {
            await fs.writeFile(filePath, sha256, 'utf8');
        } catch (e) {
            console.error(e);
        }
    }
}

async function writeSignatureToFile(signature, filePath) {
    if (signature) {
        try {
            await fs.writeFile(filePath, signature, 'utf8');
        } catch (e) {
            console.error(e);
        }
    }
}

function getLensInfoTemplate() {
    return Object.assign(defaultCrawler.formatLensItem({}), {
        lens_id: "",
        lens_url: "",
        signature: "",
        sha256: "",
        last_updated: "",
        is_mirrored: "",
    });
}

function isLensInfoMissing(lensInfo) {
    const isLensIdMissing = (!lensInfo.unlockable_id);
    const isLensNameMissing = (!lensInfo.lens_name);
    const isUserNameMissing = (!lensInfo.user_name && lensInfo.user_display_name !== 'Snapchat');
    const isCreatorTagsMissing = (lensInfo.lens_creator_search_tags?.length === 0 && lensInfo.has_search_tags !== false);

    return (isLensIdMissing || isLensNameMissing || isUserNameMissing || isCreatorTagsMissing);
}

async function crawlLenses(lenses, { queryRelayServer = true, retryBrokenDownloads = false, overwriteExistingBolts = false, overwriteExistingData = false, saveIncompleteLensInfo = false, crawler = null, resolvedLensCache = new Map() } = {}) {
    if (!(crawler instanceof SnapLensWebCrawler)) {
        crawler = defaultCrawler;
    }

    for (let lensInfo of lenses) {
        try {
            if (lensInfo.uuid) {
                lensInfo.uuid = lensInfo.uuid.toLowerCase();

                if (resolvedLensCache && resolvedLensCache.has(lensInfo.uuid)) {
                    continue;
                }

                const infoFolderPath = path.resolve(`${infoBasePath}${lensInfo.uuid}`);
                const infoFilePath = path.join(infoFolderPath, "lens.json");

                await fs.mkdir(infoFolderPath, { recursive: true });

                // read existing lens info from file
                let existingLensInfo = {};
                try {
                    const data = await fs.readFile(infoFilePath, 'utf8');
                    const lensUrl = lensInfo.lens_url;
                    const lensSig = lensInfo.signature;
                    const lastUpdated = lensInfo.last_updated;

                    existingLensInfo = JSON.parse(data);
                    if (existingLensInfo) {
                        if (overwriteExistingData) {
                            // keep latest information and overwrite existing data 
                            lensInfo = crawler.mergeLensItems(lensInfo, existingLensInfo);
                        } else {
                            // keep existing data and add missing information only
                            lensInfo = crawler.mergeLensItems(existingLensInfo, lensInfo);
                            lensInfo.uuid = lensInfo.uuid.toLowerCase();
                        }

                        // force lens url update if previous url has not been mirrored
                        if (existingLensInfo.lens_url && lensUrl && existingLensInfo.lens_url !== lensUrl && existingLensInfo.is_mirrored !== true) {
                            console.info(`[URL Replace] Replacing URL for Lens: ${lensInfo.uuid}`);

                            lensInfo.lens_url = lensUrl;
                            lensInfo.signature = lensSig || existingLensInfo.signature || "";
                            lensInfo.last_updated = lastUpdated || existingLensInfo.last_updated || "";
                            lensInfo.sha256 = "";
                            lensInfo.is_mirrored = "";
                            lensInfo.is_download_broken = "";
                        }
                    }
                } catch (err) {
                    if (err.code !== 'ENOENT') {
                        console.error(`Error trying to read ${infoFilePath}:`, err);
                    }
                }

                // try to resolve missing information from single page
                // lens URL's are no longer available
                if (isLensInfoMissing(lensInfo)) {
                    console.log(`[Crawling] https://lens.snapchat.com/${lensInfo.uuid}`);

                    const liveLensInfo = await crawler.getLensByHash(lensInfo.uuid);
                    if (!(liveLensInfo instanceof CrawlerFailure)) {
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
                    console.log(`[Wayback Machine] Trying to find lens: ${lensInfo.uuid}`);

                    const archivedLensInfo = await crawler.getLensByArchivedSnapshot(lensInfo.uuid);
                    if (!(archivedLensInfo instanceof CrawlerFailure)) {
                        lensInfo = crawler.mergeLensItems(lensInfo, archivedLensInfo);

                        // mark the non-existence of archived snapshots (prevent unecessary re-crawl)
                        if (!archivedLensInfo.lens_url && archivedLensInfo.archived_snapshot_failures.length === 0) {
                            lensInfo.has_archived_snapshots = false;
                        } else if (archivedLensInfo.snapshot) {
                            console.log(`[Found Snapshot] ${archivedLensInfo.uuid} - ${archivedLensInfo.snapshot.date}`);

                            // save reference
                            lensInfo.from_snapshot = archivedLensInfo.snapshot.url;
                        }

                        // do not store snapshot
                        delete lensInfo.snapshot;

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
                    lensInfo.deeplink = crawler.deeplinkUrl(lensInfo.uuid);
                }

                if (!lensInfo.snapcode_url) {
                    lensInfo.snapcode_url = crawler.snapcodeUrl(lensInfo.uuid);
                }

                if (!lensInfo.obfuscated_user_slug && queryRelayServer) {
                    const lens = await relayServer.getLens(lensInfo.lens_id);
                    if (lens && lens.obfuscated_user_slug) {
                        lensInfo.obfuscated_user_slug = lens.obfuscated_user_slug;
                    }
                }

                // download and write lens bolt to file and generate a checksum and signature file
                const boltFolderPath = path.resolve(`${boltBasePath}${lensInfo.uuid}`);
                const lensFilePath = path.join(boltFolderPath, "lens.lns");
                const zipFilePath = path.join(boltFolderPath, "lens.zip");

                const mirroredDownloadCondition = (lensInfo.is_mirrored !== true || overwriteExistingBolts);
                const brokenDownloadCondition = (lensInfo.is_download_broken !== true || retryBrokenDownloads);

                if (lensInfo.lens_url && mirroredDownloadCondition && brokenDownloadCondition) {
                    let boltFileExists = false;
                    try {
                        // check if file was previously downloaded
                        await fs.access(lensFilePath);
                        boltFileExists = true;
                    } catch { }

                    if (!boltFileExists || overwriteExistingBolts) {
                        try {
                            console.log(`[Downloading] ${lensInfo.lens_url}`);

                            // actually download the lens bolt
                            const downloadResult = await crawler.downloadFile(lensInfo.lens_url, lensFilePath);
                            if (downloadResult === true) {
                                boltFileExists = true;
                                lensInfo.sha256 = await generateSha256(lensFilePath);
                            } else if (downloadResult instanceof CrawlerNotFoundFailure) {
                                if (!boltFileExists) {
                                    // prevent unecessary re-download attempts
                                    lensInfo.is_download_broken = true;
                                }
                            }
                        } catch (e) {
                            console.error(e);
                        }

                        if (boltFileExists) {
                            await writeSha256ToFile(lensInfo.sha256, path.join(boltFolderPath, "lens.sha256"));
                            await writeSignatureToFile(lensInfo.signature, path.join(boltFolderPath, "lens.sig"));
                        }
                    }

                    // prevent re-downloading
                    lensInfo.is_mirrored = boltFileExists;
                }

                if (lensInfo.is_backed_up !== false && queryRelayServer) {
                    const unlock = await relayServer.getUnlock(lensInfo.lens_id);
                    if (unlock?.lens_url) {
                        const downloadUrl = unlock?.lens_url;

                        console.log(`[Downloading] ${downloadUrl}`);

                        const downloadResult = await crawler.downloadFile(downloadUrl, zipFilePath);
                        if (downloadResult === true) {
                            lensInfo.is_backed_up = true;
                            lensInfo.is_mirrored = true;

                            const sha256 = generateSha256(zipFilePath);
                            const sig = unlock.signature;

                            await writeSha256ToFile(sha256, path.join(boltFolderPath, "lens.original.sha256"));
                            await writeSignatureToFile(sig, path.join(boltFolderPath, "lens.original.sig"));
                        } else {
                            lensInfo.is_backed_up = false;
                        }
                    }
                }

                if (!lensInfo.lens_url && lensInfo.is_mirrored !== true) {
                    lensInfo.is_mirrored = false;
                    console.warn(`[Incomplete] URL missing for lens: ${lensInfo.uuid}`);
                }

                // write lens info to json file
                if (lensInfo.lens_url || lensInfo.is_mirrored || saveIncompleteLensInfo) {
                    try {
                        // use template to create uniform property order
                        lensInfo = crawler.mergeLensItems(lensInfo, getLensInfoTemplate());

                        if (JSON.stringify(lensInfo) !== JSON.stringify(existingLensInfo)) {
                            if (Object.keys(existingLensInfo).length === 0) {
                                console.log(`[Lens.json] Writing new info file: ${lensInfo.uuid}`);
                            } else {
                                console.log(`[Lens.json] Updating existing info file: ${lensInfo.uuid}`);
                            }

                            await fs.writeFile(infoFilePath, JSON.stringify(lensInfo, null, 2), 'utf8');
                        }
                    } catch (err) {
                        console.error(`Error trying to save ${infoFilePath}:`, err);
                    }
                }

                // mark lens as resolved for the current crawl iteration
                // since there are no more sources to query
                if (resolvedLensCache) {
                    resolvedLensCache.set(lensInfo.uuid, true);
                }
            } else {
                console.error(`Lens UUID is missing`, lensInfo);
            }
        } catch (e) {
            console.error(`Error trying to process lens: ${lensInfo.uuid}`, e);
        }
    }
}

export { readCSV, readTextFile, crawlLenses };
