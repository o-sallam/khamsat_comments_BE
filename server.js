const express = require("express");
const { chromium } = require("playwright");
const cors = require("cors");

// Initialize express app
const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Cache to store results
const cache = new Map();
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes

// Browser management
let browserInstance = null;
let browserContext = null;
let browserInitializing = false;
const PAGE_POOL_SIZE = 5; // Pre-warmed pages
const pagePool = [];
const MAX_TABS = 10;
const activeTabs = new Map();

// Initialize browser with Playwright
async function initBrowser() {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }

  if (browserInitializing) {
    while (browserInitializing) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return browserInstance;
  }

  browserInitializing = true;
  try {
    console.log("🚀 Initializing Playwright browser...");
    
    browserInstance = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-breakpad",
        "--disable-component-extensions-with-background-pages",
        "--disable-extensions",
        "--disable-features=TranslateUI",
        "--disable-ipc-flooding-protection",
        "--disable-renderer-backgrounding",
        "--enable-features=NetworkService,NetworkServiceInProcess",
        "--no-default-browser-check",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
      ],
    });

    // Create persistent context (faster than creating context per page)
    browserContext = await browserInstance.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 768 },
      locale: "ar-EG",
      extraHTTPHeaders: {
        "accept-language": "ar,en-US;q=0.9,en;q=0.8",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      // Disable images, fonts for speed
      ignoreHTTPSErrors: true,
    });

    browserInstance.on("disconnected", () => {
      console.warn("⚠️  Browser disconnected");
      browserInstance = null;
      browserContext = null;
      activeTabs.clear();
      pagePool.length = 0;
    });

    console.log("✅ Playwright browser initialized");
    return browserInstance;
  } catch (error) {
    console.error("❌ Failed to initialize browser:", error);
    browserInstance = null;
    browserContext = null;
    throw error;
  } finally {
    browserInitializing = false;
  }
}

// Configure page for fast scraping
async function configurePage(page) {
  // Block unnecessary resources (Playwright route method)
  await page.route("**/*", (route) => {
    const resourceType = route.request().resourceType();
    const url = route.request().url();
    
    // Block unnecessary resources
    if (
      resourceType === "image" ||
      resourceType === "media" ||
      resourceType === "font" ||
      resourceType === "stylesheet" ||
      url.includes("google-analytics") ||
      url.includes("googletagmanager") ||
      url.includes("facebook") ||
      url.includes("twitter") ||
      url.includes("analytics") ||
      url.includes("ads") ||
      url.includes("tracking")
    ) {
      route.abort();
    } else {
      route.continue();
    }
  });

  // Set extra properties to avoid detection
  await page.addInitScript(() => {
    // Override navigator properties
    Object.defineProperty(navigator, "webdriver", {
      get: () => false,
    });
    
    // Add chrome property
    window.chrome = {
      runtime: {},
    };
    
    // Override permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === "notifications"
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);
  });
}

// Pre-warm pages pool
async function warmupPagePool() {
  await initBrowser();
  console.log(`🔥 Warming up ${PAGE_POOL_SIZE} pages...`);
  
  for (let i = 0; i < PAGE_POOL_SIZE; i++) {
    try {
      const page = await browserContext.newPage();
      await configurePage(page);
      pagePool.push(page);
      console.log(`   Page ${i + 1}/${PAGE_POOL_SIZE} ready`);
    } catch (error) {
      console.error(`Failed to warm up page ${i + 1}:`, error);
    }
  }
  
  console.log(`✅ Page pool ready with ${pagePool.length} pages`);
}

// Get a page from pool or create new one
async function getPage() {
  // Try to get from pool first (fastest)
  if (pagePool.length > 0) {
    const page = pagePool.pop();
    try {
      // Quick check if page is still valid
      if (!page.isClosed()) {
        return { page, fromPool: true };
      }
    } catch (error) {
      console.error("Pool page error:", error);
    }
  }

  // Create new page if pool empty
  await initBrowser();
  
  if (activeTabs.size >= MAX_TABS) {
    throw new Error("Too many active tabs, please retry");
  }

  const page = await browserContext.newPage();
  await configurePage(page);
  return { page, fromPool: false };
}

// Return page to pool or close it
async function returnPage(page, fromPool) {
  try {
    if (fromPool && pagePool.length < PAGE_POOL_SIZE && !page.isClosed()) {
      // Fast cleanup
      await page.evaluate(() => {
        document.querySelectorAll('[role="dialog"], .modal').forEach(el => el.remove());
      }).catch(() => {});
      
      pagePool.push(page);
    } else {
      await page.close();
    }
  } catch (error) {
    try { await page.close(); } catch {}
  }
}

// Smart retry mechanism
async function scrapeWithRetry(url, maxRetries = 2) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let page = null;
    let fromPool = false;
    
    try {
      const pageInfo = await getPage();
      page = pageInfo.page;
      fromPool = pageInfo.fromPool;

      console.log(`📄 Scraping ${url} (attempt ${attempt}/${maxRetries}, pool: ${fromPool})`);

      // Playwright's optimized navigation
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });

      // Wait for content with race condition
      await Promise.race([
        page.waitForFunction(
          () => document.body.innerText.includes('التعليقات'),
          { timeout: 3000 }
        ).catch(() => {}),
        page.waitForTimeout(4000)
      ]);

      console.log("✅ Page ready, extracting...");

      // Extract comments count (Playwright evaluate is faster)
      const commentsCount = await page.evaluate(() => {
        const bodyText = document.body.innerText;
        
        // Fast regex (most common pattern first)
        const match = bodyText.match(/التعليقات\s*\((\d+)\)/);
        if (match) return parseInt(match[1], 10);
        
        // Fallback: element search
        const h3Elements = document.getElementsByTagName('h3');
        for (let i = 0; i < h3Elements.length; i++) {
          const text = h3Elements[i].textContent;
          if (text.includes('التعليقات')) {
            const m = text.match(/\((\d+)\)/);
            if (m) return parseInt(m[1], 10);
          }
        }
        
        return 0;
      });

      console.log("🎯 Extracted:", commentsCount);

      // Success! Return page to pool
      await returnPage(page, fromPool);
      
      return commentsCount;

    } catch (error) {
      console.error(`❌ Attempt ${attempt} failed:`, error.message);
      lastError = error;
      
      // Close page on error
      if (page) {
        try {
          await page.close();
        } catch {}
      }
      
      // Exponential backoff
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
  }
  
  throw lastError;
}

// Scrape endpoint
app.get("/api/scrape/:requestId", async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { requestId } = req.params;
    const cacheKey = `request_${requestId}`;
    const now = Date.now();

    // Check cache first
    if (cache.has(cacheKey)) {
      const { timestamp, data } = cache.get(cacheKey);
      if (now - timestamp < CACHE_DURATION) {
        return res.json({
          success: true,
          commentsCount: data.commentsCount,
          source: "cache",
          responseTime: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        });
      }
      cache.delete(cacheKey);
    }

    const url = `https://khamsat.com/community/requests/${requestId}`;

    // Scrape with retry
    const commentsCount = await scrapeWithRetry(url);

    // Store in cache
    cache.set(cacheKey, {
      timestamp: now,
      data: {
        commentsCount,
        timestamp: new Date().toISOString(),
      },
    });

    const responseTime = Date.now() - startTime;
    console.log(`✅ Scraped in ${responseTime}ms`);

    res.json({
      success: true,
      url,
      commentsCount,
      source: "live",
      responseTime,
      poolSize: pagePool.length,
      activeTabs: activeTabs.size,
      engine: "playwright",
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error("💥 Scraping failed:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      responseTime: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    browserConnected: browserInstance?.isConnected() || false,
    poolSize: pagePool.length,
    activeTabs: activeTabs.size,
    cacheSize: cache.size,
    engine: "playwright",
    timestamp: new Date().toISOString(),
  });
});

// Restart browser endpoint
app.post("/api/restart-browser", async (req, res) => {
  try {
    console.log("🔄 Restarting browser...");
    
    // Close pool pages
    for (const page of pagePool) {
      try {
        await page.close();
      } catch {}
    }
    pagePool.length = 0;
    
    // Close context and browser
    if (browserContext) {
      await browserContext.close();
      browserContext = null;
    }
    
    if (browserInstance) {
      await browserInstance.close();
      browserInstance = null;
    }
    
    // Reinitialize
    await initBrowser();
    await warmupPagePool();
    
    res.json({
      success: true,
      message: "Browser restarted and pool warmed up",
      poolSize: pagePool.length,
      engine: "playwright",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Clear cache endpoint
app.post("/api/clear-cache", (req, res) => {
  cache.clear();
  res.json({
    success: true,
    message: "Cache cleared",
    timestamp: new Date().toISOString(),
  });
});

// Graceful shutdown
async function shutdown() {
  console.log("🛑 Shutting down gracefully...");
  
  // Close pool pages
  for (const page of pagePool) {
    try {
      await page.close();
    } catch {}
  }
  
  // Close context and browser
  if (browserContext) {
    await browserContext.close();
  }
  
  if (browserInstance) {
    await browserInstance.close();
  }
  
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Start server
app.listen(PORT, async () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📍 Scrape: http://localhost:${PORT}/api/scrape/:requestId`);
  console.log(`⚡ Engine: Playwright (Ultra Fast Mode)`);
  
  // Initialize browser and warm up pages
  try {
    await initBrowser();
    await warmupPagePool();
    console.log("✅ Server ready to handle requests!");
  } catch (error) {
    console.error("❌ Failed to initialize:", error);
  }
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (err) => {
  console.error("💥 Unhandled Promise Rejection:", err);
});

module.exports = app;