const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// TG 通知函数
async function sendTG(message) {
  const token = process.env.TG_BOT_TOKEN;
  const chatId = process.env.TG_CHAT_ID;
  
  if (!token || !chatId || token.includes('替换')) {
    console.log('未配置有效的 TG 参数，跳过通知。');
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' })
    });
    console.log('📢 TG 通知已发送！');
  } catch (e) {
    console.error("❌ TG推送失败:", e.message);
  }
}

(async () => {
  const screenshotDir = path.join(__dirname, 'screenshots');
  if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir);
  }

  const serverUrls = process.env.SERVER_PAGE_URL 
    ? process.env.SERVER_PAGE_URL.split(',').map(url => url.trim()).filter(url => url)
    : [];

  if (serverUrls.length === 0) {
    console.error('❌ 错误: 未配置 SERVER_PAGE_URL 环境变量！');
    process.exit(1);
  }

  console.log(`📋 检测到共有 ${serverUrls.length} 个服务器待处理...`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.new_context({
    viewport: { width: 1280, height: 1024 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'zh-CN'
  });
  const page = await context.newPage();

  let reportSummary = []; 
  let hasError = false;

  try {
    // ================== 【第一阶段：强化表单登录】 ==================
    console.log('🚀 正在打开 Freemchost 登录页面...');
    await page.goto('https://new.freemchost.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 }); 

    console.log('📝 正在填写账号密码 (人类模拟模式)...');
    const emailInput = page.locator('input[type="email"]');
    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    
    // 【核心改动】：先点击再聚焦，随后用 type 模拟键盘逐字输入（或强力 fill）
    await emailInput.click();
    await emailInput.focus();
    await emailInput.fill(process.env.FREE_EMAIL);
    await page.wait_for_timeout && await page.waitForTimeout(3000) || await new Promise(r => setTimeout(r, 300));

    const passInput = page.locator('input[type="password"]');
    await pass_input_err || await passInput.click();
    await passInput.focus();
    await passInput.fill(process.env.FREE_PASSWORD);
    await page.wait_for_timeout && await page.waitForTimeout(300) || await new Promise(r => setTimeout(r, 300));
    
    console.log('🔐 正在触发登录...');
    const signInBtn = page.locator('button:has-text("Sign in")');
    await signInBtn.click();
    
    console.log('⏳ 等待登录跳转...');
    // 使用更温和的 url 状态判定，不单纯赌 waitForNavigation 动作
    await page.waitForURL(url => !url.href.includes('/login'), { timeout: 30000 });
    console.log('✅ 账号登录成功！');

    // ================== 【第二阶段：循环遍历续期】 ==================
    for (let i = 0; i < serverUrls.length; i++) {
      const currentUrl = serverUrls[i];
      const serverLabel = `服务器 [${i + 1}/${serverUrls.length}]`;
      console.log(`\n------------------ 正在处理 ${serverLabel} ------------------`);
      
      try {
        console.log(`📂 正在直达详情页: ${currentUrl}`);
        await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        console.log('🗂️ 正在切换到 [Manage] 标签页...');
        const manageTab = page.getByText('Manage', { exact: true });
        await manageTab.waitFor({ state: 'visible', timeout: 15000 });
        await manageTab.click();

        // 稍微等 2 秒等 Ajax 组件刷出来
        await page.wait_for_timeout && await page.waitForTimeout(2000) || await new Promise(r => setTimeout(r, 2000));

        console.log('🔍 正在寻觅红色的 [Renew now] 按钮...');
        const renewBtn = page.locator('button:has-text("Renew now")').last();
        
        let isVisible = false;
        try {
          await renewBtn.waitFor({ state: 'visible', timeout: 6000 });
          isVisible = true;
        } catch (e) {
          // 找不到代表不可见
        }
        
        if (isVisible) {
          await renewBtn.click();
          console.log(`🎉 【成功】${serverLabel} 已精准点击续期按钮！`);
          reportSummary.push(`🟢 <b>${serverLabel}</b>: 续期成功`);
          await page.wait_for_timeout && await page.waitForTimeout(3000) || await new Promise(r => setTimeout(r, 3000));
        } else {
          console.log(`⚠️ ${serverLabel} 未找到续期按钮，可能时间未到。`);
          reportSummary.push(`🟡 <b>${serverLabel}</b>: 跳过（时间未到或已续期）`);
        }

      } catch (innerError) {
        console.error(`❌ ${serverLabel} 执行期间发生异常:`, innerError.message);
        hasError = true;
        reportSummary.push(`🔴 <b>${serverLabel}</b>: 失败 (<code>${innerError.message.substring(0, 40)}</code>)`);
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const screenshotPath = path.join(screenshotDir, `error-server-${i+1}-${timestamp}.png`);
        try {
          await page.screenshot({ path: screenshotPath, fullPage: true });
        } catch (snapErr) {}
      }
    }

    // ================== 【第三阶段：汇总推送到 TG】 ==================
    const finalReport = `🤖 <b>Freemchost 自动续期报告</b>\n\n${reportSummary.join('\n')}\n\n<b>时间:</b> ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
    await sendTG(finalReport);

  } catch (globalError) {
    console.error('❌ 致命全局错误:', globalError.message);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      await page.screenshot({ path: path.join(screenshotDir, `global-error-${timestamp}.png`), fullPage: true });
    } catch (e) {}
    
    await sendTG(`🚨 <b>Freemchost 脚本致命全局崩溃</b>\n\n<b>错误:</b> <code>${globalError.message}</code>\n请检查账户安全或重试！`);
    hasError = true;
  } finally {
    await browser.close();
    console.log('\n🏁 浏览器已关闭，任务结束。');
    if (hasError) {
      process.exit(1);
    }
  }
})();
