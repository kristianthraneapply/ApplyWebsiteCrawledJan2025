const fs = require('node:fs').promises;
const path = require('node:path');

const INPUT_DIR = './raw_download';
const OUTPUT_DIR = './built_site';

async function getRelativePath(from, to) {
  const fromParts = from.split('/').filter(Boolean);
  const toParts = to.split('/').filter(Boolean);
  const depth = fromParts.length - 1;
  return depth > 0 ? '../'.repeat(depth) + to : to;
}

async function processHtml(rawContent, pageUrl, manifest) {
  // Remove base tag
  let content = rawContent.replace(/<base[^>]*>/, '');
  
  // Get page info from manifest
  const pageInfo = manifest.pages[pageUrl];
  if (!pageInfo) {
    console.error('Page not found in manifest:', pageUrl);
    return content;
  }

  // Replace all Webflow asset URLs with local paths
  for (const asset of pageInfo.assets) {
    const urlPath = new URL(pageUrl).pathname;
    const fileName = urlPath === '/' ? 'index.html' : `${urlPath.slice(1)}${urlPath.endsWith('/') ? 'index.html' : ''}`;
    const relativePath = await getRelativePath(fileName, asset.localPath);
    
    // Replace in src attributes
    content = content.replace(
      new RegExp(`src=["']${asset.originalUrl}["']`, 'g'),
      `src="${relativePath}"`
    );
    
    // Replace in href attributes
    content = content.replace(
      new RegExp(`href=["']${asset.originalUrl}["']`, 'g'),
      `href="${relativePath}"`
    );
    
    // Replace in style attributes
    content = content.replace(
      new RegExp(`url\\(['"]?${asset.originalUrl}['"]?\\)`, 'g'),
      `url('${relativePath}')`
    );
  }

  return content;
}

async function buildSite() {
  try {
    // Read manifest
    const manifestPath = path.join(INPUT_DIR, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    
    // Create output directory
    await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    await fs.mkdir(path.join(OUTPUT_DIR, 'assets'), { recursive: true });
    
    // Copy all assets
    console.log('Copying assets...');
    for (const [url, asset] of Object.entries(manifest.assets)) {
      const sourcePath = path.join(INPUT_DIR, asset.localPath);
      const targetPath = path.join(OUTPUT_DIR, asset.localPath);
      
      try {
        await fs.access(sourcePath);
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.copyFile(sourcePath, targetPath);
      } catch (error) {
        console.error('Failed to copy asset:', url, error.message);
      }
    }
    
    // Process each page
    console.log('Processing pages...');
    for (const [url, pageInfo] of Object.entries(manifest.pages)) {
      try {
        // Read raw HTML
        const rawHtml = await fs.readFile(path.join(INPUT_DIR, pageInfo.rawHtml), 'utf8');
        
        // Process HTML
        const processedHtml = await processHtml(rawHtml, url, manifest);
        
        // Save to output directory
        const urlPath = new URL(url).pathname;
        const outputPath = path.join(
          OUTPUT_DIR,
          urlPath === '/' ? 'index.html' : `${urlPath.slice(1)}${urlPath.endsWith('/') ? 'index.html' : ''}`
        );
        
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, processedHtml);
        console.log('Built page:', outputPath);
      } catch (error) {
        console.error('Error processing page:', url, error.message);
      }
    }
    
    console.log('\nBuild completed!');
  } catch (error) {
    console.error('Build failed:', error.message);
  }
}

buildSite().catch(console.error); 