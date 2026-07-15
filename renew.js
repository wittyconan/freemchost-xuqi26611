const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const screenshotDir = path.join(__dirname, 'screenshots');

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function saveScreenshot(page, prefix) {
  const filePath = path.join(screenshotDir, `${prefix}-${timestamp()}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  console.log(`📸 截图已保存至: ${filePath}`);
  return filePath;
}

async function sendTG(message) {
  const token = process.env.TG_BOT_TOKEN;
  const chatId = process.env.TG_CHAT_ID;

  if (!token || !chatId || token.includes('替换')) {
    console.log('未配置有效的 TG 参数，跳过通知。');
    return;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' })
    });

    if (!response.ok) {
      throw new Error(`Telegram HTTP ${response.status}: ${await response.text()}`);
    }
    console.log('📢 TG 通知已发送！');
  } catch (error) {
    console.error('❌ TG 推送失败:', error.message);
  }
}

async function clickFirstVisible(locators, timeout = 1500) {
  for (const locator of locators) {
    const target = locator.first();
    try {
      if (await target.isVisible({ timeout })) {
        await target.click({ timeout: 5000 });
        return true;
      }
    } catch {
      // 当前候选不存在、不可见或被遮挡，继续尝试下一个。
    }
  }
  return false;
}

async function closeBlockingPopups(page) {
  console.log('🕵️ 正在检测并清理屏幕上的拦截弹窗...');

  // 弹窗可能延迟注入，因此进行多轮检测。
  for (let round = 1; round <= 4; round += 1) {
    const popupVisible = await page
      .getByText(/Enjoying FreeMCHost\?|Help us with a quick review/i)
      .first()
      .isVisible({ timeout: 800 })
      .catch(() => false);

    const clicked = await clickFirstVisible([
      page.getByRole('button', { name: /maybe later/i }),
      page.getByText('Maybe later', { exact: true }),
      page.getByRole('button', { name: /close|dismiss/i }),
      page.locator('[aria-label*="close" i]'),
      page.locator('[title*="close" i]'),
      page.locator('button').filter({ hasText: /^\s*[×✕✖]\s*$/ })
    ]);

    if (clicked) {
      console.log(`🧹 第 ${round} 轮发现并关闭了弹窗。`);
      await page.waitForTimeout(700);
      continue;
    }

    if (!popupVisible) break;
    await page.waitForTimeout(800);
  }

  const trustpilotPopup = page
    .getByText(/Enjoying FreeMCHost\?|Help us with a quick review/i)
    .first();

  if (await trustpilotPopup.isVisible({ timeout: 800 }).catch(() => false)) {
    throw new Error('Trustpilot 评价弹窗仍然可见，无法继续操作。');
  }

  // 截图中左下角账号菜单曾处于展开状态，按 Escape 尝试将其收起。
  await page.keyboard.press('Escape').catch(() => {});
  console.log('✅ 弹窗检测完毕！');
}

async function openManageTab(page) {
  console.log('🗂️ 正在切换到 [Manage] 标签页...');

  const candidates = [
    page.getByRole('tab', { name: /^Manage$/i }),
    page.getByRole('link', { name: /^Manage$/i }),
    page.getByRole('button', { name: /^Manage$/i }),
    page.getByText(/^\s*Manage\s*$/i),
    page.locator('a:has-text("Manage"), button:has-text("Manage"), [role="tab"]:has-text("Manage")')
  ];

  for (const candidate of candidates) {
    const count = await candidate.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const target = candidate.nth(index);
      try {
        if (await target.isVisible({ timeout: 1000 })) {
          await target.scrollIntoViewIfNeeded();
          await target.click({ timeout: 10000 });
          console.log('✅ 已点击 Manage 标签。');
          return;
        }
      } catch {
        // 继续尝试其他候选元素。
      }
    }
  }

  const navigationText = await page
    .locator('a, button, [role="tab"]')
    .allInnerTexts()
    .catch(() => []);
  throw new Error(
    `找不到可见的 Manage 标签。当前 URL: ${page.url()}；可见导航文本: ${navigationText
      .map(text => text.trim())
      .filter(Boolean)
      .slice(0, 30)
      .join(' | ')}`
  );
}

async function findRenewButton(page) {
  const candidates = [
    page.getByRole('button', { name: /renew now/i }),
    page.getByRole('link', { name: /renew now/i }),
    page.locator('button:has-text("Renew now"), a:has-text("Renew now")')
  ];

  for (const candidate of candidates) {
    const count = await candidate.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const target = candidate.nth(index);
      if (await target.isVisible({ timeout: 1000 }).catch(() => false)) return target;
    }
  }
  return null;
}

(async () => {
  fs.mkdirSync(screenshotDir, { recursive: true });

  for (const name of ['FREE_EMAIL', 'FREE_PASSWORD', 'SERVER_PAGE_URL']) {
    if (!process.env[name]) {
      throw new Error(`缺少必需的环境变量或 GitHub Secret: ${name}`);
    }
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  let exitCode = 0;

  try {
    console.log('🚀 正在打开 Freemchost 登录页面...');
    await page.goto('https://new.freemchost.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    console.log('📝 正在输入账号密码...');
    await page.locator('input[type="email"]').fill(process.env.FREE_EMAIL, { timeout: 15000 });
    await page.locator('input[type="password"]').fill(process.env.FREE_PASSWORD, { timeout: 15000 });

    console.log('🔐 正在尝试登录...');
    await Promise.all([
      page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 30000 }),
      page.getByRole('button', { name: /sign in/i }).click()
    ]);
    console.log(`✅ 登录成功！当前 URL: ${page.url()}`);

    console.log('📂 正在直达服务器详情页...');
    const response = await page.goto(process.env.SERVER_PAGE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    console.log(`🌐 当前 URL: ${page.url()}，HTTP 状态: ${response?.status() ?? '未知'}`);

    if (response && !response.ok()) {
      throw new Error(`服务器详情页加载失败，HTTP 状态: ${response.status()}`);
    }

    await page.waitForTimeout(1800);
    await closeBlockingPopups(page);
    await page.waitForTimeout(1000);
    await closeBlockingPopups(page);
    await openManageTab(page);

    await page.waitForTimeout(1800);
    await closeBlockingPopups(page);

    console.log('🔍 正在寻找 [Renew now] 按钮...');
    const renewBtn = await findRenewButton(page);

    if (renewBtn) {
      await renewBtn.scrollIntoViewIfNeeded();
      await renewBtn.click({ timeout: 10000 });
      console.log('🎉 【成功】已点击续期按钮！');
      await sendTG(`🎉 <b>Freemchost 自动续期成功</b>\n\n<b>状态:</b> GitHub 机器人已成功登录并点击续期按钮。\n<b>时间:</b> ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
      await page.waitForTimeout(3000);
    } else {
      console.log('⚠️ 未找到续期按钮，可能尚未到续期时间，或页面结构发生变化。');
      await saveScreenshot(page, 'renew-button-not-found');
      await sendTG('⚠️ <b>Freemchost 续期跳过</b>\n\n<b>状态:</b> 页面上未找到 Renew now 按钮，可能尚未到续期时间。');
    }
  } catch (error) {
    exitCode = 1;
    console.error('❌ 自动化执行期间发生异常:', error.message);

    try {
      await saveScreenshot(page, 'error');
    } catch (screenshotError) {
      console.error('❌ 截图保存失败:', screenshotError.message);
    }

    const safeError = String(error.message)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .substring(0, 500);
    await sendTG(`🚨 <b>Freemchost 自动续期失败</b>\n\n<b>错误详情:</b> <code>${safeError}</code>\n<b>排查:</b> 请前往 GitHub Actions 下载现场截图。`);
  } finally {
    await browser.close();
    console.log('🏁 浏览器已关闭，任务结束。');
    process.exitCode = exitCode;
  }
})();
