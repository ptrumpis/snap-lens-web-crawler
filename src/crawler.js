import * as cheerio from 'cheerio';
import fetch from 'node-fetch';

export default class SnapLensWebCrawler {
    SCRIPT_SELECTOR = '#__NEXT_DATA__';

    TOP_CATEGORIES = {
        default: '/',
        face: '/category/face',
        world: '/category/world',
        music: '/category/music',
        live: '/category/web_live',
    };

    constructor(connectionTimeoutMs = 9000, headers = null) {
        this.json = {};
        this.connectionTimeoutMs = connectionTimeoutMs;
        this.headers = headers || {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
        };
    }

    mergeLensItems(item1, item2) {
        function isEmpty(value) {
            return !value ||
                (Array.isArray(value) && value.length === 0) ||
                (typeof value === "object" && value !== null && Object.keys(value).length === 0);
        }

        let merged = { ...item2, ...item1 };

        for (let key in merged) {
            if (isEmpty(item1[key])) {
                merged[key] = item2[key];
            }
        }

        return merged;
    }

    async getLensByHash(hash) {
        try {
            const url = 'https://lens.snapchat.com/' + hash;
            const lens = await this._extractLensesFromUrl(url, "props.pageProps.lensDisplayInfo");
            if (lens) {
                return this._formatLensItem(lens);
            }
        } catch (e) {
            console.error(e);
        }
        return null;
    }

    async getMoreLensesByHash(hash) {
        let lenses = [];
        try {
            const url = 'https://lens.snapchat.com/' + hash;
            const results = await this._extractLensesFromUrl(url, "props.pageProps.moreLenses");
            if (results) {
                for (const index in results) {
                    lenses.push(this._formatLensItem(results[index]));
                }
            }
        } catch (e) {
            console.error(e);
        }
        return lenses;
    }

    async getLensByCache(hash) {
        // TODO: implement
        return null;
    }

    async getMoreLensesByCache(hash) {
        // TODO: implement
        return null;
    }

    async getLensesByCreator(obfuscatedSlug, offset = 0, limit = 100) {
        limit = Math.min(100, limit);
        let lenses = [];
        try {
            const url = 'https://lensstudio.snapchat.com/v1/creator/lenses/?limit=' + limit + '&offset=' + offset + '&order=1&slug=' + obfuscatedSlug;
            const jsonString = await this._loadUrl(url);
            if (jsonString) {
                const json = JSON.parse(jsonString);

                if (json && json.lensesList) {
                    for (let i = 0; i < json.lensesList.length; i++) {
                        const item = json.lensesList[i];
                        if (item.lensId && item.deeplinkUrl && item.name && item.creatorName) {
                            lenses.push(this._formatLensItem(item, obfuscatedSlug));
                        }
                    }
                } else {
                    console.warn('JSON Property "lensesList" not found.', json);
                }
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
            const url = 'https://www.snapchat.com/explore/' + slug;
            const results = await this._extractLensesFromUrl(url, "props.pageProps.initialApolloState", "props.pageProps.encodedSearchResponse");
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
                    let sectionResults = [];
                    for (const index in searchResult.sections) {
                        if (searchResult.sections[index].title === 'Lenses') {
                            sectionResults = searchResult.sections[index].results;
                            break;
                        }
                    }

                    for (const index in sectionResults) {
                        if (sectionResults[index]?.result?.lens) {
                            let lens = sectionResults[index].result.lens;
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
            const url = 'https://www.snapchat.com/add/' + userName;
            const results = await this._extractLensesFromUrl(url, "props.pageProps.lenses");
            if (results) {
                for (const index in results) {
                    lenses.push(this._formatLensItem(results[index], userName));
                }
            }
        } catch (e) {
            console.error(e);
        }
        return lenses;
    }

    async getTopLenses(category = 'default', maxLenses = 100, sleep = 9000) {
        let lenses = [];
        try {
            if (!this.TOP_CATEGORIES[category]) {
                console.error('Unknown top lens category: ', category, "\nValid top lens categories are:", Object.getOwnPropertyNames(this.TOP_CATEGORIES));
                return null;
            }

            const categoryBaseUrl = 'https://www.snapchat.com/lens' + this.TOP_CATEGORIES[category];

            let hasMore = false;
            let cursorId = '';
            do {
                let url = categoryBaseUrl;
                if (hasMore && cursorId) {
                    url = categoryBaseUrl + "?cursor_id=" + cursorId;
                    await this._sleep(sleep);
                }

                const pageProps = await this._extractLensesFromUrl(url, "props.pageProps");
                if (pageProps?.topLenses) {
                    const results = pageProps.topLenses;
                    for (const index in results) {
                        if (maxLenses && lenses.length >= maxLenses) {
                            break;
                        }
                        lenses.push(this._formatLensItem(results[index]));
                    }
                }

                hasMore = pageProps?.hasMore || false;
                cursorId = pageProps?.nextCursorId || '';
            } while (hasMore && cursorId && !(maxLenses && lenses.length >= maxLenses));
        } catch (e) {
            console.error(e);
        }
        return lenses;
    }

    async _extractLensesFromUrl(url, ...jsonObjPath) {
        try {
            console.log('Crawling:', url);

            const body = await this._loadUrl(url);
            if (typeof body === 'string' && body) {
                const $ = cheerio.load(body);
                const jsonString = $(this.SCRIPT_SELECTOR).text();
                if (typeof jsonString === 'string' && jsonString) {
                    const jsonObj = JSON.parse(jsonString);
                    if (jsonObj) {
                        const lenses = this._getProperty(jsonObj, ...jsonObjPath);
                        if (typeof lenses !== 'undefined') {
                            return lenses;
                        } else {
                            console.warn('JSON property path not found', jsonObjPath, jsonObj);
                        }
                    } else {
                        console.warn('Unable to parse JSON string', jsonString);
                    }
                } else {
                    console.warn('Unable to read script tag', this.SCRIPT_SELECTOR);
                }
            }
        } catch (e) {
            console.error('Error extracting lenses from URL:', url, e);
        }

        return undefined;
    }

    async _loadUrl(url) {
        const controller = new AbortController();
        const timeout = setTimeout(() => {
            controller.abort();
        }, this.connectionTimeoutMs);

        try {
            const response = await fetch(url, { signal: controller.signal, headers: this.headers });
            if (response.status !== 200) {
                console.warn("Unexpected HTTP status:", response.status, url);
            }
            return await response.text();
        } catch (e) {
            console.error('Request failed:', url, e);
        } finally {
            clearTimeout(timeout);
        }

        return undefined;
    }

    _formatLensItem(lensItem, options = {}) {
        const { obfuscatedSlug = '', userName = '' } = options;

        const deeplinkUrl = lensItem.deeplinkUrl || lensItem.unlockUrl || "";
        const uuid = lensItem.scannableUuid || this._extractUuidFromDeeplink(deeplinkUrl);
        const lensId = lensItem.lensId || lensItem.id || "";

        let result = {
            //lens
            unlockable_id: lensId,
            uuid: uuid,
            snapcode_url: lensItem.snapcodeUrl || this._snapcodeUrl(uuid),

            lens_name: lensItem.lensName || lensItem.name || "",
            lens_creator_search_tags: lensItem.lensCreatorSearchTags || [],
            lens_status: "Live",

            user_display_name: lensItem.lensCreatorDisplayName || lensItem.creator?.title || lensItem.creatorName || "",
            user_name: lensItem.lensCreatorUsername || userName || "",
            user_profile_url: lensItem.userProfileUrl || this._profileUrl(lensItem.lensCreatorUsername || userName),
            user_id: lensItem.creatorUserId || "",
            user_profile_id: lensItem.creatorProfileId || "",

            deeplink: deeplinkUrl,
            icon_url: lensItem.iconUrl || "",
            thumbnail_media_url: lensItem.thumbnailUrl || lensItem.previewImageUrl || lensItem.lensPreviewImageUrl || "",
            thumbnail_media_poster_url: lensItem.thumbnailUrl || lensItem.previewImageUrl || lensItem.lensPreviewImageUrl || "",
            standard_media_url: lensItem.previewVideoUrl || lensItem.lensPreviewVideoUrl || "",
            obfuscated_user_slug: obfuscatedSlug || "",
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
        if (lensId && lensItem.lensResource) {
            Object.assign(result, {
                lens_id: lensId,
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

    _extractUuidFromDeeplink(deeplink) {
        if (typeof deeplink === "string" && deeplink && (deeplink.startsWith("https://www.snapchat.com/unlock/?") || deeplink.startsWith("https://snapchat.com/unlock/?"))) {
            let deeplinkURL = new URL(deeplink);
            const regexExp = /^[a-f0-9]{32}$/gi;
            if (regexExp.test(deeplinkURL.searchParams.get('uuid'))) {
                return deeplinkURL.searchParams.get('uuid');
            }
        }
        return '';
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
