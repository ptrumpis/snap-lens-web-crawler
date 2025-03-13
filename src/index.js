import SnapLensWebCrawler from "./lib/crawler.js";
import * as Failures from "./lib/failure.js";

export { SnapLensWebCrawler };
export * from "./lib/failure.js";

export default { SnapLensWebCrawler, ...Failures };
