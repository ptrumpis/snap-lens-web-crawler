# đģ Snap Lens Web Crawler
Crawl and download Snap Lenses from *lens.snapchat.com* with ease.

## â ī¸ Requirements
- cheerio
- node-fetch

## đ Usage
```javascript
import LensWebCrawler from "./crawler.js";

const crawler = new LensWebCrawler();

// examples
const singeLens = await crawler.getLensByHash('32_CHAR_UUID');
const creatorLenses = await crawler.searchByCreatorSlug('CREATOR_SLUG');
const searchResults = await crawler.searchLenses('SEARCH TERM');
```

## âšī¸ Info
The return values are Snap Camera compatible object(s).

This crawler is a dependency of [Snap Camera Server](https://github.com/ptrumpis/snap-camera-server)

## â¤ī¸ Support
If you like my work and want to support me, feel free to invite me for a virtual coffee â

- [â Ko-fi](https://ko-fi.com/ptrumpis)
- [â Buy me a Coffee](https://www.buymeacoffee.com/ptrumpis)
- [â Liberapay](https://liberapay.com/ptrumpis/)

You can also become my GitHub Sponsor

---

ÂŠ 2023 [Patrick Trumpis](https://github.com/ptrumpis)
