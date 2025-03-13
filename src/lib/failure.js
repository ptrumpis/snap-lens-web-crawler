class CrawlerFailure {
    constructor(message, url, previous = undefined) {
        this.message = message;
        this.url = url;
        this.previous = previous;
    }
}

class CrawlerInvalidUrlFailure extends CrawlerFailure {
    // Invalid URL provided
}

class CrawlerJsonFailure extends CrawlerFailure {
    // Base class for JSON failures
    constructor(message, json, url, previous) {
        super(message, url, previous);
        this.json = json;
    }
}

class CrawlerJsonParseFailure extends CrawlerJsonFailure {
    // JSON response parsing failed
}

class CrawlerJsonStructureFailure extends CrawlerJsonFailure {
    // JSON structure is unknown
}

class CrawlerRequestFailure extends CrawlerFailure {
    // Base class for request failures
}

class CrawlerRequestErrorFailure extends CrawlerRequestFailure {
    // Caought thrown error during request
}

class CrawlerRequestTimeoutFailure extends CrawlerRequestFailure {
    // Request timeout exceeded
}

class CrawlerHTTPStatusFailure extends CrawlerRequestFailure {
    // Base class for received HTTP status between 400 and 600
    constructor(message, code, url, previous) {
        super(message, url, previous);
        this.code = code;
    }
}

class CrawlerNotFoundFailure extends CrawlerHTTPStatusFailure {
    // HTTP status 404 received
}

export {
    CrawlerFailure,
    CrawlerInvalidUrlFailure,
    CrawlerJsonFailure,
    CrawlerJsonParseFailure,
    CrawlerJsonStructureFailure,
    CrawlerRequestFailure,
    CrawlerRequestErrorFailure,
    CrawlerRequestTimeoutFailure,
    CrawlerHTTPStatusFailure,
    CrawlerNotFoundFailure
}

export default {
    CrawlerFailure,
    CrawlerInvalidUrlFailure,
    CrawlerJsonFailure,
    CrawlerJsonParseFailure,
    CrawlerJsonStructureFailure,
    CrawlerRequestFailure,
    CrawlerRequestErrorFailure,
    CrawlerRequestTimeoutFailure,
    CrawlerHTTPStatusFailure,
    CrawlerNotFoundFailure
};
