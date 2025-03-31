import crypto from 'crypto';
import csv from 'csv-parser';
import fs from 'fs/promises';
import path from 'path';
import { createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import RelayServer from '../../lib/relay.js';
import SnapLensWebCrawler from "../../lib/crawler.js";
import { CrawlerFailure, CrawlerNotFoundFailure } from '../../lib/failure.js';

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
    try {
        const data = await fs.readFile(filePath);
        return crypto.createHash('sha256').update(data).digest('hex').toUpperCase();
    } catch (e) {
        console.error(e);
        return '';
    }
}

async function writeValueToFile(value, filePath) {
    if (value) {
        try {
            await fs.writeFile(filePath, value, 'utf8');
        } catch (e) {
            console.error(e);
        }
    }
}

function getLensInfoTemplate() {
    return Object.assign(SnapLensWebCrawler.formatLensItem({}), {
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

async function crawlLenses(lenses, { queryRelayServer = true, retryBrokenDownloads = false, overwriteExistingBolts = false, overwriteExistingData = false, saveIncompleteLensInfo = false, crawler = null, resolvedLensCache = null } = {}) {
    let destroyCrawler = false;
    let clearResolvedCache = false;

    if (!(crawler instanceof SnapLensWebCrawler)) {
        crawler = new SnapLensWebCrawler({ cacheTTL: 86400, maxRequestRetries: 2 });
        destroyCrawler = true;
    }

    if (!(resolvedLensCache instanceof Set)) {
        resolvedLensCache = new Set();
        clearResolvedCache = true;
    }

    const relayServer = new RelayServer({
        connectionTimeoutMs: crawler.getConnectionTimeout(),
        failedRequestDelayMs: crawler.getFailedRequestDelay(),
        maxRequestRetries: crawler.getMaxRequestRetries(),
        verbose: crawler.isVerbose()
    });

    for (let lensInfo of lenses) {
        try {
            if (lensInfo.uuid) {
                lensInfo.uuid = lensInfo.uuid.toLowerCase();

                if (resolvedLensCache && resolvedLensCache.has(lensInfo.uuid)) {
                    continue;
                }

                const infoFolderPath = path.resolve(`${infoBasePath}${lensInfo.uuid}`);
                const infoFilePath = path.join(infoFolderPath, "lens.json");

                // read existing lens info from file
                let existingLensInfo = {};
                try {
                    const data = await fs.readFile(infoFilePath, 'utf8');

                    existingLensInfo = JSON.parse(data);
                    if (existingLensInfo) {
                        if (existingLensInfo.lens_url && lensInfo.lens_url && existingLensInfo.lens_url !== lensInfo.lens_url && existingLensInfo.is_mirrored !== true) {
                            // keep latest information, overwrite existing data and reset download flags
                            console.info(`[URL Replace] Replacing URL for Lens: ${lensInfo.uuid}`);
                            lensInfo = SnapLensWebCrawler.mergeLensItems(lensInfo, existingLensInfo);
                            lensInfo.sha256 = "";
                            lensInfo.is_mirrored = "";
                            lensInfo.is_download_broken = "";
                        } else if (overwriteExistingData) {
                            // keep latest information and overwrite existing data 
                            lensInfo = SnapLensWebCrawler.mergeLensItems(lensInfo, existingLensInfo);
                        } else {
                            // keep existing data and add missing information only
                            lensInfo = SnapLensWebCrawler.mergeLensItems(existingLensInfo, lensInfo);
                            lensInfo.uuid = lensInfo.uuid.toLowerCase();
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
                        lensInfo = SnapLensWebCrawler.mergeLensItems(lensInfo, liveLensInfo);

                        // mark search tags as non existing (prevent unecessary re-crawl)
                        if (lensInfo.lens_creator_search_tags.length === 0) {
                            lensInfo.has_search_tags = false;
                        }
                    }
                }

                // try to resolve missing URL's from archived snapshots
                const queryArchiveCondition = (!lensInfo.lens_url && lensInfo.has_archived_snapshots !== false);
                if (queryArchiveCondition) {
                    console.log(`[Wayback Machine] Trying to find lens: ${lensInfo.uuid}`);

                    const archivedLensInfo = await crawler.getLensByArchivedSnapshot(lensInfo.uuid);
                    if (!(archivedLensInfo instanceof CrawlerFailure)) {
                        lensInfo = SnapLensWebCrawler.mergeLensItems(lensInfo, archivedLensInfo);

                        // mark the non-existence of archived snapshots (prevent unecessary re-crawl)
                        if (!archivedLensInfo.lens_url) {
                            lensInfo.has_archived_snapshots = false;
                        } else if (archivedLensInfo.snapshot) {
                            console.log(`[Found Snapshot] ${archivedLensInfo.uuid} - ${archivedLensInfo.snapshot.date}`);

                            // save reference
                            lensInfo.from_snapshot = archivedLensInfo.snapshot.url;
                        }

                        // do not store snapshot
                        delete lensInfo.snapshot;
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

                // unlock URL can be set manually
                if (!lensInfo.deeplink) {
                    lensInfo.deeplink = SnapLensWebCrawler.deeplinkUrl(lensInfo.uuid);
                }

                // snapcode URL can be set manually
                if (!lensInfo.snapcode_url) {
                    lensInfo.snapcode_url = SnapLensWebCrawler.snapcodeUrl(lensInfo.uuid);
                }

                // try to obtain rare creator slug
                if (!lensInfo.obfuscated_user_slug && lensInfo.lens_id && queryRelayServer) {
                    const relayLensInfo = await relayServer.getLens(lensInfo.lens_id);
                    if (relayLensInfo && relayLensInfo.obfuscated_user_slug) {
                        lensInfo.obfuscated_user_slug = relayLensInfo.obfuscated_user_slug;
                    }
                }

                const boltFolderPath = path.resolve(`${boltBasePath}${lensInfo.uuid}`);
                const lensFilePath = path.join(boltFolderPath, "lens.lns");
                const zipFilePath = path.join(boltFolderPath, "lens.zip");

                const mirrorDownloadCondition = (lensInfo.is_mirrored !== true || overwriteExistingBolts);
                const brokenDownloadCondition = (lensInfo.is_download_broken !== true || retryBrokenDownloads);

                // download and write lens bolt to file and generate a checksum and signature file
                if (lensInfo.lens_url && mirrorDownloadCondition && brokenDownloadCondition) {
                    let boltFileExists = false;
                    try {
                        // check if file is present for sha-256 generation
                        await fs.access(lensFilePath);
                        boltFileExists = true;
                    } catch { }

                    if ((!boltFileExists && lensInfo.is_mirrored !== true) || overwriteExistingBolts) {
                        console.log(`[Downloading] ${lensInfo.lens_url}`);

                        // actually download the lens bolt
                        const downloadResult = await crawler.downloadFile(lensInfo.lens_url, lensFilePath);
                        if (downloadResult === true) {
                            boltFileExists = true;
                            delete lensInfo.is_download_broken;
                        } else if (downloadResult instanceof CrawlerNotFoundFailure && !boltFileExists) {
                            // prevent unecessary re-download attempts
                            lensInfo.is_download_broken = true;
                        }
                    }

                    if (boltFileExists) {
                        // file needs to be present for sha-256 generation
                        lensInfo.sha256 = await generateSha256(lensFilePath);
                        await writeValueToFile(lensInfo.sha256, path.join(boltFolderPath, "lens.sha256"));
                        await writeValueToFile(lensInfo.signature, path.join(boltFolderPath, "lens.sig"));

                        lensInfo.is_mirrored = true;
                    }
                }

                // mark file as non-existent
                if (!lensInfo.lens_url || !lensInfo.is_mirrored) {
                    lensInfo.is_mirrored = false;
                }

                // try to get original lens and additional info from relay
                if (lensInfo.lens_id && queryRelayServer) {
                    let zipFileExists = false;
                    try {
                        // check if file is present for sha-256 generation
                        await fs.access(zipFilePath);
                        zipFileExists = true;
                    } catch { }

                    if (!lensInfo.lens_backup_url || !lensInfo.lens_original_signature || !lensInfo.is_backed_up) {
                        const unlock = await relayServer.getUnlock(lensInfo.lens_id);
                        if (unlock) {
                            lensInfo.lens_backup_url = unlock.lens_url || "";
                            lensInfo.lens_original_signature = unlock.signature || "";
                            lensInfo.hint_id = unlock.hint_id || "";
                            lensInfo.additional_hint_ids = unlock.additional_hint_ids || {};

                            if (unlock.lens_url && !zipFileExists && !lensInfo.is_backed_up) {
                                console.log(`[Downloading] ${unlock.lens_url}`);

                                if (await crawler.downloadFile(unlock.lens_url, zipFilePath) === true) {
                                    zipFileExists = true;
                                }
                            }
                        }
                    }

                    if (zipFileExists) {
                        // file needs to be present for sha-256 generation
                        lensInfo.lens_original_sha256 = await generateSha256(zipFilePath);
                        await writeValueToFile(lensInfo.lens_original_sha256, path.join(boltFolderPath, "lens.original.sha256"));
                        await writeValueToFile(lensInfo.lens_original_signature || "", path.join(boltFolderPath, "lens.original.sig"));

                        lensInfo.is_backed_up = true;
                    }
                }

                // write lens info to json file
                if (lensInfo.lens_url || lensInfo.is_mirrored || lensInfo.is_backed_up || saveIncompleteLensInfo) {
                    try {
                        // use template to create uniform property order
                        lensInfo = SnapLensWebCrawler.mergeLensItems(lensInfo, getLensInfoTemplate());

                        if (JSON.stringify(lensInfo) !== JSON.stringify(existingLensInfo)) {
                            if (Object.keys(existingLensInfo).length === 0) {
                                console.log(`[Lens.json] Writing new info file: ${lensInfo.uuid}`);
                            } else {
                                console.log(`[Lens.json] Updating existing info file: ${lensInfo.uuid}`);
                            }

                            await fs.mkdir(infoFolderPath, { recursive: true });
                            await fs.writeFile(infoFilePath, JSON.stringify(lensInfo, null, 2), 'utf8');
                        }
                    } catch (err) {
                        console.error(`Error trying to save ${infoFilePath}:`, err);
                    }
                }

                // mark lens as resolved for the current crawl iteration
                // since there are no more sources to query
                if (resolvedLensCache) {
                    resolvedLensCache.add(lensInfo.uuid);
                }
            } else {
                console.error(`Lens UUID is missing`, lensInfo);
            }
        } catch (e) {
            console.error(`Error trying to process lens: ${lensInfo.uuid}`, e);
        }

        lensInfo = null;
    }

    lenses = null;

    if (destroyCrawler) {
        crawler.destroy();
        crawler = null;
    }

    if (clearResolvedCache) {
        resolvedLensCache.clear();
        resolvedLensCache = null;
    }
}

export { readCSV, readTextFile, crawlLenses };
