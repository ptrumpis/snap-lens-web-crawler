import * as cheerio from 'cheerio';
import fetch from 'node-fetch';

export default class SnapLensWebCrawler {
    SCRIPT_SELECTOR = '#__NEXT_DATA__';
    constructor(connectionTimeoutMs = 9000) {
        this.json = {};
        this.connectionTimeoutMs = connectionTimeoutMs;
    }

    async getLensByHash(hash) {
        try {
            const body = await this._loadUrl('https://lens.snapchat.com/' + hash);
            const $ = cheerio.load(body);
            const json = JSON.parse($(this.SCRIPT_SELECTOR).text());
            if (json && json?.props?.pageProps?.lensDisplayInfo) {
                return this._lensInfoToLens(json.props.pageProps.lensDisplayInfo);
            }
        } catch (e) {
            console.error(e);
        }
        return null;
    }

    async getLensesByCreator(obfuscatedSlug, offset = 0, limit = 100) {
        let lenses = [];
        try {
            limit = Math.min(100, limit);
            const jsonString = await this._loadUrl('https://lensstudio.snapchat.com/v1/creator/lenses/?limit=' + limit + '&offset=' + offset + '&order=1&slug=' + obfuscatedSlug);
            if (jsonString) {
                const json = JSON.parse(jsonString);
                if (json && json.lensesList) {
                    for (let i = 0; i < json.lensesList.length; i++) {
                        const item = json.lensesList[i];
                        if (item.lensId && item.deeplinkUrl && item.name && item.creatorName) {
                            lenses.push(this._creatorItemToLens(item, obfuscatedSlug));
                        }
                    }
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
            const body = await this._loadUrl('https://www.snapchat.com/explore/' + slug);
            const $ = cheerio.load(body);
            const json = JSON.parse($(this.SCRIPT_SELECTOR).text());

            if (json && json?.props?.pageProps?.initialApolloState) {
                // old data structure
                const results = json.props.pageProps.initialApolloState;
                for (const key in results) {
                    if (key != 'ROOT_QUERY') {
                        if (results[key].id && results[key].deeplinkUrl && results[key].lensName) {
                            lenses.push(this._searchItemToLens(results[key]));
                        }
                    }
                }
            } else if (json && json?.props?.pageProps?.encodedSearchResponse) {
                // new data structure introduced in summer 2024
                const searchResult = JSON.parse(json.props.pageProps.encodedSearchResponse);
                let results = [];
                for (const index in searchResult.sections) {
                    if (searchResult.sections[index].title === 'Lenses') {
                        results = searchResult.sections[index].results;
                        break;
                    }
                }

                for (const index in results) {
                    if (results[index]?.result?.lens) {
                        let lens = results[index].result.lens;
                        if (lens.lensId && lens.deeplinkUrl && lens.name) {
                            lenses.push(this._searchItemToLens(lens));
                        }
                    }
                }
            }
        } catch (e) {
            console.error(e);
        }
        return lenses;
    }

    async getTopLenses() {
        let lenses = [];
        try {
            const body = await this._loadUrl('https://www.snapchat.com/lens');
            const $ = cheerio.load(body);
            const json = JSON.parse($(this.SCRIPT_SELECTOR).text());

            if (json && json?.props?.pageProps?.topLenses) {
                const results = json.props.pageProps.topLenses;
                for (const index in results) {
                    lenses.push(this._lensInfoToLens(results[index]));
                }
            }
        } catch (e) {
            console.error(e);
        }
        return lenses;
    }

    async _loadUrl(url) {
        const controller = new AbortController();
        const timeout = setTimeout(() => {
            controller.abort();
        }, this.connectionTimeoutMs);

        try {
            const response = await fetch(url, { signal: controller.signal });
            if (response.status !== 200) {
                console.warn("Unexpected HTTP status", response.status);
            }
            return await response.text();
        } catch (e) {
            console.error(e);
        } finally {
            clearTimeout(timeout);
        }

        return null;
    }

    _creatorItemToLens(item, obfuscatedSlug = '') {
        const uuid = this._extractUuidFromDeeplink(item.deeplinkUrl);
        return {
            unlockable_id: item.lensId,
            uuid: uuid,
            snapcode_url: item.snapcodeUrl,
            user_display_name: item.creatorName,
            lens_name: item.name,
            lens_tags: "",
            lens_status: "Live",
            deeplink: item.deeplinkUrl,
            icon_url: item.iconUrl,
            thumbnail_media_url: item.thumbnailUrl || "",
            thumbnail_media_poster_url: item.thumbnailUrl || "",
            standard_media_url: item.previewVideoUrl || "",
            standard_media_poster_url: "",
            obfuscated_user_slug: obfuscatedSlug,
            image_sequence: {
                url_pattern: item.thumbnailSequence?.urlPattern || "",
                size: item.thumbnailSequence?.numThumbnails || 0,
                frame_interval_ms: item.thumbnailSequence?.animationIntervalMs || 0
            }
        };
    }

    _searchItemToLens(searchItem) {
        const uuid = this._extractUuidFromDeeplink(searchItem.deeplinkUrl);
        let result = {
            unlockable_id: searchItem.id || searchItem.lensId,
            uuid: uuid,
            snapcode_url: "https://app.snapchat.com/web/deeplink/snapcode?data=" + uuid + "&version=1&type=png",
            user_display_name: searchItem.creator?.title || "",
            lens_name: searchItem.lensName || searchItem.name ||"",
            lens_tags: "",
            lens_status: "Live",
            deeplink: searchItem.deeplinkUrl || "",
            icon_url: searchItem.iconUrl || "",
            thumbnail_media_url: searchItem.previewImageUrl || "",
            thumbnail_media_poster_url: searchItem.previewImageUrl || "",
            standard_media_url: "",
            standard_media_poster_url: "",
            obfuscated_user_slug: "",
            image_sequence: {}
        };
        if (searchItem.thumbnailSequence) {
            result.image_sequence = {
                url_pattern: searchItem.thumbnailSequence?.urlPattern || "",
                size: searchItem.thumbnailSequence?.numThumbnails || 0,
                frame_interval_ms: searchItem.thumbnailSequence?.animationIntervalMs || 0
            }
        }
        return result;
    }

    _lensInfoToLens(lensInfo) {
        const uuid = lensInfo.scannableUuid || "";
        return {
            //lens
            unlockable_id: lensInfo.lensId,
            uuid: uuid,
            snapcode_url: "https://app.snapchat.com/web/deeplink/snapcode?data=" + uuid + "&version=1&type=png",
            user_display_name: lensInfo.lensCreatorDisplayName || "",
            lens_name: lensInfo.lensName || "",
            lens_tags: "",
            lens_status: "Live",
            deeplink: lensInfo.unlockUrl || "",
            icon_url: lensInfo.iconUrl || "",
            thumbnail_media_url: lensInfo.lensPreviewImageUrl || "",
            thumbnail_media_poster_url: lensInfo.lensPreviewImageUrl || "",
            standard_media_url: lensInfo.lensPreviewVideoUrl || "",
            standard_media_poster_url: "",
            obfuscated_user_slug: "",
            image_sequence: {},
            //unlock
            lens_id: lensInfo.lensId,
            lens_url: lensInfo.lensResource?.archiveLink || "",
            signature: lensInfo.lensResource?.signature || "",
            hint_id: "",
            additional_hint_ids: {}
        };
    }

    _extractUuidFromDeeplink(deeplink) {
        if (typeof deeplink === "string" && deeplink.startsWith("https://www.snapchat.com/unlock/?")) {
            let deeplinkURL = new URL(deeplink);
            const regexExp = /^[a-f0-9]{32}$/gi;
            if (regexExp.test(deeplinkURL.searchParams.get('uuid'))) {
                return deeplinkURL.searchParams.get('uuid');
            }
        }
        return '';
    }
}
