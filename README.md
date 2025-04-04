[![GitHub License](https://img.shields.io/github/license/ptrumpis/snap-lens-web-crawler)](https://github.com/ptrumpis/snap-lens-web-crawler?tab=GPL-3.0-1-ov-file)
[![GitHub Release Date](https://img.shields.io/github/release-date/ptrumpis/snap-lens-web-crawler)](https://github.com/ptrumpis/snap-lens-web-crawler/releases/latest)
[![GitHub Release](https://img.shields.io/github/v/release/ptrumpis/snap-lens-web-crawler)](https://github.com/ptrumpis/snap-lens-web-crawler/releases/latest)
[![GitHub Commits](https://img.shields.io/github/commit-activity/t/ptrumpis/snap-lens-web-crawler)](https://github.com/ptrumpis/snap-lens-web-crawler/commits)
[![GitHub stars](https://img.shields.io/github/stars/ptrumpis/snap-lens-web-crawler?style=flat)](https://github.com/ptrumpis/snap-lens-web-crawler/stargazers) 
[![GitHub forks](https://img.shields.io/github/forks/ptrumpis/snap-lens-web-crawler?style=flat)](https://github.com/ptrumpis/snap-lens-web-crawler/forks)

# 👻 Snap Lens Web Crawler
JavaScript library to crawl and download Snap Lenses from *lens.snapchat.com* with ease.  

## 🚀 Usage
### npm
```shell
npm i @ptrumpis/snap-lens-web-crawler
```

### JavaScript

Example:
```javascript
import LensWebCrawler from "@ptrumpis/snap-lens-web-crawler/crawler";

const crawler = new LensWebCrawler();

// examples
const topLenses = await crawler.getTopLenses();
const singeLens = await crawler.getLensByHash('32_CHAR_UUID');
const creatorLenses = await crawler.getLensesByCreator('CREATOR_SLUG');
const userProfileLenses = await crawler.getUserProfileLenses('USERNAME');
const searchResults = await crawler.searchLenses('SEARCH TERM');
```

## ℹ️ Info
### Dependents
This package is a dependency of:  
[👻 Snap Camera Server](https://github.com/ptrumpis/snap-camera-server)

The return values are Snap Camera / Snap Camera Server compatible object(s).

## ❤️ Support
If you like my work and want to support me, feel free to invite me for a virtual coffee ☕  

[![Ko-fi](https://img.shields.io/badge/Ko--fi-F16061?style=for-the-badge&logo=ko-fi&logoColor=white)](https://ko-fi.com/ptrumpis)
[![Buy me a Coffee](https://img.shields.io/badge/Buy_Me_A_Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/ptrumpis)
[![Liberapay](https://img.shields.io/badge/Liberapay-F6C915?style=for-the-badge&logo=liberapay&logoColor=black)](https://liberapay.com/ptrumpis/)
[![PayPal](https://img.shields.io/badge/PayPal-00457C?style=for-the-badge&logo=paypal&logoColor=white)](https://www.paypal.com/donate/?hosted_button_id=D2T92FVZAE65L)

You can also become my GitHub Sponsor  

[![Sponsor](https://img.shields.io/badge/sponsor-30363D?style=for-the-badge&logo=GitHub-Sponsors&logoColor=#white)](https://github.com/sponsors/ptrumpis)

---

© 2023-2025 [Patrick Trumpis](https://github.com/ptrumpis)
