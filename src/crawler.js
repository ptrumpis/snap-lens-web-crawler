import * as cheerio from 'cheerio';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';

export default class SnapLensWebCrawler {
    SCRIPT_SELECTOR = '#__NEXT_DATA__';

    // snapshots before this date will not work
    SNAPSHOT_THRESHOLD_MIN = 20220101000000;

    // snapshots from 2025 will not work
    SNAPSHOT_THRESHOLD_MAX = 20241231235959;

    // try to get snapshots from 2022-2024
    SNAPSHOT_TIMESTAMP = 20230601;

    TOP_CATEGORIES = {
        default: '/',
        face: '/category/face',
        world: '/category/world',
        music: '/category/music',
        live: '/category/web_live',
    };

    constructor({
        connectionTimeoutMs = 9000,
        minRequestDelayMs = 500,
        cacheTTL = 3600,
        failedRequestDelayMs = 3000,
        maxRequestRetries = 2,
        headers = null
    } = {}) {
        this.connectionTimeoutMs = Math.max(connectionTimeoutMs, 1000);
        this.minRequestDelayMs = Math.max(minRequestDelayMs, 100);
        this.failedRequestDelayMs = Math.max(failedRequestDelayMs, this.minRequestDelayMs);
        this.maxRequestRetries = Math.max(maxRequestRetries, 0);
        this.headers = headers || {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
        };

        this.lastRequestTimestamps = new Map();
        this.jsonCache = new Map();

        this.cacheTTL = (cacheTTL) ? Math.max(cacheTTL * 1000, 60 * 1000) : 0;
    }

    clearCache() {
        this.lastRequestTimestamps.clear();
        this.jsonCache.clear();
    }

    async downloadFile(url, dest) {
        console.log(`[Downloading] ${url}`);

        try {
            const response = await this._requestGently(url, 'GET');
            if (response?.ok) {
                const buffer = await response.arrayBuffer();
                await fs.mkdir(path.dirname(dest), { recursive: true });
                await fs.writeFile(dest, Buffer.from(buffer));

                return true;
            } else if (response?.status) {
                console.error(`[Download Error] ${url} - Unexpected HTTP Status ${response.status}`);
            }
        } catch (e) {
            console.error(e);
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

    async getLensByHash(hash) {
        const url = `https://lens.snapchat.com/${hash}`;
        return await this._getSingleLens(url, { hash });
    }

    async getMoreLensesByHash(hash) {
        const url = `https://lens.snapchat.com/${hash}`;
        return await this._getMoreLenses(url, { hash })
    }

    async getLensesByUsername(userName) {
        const url = `https://www.snapchat.com/add/${userName}`;
        return await this._getUserLenses(url, { userName });
    }

    async getLensesByCreator(obfuscatedSlug, maxLenses = 1000) {
        let lenses = [];

        for (let offset = 0; offset < maxLenses; offset += 100) {
            let limit = Math.min(maxLenses - offset, 100);
            let result = await this._getLensesByCreator(obfuscatedSlug, offset, limit);
            lenses = lenses.concat(result);
            if (result.length < 100) {
                break;
            }
        }

        return lenses;
    }

    async getTopLensesByCategory(category = 'default', maxLenses = 100) {
        if (!this.TOP_CATEGORIES[category]) {
            console.error(`Unknown top lens category: ${category} \nValid top lens categories are:`, Object.getOwnPropertyNames(this.TOP_CATEGORIES));
            return null;
        }

        const categoryBaseUrl = `https://www.snapchat.com/lens${this.TOP_CATEGORIES[category]}`;
        return await this._getTopLenses(categoryBaseUrl, maxLenses);
    }

    async searchLenses(search) {
        const slug = search.replace(/\W+/g, '-');

        const url = `https://www.snapchat.com/explore/${slug}`;
        const pageProps = await this._crawlJsonFromUrl(url, "props.pageProps");
        return this._handleSearchResults(pageProps);
    }

    async getLensByArchivedSnapshot(hash) {
        const lensUrls = [
            // ordered by highest chance of success
            `lens.snapchat.com/${hash}*`,   // very likely
            `snapchat.com/lens/${hash}*`,   // possibly
        ];

        let lens = {};
        let failures = 0;
        try {
            console.log(`[Wayback Machine] Trying to find lens: ${hash}`);

            for (const index in lensUrls) {
                const targetUrl = lensUrls[index];

                const snapshot = await this._queryArchivedSnapshot(targetUrl);
                if (typeof snapshot === 'undefined') {
                    // request failed or json error
                    failures++;
                    continue;
                } else if (typeof snapshot !== 'object' || Object.keys(snapshot).length !== 2) {
                    // snapshot does not exist or does not match criteria
                    continue;
                }

                console.log(`[Found Snapshot] ${targetUrl} - ${snapshot.date}`);

                let snapshotLens = await this._getSingleLens(snapshot.url, { hash });
                if (snapshotLens) {
                    // fix resource urls since wayback machine does not actually store lens files
                    snapshotLens = JSON.parse(this._fixArchiveUrlPrefixes(JSON.stringify(snapshotLens)));

                    // keep looking for snapshots until we found our precious lens url
                    lens = this.mergeLensItems(snapshotLens, lens);
                    if (lens.lens_url) {
                        lens.from_snapshot = snapshot.url; // save reference
                        break;
                    }
                }
            }
        } catch (e) {
            console.error(e);
        }

        lens.archived_snapshot_failures = failures;

        return lens;
    }

    async getLensesFromUrl(url, lensDefaults = {}) {
        try {
            const pageProps = await this._crawlJsonFromUrl(url, "props.pageProps");
            if (!pageProps) {
                return [];
            }

            const sources = [
                pageProps.lensDisplayInfo,
                pageProps.moreLenses,
                pageProps.lenses,
                pageProps.topLenses
            ];

            let lenses = sources
                .flatMap(source => Array.isArray(source) ? source : [source])
                .filter(Boolean)
                .map(lens => this._formatLensItem(lens, lensDefaults));

            return lenses.concat(this._handleSearchResults(pageProps, lensDefaults));
        } catch (e) {
            console.error(e);
        }

        return [];
    }

    async _getSingleLens(url, lensDefaults = {}) {
        try {
            const lens = await this._crawlJsonFromUrl(url, "props.pageProps.lensDisplayInfo");
            if (lens) {
                return this._formatLensItem(lens, lensDefaults);
            }
        } catch (e) {
            console.error(e);
        }

        return null;
    }

    async _getMoreLenses(url, lensDefaults = {}) {
        let lenses = [];

        try {
            const results = await this._crawlJsonFromUrl(url, "props.pageProps.moreLenses");
            if (results) {
                for (const index in results) {
                    lenses.push(this._formatLensItem(results[index], lensDefaults));
                }
            }
        } catch (e) {
            console.error(e);
        }

        return lenses;
    }

    async _getUserLenses(url, lensDefaults = {}) {
        let lenses = [];

        try {
            const results = await this._crawlJsonFromUrl(url, "props.pageProps.lenses");
            if (results) {
                for (const index in results) {
                    lenses.push(this._formatLensItem(results[index], lensDefaults));
                }
            }
        } catch (e) {
            console.error(e);
        }

        return lenses;
    }

    async _getLensesByCreator(obfuscatedSlug, offset = 0, limit = 100) {
        // limit 100 max
        limit = Math.min(100, limit);

        const url = `https://lensstudio.snapchat.com/v1/creator/lenses/?limit=${limit}&offset=${offset}&order=1&slug=${obfuscatedSlug}`;

        let lenses = [];
        try {
            const lensesList = await this._getJsonFromUrl(url, "lensesList");
            if (lensesList) {
                for (let i = 0; i < lensesList.length; i++) {
                    const item = lensesList[i];
                    if (item.lensId && item.deeplinkUrl && item.name && item.creatorName) {
                        lenses.push(this._formatLensItem(item, { obfuscatedSlug }));
                    }
                }
            }
        } catch (e) {
            console.error(e);
        }

        return lenses;
    }

    async _getTopLenses(url, maxLenses = 100, lensDefaults = {}) {
        let lenses = [];

        try {
            // loop through all "load more lenses" pages identified by a cursor ID
            let hasMore = false;
            let nextCursorId = '';

            const currentUrl = new URL(url);
            do {
                if (hasMore && nextCursorId) {
                    currentUrl.searchParams.set('cursor_id', nextCursorId);
                }

                const pageProps = await this._crawlJsonFromUrl(currentUrl.toString(), "props.pageProps");
                if (pageProps?.topLenses) {
                    const results = pageProps.topLenses;
                    for (const index in results) {
                        if (maxLenses && lenses.length >= maxLenses) {
                            break;
                        }
                        lenses.push(this._formatLensItem(results[index], lensDefaults));
                    }
                }

                // more pages to load are identified by next cursor ID and a boolean flag 
                hasMore = pageProps?.hasMore || false;
                nextCursorId = pageProps?.nextCursorId || '';
            } while (hasMore && nextCursorId && !(maxLenses && lenses.length >= maxLenses));
        } catch (e) {
            console.error(e);
        }

        return lenses;
    }

    async _handleSearchResults(pageProps, lensDefaults = {}) {
        if (!pageProps) {
            return [];
        }

        try {
            if (typeof pageProps.initialApolloState === "object") {
                // original data structure
                return Object.values(pageProps.initialApolloState)
                    .filter(item => item.id && item.deeplinkUrl && item.lensName)
                    .map(lens => this._formatLensItem(lens, lensDefaults));
            }

            if (typeof pageProps.encodedSearchResponse === "string") {
                // new data structure introduced in summer 2024
                const searchResult = JSON.parse(pageProps.encodedSearchResponse);
                const lensSection = searchResult.sections.find(section => section.title === "Lenses");

                return (lensSection?.results || [])
                    .map(entry => entry?.result?.lens)
                    .filter(lens => lens?.lensId && lens.deeplinkUrl && lens.name)
                    .map(lens => this._formatLensItem(lens, lensDefaults));
            }
        } catch (e) {
            console.error(e);
        }

        return [];
    }

    async _queryArchivedSnapshot(url) {
        // use official API: https://archive.org/help/wayback_api.php
        const apiUrl = `https://archive.org/wayback/available?timestamp=${this.SNAPSHOT_TIMESTAMP}&url=${encodeURIComponent(url)}`;

        const snaphot = await this._getJsonFromUrl(apiUrl, "archived_snapshots");
        if (snaphot) {
            if (snaphot.closest?.url && snaphot.closest?.timestamp) {
                const snapshotTime = (snaphot.closest.timestamp) ? parseInt(snaphot.closest.timestamp) : 0;
                if (snapshotTime && snapshotTime >= this.SNAPSHOT_THRESHOLD_MIN && snapshotTime <= this.SNAPSHOT_THRESHOLD_MAX) {
                    try {
                        const snapshotUrl = new URL(snaphot.closest.url);
                        return {
                            url: snapshotUrl.toString(),
                            date: this._archiveTimestampToDateString(snapshotTime)
                        };
                    } catch (e) {
                        // invalid url
                        console.error(`[Error] Invalid Snapshot URL: ${url} - ${e.message}`);
                        return undefined;
                    }
                }
                // snapshot exists but does not match criteria
                return true;
            }
            // snapshot does not exist
            return false;
        }
        // request failed or json error
        return undefined;
    }

    async _crawlJsonFromUrl(url, ...jsonObjPath) {
        // use JSON cache to avoid unecessary requests
        const jsonObj = this._getJsonCache(url);
        if (typeof jsonObj !== 'undefined') {
            return this._getProperty(jsonObj, ...jsonObjPath);
        }

        try {
            console.log(`[Crawling] ${url}`);

            const body = await this._loadUrl(url);
            if (typeof body !== 'string' || !body) {
                // request failed
                return undefined;
            }

            const $ = cheerio.load(body);

            // extract lens info from script tag
            const jsonString = $(this.SCRIPT_SELECTOR).text();
            if (typeof jsonString !== 'string' || !jsonString) {
                console.error(`[Crawl Error] ${url} - Unable to read script tag: ${this.SCRIPT_SELECTOR}`);
                return undefined;
            }

            try {
                const jsonObj = JSON.parse(jsonString);
                if (jsonObj) {
                    this._setJsonCache(url, jsonObj);
                }

                return this._getProperty(jsonObj, ...jsonObjPath);
            } catch (e) {
                if (e.name === 'SyntaxError') {
                    // JSON parse error
                    console.error(`[JSON Error] ${url} - ${e.message}`);
                } else {
                    // unexpected error
                    console.error(`[Error] ${url}`, e);
                }
            }
        } catch (e) {
            console.error(e);
        }

        return undefined;
    }

    async _getJsonFromUrl(url, ...jsonObjPath) {
        // use JSON cache to avoid unecessary requests
        const jsonObj = this._getJsonCache(url);
        if (typeof jsonObj !== 'undefined') {
            return this._getProperty(jsonObj, ...jsonObjPath);
        }

        try {
            console.log(`[API Request] ${url}`);

            const jsonString = await this._loadUrl(url);
            if (typeof jsonString !== 'string' || !jsonString) {
                // request failed
                return undefined;
            }

            try {
                const jsonObj = JSON.parse(jsonString);
                if (jsonObj) {
                    this._setJsonCache(url, jsonObj);
                }

                return this._getProperty(jsonObj, ...jsonObjPath);
            } catch (e) {
                if (e.name === 'SyntaxError') {
                    // JSON parse error
                    console.error(`[JSON Error] ${url} - ${e.message}`);
                } else {
                    // unexpected error
                    console.error(`[Error] ${url}`, e);
                }
            }
        } catch (e) {
            console.error(e);
        }

        return undefined;
    }

    async _loadUrl(url) {
        try {
            const response = await this._requestGently(url, 'GET');
            if (response?.ok) {
                return await response.text();
            }
        } catch (e) {
            console.error(e);
        }

        return undefined;
    }

    async _requestGently(url, method = 'GET') {
        try {
            const hostname = new URL(url).hostname;
            const now = Date.now();

            // avoid hammering the server with too many requests
            // by keeping track of the last request to the same hostname
            if (this.lastRequestTimestamps.has(hostname)) {
                const lastRequestTime = this.lastRequestTimestamps.get(hostname);
                const elapsed = now - lastRequestTime;
                if (elapsed < this.minRequestDelayMs) {
                    await this._sleep(this.minRequestDelayMs - elapsed);
                }
            }

            return await this._request(url, method);
        } catch (e) {
            console.error(e);
        }

        return undefined;
    }

    async _request(url, method = 'GET') {
        let attempt = 1;
        let maxAttempts = this.maxRequestRetries + 1;
        let hostname = null;

        try {
            hostname = new URL(url).hostname;
        } catch (e) {
            // invalid url given
            console.error(`[Error] Invalid URL: ${url} - ${e.message}`);
            return undefined;
        }

        while (attempt <= maxAttempts) {
            const controller = new AbortController();
            const timeout = setTimeout(() => {
                controller.abort();
            }, this.connectionTimeoutMs);

            try {
                // update last request time to keep track of last request
                this.lastRequestTimestamps.set(hostname, Date.now());

                const response = await fetch(url, { method: method, signal: controller.signal, headers: this.headers });
                clearTimeout(timeout);

                // trigger retry
                if (response.status >= 400 && response.status < 600) {
                    const statusError = new Error(`HTTP Status ${response.status}`);
                    statusError.name = 'ResponseStatus';
                    throw statusError
                }

                return response;
            } catch (e) {
                if (e.name === 'ResponseStatus') {
                    console.error(`[Failed] (${attempt}/${maxAttempts}): ${url} - ${e.message}`);
                } else if (e.name === 'AbortError') {
                    console.error(`[Timeout] (${attempt}/${maxAttempts}): ${url}`);
                } else {
                    console.error(`[Error] (${attempt}/${maxAttempts}): ${url} - ${e.message}`);
                }
            } finally {
                clearTimeout(timeout);
            }

            attempt++;
            if (attempt <= maxAttempts) {
                await this._sleep(this.failedRequestDelayMs);
            }
        }

        return undefined;
    }

    _setJsonCache(url, jsonObj) {
        this.jsonCache.set(url, {
            jsonObj: jsonObj,
            timestamp: Date.now()
        });
    }

    _getJsonCache(url) {
        if (this.cacheTTL) {
            const cacheEntry = this.jsonCache.get(url);
            if (cacheEntry) {
                if ((Date.now() - cacheEntry.timestamp) >= this.cacheTTL) {
                    // cache TTL expired
                    this.jsonCache.delete(url);
                } else {
                    return cacheEntry.jsonObj;
                }
            }
        }

        return undefined;
    }

    _formatLensItem(lensItem, options = {}) {
        const { obfuscatedSlug = '', userName = '', hash = '', unlockableId = '' } = options;

        const deeplinkUrl = lensItem.deeplinkUrl || lensItem.unlockUrl || "";
        const uuid = lensItem.scannableUuid || this._extractUuidFromDeeplink(deeplinkUrl) || hash || "";
        const lensId = lensItem.lensId || lensItem.id || unlockableId || "";

        let result = {
            //lens
            unlockable_id: lensId,
            uuid: uuid,
            deeplink: deeplinkUrl || this._deeplinkUrl(uuid) || "",
            snapcode_url: lensItem.snapcodeUrl || this._snapcodeUrl(uuid) || "",

            lens_name: lensItem.lensName || lensItem.name || "",
            lens_creator_search_tags: lensItem.lensCreatorSearchTags || [],
            lens_status: "Live",

            user_display_name: lensItem.lensCreatorDisplayName || lensItem.creator?.title || lensItem.creatorName || "",
            user_name: lensItem.lensCreatorUsername || userName || "",
            user_profile_url: lensItem.userProfileUrl || this._profileUrl(lensItem.lensCreatorUsername || userName) || "",
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

    _profileUrl(username) {
        if (typeof username === 'string' && username) {
            return `https://www.snapchat.com/add/${username}`;
        }
        return '';
    }

    _snapcodeUrl(uuid) {
        if (typeof uuid === 'string' && uuid) {
            return `https://app.snapchat.com/web/deeplink/snapcode?data=${uuid}&version=1&type=png`;
        }
        return '';
    }

    _deeplinkUrl(uuid) {
        if (typeof uuid === 'string' && uuid) {
            return `https://snapchat.com/unlock/?type=SNAPCODE&uuid=${uuid}&metadata=01`;
        }
        return '';
    }

    _extractUuidFromDeeplink(deeplink) {
        if (typeof deeplink === 'string' && deeplink && (deeplink.startsWith("https://www.snapchat.com/unlock/?") || deeplink.startsWith("https://snapchat.com/unlock/?"))) {
            let deeplinkURL = new URL(deeplink);
            const regexExp = /^[a-f0-9]{32}$/gi;
            if (regexExp.test(deeplinkURL.searchParams.get('uuid'))) {
                return deeplinkURL.searchParams.get('uuid');
            }
        }
        return '';
    }

    _archiveTimestampToDateString(YYYYMMDDhhmmss) {
        try {
            if (YYYYMMDDhhmmss) {
                return new Date(`${YYYYMMDDhhmmss}`.replace(
                    /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)$/,
                    '$4:$5:$6 $2/$3/$1'
                )).toDateString();
            }
        } catch (e) {
        }

        return 'Invalid Date';
    }

    _fixArchiveUrlPrefixes(text) {
        const regex = /https?:\/\/web\.archive\.org\/web\/\d+\//g;
        return text.replace(regex, '');
    }

    _getProperty(obj, ...selectors) {
        if (typeof obj !== 'object' || !obj || Object.keys(obj).length === 0) {
            console.error(`[Parse Error] Invalid object given:`, obj);
            return undefined;
        }

        for (const selector of selectors) {
            const value = selector
                .replace(/\[([^\[\]]*)\]/g, ".$1.")
                .split(".")
                .filter((t) => t !== "")
                .reduce((prev, cur) => prev?.[cur], obj);

            if (value !== undefined) {
                return value;
            }
        }

        console.error(`[Parse Error] Property path(s) not found: '${selectors.toString}'`, obj);

        return undefined;
    }

    _sleep(ms) {
        return new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    }
}
