import * as cheerio from 'cheerio';
import fs from 'fs/promises';
import path from 'path';
import HTTPStatusError from './error.js';
import { CrawlerFailure, CrawlerInvalidUrlFailure, CrawlerJsonFailure, CrawlerJsonParseFailure, CrawlerJsonStructureFailure, CrawlerRequestFailure, CrawlerRequestErrorFailure, CrawlerRequestTimeoutFailure, CrawlerHTTPStatusFailure, CrawlerNotFoundFailure } from './failure.js';

class SnapLensWebCrawler {
    TOP_CATEGORIES = {
        default: '/',
        face: '/category/face',
        world: '/category/world',
        music: '/category/music',
        live: '/category/web_live',
    };

    #SCRIPT_SELECTOR = '#__NEXT_DATA__';

    // snapshots before this date will not work
    #SNAPSHOT_THRESHOLD_MIN = 20220101000000;

    // snapshots from 2025 will not work
    #SNAPSHOT_THRESHOLD_MAX = 20241231235959;

    // try to get snapshots from 2022-2024
    #SNAPSHOT_TIMESTAMP = 20230601;

    #connectionTimeoutMs;
    #minRequestDelayMs;
    #failedRequestDelayMs;
    #maxRequestRetries;
    #headers;
    #lastRequestTimestamps = new Map();
    #jsonCache = new Map();
    #cacheTTL;
    #gcInterval;
    #cleanupInterval;

    constructor({
        connectionTimeoutMs = 9000,
        minRequestDelayMs = 500,
        cacheTTL = 3600,
        gcInterval = 3600,
        failedRequestDelayMs = 4500,
        maxRequestRetries = 2,
        headers = null
    } = {}) {
        this.#connectionTimeoutMs = Math.max(connectionTimeoutMs, 1000);
        this.#minRequestDelayMs = Math.max(minRequestDelayMs, 100);
        this.#failedRequestDelayMs = Math.max(failedRequestDelayMs, this.#minRequestDelayMs);
        this.#maxRequestRetries = Math.max(maxRequestRetries, 0);
        this.#headers = headers || {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
        };

        this.#cacheTTL = cacheTTL ? Math.max(parseInt(cacheTTL) * 1000, 60 * 1000) : 0;
        this.#gcInterval = Math.max(parseInt(gcInterval) * 1000, 5 * 60 * 1000);

        this.#cleanupInterval = setInterval(() => { this.#cleanupCache() }, this.#gcInterval).unref();
    }

    destroy() {
        clearInterval(this.#cleanupInterval);
        this.#lastRequestTimestamps.clear();
        this.#jsonCache.clear();
    }

    async downloadFile(url, dest) {
        try {
            const response = await this.#requestGently(url, 'GET');
            if (response instanceof CrawlerFailure) {
                return response;
            }

            if (response?.ok) {
                const buffer = await response.arrayBuffer();
                await fs.mkdir(path.dirname(dest), { recursive: true });
                await fs.writeFile(dest, Buffer.from(buffer));

                return true;
            }
        } catch (e) {
            console.error(e);
            return CrawlerFailure(e.message, url);
        }

        return false;
    }

    mergeLensItems(item1, item2) {
        function isEmpty(value) {
            return (!value && value !== false) ||
                (Array.isArray(value) && value.length === 0) ||
                (typeof value === 'object' && value !== null && Object.keys(value).length === 0);
        }

        let merged = { ...item2, ...item1 };

        for (let key in merged) {
            if (isEmpty(item1[key]) && !isEmpty(item2[key])) {
                merged[key] = item2[key];
            }
        }

        return merged;
    }

    formatLensItem(lensItem, options = {}) {
        const { obfuscatedSlug = '', userName = '', hash = '', unlockableId = '' } = options;

        const deeplinkUrl = lensItem.deeplinkUrl || lensItem.unlockUrl || "";
        const uuid = lensItem.scannableUuid || this.#extractUuidFromDeeplink(deeplinkUrl) || hash || "";
        const lensId = lensItem.lensId || lensItem.id || unlockableId || "";

        let result = {
            //lens
            unlockable_id: lensId,
            uuid: uuid,
            deeplink: deeplinkUrl || this.deeplinkUrl(uuid) || "",
            snapcode_url: lensItem.snapcodeUrl || this.snapcodeUrl(uuid) || "",

            lens_name: lensItem.lensName || lensItem.name || "",
            lens_creator_search_tags: lensItem.lensCreatorSearchTags || [],
            lens_status: "Live",

            user_display_name: lensItem.lensCreatorDisplayName || lensItem.creator?.title || lensItem.creatorName || "",
            user_name: lensItem.lensCreatorUsername || userName || "",
            user_profile_url: lensItem.userProfileUrl || this.profileUrl(lensItem.lensCreatorUsername || userName) || "",
            user_id: lensItem.creatorUserId || "",
            user_profile_id: lensItem.creatorProfileId || "",
            obfuscated_user_slug: obfuscatedSlug || "",

            icon_url: lensItem.iconUrl || "",
            thumbnail_media_url: lensItem.thumbnailUrl || lensItem.previewImageUrl || lensItem.lensPreviewImageUrl || "",
            thumbnail_media_poster_url: lensItem.thumbnailUrl || lensItem.previewImageUrl || lensItem.lensPreviewImageUrl || "",
            standard_media_url: lensItem.previewVideoUrl || lensItem.lensPreviewVideoUrl || "",
            image_sequence: {},
        };

        if (lensItem.thumbnailSequence) {
            result.image_sequence = {
                url_pattern: lensItem.thumbnailSequence?.urlPattern || "",
                size: lensItem.thumbnailSequence?.numThumbnails || 0,
                frame_interval_ms: lensItem.thumbnailSequence?.animationIntervalMs || 0
            }
        }

        //unlock
        if (lensItem.lensResource) {
            Object.assign(result, {
                lens_id: lensId || "",
                lens_url: lensItem.lensResource?.archiveLink || "",
                signature: lensItem.lensResource?.signature || "",
                sha256: lensItem.lensResource?.checkSum || "",
                last_updated: lensItem.lensResource?.lastUpdated || ""
            });
        }

        return result;
    }

    profileUrl(username) {
        if (typeof username === 'string' && username) {
            return `https://www.snapchat.com/add/${username}`;
        }
        return '';
    }

    snapcodeUrl(uuid) {
        if (typeof uuid === 'string' && uuid) {
            return `https://app.snapchat.com/web/deeplink/snapcode?data=${uuid}&version=1&type=png`;
        }
        return '';
    }

    deeplinkUrl(uuid) {
        if (typeof uuid === 'string' && uuid) {
            return `https://snapchat.com/unlock/?type=SNAPCODE&uuid=${uuid}&metadata=01`;
        }
        return '';
    }

    async getLensByHash(hash) {
        return await this.#getSingleLens(`https://lens.snapchat.com/${hash}`, { hash });
    }

    async getMoreLensesByHash(hash) {
        return await this.#getMoreLenses(`https://lens.snapchat.com/${hash}`, { hash })
    }

    async getLensesByUsername(userName) {
        return await this.#getUserLenses(`https://www.snapchat.com/add/${userName}`, { userName });
    }

    async getLensesByCreator(obfuscatedSlug, maxLenses = 1000) {
        const lenses = [];

        for (let offset = 0; offset < maxLenses; offset += 100) {
            const limit = Math.min(maxLenses - offset, 100);
            const result = await this.#getLensesByCreator(obfuscatedSlug, offset, limit);
            if (result instanceof CrawlerFailure) {
                break;
            }

            lenses.push(...result);
            if (result.length < 100) {
                break;
            }
        }

        return lenses;
    }

    async getTopLensesByCategory(category = 'default', maxLenses = 100) {
        if (!this.TOP_CATEGORIES[category]) {
            console.error(`Unknown top lens category: ${category} \nValid top lens categories are:`, Object.getOwnPropertyNames(this.TOP_CATEGORIES));
            return [];
        }

        return await this.#getTopLenses(`https://www.snapchat.com/lens${this.TOP_CATEGORIES[category]}`, maxLenses);
    }

    async searchLenses(search) {
        const slug = search.replace(/\W+/g, '-');

        const pageProps = await this.#crawlJsonFromUrl(`https://www.snapchat.com/explore/${slug}`, "props.pageProps");
        if (pageProps instanceof CrawlerFailure) {
            return pageProps;
        }

        return this.#handleSearchResults(pageProps);
    }

    async getLensByArchivedSnapshot(hash) {
        const lensUrls = [
            `lens.snapchat.com/${hash}*`,
            `snapchat.com/lens/${hash}*`,
        ];

        let lens = {};
        let failures = [];
        try {
            for (const index in lensUrls) {
                const targetUrl = lensUrls[index];

                const snapshot = await this.#queryArchivedSnapshot(targetUrl);
                if (snapshot instanceof CrawlerFailure) {
                    failures.push(snapshot);
                    continue;
                } else if (!(snapshot instanceof ArchivedSnapshot)) {
                    continue;
                }

                let snapshotLens = await this.#getSingleLens(snapshot.url, { hash });
                if (snapshotLens) {
                    snapshotLens = this.#fixArchiveUrlPrefixes(snapshotLens);

                    lens = this.mergeLensItems(snapshotLens, lens);
                    if (lens.lens_url) {
                        lens.snapshot = snapshot;
                        break;
                    }
                }
            }

            // let caller know about failures
            lens.archived_snapshot_failures = failures;

            return lens;
        } catch (e) {
            console.error(e);
            return new CrawlerFailure(e.message, url);
        }
    }

    async getLensesFromUrl(url, lensDefaults = {}) {
        try {
            const pageProps = await this.#crawlJsonFromUrl(url, "props.pageProps");
            if (pageProps instanceof CrawlerFailure) {
                return pageProps;
            }

            const sources = [
                pageProps.lensDisplayInfo,
                pageProps.moreLenses,
                pageProps.lenses,
                pageProps.topLenses
            ];

            const lenses = sources
                .flatMap(source => Array.isArray(source) ? source : [source])
                .filter(Boolean)
                .map(lens => this.formatLensItem(lens, lensDefaults));

            return lenses
                .concat(this.#handleSearchResults(pageProps, lensDefaults))
                .map(lens => this.#fixArchiveUrlPrefixes(lens));
        } catch (e) {
            console.error(e);
            return new CrawlerFailure(e.message, url);
        }
    }

    async #getSingleLens(url, lensDefaults = {}) {
        try {
            const lens = await this.#crawlJsonFromUrl(url, "props.pageProps.lensDisplayInfo");
            if (lens instanceof CrawlerFailure) {
                return lens;
            }

            return this.formatLensItem(lens, lensDefaults);
        } catch (e) {
            console.error(e);
            return new CrawlerFailure(e.message, url);
        }
    }

    async #getMoreLenses(url, lensDefaults = {}) {
        try {
            const lenses = await this.#crawlJsonFromUrl(url, "props.pageProps.moreLenses");
            if (lenses instanceof CrawlerFailure) {
                return lenses;
            }

            return lenses.map(lens => this.formatLensItem(lens, lensDefaults));
        } catch (e) {
            console.error(e);
            return new CrawlerFailure(e.message, url);
        }
    }

    async #getUserLenses(url, lensDefaults = {}) {
        try {
            const lenses = await this.#crawlJsonFromUrl(url, "props.pageProps.lenses");
            if (lenses instanceof CrawlerFailure) {
                return lenses;
            }

            return lenses.map(lens => this.formatLensItem(lens, lensDefaults));
        } catch (e) {
            console.error(e);
            return new CrawlerFailure(e.message, url);
        }
    }

    async #getLensesByCreator(obfuscatedSlug, offset = 0, limit = 100) {
        const maxLenses = Math.min(100, limit);
        const url = `https://lensstudio.snapchat.com/v1/creator/lenses/?limit=${maxLenses}&offset=${offset}&order=1&slug=${obfuscatedSlug}`;

        try {
            const lensesList = await this.#getJsonFromUrl(url, "lensesList", { retryNotFound: true });
            if (lensesList instanceof CrawlerFailure) {
                return lensesList;
            }

            return (lensesList || [])
                .filter(item => item.lensId && item.deeplinkUrl && item.name && item.creatorName)
                .map(item => this.formatLensItem(item, { obfuscatedSlug }));
        } catch (e) {
            console.error(e);
            return new CrawlerFailure(e.message, url);
        }
    }

    async #getTopLenses(url, maxLenses = 100, lensDefaults = {}) {
        const lenses = [];
        const currentUrl = new URL(url);
        const shouldLimit = Number.isInteger(maxLenses) && maxLenses > 0;

        try {
            while (!shouldLimit || lenses.length < maxLenses) {
                const pageProps = await this.#crawlJsonFromUrl(currentUrl.toString(), "props.pageProps", { retryNotFound: true });
                if (!pageProps?.topLenses) {
                    break;
                }

                let newLenses = pageProps.topLenses;
                if (shouldLimit && lenses.length < maxLenses) {
                    const remaining = maxLenses - lenses.length;
                    newLenses = newLenses.slice(0, Math.max(0, remaining));
                }

                newLenses.forEach(lens => lenses.push(this.formatLensItem(lens, lensDefaults)));

                if (!pageProps.hasMore || !pageProps.nextCursorId) {
                    break;
                }

                currentUrl.searchParams.set("cursor_id", pageProps.nextCursorId);
            }
        } catch (e) {
            console.error(e);
        }

        return lenses;
    }

    #handleSearchResults(pageProps, lensDefaults = {}) {
        if (!pageProps) {
            return [];
        }

        try {
            if (typeof pageProps.initialApolloState === "object") {
                return Object.values(pageProps.initialApolloState)
                    .filter(item => item.id && item.deeplinkUrl && item.lensName)
                    .map(lens => this.formatLensItem(lens, lensDefaults));
            }

            if (typeof pageProps.encodedSearchResponse === "string") {
                // new data structure introduced in summer 2024
                const searchResult = JSON.parse(pageProps.encodedSearchResponse);
                const lensSection = searchResult.sections.find(section => section.title === "Lenses");

                return (lensSection?.results || [])
                    .map(entry => entry?.result?.lens)
                    .filter(lens => lens?.lensId && lens.deeplinkUrl && lens.name)
                    .map(lens => this.formatLensItem(lens, lensDefaults));
            }
        } catch (e) {
            console.error(e);
        }

        return [];
    }

    async #queryArchivedSnapshot(url) {
        const apiUrl = `https://archive.org/wayback/available?timestamp=${this.#SNAPSHOT_TIMESTAMP}&url=${encodeURIComponent(url)}`;

        const result = await this.#getJsonFromUrl(apiUrl, "archived_snapshots");
        if (result instanceof CrawlerFailure) {
            return result;
        }

        if (!result.closest?.url || !result.closest?.timestamp) {
            // snapshot does not exist
            return null;
        }

        const snapshotTime = parseInt(result.closest.timestamp) || 0;
        if (snapshotTime < this.#SNAPSHOT_THRESHOLD_MIN || snapshotTime > this.#SNAPSHOT_THRESHOLD_MAX) {
            // snapshot exists but does not match criteria
            return null;
        }

        try {
            const snapshotUrl = new URL(result.closest.url);
            return new ArchivedSnapshot(snapshotUrl.toString(), this.#archiveTimestampToDateString(snapshotTime));
        } catch (e) {
            console.error(`[Error] Invalid Snapshot URL: ${url} - ${e.message}`);
            return new CrawlerInvalidUrlFailure(e.message, url);
        }
    }

    async #crawlJsonFromUrl(url, jsonPropertyPath, options = {}) {
        const jsonObj = this.#getJsonCache(url);
        if (typeof jsonObj !== 'undefined') {
            return this.#getProperty(jsonObj, jsonPropertyPath, url);
        }

        try {
            const body = await this.#loadUrl(url, options);
            if (body instanceof CrawlerFailure) {
                return body;
            }

            if (typeof body === 'string' && body.trim().length === 0) {
                console.error(`[Crawl Error] ${url} - Empty HTML body received`);
                return new CrawlerFailure('Empty HTML body received', url);
            }

            const $ = cheerio.load(body);

            const jsonString = $(this.#SCRIPT_SELECTOR).text();
            if (typeof jsonString !== 'string' || !jsonString) {
                console.error(`[Crawl Error] ${url} - Unable to read script tag: ${this.#SCRIPT_SELECTOR}`);
                return CrawlerFailure(`Unable to read script tag: ${this.#SCRIPT_SELECTOR}`, url);
            }

            try {
                const parsedJson = JSON.parse(jsonString);
                if (parsedJson) {
                    this.#setJsonCache(url, parsedJson);
                }

                return this.#getProperty(parsedJson, jsonPropertyPath, url);
            } catch (e) {
                if (e.name === 'SyntaxError') {
                    console.error(`[JSON Error] ${url} - ${e.message}`);
                    return new CrawlerJsonParseFailure(e.message, jsonString, url);
                } else {
                    console.error(`[Error] ${url}`, e);
                    return new CrawlerJsonFailure(e.message, jsonString, url);
                }
            }
        } catch (e) {
            console.error(e);
            return new CrawlerFailure(e.message, url);
        }
    }

    async #getJsonFromUrl(url, jsonPropertyPath, options = {}) {
        const jsonObj = this.#getJsonCache(url);
        if (typeof jsonObj !== 'undefined') {
            return this.#getProperty(jsonObj, jsonPropertyPath, url);
        }

        try {
            const jsonString = await this.#loadUrl(url, options);
            if (jsonString instanceof CrawlerFailure) {
                return jsonString;
            }

            try {
                const parsedJson = JSON.parse(jsonString);
                if (parsedJson) {
                    this.#setJsonCache(url, parsedJson);
                }

                return this.#getProperty(parsedJson, jsonPropertyPath, url);
            } catch (e) {
                if (e.name === 'SyntaxError') {
                    console.error(`[JSON Error] ${url} - ${e.message}`);
                    return new CrawlerJsonParseFailure(e.message, jsonString, url);
                } else {
                    console.error(`[Error] ${url}`, e);
                    return new CrawlerJsonFailure(e.message, jsonString, url);
                }
            }
        } catch (e) {
            console.error(e);
            return new CrawlerFailure(e.message, url);
        }
    }

    async #loadUrl(url, options = {}) {
        try {
            const response = await this.#requestGently(url, 'GET', options);
            if (response?.ok) {
                return await response.text();
            }

            return response;
        } catch (e) {
            console.error(e);
            return new CrawlerFailure(e.message, url);
        }
    }

    async #requestGently(url, method = 'GET', options = {}) {
        let hostname = null;

        try {
            hostname = new URL(url).hostname;
        } catch (e) {
            console.error(`[Error] Invalid URL: ${url} - ${e.message}`);
            return new CrawlerInvalidUrlFailure(e.message, url);
        }

        try {
            const now = Date.now();

            if (this.#lastRequestTimestamps.has(hostname)) {
                const lastRequestTime = this.#lastRequestTimestamps.get(hostname);
                const elapsed = now - lastRequestTime;
                if (elapsed < this.#minRequestDelayMs) {
                    await this.#sleep(this.#minRequestDelayMs - elapsed);
                }
            }

            return await this.#request(url, method, options);
        } catch (e) {
            console.error(e);
            return new CrawlerFailure(e.message, url);
        }
    }

    async #request(url, method = 'GET', { retryNotFound = false, retryFailed = true, retryTimeout = true, retryError = true } = {}) {
        const maxAttempts = this.#maxRequestRetries + 1;
        let attempt = 1;
        let hostname = null;

        try {
            hostname = new URL(url).hostname;
        } catch (e) {
            console.error(`[Error] Invalid URL: ${url} - ${e.message}`);
            return new CrawlerInvalidUrlFailure(e.message, url);
        }

        let crawlerFailure = undefined;
        while (attempt <= maxAttempts) {
            const controller = new AbortController();
            const timeout = setTimeout(() => {
                controller.abort();
            }, this.#connectionTimeoutMs);

            try {
                this.#lastRequestTimestamps.set(hostname, Date.now());

                const response = await fetch(url, { method: method, signal: controller.signal, headers: this.#headers });
                clearTimeout(timeout);

                if (response?.ok) {
                    return response;
                }

                throw new HTTPStatusError(response?.status);
            } catch (e) {
                const retryStatus = `(${attempt}/${maxAttempts})`;
                if (e instanceof HTTPStatusError) {
                    if (e.code == 404) {
                        crawlerFailure = new CrawlerNotFoundFailure(e.message, e.code, url, crawlerFailure);
                        if (retryNotFound === true) {
                            console.error(`[Not Found] ${retryStatus} ${url} - ${e.message}`);
                        } else {
                            console.error(`[Not Found] ${url} - ${e.message}`);
                            break;
                        }
                    } else {
                        crawlerFailure = new CrawlerHTTPStatusFailure(e.message, e.code, url, crawlerFailure);
                        if (retryFailed === true) {
                            console.error(`[Failed] ${retryStatus} ${url} - ${e.message}`);
                        } else {
                            console.error(`[Failed] ${url} - ${e.message}`);
                            break;
                        }
                    }
                } else if (e.name === 'AbortError') {
                    crawlerFailure = new CrawlerRequestTimeoutFailure(e.message, url, crawlerFailure);
                    if (retryTimeout === true) {
                        console.error(`[Timeout] ${retryStatus} ${url}`);
                    } else {
                        console.error(`[Timeout] ${url}`);
                        break;
                    }
                } else {
                    crawlerFailure = new CrawlerRequestErrorFailure(e.message, url, crawlerFailure);
                    if (retryError === true) {
                        console.error(`[Error] ${retryStatus} ${url} - ${e.message}`);
                    } else {
                        console.error(`[Error] ${url} - ${e.message}`);
                        break;
                    }
                }
            } finally {
                clearTimeout(timeout);
            }

            attempt++;
            if (attempt <= maxAttempts) {
                await this.#sleep(this.#failedRequestDelayMs);
            }
        }

        return crawlerFailure || new CrawlerFailure('Unexpected', url);
    }

    #setJsonCache(url, jsonObj) {
        this.#jsonCache.set(url, {
            jsonObj: jsonObj,
            timestamp: Date.now()
        });
    }

    #getJsonCache(url) {
        if (this.#cacheTTL) {
            const cacheEntry = this.#jsonCache.get(url);
            if (cacheEntry) {
                if ((Date.now() - cacheEntry.timestamp) >= this.#cacheTTL) {
                    this.#jsonCache.delete(url);
                } else {
                    return cacheEntry.jsonObj;
                }
            }
        }

        return undefined;
    }

    #cleanupCache() {
        const now = Date.now();
        try {
            for (const [url, cacheEntry] of this.#jsonCache) {
                if (now - cacheEntry.timestamp >= this.#cacheTTL) {
                    this.#jsonCache.delete(url);
                }
            }

            for (const [hostname, timestamp] of this.#lastRequestTimestamps) {
                if (now - timestamp >= this.#cacheTTL) {
                    this.#lastRequestTimestamps.delete(hostname);
                }
            }
        } catch (e) {
            console.error(e);
        }
    }

    #extractUuidFromDeeplink(deeplink) {
        try {
            if (typeof deeplink === 'string' && deeplink && (deeplink.startsWith("https://www.snapchat.com/unlock/?") || deeplink.startsWith("https://snapchat.com/unlock/?"))) {
                let deeplinkURL = new URL(deeplink);
                const regexExp = /^[a-f0-9]{32}$/gi;
                if (regexExp.test(deeplinkURL.searchParams.get('uuid'))) {
                    return deeplinkURL.searchParams.get('uuid');
                }
            }
        } catch (e) { }

        return '';
    }

    #archiveTimestampToDateString(YYYYMMDDhhmmss) {
        try {
            if (YYYYMMDDhhmmss) {
                return new Date(`${YYYYMMDDhhmmss}`.replace(
                    /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)$/,
                    '$4:$5:$6 $2/$3/$1'
                )).toDateString();
            }
        } catch (e) { }

        return 'Invalid Date';
    }

    #fixArchiveUrlPrefixes(obj) {
        const text = JSON.stringify(obj);
        const regex = /https?:\/\/web\.archive\.org\/web\/\d+\//g;
        return JSON.parse(text.replace(regex, ''));
    }

    #getProperty(object, propertyPath, urlRef) {
        if (typeof object !== 'object' || !object || Object.keys(object).length === 0) {
            console.error(`[Parse Error] Invalid object given:`, object);
            return new CrawlerJsonStructureFailure('Invalid object given', JSON.stringify(object), urlRef);
        }

        const value = propertyPath
            .replace(/\[([^\[\]]*)\]/g, ".$1.")
            .split(".")
            .filter((t) => t !== "")
            .reduce((prev, cur) => prev?.[cur], object);

        if (value !== undefined) {
            return value;
        }

        console.error(`[Parse Error] Property path not found: '${propertyPath}'`, object);
        return new CrawlerJsonStructureFailure(`Property path not found: '${propertyPath}'`, JSON.stringify(object), urlRef);
    }

    #sleep(ms) {
        return new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    }
}

class ArchivedSnapshot {
    constructor(url, date) {
        this.url = url;
        this.date = date;
    }
}

export default SnapLensWebCrawler;
export { SnapLensWebCrawler };
