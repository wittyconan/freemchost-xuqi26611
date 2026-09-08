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

// 强力模拟真实用户输入（防止 SPA 水合清空）
async function safeFill(page, locator, value, label) {
  await locator.waitFor({ state: 'visible', timeout: 15000 });
  await locator.click();
  await locator.focus();
  await locator.fill(value);
  await page.waitForTimeout(300);

  const actualVal = await locator.inputValue().catch(() => '');
  if (!actualVal) {
    console.log(`⚠️ 检测到 ${label} 未被写入，切换为键盘模拟逐字输入...`);
    await locator.click();
    await locator.pressSequentially(value, { delay: 30 });
  }
}

(async () => {
  const email = (process.env.FREE_EMAIL || '').trim();
  const password = (process.env.FREE_PASSWORD || '').trim();
  const serverPageUrl = (process.env.SERVER_PAGE_URL || '').trim();
  const proxyUrl = (process.env.PROXY_URL || '').trim();
  const tgToken = (process.env.TG_BOT_TOKEN || '').trim();
  const tgChatId = (process.env.TG_CHAT_ID || '').trim();

  if (!email || !password) {
    console.error('❌ 致命错误: FREE_EMAIL 或 FREE_PASSWORD 环境变量为空！');
    process.exit(1);
  }

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
    await page.waitForTimeout(2000);
    await forceDismissPopups(page);

    console.log('📝 正在输入账号密码...');
    const emailLocator = page.locator('input[type="email"], input[name="email"]').first();
    const passLocator = page.locator('input[type="password"], input[name="password"]').first();

    await safeFill(page, emailLocator, email, 'Email');
    await safeFill(page, passLocator, password, 'Password');

    console.log('🔐 正在尝试登录...');
    const signInBtn = page.locator('button:has-text("Sign in"), button[type="submit"]').first();
    await Promise.all([
      page.waitForURL(url => !url.href.includes('/login'), { timeout: 45000 }),
      signInBtn.click()
    ]);

    console.log('✅ 登录成功！当前 URL:', page.url());

    // 1. 进入服务列表主页
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

    // 3. 获取倒计时剩余时长
    const expiryText = await page.evaluate(() => {
      const allText = document.body.innerText || '';
      const match = allText.match(/(\d{2}\s*D\s*\d{2}\s*H\s*\d{2}\s*M)/i);
      return match ? match[0] : '未知';
    }).catch(() => '未知');
    console.log(`⏱️ 当前服务器剩余时间: ${expiryText}`);

    // 定位红色的 Renew now 按钮
    const renewBtn = page.locator('button:has-text("Renew now")').first();
    await renewBtn.waitFor({ state: 'visible', timeout: 10000 });

    console.log('🔄 正在点击 [Renew now] 呼出续期选项弹窗...');
    await renewBtn.click();
    await page.waitForTimeout(2500);

    // 4. 【核心匹配】：解析 "Keep your server online" 弹窗中的免费续期状态
    console.log('📋 正在匹配免费续期选项状态...');

    const modalStatus = await page.evaluate(() => {
      const allText = document.body.innerText || '';
      const hasModal = allText.includes('Keep your server online');
      if (!hasModal) return { foundModal: false };

      // 规则：Free renewals open 46h before expiry — come back later.
      const isLocked = allText.toLowerCase().includes('come back later') || allText.toLowerCase().includes('open 46h before');

      // 寻找 60 hours 选项块
      const allElements = Array.from(document.querySelectorAll('*'));
      const target60 = allElements.find(el => 
        el.children.length === 0 && 
        el.textContent.trim().toLowerCase().includes('60 hours')
      );

      if (isLocked) {
        return { foundModal: true, locked: true };
      }

      if (target60) {
        // 找到可点击的容器
        let p = target60;
        for (let i = 0; i < 6; i++) {
          if (p.parentElement && p.parentElement !== document.body) {
            p = p.parentElement;
            if (p.tagName === 'BUTTON' || p.getAttribute('role') === 'button' || p.onclick || p.classList.toString().includes('cursor-pointer')) {
              p.click();
              return { foundModal: true, locked: false, clicked: true };
            }
          }
        }
        target60.click();
        return { foundModal: true, locked: false, clicked: true };
      }

      return { foundModal: true, locked: false, clicked: false };
    });

    if (modalStatus.locked) {
      console.log('⏳ 免费续期规则触发：剩余时间仍 > 46h，免费续期（60 hours）尚未开放。');
      await page.keyboard.press('Escape'); // 安全关闭弹窗
      await page.waitForTimeout(1000);
      await page.screenshot({ path: 'screenshots/renew_waiting_46h.png', fullPage: true });

      const notice = `ℹ️ <b>Freemchost 巡检正常</b>\n\n<b>剩余时间:</b> ${expiryText}\n<b>状态:</b> 官方规则为到期前 46h 内开放免费续期，当前无需操作。\n<b>下周期检测:</b> 6 小时后自动再访`;
      console.log('✅ ' + notice.replace(/<[^>]+>/g, ''));
      await sendTelegramMessage(tgToken, tgChatId, notice);

    } else if (modalStatus.clicked) {
      console.log('🎉 成功选中 [60 hours] 免费续期选项！');
      await page.waitForTimeout(4000);
      await page.screenshot({ path: 'screenshots/renew_success.png', fullPage: true });

      const successMsg = `🎉 <b>Freemchost 自动续期成功</b>\n\n<b>续期档位:</b> 60 hours (Discord Boosted)\n<b>前序剩余:</b> ${expiryText}\n<b>状态:</b> 续期完成，服务器已满血复活！\n<b>时间:</b> ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
      console.log('✅ ' + successMsg.replace(/<[^>]+>/g, ''));
      await sendTelegramMessage(tgToken, tgChatId, successMsg);

    } else {
      console.log('⚠️ 弹窗已开启，但未能在视窗内锁定目标选项，保存截图排查。');
      await page.screenshot({ path: 'screenshots/renew_modal_check.png', fullPage: true });
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
