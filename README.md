# 👻 Snap Lens Web Crawler
Crawl and download Snap Lenses from *lens.snapchat.com* with ease.

## ⚠️ Requirements
- cheerio
- node-fetch

## 🚀 Usage
```javascript
import LensWebCrawler from "./crawler.js";

const crawler = new LensWebCrawler();

// examples
const singeLens = await crawler.getLensByHash('32_CHAR_UUID');
const creatorLenses = await crawler.searchByCreatorSlug('CREATOR_SLUG');
const searchResults = await crawler.searchLenses('SEARCH TERM');
```

## ℹ️  Info
The return values are Snap Camera compatible object(s).

This crawler is a dependency of [Snap Camera Server](https://github.com/ptrumpis/snap-camera-server)

## ❤️ Support
If you like my work and want to support me, feel free to invite me for a virtual coffee ☕

- [☕ Ko-fi](https://ko-fi.com/ptrumpis)
- [☕ Buy me a Coffee](https://www.buymeacoffee.com/ptrumpis)
- [☕ Liberapay](https://liberapay.com/ptrumpis/)

You can also become my GitHub Sponsor

---

© 2023 [Patrick Trumpis](https://github.com/ptrumpis)
