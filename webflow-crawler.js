const { chromium } = require('playwright');
const fs = require('node:fs').promises;
const path = require('node:path');
const { createHash } = require('node:crypto');

const OUTPUT_DIR = './raw_download';
const ASSETS_DIR = path.join(OUTPUT_DIR, 'assets');
const PAGES_DIR = path.join(OUTPUT_DIR, 'pages');
const MANIFEST_FILE = path.join(OUTPUT_DIR, 'manifest.json');

const TARGET_PAGES = [
  'https://apply.agency/',
  'https://apply.agency/cases'
];

const WEBFLOW_DOMAINS = [
  'webflow.com',
  'cdn.prod.website-files.com',
  'assets.website-files.com',
  'uploads-ssl.webflow.com',
  'assets-global.website-files.com'
];

// Random delay between requests to avoid rate limiting
function randomDelay(min = 1000, max = 3000) {
  return new Promise(resolve => {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    setTimeout(resolve, delay);
  });
}

function isWebflowAsset(url) {
  try {
    const hostname = new URL(url).hostname;
    return WEBFLOW_DOMAINS.some(domain => hostname.includes(domain));
  } catch {
    return false;
  }
}

async function downloadAsset(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Referer': 'https://apply.agency/'
        }
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const buffer = await response.arrayBuffer();
      const hash = createHash('md5').update(url).digest('hex');
      const ext = path.extname(url) || '.bin';
      const outputPath = path.join(ASSETS_DIR, `${hash}${ext}`);

      await fs.writeFile(outputPath, Buffer.from(buffer));
      console.log('Downloaded:', url, '→', outputPath);
      
      // Random delay between asset downloads
      await randomDelay(500, 1500);
      
      return {
        originalUrl: url,
        localPath: path.join('assets', `${hash}${ext}`),
        hash: hash,
        extension: ext
      };
    } catch (error) {
      if (attempt === retries) {
        console.error(`Failed to download after ${retries} attempts:`, url, error.message);
        return null;
      }
      console.log(`Attempt ${attempt}/${retries} failed, retrying:`, url);
      await randomDelay(2000 * attempt, 5000 * attempt);
    }
  }
}

async function processPage(browser, url, manifest) {
  if (manifest.pages[url]) {
    console.log('Already processed:', url);
    return;
  }

  console.log('Processing page:', url);
  manifest.pages[url] = { assets: [] };

  try {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0',
        'Referer': 'https://www.google.com/'
      },
      ignoreHTTPSErrors: true,
      javaScriptEnabled: true
    });
    
    const page = await context.newPage();
    
    // Block analytics and tracking
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.includes('google-analytics') || 
          url.includes('analytics') || 
          url.includes('tracking') ||
          url.includes('matomo') ||
          url.includes('piwik')) {
        route.abort();
      } else {
        route.continue();
      }
    });

    // Record network requests for debugging
    page.on('request', request => {
      console.log('Request:', request.url());
    });
    
    page.on('response', response => {
      console.log('Response:', response.url(), response.status());
    });

    // Add error handling for page errors
    page.on('pageerror', error => {
      console.error('Page error:', error);
    });

    page.on('console', msg => {
      console.log('Console:', msg.text());
    });

    await page.goto(url, { 
      waitUntil: 'networkidle',
      timeout: 30000
    });

    // Wait for content to be loaded
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000); // Wait for dynamic content

    // Extract all assets
    const assets = await page.evaluate(() => {
      const results = new Set();
      
      // Images and srcset
      for (const img of document.querySelectorAll('img[src]')) {
        if (img.src) results.add(img.src);
        if (img.srcset) {
          const srcset = img.srcset.split(',').map(s => s.trim().split(' ')[0]);
          for (const src of srcset) results.add(src);
        }
      }
      
      // CSS
      for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
        if (link.href) results.add(link.href);
      }
      
      // Scripts
      for (const script of document.querySelectorAll('script[src]')) {
        if (script.src) results.add(script.src);
      }

      // Background images in style attributes
      for (const el of document.querySelectorAll('[style*="background"]')) {
        const style = el.getAttribute('style');
        if (style) {
          const matches = style.match(/url\(['"]?([^'")\s]+)['"]?\)/g);
          if (matches) {
            for (const match of matches) {
              const url = match.slice(4, -1).replace(/['"]/g, '');
              results.add(url);
            }
          }
        }
      }

      // Background images in CSS
      for (const style of document.querySelectorAll('style')) {
        const matches = style.textContent.match(/url\(['"]?([^'")\s]+)['"]?\)/g);
        if (matches) {
          for (const match of matches) {
            const url = match.slice(4, -1).replace(/['"]/g, '');
            results.add(url);
          }
        }
      }

      // Fonts
      for (const link of document.querySelectorAll('link[rel="preload"][as="font"]')) {
        if (link.href) results.add(link.href);
      }

      return Array.from(results);
    });

    console.log('Found assets:', assets.length);

    // Download only Webflow assets
    for (const asset of assets) {
      if (isWebflowAsset(asset)) {
        const result = await downloadAsset(asset);
        if (result) {
          manifest.pages[url].assets.push(result);
          manifest.assets[result.originalUrl] = result;
        }
      }
    }

    // Save raw HTML
    const content = await page.content();
    const pageHash = createHash('md5').update(url).digest('hex');
    const pagePath = path.join(PAGES_DIR, `${pageHash}.html`);
    await fs.writeFile(pagePath, content);
    manifest.pages[url].rawHtml = path.relative(OUTPUT_DIR, pagePath);

    await context.close();
  } catch (error) {
    console.error('Error processing page:', url, error.message);
    manifest.pages[url].error = error.message;
  }
}

async function main() {
  const browser = await chromium.launch({
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1920,1080'
    ]
  });
  
  try {
    // Create output directories
    await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    await fs.mkdir(ASSETS_DIR, { recursive: true });
    await fs.mkdir(PAGES_DIR, { recursive: true });
    
    // Initialize manifest
    const manifest = {
      startTime: new Date().toISOString(),
      pages: {},
      assets: {}
    };
    
    // Process only target pages
    for (const url of TARGET_PAGES) {
      await processPage(browser, url, manifest);
      // Random delay between pages
      await randomDelay(3000, 7000);
    }
    
    // Save manifest
    manifest.endTime = new Date().toISOString();
    await fs.writeFile(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
    
    console.log('\nCrawl completed!');
    console.log(`Total pages: ${Object.keys(manifest.pages).length}`);
    console.log(`Total assets: ${Object.keys(manifest.assets).length}`);
  } finally {
    await browser.close();
  }
}

main().catch(console.error); 