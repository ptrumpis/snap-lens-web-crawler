import LensWebCrawler from "./crawler.js";

const crawler = new LensWebCrawler();

// examples
console.info('Uncomment code examples in src/index.js to get started.');

//const singeLens = await crawler.getLensByHash('87b1a718d4184ea98c3a0a213414425c');
//console.log(singeLens);

//const singeLensRaw = await crawler.getLensByHash('87b1a718d4184ea98c3a0a213414425c', true);
//console.log(singeLensRaw.props.pageProps.lensDisplayInfo);

//const searchResults = await crawler.searchLenses('cute');
//console.log(searchResults);

//const searchResultsRaw = await crawler.searchLenses('cute', true);
//const searchResultsRawDecoded = JSON.parse(searchResultsRaw.props.pageProps.encodedSearchResponse);
//console.log(searchResultsRawDecoded.sections[1].results);

//const creatorLenses = await crawler.getLensesByCreator('ZAY15DW3mdvHyeryV7riDQ');
//console.log(creatorLenses);

//const creatorLensesRaw = await crawler.getLensesByCreator('ZAY15DW3mdvHyeryV7riDQ', 0, 100, true);
//console.log(creatorLensesRaw.lensesList);

//const userProfileLenses = await crawler.getUserProfileLenses('mahmoyd_awa2021');
//console.log(userProfileLenses);

//const userProfileLensesRaw = await crawler.getUserProfileLenses('mahmoyd_awa2021', true);
//console.log(userProfileLensesRaw.props.pageProps.lenses);

//const topLenses = await crawler.getTopLenses();
//console.log(topLenses);

//const topLensesRaw = await crawler.getTopLenses(true);
//console.log(topLensesRaw.props.pageProps.topLenses);
