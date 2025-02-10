import * as cheerio from 'cheerio';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';

export default class SnapLensWebCrawler {
    SCRIPT_SELECTOR = '#__NEXT_DATA__';

    // snapshots from 2025 will not work
    SNAPSHOT_THRESHOLD = 20241231235959;

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
        console.log(`[Downloading]: ${url}`);

        try {
            const response = await this._requestGently(url, 'GET');
            if (response?.ok) {
                const buffer = await response.arrayBuffer();
                await fs.mkdir(path.dirname(dest), { recursive: true });
                await fs.writeFile(dest, Buffer.from(buffer));

                return true;
            } else if (response?.status) {
                console.error(`[Download Error]: ${url} - Unexpected HTTP Status ${response.status}`);
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
        try {
            const url = `https://lens.snapchat.com/${hash}`;
            const lens = await this._extractLensesFromUrl(url, true, "props.pageProps.lensDisplayInfo");
            if (lens) {
                return this._formatLensItem(lens, { hash });
            }
        } catch (e) {
            console.error(e);
        }
        return null;
    }

    async getMoreLensesByHash(hash) {
        let lenses = [];
        try {
            const url = `https://lens.snapchat.com/${hash}`;
            const results = await this._extractLensesFromUrl(url, true, "props.pageProps.moreLenses");
            if (results) {
                for (const index in results) {
                    lenses.push(this._formatLensItem(results[index], { hash }));
                }
            }
        } catch (e) {
            console.error(e);
        }
        return lenses;
    }

    async getAllLensesByCreator(obfuscatedSlug) {
        let lenses = [];
        for (let offset = 0; offset < 1000; offset += 100) {
            let result = await this.getLensesByCreator(obfuscatedSlug, offset, 100);
            lenses = lenses.concat(result);
            if (result.length < 100) {
                break;
            }
        }
        return lenses;
    }

    async getLensesByCreator(obfuscatedSlug, offset = 0, limit = 100) {
        limit = Math.min(100, limit);
        let lenses = [];
        try {
            const url = `https://lensstudio.snapchat.com/v1/creator/lenses/?limit=${limit}&offset=${offset}&order=1&slug=${obfuscatedSlug}`;

            // use JSON cache to avoid unecessary requests
            let jsonObj = this._getJsonCache(url);

            if (typeof jsonObj === 'undefined') {
                console.log('[API Request]:', url);

                const jsonString = await this._loadUrl(url);
                if (!jsonString) {
                    // request failed
                    return lenses;
                }

                jsonObj = JSON.parse(jsonString);
                if (!jsonObj) {
                    console.warn('Unable to parse JSON string', jsonString);
                    return lenses;
                }

                this._setJsonCache(url, jsonObj);
            }

            if (jsonObj.lensesList) {
                for (let i = 0; i < jsonObj.lensesList.length; i++) {
                    const item = jsonObj.lensesList[i];
                    if (item.lensId && item.deeplinkUrl && item.name && item.creatorName) {
                        lenses.push(this._formatLensItem(item, { obfuscatedSlug }));
                    }
                }
            } else {
                console.warn('JSON property "lensesList" not found.', jsonObj);
            }
        } catch (e) {
            console.error(e);
        }
        return lenses;
    }

    async searchLenses(search) {
        const slug = search.replace(/\W+/g, '-');
        let lenses = [];
        try {
            const url = `https://www.snapchat.com/explore/${slug}`;
            const results = await this._extractLensesFromUrl(url, false, "props.pageProps.initialApolloState", "props.pageProps.encodedSearchResponse");
            if (results) {
                if (typeof results === 'object') {
                    // original data structure
                    for (const key in results) {
                        if (key != 'ROOT_QUERY') {
                            if (results[key].id && results[key].deeplinkUrl && results[key].lensName) {
                                lenses.push(this._formatLensItem(results[key]));
                            }
                        }
                    }
                } else if (typeof results === 'string') {
                    // new data structure introduced in summer 2024
                    const searchResult = JSON.parse(results);
                    let lensSectionResults = [];

                    // try to find "Lenses" section
                    for (const index in searchResult.sections) {
                        if (searchResult.sections[index].title === 'Lenses') {
                            lensSectionResults = searchResult.sections[index].results;
                            break;
                        }
                    }

                    // save each lens
                    for (const index in lensSectionResults) {
                        if (lensSectionResults[index]?.result?.lens) {
                            let lens = lensSectionResults[index].result.lens;
                            if (lens.lensId && lens.deeplinkUrl && lens.name) {
                                lenses.push(this._formatLensItem(lens));
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.error(e);
        }
        return lenses;
    }

    async getUserProfileLenses(userName) {
        let lenses = [];
        try {
            const url = `https://www.snapchat.com/add/${userName}`;
            const results = await this._extractLensesFromUrl(url, false, "props.pageProps.lenses");
            if (results) {
                for (const index in results) {
                    lenses.push(this._formatLensItem(results[index], { userName }));
                }
            }
        } catch (e) {
            console.error(e);
        }
        return lenses;
    }

    async getTopLenses(category = 'default', maxLenses = 100) {
        let lenses = [];
        try {
            if (!this.TOP_CATEGORIES[category]) {
                console.error('Unknown top lens category: ', category, "\nValid top lens categories are:", Object.getOwnPropertyNames(this.TOP_CATEGORIES));
                return null;
            }

            const categoryPath = this.TOP_CATEGORIES[category];
            const categoryBaseUrl = `https://www.snapchat.com/lens${categoryPath}`;

            // loop through all "load more lenses" pages identified by a cursor ID
            let hasMore = false;
            let cursorId = '';
            do {
                let url = categoryBaseUrl;
                if (hasMore && cursorId) {
                    url = categoryBaseUrl + "?cursor_id=" + cursorId;
                }

                const pageProps = await this._extractLensesFromUrl(url, false, "props.pageProps");
                if (pageProps?.topLenses) {
                    const results = pageProps.topLenses;
                    for (const index in results) {
                        if (maxLenses && lenses.length >= maxLenses) {
                            break;
                        }
                        lenses.push(this._formatLensItem(results[index]));
                    }
                }

                // more pages to load are identified by next cursor ID and a boolean flag 
                hasMore = pageProps?.hasMore || false;
                cursorId = pageProps?.nextCursorId || '';
            } while (hasMore && cursorId && !(maxLenses && lenses.length >= maxLenses));
        } catch (e) {
            console.error(e);
        }
        return lenses;
    }

    async getLensByArchivedSnapshot(hash) {
        const lensUrls = [
            // ordered by highest chance of success
            `https://lens.snapchat.com/${hash}`,
            `https://www.snapchat.com/lens/${hash}`,
            `https://www.snapchat.com/lens/${hash}?type=SNAPCODE&metadata=01`,
        ];

        let lens = null;
        try {
            console.log('[Wayback Machine]: Trying to find lens', hash);

            for (const index in lensUrls) {
                // use official API: https://archive.org/help/wayback_api.php
                const apiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(lensUrls[index])}&timestamp=${this.SNAPSHOT_TIMESTAMP}`;

                // use JSON cache to avoid unecessary requests
                let jsonObj = this._getJsonCache(apiUrl);

                if (typeof jsonObj === 'undefined') {
                    console.log('[API Request]:', apiUrl);

                    const jsonString = await this._loadUrl(apiUrl);
                    if (!jsonString) {
                        // request failed
                        continue;
                    }

                    jsonObj = JSON.parse(jsonString);
                    if (!jsonObj) {
                        console.warn('Unable to parse JSON string', jsonString);
                        continue;
                    }

                    this._setJsonCache(apiUrl, jsonObj);
                }

                if (!jsonObj.archived_snapshots?.closest?.url) {
                    // no snapshot available
                    continue;
                }

                const snapshotTime = jsonObj.archived_snapshots.closest.timestamp;
                if (snapshotTime && parseInt(snapshotTime) > this.SNAPSHOT_THRESHOLD) {
                    // snapshot is available but not from 2024 or earlier
                    continue;
                }

                console.log('[Found Snapshot]:', lensUrls[index], "-", this._archiveTimestampToDateString(snapshotTime));

                const snapshotUrl = jsonObj.archived_snapshots.closest.url;
                let snapshotLens = await this._extractLensesFromUrl(snapshotUrl, true, "props.pageProps.lensDisplayInfo");
                if (snapshotLens) {
                    // fix resource urls since wayback machine does not actually store these files
                    snapshotLens = JSON.parse(this._fixArchiveUrlPrefixes(JSON.stringify(snapshotLens)));

                    snapshotLens = this._formatLensItem(snapshotLens, { hash });

                    // keep looking for snapshots until we found our precious lens url
                    lens = this.mergeLensItems(snapshotLens, lens || {});
                    if (lens.lens_url) {
                        lens.from_snapshot = snapshotUrl; // save reference
                        break;
                    }
                }
            }
        } catch (e) {
            console.error(e);
        }

        return lens;
    }

    async getMoreLensesByArchivedSnapshot(hash) {
        // TODO: implement
        return null;
    }

    async _extractLensesFromUrl(url, useCache, ...jsonObjPath) {
        try {
            if (useCache) {
                // use JSON cache to avoid unecessary requests
                const jsonObj = this._getJsonCache(url);
                if (typeof jsonObj !== 'undefined') {
                    // try to get lens object from cached JSON object
                    const lensObjFromPropertyPath = this._getProperty(jsonObj, ...jsonObjPath);
                    if (typeof lensObjFromPropertyPath === 'undefined') {
                        console.warn('JSON property path not found', jsonObjPath, jsonObj);
                    }
                    return lensObjFromPropertyPath; // object|undefined
                }
            }

            console.log('[Crawling]:', url);

            const body = await this._loadUrl(url);
            if (typeof body !== 'string' || !body) {
                // request failed
                return undefined;
            }

            const $ = cheerio.load(body);

            // extract lens info from script tag
            const jsonString = $(this.SCRIPT_SELECTOR).text();
            if (typeof jsonString !== 'string' || !jsonString) {
                console.warn('Unable to read script tag', this.SCRIPT_SELECTOR);
                return undefined;
            }

            const jsonObj = JSON.parse(jsonString);
            if (!jsonObj) {
                console.warn('Unable to parse JSON string', jsonString);
                return undefined;
            }

            this._setJsonCache(url, jsonObj);

            const lensObjFromPropertyPath = this._getProperty(jsonObj, ...jsonObjPath);
            if (typeof lensObjFromPropertyPath === 'undefined') {
                console.warn('JSON property path not found', jsonObjPath, jsonObj);
            }
            return lensObjFromPropertyPath; // object|undefined
        } catch (e) {
            console.error('Error extracting lenses from URL:', url, e);
        }

        return undefined;
    }

    async _loadUrl(url) {
        try {
            const response = await this._requestGently(url, 'GET');
            if (response && response.ok) {
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
            // invalid url
            console.error(e);
            return undefined;
        }

        while (attempt <= maxAttempts) {
            const controller = new AbortController();
            const timeout = setTimeout(() => {
                controller.abort();
            }, this.connectionTimeoutMs);

            try {
                // update last request time
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
                    console.error(`[Failed] (${attempt}/${maxAttempts}):`, url, "-", e.message);
                } else if (e.name === 'AbortError') {
                    console.error(`[Timeout] (${attempt}/${maxAttempts}):`, url);
                } else {
                    console.error(`[Error] (${attempt}/${maxAttempts}):`, url, e);
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
                    // return cached object
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
            return "https://www.snapchat.com/add/" + username;
        }
        return '';
    }

    _snapcodeUrl(uuid) {
        if (typeof uuid === 'string' && uuid) {
            return "https://app.snapchat.com/web/deeplink/snapcode?data=" + uuid + "&version=1&type=png";
        }
        return '';
    }

    _deeplinkUrl(uuid) {
        if (typeof uuid === 'string' && uuid) {
            return "'https://snapchat.com/unlock/?type=SNAPCODE&uuid=" + uuid + "&metadata=01";
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
                return new Date(YYYYMMDDhhmmss.replace(
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
        if (!obj) return null;

        for (const selector of selectors) {
            const value = selector
                .replace(/\[([^\[\]]*)\]/g, ".$1.")
                .split(".")
                .filter((t) => t !== "")
                .reduce((prev, cur) => prev?.[cur], obj);

            if (value !== undefined) return value;
        }

        return undefined;
    }

    _sleep(ms) {
        return new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    }
}
