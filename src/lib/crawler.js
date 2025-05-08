import * as cheerio from 'cheerio';
import fs from 'fs/promises';
import path from 'path';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { randomUUID } from 'node:crypto';
import SpoofHeader from './header.js';
import HTTPStatusError from './error.js';
import { CrawlerFailure, CrawlerInvalidUrlFailure, CrawlerJsonFailure, CrawlerJsonParseFailure, CrawlerJsonStructureFailure, CrawlerRequestErrorFailure, CrawlerRequestTimeoutFailure, CrawlerHTTPStatusFailure, CrawlerNotFoundFailure, CralwerAggregateFailure } from './failure.js';

class SnapLensWebCrawler {
    TOP_CATEGORIES = {
        default: '/',
        face: '/category/face',
        world: '/category/world',
        music: '/category/music',
        live: '/category/web_live',
    };

    TOP_LOCALES = [
        "ar", "bn-BD", "bn-IN", "da-DK", "de-DE", "el-GR", "en-GB", "en-US", "es",
        "es-AR", "es-ES", "es-MX", "fi-FI", "fil-PH", "fr-FR", "gu-IN", "hi-IN",
        "id-ID", "it-IT", "ja-JP", "kn-IN", "ko-KR", "ml-IN", "mr-IN", "ms-MY",
        "nb-NO", "nl-NL", "pa", "pl-PL", "pt-BR", "pt-PT", "ro-RO", "ru-RU", "sv-SE",
        "ta-IN", "te-IN", "th-TH", "tr-TR", "ur-PK", "vi-VN", "zh-Hans", "zh-Hant"
    ];

    #SCRIPT_SELECTOR = '#__NEXT_DATA__';

    // snapshots before this date will not work
    #SNAPSHOT_THRESHOLD_MIN = 20220101000000;

    // snapshots from 2025 will not work
    #SNAPSHOT_THRESHOLD_MAX = 20241231235959;

    // try to get snapshots from 2022-2024
    #SNAPSHOT_TIMESTAMP = 20230601000000;

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
    #verbose;
    #console;

    static #registry = new FinalizationRegistry((cleanupInterval) => {
        clearInterval(cleanupInterval);
    });

    constructor({
        connectionTimeoutMs = 9000,
        minRequestDelayMs = 100,
        cacheTTL = 3600,
        gcInterval = 3600,
        failedRequestDelayMs = 4500,
        maxRequestRetries = 2,
        headers = undefined,
        verbose = true,
    } = {}) {
        this.#connectionTimeoutMs = Math.max(connectionTimeoutMs, 1000);
        this.#minRequestDelayMs = Math.max(minRequestDelayMs, 0);
        this.#failedRequestDelayMs = Math.max(failedRequestDelayMs, this.#minRequestDelayMs);
        this.#maxRequestRetries = Math.max(maxRequestRetries, 0);
        this.#headers = headers || {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        };

        this.setVerbose(verbose);

        this.#cacheTTL = cacheTTL ? Math.max(parseInt(cacheTTL) * 1000, 1000) : 0;
        this.#gcInterval = gcInterval ? Math.max(parseInt(gcInterval) * 1000, 5 * 60 * 1000) : false;

        if (this.#gcInterval) {
            this.#cleanupInterval = setInterval(() => { this.#cleanupCache() }, this.#gcInterval).unref();
            SnapLensWebCrawler.#registry.register(this, this.#cleanupInterval, this);
        }
    }

    getConnectionTimeout() { return this.#connectionTimeoutMs; }
    getMinRequestDelay() { return this.#minRequestDelayMs; }
    getFailedRequestDelay() { return this.#failedRequestDelayMs; }
    getMaxRequestRetries() { return this.#maxRequestRetries; }
    getCacheTTL() { return this.#cacheTTL; }
    getGCInterval() { return this.#gcInterval; }
    getHeaders() { return this.#headers; }
    isVerbose() { return this.#verbose; }

    setVerbose(verbose) {
        this.#verbose = verbose;
        this.#console = this.#verbose ? console : {
            log: () => { },
            info: () => { },
            warn: () => { },
            error: () => { },
            debug: () => { }
        };
    }

    destroy() {
        if (this.#gcInterval) {
            clearInterval(this.#cleanupInterval);
            SnapLensWebCrawler.#registry.unregister(this);
        }

        this.#lastRequestTimestamps.clear();
        this.#jsonCache.clear();
    }

    async downloadFile(url, dest) {
        try {
            const response = await this.#requestGently(url, 'GET');
            if (response instanceof CrawlerFailure) {
                return response;
            }

            if (response?.ok && response.body) {
                await fs.mkdir(path.dirname(dest), { recursive: true });
                await pipeline(response.body, createWriteStream(dest));

                return true;
            }
        } catch (e) {
            this.#console.error(e);
            return new CrawlerFailure(e.message, url);
        }

        return false;
    }

    static mergeLensItems(primary, secondary) {
        function isEmpty(value) {
            return (!value && value !== false) ||
                (Array.isArray(value) && value.length === 0) ||
                (typeof value === 'object' && value !== null && Object.keys(value).length === 0);
        }

        let merged = { ...secondary, ...primary };

        for (let key in merged) {
            if (isEmpty(primary[key]) && !isEmpty(secondary[key])) {
                merged[key] = secondary[key];
            }
        }

        return merged;
    }

    static formatLensItem(lensItem, options = {}) {
        const { obfuscatedSlug = '', userName = '', hash = '', unlockableId = '' } = options;

        const deeplinkUrl = lensItem.deeplinkUrl || lensItem.unlockUrl || "";
        const uuid = lensItem.scannableUuid || SnapLensWebCrawler.extractUuidFromDeeplink(deeplinkUrl) || hash || "";
        const lensId = lensItem.lensId || lensItem.id || unlockableId || "";

        let result = {
            //lens
            unlockable_id: lensId,
            uuid: uuid,
            deeplink: deeplinkUrl || SnapLensWebCrawler.deeplinkUrl(uuid) || "",
            snapcode_url: lensItem.snapcodeUrl || SnapLensWebCrawler.snapcodeUrl(uuid) || "",

            lens_name: (lensItem.lensName || lensItem.name || "")?.trim(),
            lens_creator_search_tags: lensItem.lensCreatorSearchTags || [],
            lens_status: "Live",

            user_display_name: (lensItem.lensCreatorDisplayName || lensItem.creator?.title || lensItem.creatorName || "")?.trim(),
            user_name: lensItem.lensCreatorUsername || userName || "",
            user_profile_url: lensItem.userProfileUrl || SnapLensWebCrawler.profileUrl(lensItem.lensCreatorUsername || userName) || "",
            user_id: lensItem.creatorUserId || "",
            user_profile_id: lensItem.creatorProfileId || "",
            obfuscated_user_slug: obfuscatedSlug || "",

            icon_url: lensItem.iconUrl || "",
            thumbnail_media_url: lensItem.thumbnailUrl || lensItem.previewImageUrl || lensItem.lensPreviewImageUrl || "",
            thumbnail_media_poster_url: lensItem.thumbnailUrl || lensItem.previewImageUrl || lensItem.lensPreviewImageUrl || "",
            standard_media_url: lensItem.previewVideoUrl || lensItem.lensPreviewVideoUrl || "",
            image_sequence: {},
            hint_id: "",
            additional_hint_ids: {}
        };

        if (lensItem.thumbnailSequence && typeof lensItem.thumbnailSequence === 'object' && Object.keys(lensItem.thumbnailSequence).length) {
            result.image_sequence = {
                url_pattern: lensItem.thumbnailSequence?.urlPattern || "",
                size: parseInt(lensItem.thumbnailSequence?.numThumbnails) || 0,
                frame_interval_ms: parseInt(lensItem.thumbnailSequence?.animationIntervalMs) || 0
            }
        }

        //unlock
        if (lensItem.lensResource && typeof lensItem.lensResource === 'object' && Object.keys(lensItem.lensResource).length) {
            Object.assign(result, {
                lens_id: lensId || "",
                lens_url: lensItem.lensResource?.archiveLink || "",
                signature: lensItem.lensResource?.signature || "",
                sha256: lensItem.lensResource?.checkSum || "",
                last_updated: lensItem.lensResource?.lastUpdated || lensItem.lastUpdatedEpoch || ""
            });

            if (result.last_updated) {
                result.last_updated = SnapLensWebCrawler.normalizeTimestamp(result.last_updated);
            }
        }

        return result;
    }

    static profileUrl(username) {
        if (typeof username === 'string' && username) {
            return `https://www.snapchat.com/add/${username}`;
        }
        return '';
    }

    static snapcodeUrl(uuid) {
        if (typeof uuid === 'string' && uuid) {
            return `https://app.snapchat.com/web/deeplink/snapcode?data=${uuid}&version=1&type=png`;
        }
        return '';
    }

    static deeplinkUrl(uuid) {
        if (typeof uuid === 'string' && uuid) {
            return `https://snapchat.com/unlock/?type=SNAPCODE&uuid=${uuid}&metadata=01`;
        }
        return '';
    }

    static extractUuidFromDeeplink(deeplink) {
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

    static normalizeTimestamp(ts) {
        return ts < 1e12 ? ts * 1000 : ts;
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
        if (typeof this.TOP_CATEGORIES[category] === 'undefined') {
            this.#console.error(`Unknown top lens category: ${category} \nValid top lens categories are:`, Object.getOwnPropertyNames(this.TOP_CATEGORIES));
            return [];
        }

        if (category === 'live') {
            // live category has only 11 filters
            maxLenses = 11;
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
                    failures.push(new CrawlerFailure('Unexpected return value', targetUrl));
                    continue;
                }

                let snapshotLens = await this.#getSingleLens(snapshot.url, { hash });
                if (snapshotLens instanceof CrawlerFailure) {
                    failures.push(snapshotLens);
                    continue;
                }

                lens = SnapLensWebCrawler.mergeLensItems(this.#fixArchiveUrlPrefixes(snapshotLens), lens);
                if (lens.lens_url) {
                    lens.snapshot = snapshot;
                    return lens;
                }

                failures.push(new CrawlerFailure(`Snapshot exists but has no lens URL`, targetUrl));
            }
        } catch (e) {
            this.#console.error(e);
            return new CrawlerFailure(e.message);
        }

        return new CralwerAggregateFailure(failures, `Failed to get snapshot for: ${hash}`);
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
                .map(lens => SnapLensWebCrawler.formatLensItem(lens, lensDefaults));

            return lenses
                .concat(this.#handleSearchResults(pageProps, lensDefaults))
                .map(lens => this.#fixArchiveUrlPrefixes(lens));
        } catch (e) {
            this.#console.error(e);
            return new CrawlerFailure(e.message, url);
        }
    }

    async #getSingleLens(url, lensDefaults = {}) {
        try {
            const lens = await this.#crawlJsonFromUrl(url, "props.pageProps.lensDisplayInfo");
            if (lens instanceof CrawlerFailure) {
                return lens;
            }

            return SnapLensWebCrawler.formatLensItem(lens, lensDefaults);
        } catch (e) {
            this.#console.error(e);
            return new CrawlerFailure(e.message, url);
        }
    }

    async #getMoreLenses(url, lensDefaults = {}) {
        try {
            const lenses = await this.#crawlJsonFromUrl(url, "props.pageProps.moreLenses");
            if (lenses instanceof CrawlerFailure) {
                return lenses;
            }

            return lenses.map(lens => SnapLensWebCrawler.formatLensItem(lens, lensDefaults));
        } catch (e) {
            this.#console.error(e);
            return new CrawlerFailure(e.message, url);
        }
    }

    async #getUserLenses(url, lensDefaults = {}) {
        try {
            const lenses = await this.#crawlJsonFromUrl(url, "props.pageProps.lenses");
            if (lenses instanceof CrawlerFailure) {
                return lenses;
            }

            return lenses.map(lens => SnapLensWebCrawler.formatLensItem(lens, lensDefaults));
        } catch (e) {
            this.#console.error(e);
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
                .map(item => SnapLensWebCrawler.formatLensItem(item, { obfuscatedSlug }));
        } catch (e) {
            this.#console.error(e);
            return new CrawlerFailure(e.message, url);
        }
    }

    async #getTopLenses(url, maxLenses, lensDefaults = {}) {
        const lenses = new Map();
        const currentUrl = new URL(url);

        const cursors = new Set();
        const cursorLimit = 50;

        // enforce maximum of 10000 lenses
        maxLenses = (Number.isInteger(maxLenses) && maxLenses > 0) ? maxLenses : 10000;

        try {
            const spoofHeader = new SpoofHeader();

            const locales = this.#shuffle(this.TOP_LOCALES);
            for (const locale of locales) {
                if (currentUrl.searchParams.has('locale')) {
                    currentUrl.searchParams.set('locale', locale);
                }

                if (currentUrl.searchParams.has('sender_web_id')) {
                    currentUrl.searchParams.set('sender_web_id', randomUUID());
                }

                cursors.clear();

                const headers = spoofHeader.getHeadersFor(currentUrl.toString(), [locale], false);

                while (lenses.size < maxLenses) {
                    const pageProps = await this.#crawlJsonFromUrl(currentUrl.toString(), "props.pageProps", { retryNotFound: true, headers: headers });
                    if (pageProps instanceof CrawlerNotFoundFailure) {
                        currentUrl.searchParams.delete('cursor_id');
                        break;
                    } else if (!pageProps?.topLenses || !Array.isArray(pageProps.topLenses) || !pageProps.topLenses.length) {
                        break;
                    }

                    let newLenses = pageProps.topLenses;
                    if ((lenses.size + newLenses.length) > maxLenses) {
                        const remaining = maxLenses - lenses.size;
                        newLenses = newLenses.slice(0, Math.max(0, remaining));
                    }

                    newLenses.forEach(newLens => {
                        const lens = SnapLensWebCrawler.formatLensItem(newLens, lensDefaults);
                        if (!lenses.has(lens.uuid)) {
                            lenses.set(lens.uuid, lens);
                        }
                    });

                    if (!pageProps.hasMore || !pageProps.nextCursorId || cursors.size >= cursorLimit) {
                        currentUrl.searchParams.delete('cursor_id');
                        break;
                    }

                    if (cursors.has(pageProps.nextCursorId)) {
                        this.#jsonCache.delete(currentUrl.toString());

                        currentUrl.searchParams.set('locale', locale);
                        currentUrl.searchParams.set('sender_web_id', randomUUID());

                        this.#sleep(this.#failedRequestDelayMs);
                        break;
                    }

                    currentUrl.searchParams.set('cursor_id', pageProps.nextCursorId);
                    cursors.add(pageProps.nextCursorId);
                }

                if (lenses.size >= maxLenses || lenses.size === 0) {
                    break;
                }
            }
        } catch (e) {
            this.#console.error(e);
        }

        return Array.from(lenses.values());
    }

    #handleSearchResults(pageProps, lensDefaults = {}) {
        if (!pageProps) {
            return [];
        }

        try {
            if (typeof pageProps.initialApolloState === "object") {
                return Object.values(pageProps.initialApolloState)
                    .filter(item => item.id && item.deeplinkUrl && item.lensName)
                    .map(lens => SnapLensWebCrawler.formatLensItem(lens, lensDefaults));
            }

            if (typeof pageProps.encodedSearchResponse === "string") {
                // new data structure introduced in summer 2024
                const searchResult = JSON.parse(pageProps.encodedSearchResponse);
                const lensSection = searchResult.sections.find(section => (section.title === "Lenses" || section.sectionType === 6));

                return (lensSection?.results || [])
                    .map(entry => entry?.result?.lens)
                    .filter(lens => lens?.lensId && lens.deeplinkUrl && lens.name)
                    .map(lens => SnapLensWebCrawler.formatLensItem(lens, lensDefaults));
            }
        } catch (e) {
            this.#console.error(e);
        }

        return [];
    }

    async #queryArchivedSnapshot(url) {
        const apiUrl = `https://archive.org/wayback/available?timestamp=${this.#SNAPSHOT_TIMESTAMP}&url=${encodeURIComponent(url)}`;

        try {
            const result = await this.#getJsonFromUrl(apiUrl, "archived_snapshots");
            if (result instanceof CrawlerFailure) {
                return result;
            }

            if (!result.closest?.url || !result.closest?.timestamp) {
                return new CrawlerFailure(`Snapshot does not exist`, apiUrl);
            }

            const snapshotTime = parseInt(result.closest.timestamp) || 0;
            if (snapshotTime < this.#SNAPSHOT_THRESHOLD_MIN || snapshotTime > this.#SNAPSHOT_THRESHOLD_MAX) {
                return new CrawlerFailure(`Snapshot exists but does not match criteria`, apiUrl);
            }

            try {
                const snapshotUrl = new URL(result.closest.url);
                return new ArchivedSnapshot(snapshotUrl.toString(), this.#archiveTimestampToDateString(snapshotTime));
            } catch (e) {
                this.#console.error(`[Error] ${url} - Invalid snapshot URL: ${result.closest.url}`);
                return new CrawlerFailure(e.message, apiUrl);
            }
        } catch (e) {
            this.#console.error(e);
            return new CrawlerFailure(e.message, apiUrl);
        }
    }

    async #crawlJsonFromUrl(url, jsonPropertyPath = null, options = {}) {
        const jsonObj = this.#getJsonCache(url);
        if (typeof jsonObj !== 'undefined') {
            return (jsonPropertyPath) ? this.#getProperty(jsonObj, jsonPropertyPath, url) : jsonObj;
        }

        try {
            let body = await this.#loadUrl(url, options);
            if (body instanceof CrawlerFailure) {
                return body;
            }

            if (typeof body === 'string' && body.trim().length === 0) {
                this.#console.error(`[Crawl Error] ${url} - Empty HTML body received`);
                return new CrawlerFailure(`Empty HTML body received`, url);
            }

            let $ = cheerio.load(body);
            body = null;

            let jsonString = $(this.#SCRIPT_SELECTOR).text();
            $ = null;

            if (typeof jsonString !== 'string' || !jsonString) {
                this.#console.error(`[Crawl Error] ${url} - Unable to read script tag: ${this.#SCRIPT_SELECTOR}`);
                return new CrawlerFailure(`Unable to read script tag: ${this.#SCRIPT_SELECTOR}`, url);
            }

            try {
                const parsedJson = JSON.parse(jsonString);
                jsonString = null;

                if (parsedJson) {
                    this.#setJsonCache(url, parsedJson);
                }

                return (jsonPropertyPath) ? this.#getProperty(parsedJson, jsonPropertyPath, url) : parsedJson;
            } catch (e) {
                if (e.name === 'SyntaxError') {
                    this.#console.error(`[JSON Error] ${url} - ${e.message}`);
                    return new CrawlerJsonParseFailure(e.message, jsonString, url);
                } else {
                    this.#console.error(`[Error] ${url}`, e);
                    return new CrawlerJsonFailure(e.message, jsonString, url);
                }
            }
        } catch (e) {
            this.#console.error(e);
            return new CrawlerFailure(e.message, url);
        }
    }

    async #getJsonFromUrl(url, jsonPropertyPath = null, options = {}) {
        const jsonObj = this.#getJsonCache(url);
        if (typeof jsonObj !== 'undefined') {
            return (jsonPropertyPath) ? this.#getProperty(jsonObj, jsonPropertyPath, url) : jsonObj;
        }

        try {
            let jsonString = await this.#loadUrl(url, options);
            if (jsonString instanceof CrawlerFailure) {
                return jsonString;
            }

            try {
                const parsedJson = JSON.parse(jsonString);
                jsonString = null;

                if (parsedJson) {
                    this.#setJsonCache(url, parsedJson);
                }

                return (jsonPropertyPath) ? this.#getProperty(parsedJson, jsonPropertyPath, url) : parsedJson;
            } catch (e) {
                if (e.name === 'SyntaxError') {
                    this.#console.error(`[JSON Error] ${url} - ${e.message}`);
                    return new CrawlerJsonParseFailure(e.message, jsonString, url);
                } else {
                    this.#console.error(`[Error] ${url}`, e);
                    return new CrawlerJsonFailure(e.message, jsonString, url);
                }
            }
        } catch (e) {
            this.#console.error(e);
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
            this.#console.error(e);
            return new CrawlerFailure(e.message, url);
        }
    }

    async #requestGently(url, method = 'GET', options = {}) {
        let hostname = null;

        try {
            hostname = (new URL(url)).hostname;
        } catch (e) {
            this.#console.error(`[Error] Invalid URL: ${url} - ${e.message}`);
            return new CrawlerInvalidUrlFailure(e.message, url);
        }

        try {
            const now = Date.now();

            if (this.#minRequestDelayMs && this.#lastRequestTimestamps.has(hostname)) {
                const lastRequestTime = this.#lastRequestTimestamps.get(hostname);
                const elapsed = now - lastRequestTime;
                if (elapsed < this.#minRequestDelayMs) {
                    await this.#sleep(this.#minRequestDelayMs - elapsed);
                }
            }

            return await this.#request(url, method, options);
        } catch (e) {
            this.#console.error(e);
            return new CrawlerFailure(e.message, url);
        }
    }

    async #request(url, method = 'GET', { retryNotFound = false, retryFailed = true, retryTimeout = true, retryError = true, headers = null } = {}) {
        const maxAttempts = this.#maxRequestRetries + 1;
        let attempt = 1;
        let hostname = null;

        try {
            hostname = (new URL(url)).hostname;
        } catch (e) {
            this.#console.error(`[Error] Invalid URL: ${url} - ${e.message}`);
            return new CrawlerInvalidUrlFailure(e.message, url);
        }

        const requestHeaders = { ...this.#headers, ...(headers || {}) };

        let crawlerFailure = undefined;
        while (attempt <= maxAttempts) {
            const controller = new AbortController();
            const timeout = setTimeout(() => {
                controller.abort();
            }, this.#connectionTimeoutMs);

            try {
                if (this.#minRequestDelayMs) {
                    this.#lastRequestTimestamps.set(hostname, Date.now());
                }

                const response = await fetch(url, { method: method, signal: controller.signal, headers: requestHeaders });
                clearTimeout(timeout);

                if (response?.ok) {
                    return response;
                }

                throw new HTTPStatusError(response?.status);
            } catch (e) {
                clearTimeout(timeout);
                const retryStatus = `(${attempt}/${maxAttempts})`;
                if (e instanceof HTTPStatusError) {
                    if (e.code == 404) {
                        crawlerFailure = new CrawlerNotFoundFailure(e.message, e.code, url, crawlerFailure);
                        if (retryNotFound === true) {
                            this.#console.error(`[Not Found] ${retryStatus} ${url} - ${e.message}`);
                        } else {
                            this.#console.error(`[Not Found] ${url} - ${e.message}`);
                            break;
                        }
                    } else {
                        crawlerFailure = new CrawlerHTTPStatusFailure(e.message, e.code, url, crawlerFailure);
                        if (retryFailed === true) {
                            this.#console.error(`[Failed] ${retryStatus} ${url} - ${e.message}`);
                        } else {
                            this.#console.error(`[Failed] ${url} - ${e.message}`);
                            break;
                        }
                    }
                } else if (e.name === 'AbortError') {
                    crawlerFailure = new CrawlerRequestTimeoutFailure(e.message, url, crawlerFailure);
                    if (retryTimeout === true) {
                        this.#console.error(`[Timeout] ${retryStatus} ${url}`);
                    } else {
                        this.#console.error(`[Timeout] ${url}`);
                        break;
                    }
                } else {
                    crawlerFailure = new CrawlerRequestErrorFailure(e.message, url, crawlerFailure);
                    if (retryError === true) {
                        this.#console.error(`[Error] ${retryStatus} ${url} - ${e.message}`);
                    } else {
                        this.#console.error(`[Error] ${url} - ${e.message}`);
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
        if (this.#cacheTTL) {
            this.#jsonCache.set(url, {
                jsonObj: jsonObj,
                timestamp: Date.now()
            });
        }
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
            if (this.#cacheTTL) {
                for (const [url, cacheEntry] of this.#jsonCache) {
                    if (now - cacheEntry.timestamp >= this.#cacheTTL) {
                        this.#jsonCache.delete(url);
                    }
                }
            }

            if (this.#minRequestDelayMs) {
                for (const [hostname, timestamp] of this.#lastRequestTimestamps) {
                    if (now - timestamp >= this.#minRequestDelayMs) {
                        this.#lastRequestTimestamps.delete(hostname);
                    }
                }
            }
        } catch (e) {
            this.#console.error(e);
        }
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
            const json = JSON.stringify(object, null, 4);
            object = null;

            this.#console.error(`[Parse Error] Invalid object given:`, json);
            return new CrawlerJsonStructureFailure('Invalid object given', json, urlRef);
        }

        const value = propertyPath
            .replace(/\[([^\[\]]*)\]/g, ".$1.")
            .split(".")
            .filter((t) => t !== "")
            .reduce((prev, cur) => prev?.[cur], object);

        if (value !== undefined) {
            object = null;
            return value;
        }

        const json = JSON.stringify(object, null, 4);
        object = null;

        this.#console.error(`[Parse Error] Property path not found: '${propertyPath}'`, json);
        return new CrawlerJsonStructureFailure(`Property path not found: '${propertyPath}'`, json, urlRef);
    }

    #sleep(ms) {
        return new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    }

    #shuffle(arr) {
        const a = [...arr];
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
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
