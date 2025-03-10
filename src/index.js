import SnapLensWebCrawler from "./lib/crawler.js";
import { CrawlerFailure, CrawlerInvalidUrlFailure, CrawlerJsonFailure, CrawlerJsonParseFailure, CrawlerJsonStructureFailure, CrawlerRequestFailure, CrawlerRequestErrorFailure, CrawlerRequestTimeoutFailure, CrawlerHTTPStatusFailure, CrawlerNotFoundFailure } from "./lib/failure.js";

export { SnapLensWebCrawler };
export { CrawlerFailure };
export { CrawlerInvalidUrlFailure };
export { CrawlerJsonFailure };
export { CrawlerJsonParseFailure };
export { CrawlerJsonStructureFailure };
export { CrawlerRequestFailure };
export { CrawlerRequestErrorFailure };
export { CrawlerRequestTimeoutFailure };
export { CrawlerHTTPStatusFailure };
export { CrawlerNotFoundFailure };

export default { SnapLensWebCrawler, CrawlerFailure, CrawlerInvalidUrlFailure, CrawlerJsonFailure, CrawlerJsonParseFailure, CrawlerJsonStructureFailure, CrawlerRequestFailure, CrawlerRequestErrorFailure, CrawlerRequestTimeoutFailure, CrawlerHTTPStatusFailure, CrawlerNotFoundFailure };
