const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

if (!fs.existsSync('screenshots')) {
  fs.mkdirSync('screenshots');
}

async function sendTelegramMessage(botToken, chatId, text) {
  if (!botToken || !chatId) return;
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' })
    });
  } catch (err) {
    console.error('❌ TG 发送失败:', err.message);
  }
}

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
      el.children.length === 0 && ['maybe later', 'i need help'].includes(el.textContent.trim().toLowerCase())
    );
    targets.forEach(el => el.click());
  });
}

async function safeFill(page, locator, value) {
  await locator.waitFor({ state: 'visible', timeout: 15000 });
  await locator.click();
  await locator.focus();
  await locator.fill(value);
  await page.waitForTimeout(300);
  const val = await locator.inputValue().catch(() => '');
  if (!val) {
    await locator.click();
    await locator.pressSequentially(value, { delay: 30 });
  }
}

// 动态重写 workflow 文件的 Cron
function scheduleNextRunInHours(hoursWait) {
  const workflowPath = path.join('.github', 'workflows', 'freemchost.yml');
  if (!fs.existsSync(workflowPath)) {
    console.log('⚠️ 未在当前运行路径找到 freemchost.yml，跳过动态重写。');
    return;
  }

  // 提前 15 分钟触发，最小等待 10 分钟
  const targetTime = new Date(Date.now() + Math.max(hoursWait * 3600 * 1000 - 15 * 60 * 1000, 10 * 60 * 1000));
  const minute = targetTime.getUTCMinutes();
  const hour = targetTime.getUTCHours();
  const day = targetTime.getUTCDate();
  const month = targetTime.getUTCMonth() + 1;

  const newCron = `${minute} ${hour} ${day} ${month} *`;
  console.log(`⏱️ 计算出的最佳下一次执行时刻 (UTC): ${newCron} (北京时间约: ${targetTime.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })})`);

  let content = fs.readFileSync(workflowPath, 'utf8');
  content = content.replace(/- cron:\s*['"][^'"]+['"]/, `- cron: '${newCron}'`);
  fs.writeFileSync(workflowPath, content, 'utf8');
  console.log('✅ 已成功写入工作流调度计划！');
}

(async () => {
  const email = (process.env.FREE_EMAIL || '').trim();
  const password = (process.env.FREE_PASSWORD || '').trim();
  const rawUrls = (process.env.SERVER_PAGE_URL || '').trim();
  const proxyUrl = (process.env.PROXY_URL || '').trim();
  const tgToken = (process.env.TG_BOT_TOKEN || '').trim();
  const tgChatId = (process.env.TG_CHAT_ID || '').trim();

  const serverUrls = rawUrls
    .split(/[\r\n,]+/)
    .map(u => u.trim())
    .filter(u => u.startsWith('http'));

  if (!email || !password || serverUrls.length === 0) {
    console.error('❌ 缺失账号或有效的 SERVER_PAGE_URL 地址！');
    process.exit(1);
  }

  console.log(`📋 检测到 ${serverUrls.length} 个独立服务器地址待巡检...`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1920,1080'],
    proxy: proxyUrl ? { server: proxyUrl } : undefined
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();
  let reports = [];
  let minWaitHours = 999;

  try {
    console.log('🚀 登录 FreeMCHost 控制台...');
    await page.goto('https://freemchost.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
    await forceDismissPopups(page);

    await safeFill(page, page.locator('input[type="email"], input[name="email"]').first(), email);
    await safeFill(page, page.locator('input[type="password"], input[name="password"]').first(), password);
    
    const signInBtn = page.locator('button:has-text("Sign in"), button[type="submit"]').first();
    await Promise.all([
      page.waitForURL(url => !url.href.includes('/login'), { timeout: 45000 }),
      signInBtn.click()
    ]);
    console.log('✅ 登录成功！');

    for (let i = 0; i < serverUrls.length; i++) {
      const currentUrl = serverUrls[i];
      const sIndex = i + 1;
      console.log(`\n================= 正在巡检服务器 [${sIndex}/${serverUrls.length}] =================`);
      console.log(`🔗 目标地址: ${currentUrl}`);

      try {
        await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2500);
        await forceDismissPopups(page);

        // 点击 Manage 标签
        const manageTab = page.locator('button, a, div[role="tab"]').filter({ hasText: /^Manage$/ }).first();
        await manageTab.waitFor({ state: 'visible', timeout: 15000 });
        await manageTab.click();
        
        // 关键：显式等待倒计时卡片在 Manage 页面完成动态水合加载
        console.log('⏳ 等待倒计时与 Renew now 按钮加载...');
        const renewBtn = page.locator('button:has-text("Renew now")').first();
        await renewBtn.waitFor({ state: 'visible', timeout: 15000 });
        await page.waitForTimeout(1500);
        await forceDismissPopups(page);

        // 精确从 TIME UNTIL EXPIRY 容器中抓取 D / H / M 数字
        const timeData = await page.evaluate(() => {
          // 查找包含 TIME UNTIL EXPIRY 的父级容器
          const headings = Array.from(document.querySelectorAll('*'));
          const expiryHeader = headings.find(el => el.textContent && el.textContent.trim().toUpperCase() === 'TIME UNTIL EXPIRY');
          
          let containerText = '';
          if (expiryHeader && expiryHeader.parentElement) {
            containerText = expiryHeader.parentElement.innerText;
          } else {
            containerText = document.body.innerText || '';
          }

          // 匹配紧跟在方块结构里的格式: 数字 D 数字 H 数字 M
          const match = containerText.match(/(\d{1,2})\s*\n?\s*D\s*\n?\s*(\d{1,2})\s*\n?\s*H\s*\n?\s*(\d{1,2})\s*\n?\s*M/i);
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

        // 判断是否小于 46 小时
        if (remainHours < 46) {
          console.log(`🎯 时长低于 46 小时，执行续期...`);
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
            console.log(`🎉 服务器 [${sIndex}] 续期成功！`);
            reports.push(`🟢 <b>服务器 ${sIndex}</b>: 成功满血续期 (+60h)`);
            minWaitHours = Math.min(minWaitHours, 13.8);
          } else {
            console.log(`⚠️ 服务器 [${sIndex}] 未能点击到 60 hours 选项。`);
            reports.push(`🟡 <b>服务器 ${sIndex}</b>: 触发续期但未选定 60h`);
          }
          await page.keyboard.press('Escape');
        } else {
          const waitTime = Math.max(remainHours - 46, 0.5);
          minWaitHours = Math.min(minWaitHours, waitTime);
          console.log(`⏳ 服务器 [${sIndex}] 尚未进入 46h 窗口，距开放还差约 ${waitTime.toFixed(1)} 小时。`);
          reports.push(`⚪ <b>服务器 ${sIndex}</b>: 剩余 ${remainStr} (未达 46h)`);
        }

      } catch (innerErr) {
        console.error(`❌ 服务器 [${sIndex}] 处理异常:`, innerErr.message);
        reports.push(`🔴 <b>服务器 ${sIndex}</b>: 巡检失败 (${innerErr.message.substring(0, 30)})`);
      }
    }

    if (minWaitHours === 999) minWaitHours = 6;
    scheduleNextRunInHours(minWaitHours);

    const nextExecutionText = new Date(Date.now() + minWaitHours * 3600 * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const summaryMsg = `🤖 <b>FreeMCHost 动态续期监控报告</b>\n\n${reports.join('\n')}\n\n<b>下次执行预计:</b> ${nextExecutionText} 左右\n<b>策略:</b> 纯动态睡眠调度 (零多余资源消耗)`;
    await sendTelegramMessage(tgToken, tgChatId, summaryMsg);

  } catch (error) {
    console.error('❌ 全局错误:', error.message);
    await sendTelegramMessage(tgToken, tgChatId, `🚨 <b>Freemchost 运行崩溃:</b> <code>${error.message}</code>`);
    process.exitCode = 1;
  } finally {
    await browser.close();
    console.log('🏁 任务完成，浏览器已关闭。');
  }
})();
