const { chromium } = require('playwright');
const fs = require('fs');

if (!fs.existsSync('screenshots')) {
  fs.mkdirSync('screenshots');
}

// 强化版 Telegram 推送工具：带有 HTTP 状态核验与 HTML 解析错误自动降级重发机制
async function sendTelegramMessage(botToken, chatId, text) {
  if (!botToken || !chatId) {
    console.log('⚠️ 未配置有效的 TG_BOT_TOKEN 或 TG_CHAT_ID，跳过通知。');
    return;
  }
  
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        chat_id: chatId, 
        text: text, 
        parse_mode: 'HTML',
        disable_web_page_preview: true 
      })
    });
    
    const result = await res.json();
    if (result.ok) {
      console.log('📢 TG 通知已成功送达！');
    } else {
      console.error('⚠️ TG 接口拒收:', result.description);
      // 若出现 HTML 标签解析错误（比如包含特殊未闭合符号），自动剔除 HTML 标签使用纯文本兜底重发
      if (result.description && result.description.includes("can't parse entities")) {
        console.log('🔄 检测到 HTML 标签解析冲突，正在转为纯文本格式重新补发...');
        const plainText = text.replace(/<[^>]+>/g, '');
        const retryRes = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: plainText })
        });
        const retryResult = await retryRes.json();
        if (retryResult.ok) {
          console.log('📢 TG 纯文本通知补发成功！');
        } else {
          console.error('❌ TG 纯文本重发失败:', retryResult.description);
        }
      }
    }
  } catch (err) {
    console.error('❌ TG 网络请求发生异常:', err.message);
  }
}

// 🛡️ 扫除干扰弹窗与 Cookie 协议
async function forceDismissPopups(page) {
  await page.keyboard.press('Escape');

  try {
    const cookieBtn = page.locator('button:has-text("Accept all"), button:has-text("Reject all")').first();
    if (await cookieBtn.isVisible({ timeout: 1500 })) {
      await cookieBtn.click();
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
  const rawUrls = (process.env.SERVER_PAGE_URL || '').trim();
  const proxyUrl = (process.env.PROXY_URL || '').trim();
  const tgToken = (process.env.TG_BOT_TOKEN || '').trim();
  const tgChatId = (process.env.TG_CHAT_ID || '').trim();

  // 严格解析换行或逗号分隔的多个服务器 URL
  const serverUrls = rawUrls
    .split(/[\r\n,]+/)
    .map(u => u.trim())
    .filter(u => u.startsWith('http'));

  if (!email || !password || serverUrls.length === 0) {
    console.error('❌ 缺失账号、密码或有效的 SERVER_PAGE_URL 地址！请检查配置！');
    process.exit(1);
  }

  console.log(`📋 检测到 ${serverUrls.length} 个独立服务器地址待巡检...`);

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
  let reports = [];

  try {
    console.log('🚀 登录 FreeMCHost 控制台...');
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

    // 逐台机器执行巡检/续期
    for (let i = 0; i < serverUrls.length; i++) {
      const currentUrl = serverUrls[i];
      const sIndex = i + 1;
      console.log(`\n================= 正在巡检服务器 [${sIndex}/${serverUrls.length}] =================`);
      console.log(`🔗 目标地址: ${currentUrl}`);

      try {
        await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2500);
        await forceDismissPopups(page);

        // 切换到 Manage 标签
        console.log('🗂️ 正在定位并点击 [Manage] 标签页...');
        const manageTab = page.locator('button, a, div[role="tab"]').filter({ hasText: /^Manage$/ }).first();
        await manageTab.waitFor({ state: 'visible', timeout: 15000 });
        await manageTab.click();
        
        console.log('⏳ 等待 Manage 页面面板加载...');
        const renewBtn = page.locator('button:has-text("Renew now")').first();
        await renewBtn.waitFor({ state: 'visible', timeout: 15000 });
        await page.waitForTimeout(2000);
        await forceDismissPopups(page);

        // 🎯 精确从 TIME UNTIL EXPIRY 方块容器中解析 D / H / M / S 数字
        const timeData = await page.evaluate(() => {
          const allEls = Array.from(document.querySelectorAll('*'));
          const header = allEls.find(el => el.textContent && el.textContent.trim().toUpperCase() === 'TIME UNTIL EXPIRY');
          if (!header) return null;

          let container = header.parentElement;
          for (let k = 0; k < 3; k++) {
            if (container && container.innerText.includes('Renew now')) break;
            if (container && container.parentElement) container = container.parentElement;
          }

          if (!container) return null;

          const text = container.innerText;
          const match = text.match(/(\d{1,2})\s*\n?\s*D[\s\S]*?(\d{1,2})\s*\n?\s*H[\s\S]*?(\d{1,2})\s*\n?\s*M/i);
          if (match) {
            const d = parseInt(match[1], 10);
            const h = parseInt(match[2], 10);
            const m = parseInt(match[3], 10);
            return { totalHours: d * 24 + h + m / 60, raw: `${d}天${h}小时${m}分` };
          }
          return null;
        });

        const remainHours = timeData ? timeData.totalHours : 99;
        const remainStr = timeData ? timeData.raw : '未读取到';
        console.log(`⏱️ 服务器 [${sIndex}] 实际剩余时长: ${remainStr} (约 ${remainHours.toFixed(1)} 小时)`);

        // 判断是否符合 < 46 小时 免费续期门槛
        if (remainHours < 46) {
          console.log(`🎯 时长已低于 46 小时门槛，立即进行 60h 续期...`);
          await renewBtn.click();
          await page.waitForTimeout(2500);

          const renewSuccess = await page.evaluate(() => {
            const allEls = Array.from(document.querySelectorAll('*'));
            const opt60 = allEls.find(el => el.children.length === 0 && el.textContent.trim().toLowerCase().includes('60 hours'));
            if (opt60) {
              let p = opt60;
              for (let j = 0; j < 6; j++) {
                if (p.parentElement && p.parentElement !== document.body) {
                  p = p.parentElement;
                  if (p.tagName === 'BUTTON' || p.getAttribute('role') === 'button' || p.onclick) {
                    p.click();
                    return true;
                  }
                }
              }
              opt60.click();
              return true;
            }
            return false;
          });

          if (renewSuccess) {
            console.log(`🎉 服务器 [${sIndex}] 续期成功！已增加 60 小时！`);
            reports.push(`🟢 <b>服务器 ${sIndex}</b>: 成功满血续期 (+60h)`);
          } else {
            console.log(`⚠️ 服务器 [${sIndex}] 未能在弹窗中选定 60 hours 选项。`);
            reports.push(`🟡 <b>服务器 ${sIndex}</b>: 触发续期但未选定 60h`);
          }
          await page.keyboard.press('Escape');
        } else {
          console.log(`⏳ 服务器 [${sIndex}] 距 46h 开放还差约 ${(remainHours - 46).toFixed(1)} 小时，保持等待。`);
          // 避开直接裸写 < 符号，防止 Telegram HTML 解析器报错
          reports.push(`⚪ <b>服务器 ${sIndex}</b>: 剩余 ${remainStr} (未达 46h)`);
        }

      } catch (innerErr) {
        console.error(`❌ 服务器 [${sIndex}] 处理异常:`, innerErr.message);
        reports.push(`🔴 <b>服务器 ${sIndex}</b>: 巡检失败 (${innerErr.message.substring(0, 30)})`);
      }
    }

    // 汇总推送 Telegram 报告（转义/替换任何可能引起冲突的 HTML 实体符号）
    const summaryMsg = `🤖 <b>FreeMCHost 巡检报告</b>\n\n${reports.join('\n')}\n\n<b>检查周期:</b> 每 12 小时自动巡检\n<b>规则:</b> 触发低于 46h 门槛时自动加满 60h\n<b>时间:</b> ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
    await sendTelegramMessage(tgToken, tgChatId, summaryMsg);

  } catch (error) {
    console.error('❌ 全局致命错误:', error.message);
    await page.screenshot({ path: 'screenshots/renew_fatal.png', fullPage: true });
    await sendTelegramMessage(tgToken, tgChatId, `🚨 <b>Freemchost 运行崩溃:</b> <code>${error.message}</code>`);
    process.exitCode = 1;
  } finally {
    await browser.close();
    console.log('🏁 任务完成，浏览器已关闭。');
  }
})();
