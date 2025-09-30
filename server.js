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
const CACHE_DURATION = 30 * 1000; // 30 seconds

// Browser management
let browserInstance = null;
let browserContext = null;
let browserInitializing = false;

// CRITICAL: Limit concurrent scraping for Railway
const MAX_CONCURRENT_SCRAPES = 3; // Railway can't handle more than 3 concurrent
let activeScrapes = 0;
const scrapeQueue = [];
let lastRequestTime = 0;
const REQUEST_DELAY = 500; // 500ms delay between requests

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
        "--disable-gpu",
        "--single-process", // CRITICAL for Railway
        "--no-zygote",
        "--disable-blink-features=AutomationControlled",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-breakpad",
        "--disable-extensions",
        "--disable-features=TranslateUI",
        "--disable-renderer-backgrounding",
        "--no-first-run",
      ],
    });

    // Create persistent context
    browserContext = await browserInstance.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 768 },
      locale: "ar-EG",
      extraHTTPHeaders: {
        "accept-language": "ar,en-US;q=0.9,en;q=0.8",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      ignoreHTTPSErrors: true,
    });

    browserInstance.on("disconnected", () => {
      console.warn("⚠️  Browser disconnected - will reinitialize on next request");
      browserInstance = null;
      browserContext = null;
      activeScrapes = 0;
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
  // Block unnecessary resources
  await page.route("**/*", (route) => {
    const resourceType = route.request().resourceType();
    const url = route.request().url();
    
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

  // Anti-detection
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => false,
    });
    
    window.chrome = { runtime: {} };
    
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === "notifications"
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);
  });
}

// Queue management - CRITICAL for Railway stability
async function waitForSlot() {
  // Add delay between consecutive requests
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < REQUEST_DELAY) {
    await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY - timeSinceLastRequest));
  }
  lastRequestTime = Date.now();
  while (activeScrapes >= MAX_CONCURRENT_SCRAPES) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  activeScrapes++;
  console.log(`🔄 Active scrapes: ${activeScrapes}/${MAX_CONCURRENT_SCRAPES}`);
}

function releaseSlot() {
  activeScrapes = Math.max(0, activeScrapes - 1);
  console.log(`✅ Released slot. Active: ${activeScrapes}/${MAX_CONCURRENT_SCRAPES}`);
}

// Smart retry mechanism with queue management
async function scrapeWithRetry(url, maxRetries = 2) {
  // Wait for available slot
  await waitForSlot();
  
  let lastError;
  let page = null;
  
  try {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await initBrowser();
        
        page = await browserContext.newPage();
        await configurePage(page);

        console.log(`📄 Scraping ${url} (attempt ${attempt}/${maxRetries})`);

        // Navigate with timeout
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 25000,
        });

        // Wait for content
        await Promise.race([
          page.waitForFunction(
            () => document.body.innerText.includes('التعليقات'),
            { timeout: 3000 }
          ).catch(() => {}),
          page.waitForTimeout(4000)
        ]);

        console.log("✅ Page ready, extracting...");

        // Extract comments count
        const commentsCount = await page.evaluate(() => {
          const bodyText = document.body.innerText;
          
          // Fast regex
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

        // Close page immediately
        await page.close();
        page = null;
        
        return commentsCount;

      } catch (error) {
        console.error(`❌ Attempt ${attempt} failed:`, error.message);
        lastError = error;
        
        // Close page on error
        if (page) {
          try {
            await page.close();
          } catch {}
          page = null;
        }
        
        // Exponential backoff
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
        }
      }
    }
    
    throw lastError;
    
  } finally {
    // CRITICAL: Always release the slot
    releaseSlot();
    
    // Ensure page is closed
    if (page) {
      try {
        await page.close();
      } catch {}
    }
  }
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

    // Scrape with queue management
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
      activeScrapes,
      maxConcurrent: MAX_CONCURRENT_SCRAPES,
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
    activeScrapes,
    maxConcurrent: MAX_CONCURRENT_SCRAPES,
    cacheSize: cache.size,
    engine: "playwright",
    timestamp: new Date().toISOString(),
  });
});

// Restart browser endpoint
app.post("/api/restart-browser", async (req, res) => {
  try {
    console.log("🔄 Restarting browser...");
    
    // Wait for active scrapes to finish
    while (activeScrapes > 0) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
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
    
    res.json({
      success: true,
      message: "Browser restarted",
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
  
  // Wait for active scrapes
  while (activeScrapes > 0) {
    console.log(`⏳ Waiting for ${activeScrapes} active scrapes...`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  // Close browser
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
  console.log(`⚡ Engine: Playwright (Railway Optimized)`);
  console.log(`🔒 Max concurrent scrapes: ${MAX_CONCURRENT_SCRAPES}`);
  
  // Initialize browser
  try {
    await initBrowser();
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