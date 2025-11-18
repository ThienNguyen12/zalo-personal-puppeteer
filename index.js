// index.js
const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const COOKIE_PATH = path.join(__dirname, 'zalo_session.json');
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'CHANGE_THIS_SECRET';

let browser = null;
let page = null;

async function launchBrowser() {
  if (browser) return;
 browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-features=NetworkService",
    "--disable-features=VizDisplayCompositor"
  ]
});

  page = await browser.newPage();
  // optional: speed up
  await page.setViewport({ width: 1200, height: 900 });
}

async function restoreCookiesIfAny() {
  if (!fs.existsSync(COOKIE_PATH)) return false;
  try {
    const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf8'));
    await page.setCookie(...cookies);
    console.log('Cookies restored');
    return true;
  } catch (e) {
    console.warn('Restore cookie failed', e);
    return false;
  }
}

async function saveCookies() {
  const cookies = await page.cookies();
  fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
  console.log('Cookies saved to', COOKIE_PATH);
}

// go to Zalo web and check login status
async function ensureOpenZalo() {
  await launchBrowser();
  await page.goto('https://chat.zalo.me', { waitUntil: 'networkidle2' });
}

// try to detect logged in
async function isLoggedIn() {
  try {
    await ensureOpenZalo();
    // Example check: presence of sidebar or user avatar element
    const exist = await page.evaluate(() => {
      return !!document.querySelector('.sidebar, .chat-list, [data-testid="sidebar"]');
    });
    return exist;
  } catch (e) {
    console.error('isLoggedIn err', e);
    return false;
  }
}

// Get QR image (base64 data URL)
async function getLoginQRCodeDataUrl() {
  await launchBrowser();
  await page.goto('https://chat.zalo.me', { waitUntil: 'networkidle2' });

  // Wait a bit for QR or login elements to appear
  await page.waitForTimeout(1500);

  // Try several selectors to find QR
  const qrSrc = await page.evaluate(() => {
    const selectors = [
      'img[src*="qrcode"]',
      'img[alt*="QR"]',
      'img[alt*="qrcode"]',
      'img[src*="login-qrcode"]'
    ];
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el && el.src) return el.src;
    }
    return null;
  });

  if (qrSrc && qrSrc.startsWith('data:')) {
    return qrSrc;
  }

  // If qrSrc is an external url, fetch via page context and convert to base64
  if (qrSrc) {
    const data = await page.evaluate(async (src) => {
      try {
        const res = await fetch(src);
        const blob = await res.blob();
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });
      } catch (e) {
        return null;
      }
    }, qrSrc);
    if (data) return data;
  }

  // Fallback: screenshot a QR container if exists
  try {
    const qrEl = await page.$('div.qr, .login-qr, .qr-code, .zalo-qr');
    if (qrEl) {
      const buffer = await qrEl.screenshot({ encoding: 'base64' });
      return 'data:image/png;base64,' + buffer;
    }
  } catch (e) {
    console.warn('fallback qr screenshot failed', e);
  }

  throw new Error('Không tìm được QR code trên trang. UI Zalo có thể đã thay đổi.');
}

// Search chat by phone OR by name OR by group name, then send message
async function sendMessageToTarget(target, message) {
  if (!target) throw new Error('target required');

  await ensureOpenZalo();

  // restore cookies if exist
  if (fs.existsSync(COOKIE_PATH)) {
    await restoreCookiesIfAny();
    await page.reload({ waitUntil: 'networkidle2' });
    // wait short
    await page.waitForTimeout(1000);
  }

  // If not logged in, return special error
  const logged = await isLoggedIn();
  if (!logged) {
    return { ok: false, error: 'NOT_LOGGED_IN' };
  }

  // Focus search box (selectors may vary; adjust if fails)
  const searchSelectors = [
    'input[placeholder*="Tìm kiếm"]',
    'input[placeholder*="Search"]',
    'input[type="search"]',
    'input[aria-label*="search"]'
  ];
  let searchBox = null;
  for (const s of searchSelectors) {
    try {
      searchBox = await page.$(s);
      if (searchBox) break;
    } catch (e) {}
  }

  if (!searchBox) {
    // alternative: click on search icon to open search
    // try to find a search button and click it
    const btn = await page.$('button[aria-label*="Search"], button[title*="Search"], .search-btn');
    if (btn) {
      await btn.click();
      await page.waitForTimeout(500);
      for (const s of searchSelectors) {
        searchBox = await page.$(s);
        if (searchBox) break;
      }
    }
  }

  if (!searchBox) throw new Error('Không tìm thấy ô tìm kiếm. Cần cập nhật selector.');

  // Clear and type target
  await searchBox.click({ clickCount: 3 });
  await searchBox.focus();
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await searchBox.type(String(target), { delay: 60 });
  await page.waitForTimeout(1200);

  // Try to click first result
  // selectors for list item may change; try common ones
  const resultSelectors = [
    '.conversation-item', '.chat-item', '.list-item', '.search-result-item', '.result-item'
  ];

  let firstResult = null;
  for (const sel of resultSelectors) {
    firstResult = await page.$(sel);
    if (firstResult) break;
  }

  // If no result found, try opening Contacts and searching there (fallback)
  if (!firstResult) {
    // try open contacts panel
    try {
      const contactBtn = await page.$('a[href*="contacts"], button[aria-label*="contacts"], .contact-button');
      if (contactBtn) {
        await contactBtn.click();
        await page.waitForTimeout(800);
        // find contact search inside contacts
        for (const s of searchSelectors) {
          const sb = await page.$(s);
          if (sb) {
            await sb.click({ clickCount: 3 });
            await sb.type(String(target), { delay: 60 });
            await page.waitForTimeout(800);
            // try to select contact
            firstResult = await page.$('.contact-item, .list-item, .search-result-item');
            if (firstResult) break;
          }
        }
      }
    } catch (e) {
      console.warn('contacts fallback failed', e);
    }
  }

  if (!firstResult) {
    // If still not found, try to search by phone in chat list by iterating elements
    // (we could try to query all conversation titles)
    const found = await page.evaluate((t) => {
      const nodes = Array.from(document.querySelectorAll('.conversation-item, .list-item, .chat-item, .channel-item'));
      for (const n of nodes) {
        const txt = n.innerText || '';
        if (txt.includes(t)) {
          n.scrollIntoView();
          n.click();
          return true;
        }
      }
      return false;
    }, String(target));
    if (!found) {
      throw new Error('Không tìm thấy cuộc trò chuyện khớp với: ' + target + '. Hãy kiểm tra định dạng SĐT (ví dụ 0911234567 hoặc +84911234567) và thử lại.');
    }
  } else {
    // click the result
    await firstResult.click();
  }

  await page.waitForTimeout(700);

  // Find message input
  const inputSelectors = [
    'div[contenteditable="true"]', 'textarea', 'input[aria-label*="message"]'
  ];
  let inputArea = null;
  for (const sel of inputSelectors) {
    inputArea = await page.$(sel);
    if (inputArea) break;
  }
  if (!inputArea) throw new Error('Không tìm thấy ô nhập tin nhắn. Cần cập nhật selector.');

  // Type and send
  try {
    await inputArea.focus();
    // some editors need typing via keyboard
    await page.keyboard.type(String(message), { delay: 25 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
  } catch (e) {
    throw new Error('Gửi tin nhắn thất bại: ' + e.message);
  }

  return { ok: true, message: 'Đã gửi' };
}

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

// auth middleware
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key || key !== API_KEY) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

// GET /qr => return QR image dataURL so user scans with phone
app.get('/qr', async (req, res) => {
  try {
    const dataUrl = await getLoginQRCodeDataUrl();
    res.json({ ok: true, qr: dataUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /save => save cookies to disk (after scanning)
app.get('/save', async (req, res) => {
  try {
    await saveCookies();
    res.json({ ok: true, message: 'Saved cookies' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /send => send message (protected)
app.post('/send', requireApiKey, async (req, res) => {
  try {
    const { target, message } = req.body;
    if (!target || !message) return res.status(400).json({ ok: false, error: 'target & message required' });

    const result = await sendMessageToTarget(target, message);
    if (result && result.ok) res.json({ ok: true });
    else res.status(500).json({ ok: false, error: result && result.error ? result.error : 'unknown' });
  } catch (e) {
    console.error('send error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
