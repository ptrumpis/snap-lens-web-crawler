# Snap Lens Web Crawler
Crawl and download Snap Lenses from *lens.snapchat.com* with ease

## Usage
```javascript
import LensWebCrawler from "crawler.js";

const crawler = new LensWebCrawler();

// examples
const singeLens = await crawler.getLensByHash('32_CHAR_UUID');
const creatorLensArr = await searchByCreatorSlug('CREATOR_SLUG');
const searchResults = await crawler.searchLenses('SEARCH TERM');
```
