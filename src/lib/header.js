import { FingerprintGenerator } from 'fingerprint-generator';

class SpoofHeader {
    #headerCache = new Map();
    #config = {};

    constructor(config = {}) {
        const defaultConfig = {
            browsers: [
                { name: 'chrome', minVersion: 114 },
                { name: 'firefox', minVersion: 115 },
                { name: 'safari', minVersion: 16 },
            ],
            devices: ['desktop', 'mobile'],
            operatingSystems: ['windows', 'macos', 'android', 'ios'],
            httpVersion: '1',
        };

        this.#config = { ...defaultConfig, ...config };
    }

    getHeadersFor(url, locales = ['en-US'], useCache = true) {
        const domain = new URL(url).hostname;
        const cacheKey = `${domain}:${locales.join(',')}`;

        if (useCache && this.#headerCache.has(cacheKey)) {
            return this.#headerCache.get(cacheKey);
        }

        const generator = new FingerprintGenerator(this.#config);
        const { headers } = generator.getFingerprint({ locales });

        if (useCache) {
            this.#headerCache.set(cacheKey, headers);
        }

        return headers;
    }
}

export default SpoofHeader;
export { SpoofHeader };