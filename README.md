# Snap Lens Web Crawler
Crawl and download Snap Lenses from *lens.snapchat.com* with ease

## Usage
```javascript
import LensWebCrawler from "crawler.js";

const crawler = new LensWebCrawler();

// examples
const singeLens = await crawler.getLensByHash('32_CHAR_UUID');
const creatorLenses = await crawler.searchByCreatorSlug('CREATOR_SLUG');
const searchResults = await crawler.searchLenses('SEARCH TERM');
```

## Info
The return values are Snap Camera compatible object(s)

© [Patrick Trumpis](https://github.com/ptrumpis)
