const { chromium } = require('playwright');
const fs = require('fs');

if (!fs.existsSync('screenshots')) {
  fs.mkdirSync('screenshots');
}

// Telegram 通知工具
async function sendTelegramMessage(botToken, chatId, text) {
  if (!botToken || !chatId) return;
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' })
    });
    console.log('📢 TG 通知已发送！');
  } catch (err) {
    console.error('❌ TG 通知发送失败:', err.message);
  }
}

// 🛡️ 扫除干扰弹窗与 Cookie 协议
async function forceDismissPopups(page) {
  await page.keyboard.press('Escape');

  try {
    const cookieBtn = page.locator('button:has-text("Accept all"), button:has-text("Reject all")').first();
    if (await cookieBtn.isVisible({ timeout: 1500 })) {
      await cookieBtn.click();
      console.log('🍪 已关闭 Cookie 授权弹窗');
    }
  } catch (e) {}

  await page.evaluate(() => {
    const allEls = Array.from(document.querySelectorAll('*'));
    const targets = allEls.filter(el => 
      el.children.length === 0 && 
      ['maybe later', 'i need help'].includes(el.textContent.trim().toLowerCase())
    );
    targets.forEach(el => el.click());

    const ideaHeader = allEls.find(el => el.textContent && el.textContent.includes('Got an idea to make FreeMCHost better'));
    if (ideaHeader) {
      let container = ideaHeader;
      for (let i = 0; i < 5; i++) {
        if (container.parentElement && container.parentElement !== document.body) {
          container = container.parentElement;
        }
      }
      if (container && container !== document.body) {
        container.remove();
      }
    }
  });
  await page.waitForTimeout(500);
}

(async () => {
  const email = process.env.FREE_EMAIL;
  const password = process.env.FREE_PASSWORD;
  const serverPageUrl = process.env.SERVER_PAGE_URL;
  const proxyUrl = process.env.PROXY_URL;
  const tgToken = process.env.TG_BOT_TOKEN;
  const tgChatId = process.env.TG_CHAT_ID;

  console.log('🚀 正在启动伪装浏览器...');

  const launchOptions = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080'
    ]
  };

  if (proxyUrl) {
    console.log(`🌐 正在初始化代理网络: ${proxyUrl}`);
    launchOptions.proxy = { server: proxyUrl };
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US'
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();

  try {
    console.log('🚀 正在打开 Freemchost 登录页面...');
    await page.goto('https://freemchost.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });

    console.log('📝 正在输入账号密码...');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"], input[name="password"]', password);

    console.log('🔐 正在尝试登录...');
    await Promise.all([
      page.waitForURL(url => !url.href.includes('/login'), { timeout: 45000 }),
      page.click('button[type="submit"]')
    ]);

    console.log('✅ 登录成功！当前 URL:', page.url());

    // 1. 进入服务器控制面板
    console.log('📂 正在访问服务列表主页...');
    await page.goto('https://freemchost.com/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    await forceDismissPopups(page);

    console.log('🔍 正在定位服务器卡片...');
    let cardClicked = false;
    let targetUuid = '';
    if (serverPageUrl && serverPageUrl.includes('/servers/')) {
      targetUuid = serverPageUrl.split('/servers/')[1].trim();
    }

    if (targetUuid) {
      const specificLink = page.locator(`a[href*="${targetUuid}"]`).first();
      if (await specificLink.count() > 0) {
        console.log(`👉 找到指定 UUID [${targetUuid}] 卡片，进入详情...`);
        await specificLink.click();
        cardClicked = true;
      }
    }

    if (!cardClicked) {
      const firstServerLink = page.locator('a[href*="/app/servers/"]').first();
      if (await firstServerLink.count() > 0) {
        console.log('👉 点击列表中第一个服务器卡片...');
        await firstServerLink.click();
        cardClicked = true;
      }
    }

    if (!cardClicked && serverPageUrl) {
      console.log('⚠️ 使用直达 URL 进入详情页:', serverPageUrl);
      await page.goto(serverPageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }

    console.log('📍 实际到达页面 URL:', page.url());
    await page.waitForTimeout(3000);
    await forceDismissPopups(page);

    // 2. 切换到 [Manage] 选项卡
    console.log('🗂️ 正在定位并点击 [Manage] 标签页...');
    const manageTab = page.locator('button, a, div[role="tab"]').filter({ hasText: /^Manage$/ }).first();
    await manageTab.waitFor({ state: 'visible', timeout: 15000 });
    await manageTab.click();
    await page.waitForTimeout(2000);
    await forceDismissPopups(page);

    // 3. 检查当前剩余时间与 Renew now 按钮状态
    console.log('🔍 正在检查 Manage 面板及续期按钮...');
    
    // 抓取页面当前剩余时间文本，方便通知
    const expiryText = await page.evaluate(() => {
      const box = document.querySelector('div:has(> button:has-text("Renew now")), div.grid');
      const allText = document.body.innerText || '';
      const match = allText.match(/(\d{2}\s*D\s*\d{2}\s*H\s*\d{2}\s*M)/i);
      return match ? match[0] : '未知';
    }).catch(() => '未知');
    console.log(`⏱️ 当前服务器剩余时间约: ${expiryText}`);

    // 定位红色的 Renew now 按钮
    const renewBtn = page.locator('button:has-text("Renew now")').first();
    await renewBtn.waitFor({ state: 'visible', timeout: 10000 });

    const isEnabled = await renewBtn.isEnabled().catch(() => true);

    if (await renewBtn.isVisible() && isEnabled) {
      console.log('🔄 正在触发 [Renew now] 按钮点击...');
      await renewBtn.click();
      await page.waitForTimeout(2000);

      // 4. 处理可能出现的弹窗确认（48 hours / 60 hours / Confirm）
      console.log('📋 检测是否弹出续期确认选项...');
      const popupClicked = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('button, div[role="button"], span'));
        // 匹配 48 hours / 60 hours / Extend / Confirm 等弹窗按钮
        const target = els.find(el => {
          const t = (el.textContent || '').trim().toLowerCase();
          return t.includes('48 hours') || t.includes('60 hours') || t === 'confirm' || t === 'extend';
        });
        if (target) {
          target.click();
          return true;
        }
        return false;
      });

      if (popupClicked) {
        console.log('👉 已确认选择续期弹窗选项！');
      }

      await page.waitForTimeout(4000);
      await page.screenshot({ path: 'screenshots/renew_success.png', fullPage: true });

      const msg = `🎉 <b>Freemchost 自动续期成功</b>\n\n<b>剩余时间:</b> ${expiryText}\n<b>状态:</b> 已点击 Renew now 完成加时\n<b>时间:</b> ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
      console.log('✅ 续期完成！');
      await sendTelegramMessage(tgToken, tgChatId, msg);

    } else {
      console.log('⚠️ Renew now 按钮当前不可点击或时间充足，安全跳过。');
      await page.screenshot({ path: 'screenshots/renew_skip.png', fullPage: true });
      const skipMsg = `ℹ️ <b>Freemchost 续期跳过</b>\n\n<b>剩余时间:</b> ${expiryText}\n<b>状态:</b> 续期按钮暂未开放，下个周期自动重试。`;
      await sendTelegramMessage(tgToken, tgChatId, skipMsg);
    }

  } catch (error) {
    console.error('❌ 执行过程中出错:', error.message);
    await page.screenshot({ path: 'screenshots/renew_error.png', fullPage: true });
    await sendTelegramMessage(tgToken, tgChatId, `⚠️ <b>Freemchost 续期异常</b>\n\n错误: <code>${error.message}</code>`);
    process.exitCode = 1;
  } finally {
    await browser.close();
    console.log('🏁 浏览器已关闭，任务结束。');
  }
})();
