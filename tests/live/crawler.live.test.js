import assert from 'assert';
import SnapLensWebCrawler from '../../src/lib/crawler.js';
import { CrawlerFailure } from '../../src/lib/failure.js';

describe('SnapLensWebCrawler [Live Test]', () => {
    let crawler;

    beforeEach(() => {
        crawler = new SnapLensWebCrawler({ connectionTimeoutMs: 6000, maxRequestRetries: 0, verbose: true });
    });

    afterEach(() => {
        crawler.destroy();
    });

    it('should get lenses from a URL', async () => {
        const lenses = await crawler.getLensesFromUrl('https://www.snapchat.com/lens/e66f492e1fdf405c90bceec3b136ebf1?type=SNAPCODE&metadata=01');
        assert(Array.isArray(lenses), 'Result should be an array');
        assert.ok(lenses.length > 1, 'Should return more than 1 lens');
    });

    it('should get a lens by hash', async () => {
        const lens = await crawler.getLensByHash('e66f492e1fdf405c90bceec3b136ebf1');
        assert(!(lens instanceof CrawlerFailure), 'Lens should not be an instance of CrawlerFailure');
        assert(lens, 'Lens should be returned');
        assert.strictEqual(lens.uuid, 'e66f492e1fdf405c90bceec3b136ebf1', 'Lens UUID should match');
        assert.strictEqual(lens.unlockable_id, '66383101410236', 'Lens ID should match');
        assert.strictEqual(lens.lens_name, 'Snow White Dog', 'Lens name should match');
    });

    it('should get a lens by archived snapshot', async () => {
        const lens = await crawler.getLensByArchivedSnapshot('e66f492e1fdf405c90bceec3b136ebf1');
        assert(!(lens instanceof CrawlerFailure), 'Lens should not be an instance of CrawlerFailure');
        assert(lens, 'Lens should be returned');
        assert.strictEqual(lens.uuid, 'e66f492e1fdf405c90bceec3b136ebf1', 'Lens UUID should match');
        assert.strictEqual(lens.unlockable_id, '66383101410236', 'Lens ID should match');
        assert.strictEqual(lens.lens_name, 'Snow White Dog', 'Lens name should match');
    });

    it('should get more lenses by hash', async () => {
        const lenses = await crawler.getMoreLensesByHash('e66f492e1fdf405c90bceec3b136ebf1');
        assert(Array.isArray(lenses), 'Result should be an array');
        assert.strictEqual(lenses.length, 12, 'Should return 12 lenses');
    });

    it('should get lenses by username', async () => {
        const lenses = await crawler.getLensesByUsername('jppirie');
        assert(Array.isArray(lenses), 'Result should be an array');
        assert.ok(lenses.length >= 16, 'Should return 16 lenses or more');
    });

    it('should get lenses by creator', async () => {
        const lenses = await crawler.getLensesByCreator('-jYwAMbQOscjfh5HM_cw6w', 100);
        assert(Array.isArray(lenses), 'Result should be an array');
        assert.strictEqual(lenses.length, 100, 'Should return 100 lenses');
    });

    it('should get top lenses by category', async () => {
        const lenses = await crawler.getTopLensesByCategory('default', 20);
        assert(Array.isArray(lenses), 'Result should be an array');
        assert.strictEqual(lenses.length, 20, 'Should return 20 lenses');
    });

    it('should search lenses', async () => {
        const lenses = await crawler.searchLenses('cute');
        assert(Array.isArray(lenses), 'Result should be an array');
        assert.strictEqual(lenses.length, 24, 'Should return 24 lenses');
    });
});