import fetch from 'node-fetch';

class RelayServer {
    #host;
    #timeoutMs;
    #headers;

    constructor(host = 'https://snapchatreverse.jaku.tv', timeoutMs = 6000) {
        this.#host = host;
        this.#timeoutMs = timeoutMs;
        this.#headers = new Headers({
            'User-Agent': 'SnapCamera/1.21.0.0 (Windows 10 Version 2009)',
            'Content-Type': 'application/json',
            'X-Installation-Id': 'default'
        });
    }

    async getDownloadUrl(lensId) {
        const unlock = await this.#request(`/vc/v1/explorer/unlock?uid=${lensId}`);
        if (unlock && unlock.lens_id && unlock.lens_url) {
            return unlock.lens_url;
        }
        return null;
    }

    async #request(path, method = 'GET', body = null) {
        const controller = new AbortController();
        const timeout = setTimeout(() => {
            controller.abort();
        }, this.#timeoutMs);

        const url = `${this.#host}${path}`;

        try {
            let requestInit = { method: method, headers: this.#headers, signal: controller.signal };
            if (body) {
                requestInit.body = body;
            }

            const response = await fetch(url, requestInit);
            clearTimeout(timeout);

            if (response?.ok) {
                const data = await response.text();
                if (data) {
                    return JSON.parse(data);
                }
            }
        } catch (e) {
            if (e.name === 'AbortError') {
                console.error(`[Timeout]: ${url}`);
            } else {
                console.error(`[Error]: ${url} - ${e.message}`);
            }
        } finally {
            clearTimeout(timeout);
        }

        return null;
    }
}

export default RelayServer;
export { RelayServer };
