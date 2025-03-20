import assert from 'assert';
import nock from 'nock';
import SnapLensWebCrawler from '../src/lib/crawler.js';
import { CrawlerFailure, CrawlerHTTPStatusFailure, CrawlerNotFoundFailure } from '../src/lib/failure.js';

function getMockPage(mockJsonData) {
    const mockHtmlResponse = `
        <html>
            <head><title>Mock Page</title></head>
            <body>
                <script id="__NEXT_DATA__" type="application/json">
                    ${JSON.stringify(mockJsonData)}
                </script>
            </body>
        </html>
    `;
    return mockHtmlResponse;
}

describe('SnapLensWebCrawler', () => {
    let crawler;

    beforeEach(() => {
        crawler = new SnapLensWebCrawler({ maxRequestRetries: 0, verbose: false });
    });

    afterEach(() => {
        crawler.destroy();
        nock.cleanAll();
    });

    it('should get lenses from a URL', async () => {
        const mockJsonData = {
            props: {
                pageProps: {
                    lensDisplayInfo: [{ scannableUuid: 'example-hash1', lensId: '11234567890', lensName: 'Test Lens 1' }],
                    moreLenses: [{ scannableUuid: 'example-hash2', lensId: '21234567890', lensName: 'Test Lens 2' }],
                    lenses: [{ scannableUuid: 'example-hash3', lensId: '31234567890', lensName: 'Test Lens 3' }],
                    topLenses: [{ scannableUuid: 'example-hash4', lensId: '41234567890', lensName: 'Test Lens 4' }]
                }
            }
        };

        nock('https://example.com')
            .get('/lenses')
            .reply(200, getMockPage(mockJsonData), { 'Content-Type': 'text/html' });

        const lenses = await crawler.getLensesFromUrl('https://example.com/lenses');
        assert(Array.isArray(lenses), 'Result should be an array');
        assert.strictEqual(lenses.length, 4, 'Should return 4 lenses');
    });

    it('should get a lens by hash', async () => {
        const mockJsonData = {
            props: {
                pageProps: {
                    lensDisplayInfo: {
                        scannableUuid: 'example-hash',
                        lensId: '11234567890',
                        lensName: 'Test Lens'
                    }
                }
            }
        };

        nock('https://lens.snapchat.com')
            .get('/example-hash')
            .reply(200, getMockPage(mockJsonData), { 'Content-Type': 'text/html' });

        const lens = await crawler.getLensByHash('example-hash');
        assert(!(lens instanceof CrawlerFailure), 'Lens should not be an instance of CrawlerFailure');
        assert(lens, 'Lens should be returned');
        assert.strictEqual(lens.uuid, 'example-hash', 'Lens UUID should match');
        assert.strictEqual(lens.unlockable_id, '11234567890', 'Lens ID should match');
        assert.strictEqual(lens.lens_name, 'Test Lens', 'Lens name should match');
    });


    it('should get a lens by archived snapshot', async () => {
        const mockWaybackResponse = {
            archived_snapshots: {
                closest: {
                    available: true,
                    url: 'https://web.archive.org/web/20220101000000/https://lens.snapchat.com/example-hash',
                    timestamp: '20220101000000',
                    status: '200'
                }
            }
        };

        const mockJsonData = {
            props: {
                pageProps: {
                    lensDisplayInfo: {
                        scannableUuid: 'example-hash',
                        lensId: '11234567890',
                        lensName: 'Test Lens',
                        lensResource: {
                            archiveLink: 'https://example.com/download/file.lns'
                        }
                    }
                }
            }
        };

        nock('https://archive.org')
            .get('/wayback/available')
            .query((query) => query.url === 'lens.snapchat.com/example-hash*')
            .reply(200, mockWaybackResponse);

        nock('https://web.archive.org')
            .get('/web/20220101000000/https://lens.snapchat.com/example-hash')
            .reply(200, getMockPage(mockJsonData), { 'Content-Type': 'text/html' });

        const lens = await crawler.getLensByArchivedSnapshot('example-hash');
        assert(!(lens instanceof CrawlerFailure), 'Lens should not be an instance of CrawlerFailure');
        assert(lens, 'Lens should be returned');
        assert.strictEqual(lens.uuid, 'example-hash', 'Lens UUID should match');
        assert.strictEqual(lens.unlockable_id, '11234567890', 'Lens ID should match');
        assert.strictEqual(lens.lens_name, 'Test Lens', 'Lens name should match');
    });

    it('should get more lenses by hash', async () => {
        const mockJsonData = {
            props: {
                pageProps: {
                    moreLenses: [
                        { scannableUuid: 'example-hash1', lensId: '11234567890', lensName: 'Test Lens 1' },
                        { scannableUuid: 'example-hash2', lensId: '21234567890', lensName: 'Test Lens 2' },
                        { scannableUuid: 'example-hash3', lensId: '31234567890', lensName: 'Test Lens 3' }
                    ],
                }
            }
        };

        nock('https://lens.snapchat.com')
            .get('/example-hash')
            .reply(200, getMockPage(mockJsonData), { 'Content-Type': 'text/html' });

        const lenses = await crawler.getMoreLensesByHash('example-hash');
        assert(Array.isArray(lenses), 'Result should be an array');
        assert.strictEqual(lenses.length, 3, 'Should return 3 lenses');
    });

    it('should get lenses by username', async () => {
        const mockJsonData = {
            props: {
                pageProps: {
                    lenses: [
                        { scannableUuid: 'example-hash1', lensId: '11234567890', lensName: 'Test Lens 1' },
                        { scannableUuid: 'example-hash2', lensId: '21234567890', lensName: 'Test Lens 2' },
                        { scannableUuid: 'example-hash3', lensId: '31234567890', lensName: 'Test Lens 3' }
                    ],
                }
            }
        };

        nock('https://www.snapchat.com')
            .get('/add/example-username')
            .reply(200, getMockPage(mockJsonData), { 'Content-Type': 'text/html' });

        const lenses = await crawler.getLensesByUsername('example-username');
        assert(Array.isArray(lenses), 'Result should be an array');
        assert.strictEqual(lenses.length, 3, 'Should return 3 lenses');
    });

    it('should get lenses by creator', async () => {
        const mockJsonData = {
            lensesList: [
                { lensId: '11234567890', name: 'Test Lens 1', creatorName: 'test', deeplinkUrl: 'https://www.snapchat.com/unlock/?type=SNAPCODE&uuid=example-hash&metadata=01' },
                { lensId: '21234567890', name: 'Test Lens 2', creatorName: 'test', deeplinkUrl: 'https://www.snapchat.com/unlock/?type=SNAPCODE&uuid=example-hash&metadata=01' },
                { lensId: '31234567890', name: 'Test Lens 3', creatorName: 'test', deeplinkUrl: 'https://www.snapchat.com/unlock/?type=SNAPCODE&uuid=example-hash&metadata=01' }
            ],
        };

        nock('https://lensstudio.snapchat.com')
            .get('/v1/creator/lenses/')
            .query((query) => query.slug === 'example-slug')
            .reply(200, JSON.stringify(mockJsonData), { 'Content-Type': 'application/json' });

        const lenses = await crawler.getLensesByCreator('example-slug');
        assert(Array.isArray(lenses), 'Result should be an array');
        assert.strictEqual(lenses.length, 3, 'Should return 3 lenses');
    });

    it('should get top lenses by category', async () => {
        const mockJsonData = {
            props: {
                pageProps: {
                    topLenses: [
                        { scannableUuid: 'example-hash1', lensId: '11234567890', lensName: 'Test Lens 1' },
                        { scannableUuid: 'example-hash2', lensId: '21234567890', lensName: 'Test Lens 2' },
                        { scannableUuid: 'example-hash3', lensId: '31234567890', lensName: 'Test Lens 3' }
                    ],
                }
            }
        };

        nock('https://www.snapchat.com')
            .get('/lens/')
            .reply(200, getMockPage(mockJsonData), { 'Content-Type': 'text/html' });

        const lenses = await crawler.getTopLensesByCategory('default');
        assert(Array.isArray(lenses), 'Result should be an array');
    });

    it('should search lenses', async () => {
        const mockJsonData = {
            props: {
                pageProps: {
                    encodedSearchResponse: JSON.stringify({
                        sections: [
                            {
                                title: 'Lenses',
                                sectionType: 6,
                                results: [
                                    {
                                        resultType: 6,
                                        result: {
                                            "$case": "lens",
                                            lens: {
                                                lensId: "11234567890",
                                                name: "Test Lens 1",
                                                deeplinkUrl: 'https://www.snapchat.com/unlock/?type=SNAPCODE&uuid=example-hash&metadata=01'
                                            }
                                        }
                                    },
                                    {
                                        resultType: 6,
                                        result: {
                                            "$case": "lens",
                                            lens: {
                                                lensId: "21234567890",
                                                name: "Test Lens 2",
                                                deeplinkUrl: 'https://www.snapchat.com/unlock/?type=SNAPCODE&uuid=example-hash&metadata=01'
                                            }
                                        }
                                    }
                                ]
                            }
                        ]
                    })
                }
            }
        };

        nock('https://www.snapchat.com')
            .get('/explore/example-search')
            .reply(200, getMockPage(mockJsonData), { 'Content-Type': 'text/html' });

        const lenses = await crawler.searchLenses('example-search');
        assert(Array.isArray(lenses), 'Result should be an array');
        assert.strictEqual(lenses.length, 2, 'Should return 2 lenses');
    });

    it('should handle a HTTP 400 request gracefully', async () => {
        nock('https://example.com')
            .get('/should-fail-with-400')
            .reply(400, { error: 'Bad Request' });

        const result = await crawler.getLensesFromUrl('https://example.com/should-fail-with-400');
        assert(result instanceof CrawlerHTTPStatusFailure, 'Result should be an error');
    });

    it('should handle a HTTP 404 request gracefully', async () => {
        nock('https://example.com')
            .get('/should-fail-with-404')
            .reply(404, { error: 'Not Found' });

        const result = await crawler.getLensesFromUrl('https://example.com/should-fail-with-404');
        assert(result instanceof CrawlerNotFoundFailure, 'Result should be an error');
    });

    it('should handle a HTTP 500 request gracefully', async () => {
        nock('https://example.com')
            .get('/should-fail-with-500')
            .reply(500, { error: 'Internal Server Error' });

        const result = await crawler.getLensesFromUrl('https://example.com/should-fail-with-500');
        assert(result instanceof CrawlerHTTPStatusFailure, 'Result should be an error');
    });
});