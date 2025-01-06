const { chromium } = require('playwright-extra');
const fs = require('fs-extra');
const path = require('node:path');
const { URL } = require('node:url');

// Configuration
const config = {
  startUrl: 'https://apply.agency',
  allowedDomains: [
    'apply.agency',
    'www.apply.agency',
    'webflow.com',
    'webflow.io',
    'd3e54v103j8qbb.cloudfront.net', // Common Webflow asset domain
    'uploads-ssl.webflow.com',
    'assets.website-files.com'
  ],
  outputDir: './downloaded_site',
  concurrency: 5,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

// Track visited URLs and downloaded assets
const visited = new Set();
const downloadedAssets = new Map();
const failedUrls = new Set();

async function initBrowser() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: config.userAgent,
    viewport: { width: 1920, height: 1080 },
    extraHTTPHeaders: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Cache-Control': 'no-cache',
    }
  });
  return { browser, context };
}

function isAllowedDomain(url) {
  try {
    const hostname = new URL(url).hostname;
    return config.allowedDomains.some(domain => hostname.includes(domain));
  } catch {
    return false;
  }
}

async function downloadAsset(url, context) {
  if (downloadedAssets.has(url)) {
    return downloadedAssets.get(url);
  }

  try {
    const response = await context.request.get(url);
    const buffer = await response.body();
    const urlObj = new URL(url);
    const relativePath = `assets${urlObj.pathname}`;
    const fullPath = path.join(config.outputDir, relativePath);

    await fs.ensureDir(path.dirname(fullPath));
    await fs.writeFile(fullPath, buffer);

    downloadedAssets.set(url, relativePath);
    return relativePath;
  } catch (error) {
    console.error(`Failed to download asset: ${url}`, error.message);
    failedUrls.add(url);
    return url; // Return original URL if download fails
  }
}

async function processPage(url, context) {
  if (visited.has(url)) return;
  visited.add(url);

  console.log(`Processing: ${url}`);
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    // Handle JavaScript-rendered content
    await page.waitForLoadState('networkidle');

    // Extract and download all assets
    const assets = await page.evaluate(() => {
      const results = new Set();
      
      // Images
      for (const img of document.querySelectorAll('img')) {
        if (img.src) results.add(img.src);
        if (img.srcset) {
          for (const src of img.srcset.split(',')) {
            const url = src.trim().split(' ')[0];
            results.add(url);
          }
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

      // Background images
      for (const el of document.querySelectorAll('*')) {
        const style = window.getComputedStyle(el);
        const bgImage = style.backgroundImage;
        if (bgImage && bgImage !== 'none') {
          const url = bgImage.slice(4, -1).replace(/['"]/g, '');
          if (url) results.add(url);
        }
      }

      return Array.from(results);
    });

    // Download assets and get their new paths
    const assetMap = new Map();
    for (const asset of assets) {
      if (isAllowedDomain(asset)) {
        const localPath = await downloadAsset(asset, context);
        assetMap.set(asset, localPath);
      }
    }

    // Get the page content
    let html = await page.content();

    // Rewrite asset URLs
    assetMap.forEach((localPath, originalUrl) => {
      html = html.replace(new RegExp(originalUrl, 'g'), localPath);
    });

    // Save the HTML file
    const urlObj = new URL(url);
    let filePath = path.join(config.outputDir, urlObj.pathname);
    
    if (filePath.endsWith('/')) {
      filePath = path.join(filePath, 'index.html');
    } else if (!path.extname(filePath)) {
      filePath += '.html';
    }

    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, html);

    // Extract and follow links
    const links = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href]')).map(a => a.href);
    });

    // Queue new pages
    for (const link of links) {
      if (isAllowedDomain(link) && !visited.has(link)) {
        await processPage(link, context);
      }
    }

  } catch (error) {
    console.error(`Failed to process page: ${url}`, error.message);
    failedUrls.add(url);
  } finally {
    await page.close();
  }
}

async function main() {
  const { browser, context } = await initBrowser();

  try {
    await fs.ensureDir(config.outputDir);
    await processPage(config.startUrl, context);
  } finally {
    await browser.close();
  }

  // Report results
  console.log('\nCrawl completed!');
  console.log(`Total pages visited: ${visited.size}`);
  console.log(`Total assets downloaded: ${downloadedAssets.size}`);
  console.log(`Failed URLs: ${failedUrls.size}`);
  
  if (failedUrls.size > 0) {
    console.log('\nFailed URLs:');
    for (const url of failedUrls) {
      console.log(url);
    }
  }
}

main().catch(console.error); 