import HTTPStatusError from './error.js';

class RelayServer {
    #host;
    #connectionTimeoutMs;
    #failedRequestDelayMs;
    #maxRequestRetries;
    #headers;
    #verbose;
    #console;

    constructor({ host = 'https://snapchatreverse.jaku.tv', connectionTimeoutMs = 9000, failedRequestDelayMs = 4500, maxRequestRetries = 2, verbose = true } = {}) {
        this.#host = host;
        this.#connectionTimeoutMs = connectionTimeoutMs;
        this.#failedRequestDelayMs = failedRequestDelayMs;
        this.#maxRequestRetries = maxRequestRetries;
        this.#headers = {
            'User-Agent': 'SnapCamera/1.21.0.0 (Windows 10 Version 2009)',
            'Content-Type': 'application/json',
            'X-Installation-Id': 'default'
        };

        this.#verbose = verbose;
        this.#console = this.#verbose ? console : {
            log: () => { },
            info: () => { },
            warn: () => { },
            error: () => { },
            debug: () => { }
        };
    }

    async getLens(lensId) {
        const result = await this.#request(`/vc/v1/explorer/lenses`, 'POST', JSON.stringify({ 'lenses': [lensId] }));
        if (result && result['lenses']) {
            return result['lenses'];
        }
        return null;
    }

    async getUnlock(lensId) {
        const unlock = await this.#request(`/vc/v1/explorer/unlock?uid=${lensId}`);
        if (unlock && unlock.lens_id && unlock.lens_url) {
            return unlock;
        }
        return null;
    }

    async #request(path, method = 'GET', body = null) {
        const url = `${this.#host}${path}`;
        const maxAttempts = this.#maxRequestRetries + 1;
        let attempt = 1;

        while (attempt <= maxAttempts) {
            const controller = new AbortController();
            const timeout = setTimeout(() => {
                controller.abort();
            }, this.#connectionTimeoutMs);

            try {
                let requestInit = { method: method, headers: this.#headers, signal: controller.signal };
                if (body) {
                    requestInit.body = body;
                }

                const response = await fetch(url, requestInit);
                clearTimeout(timeout);

                if (response?.ok) {
                    const data = (response.body) ? await response.text() : null;
                    return (data) ? JSON.parse(data) : null;
                }

                throw new HTTPStatusError(response?.status);
            } catch (e) {
                clearTimeout(timeout);
                if (e instanceof HTTPStatusError) {
                    if (e.code == 404) {
                        this.#console.error(`[Not Found] ${url} - ${e.message}`);
                        break;
                    } else {
                        this.#console.error(`[Failed] (${attempt}/${maxAttempts}) ${url} - ${e.message}`);
                    }
                } else if (e.name === 'AbortError') {
                    this.#console.error(`[Timeout] (${attempt}/${maxAttempts}) ${url}`);
                } else {
                    this.#console.error(`[Error] (${attempt}/${maxAttempts}) ${url} - ${e.message}`);
                }
            } finally {
                clearTimeout(timeout);
            }

            attempt++;
            if (attempt <= maxAttempts) {
                await this.#sleep(this.#failedRequestDelayMs);
            }
        }

        return null;
    }

    #sleep(ms) {
        return new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    }
}

export default RelayServer;
export { RelayServer };
