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
  // 确保截图保存目录存在
  const screenshotDir = path.join(__dirname, 'screenshots');
  if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir);
  }

  // 1. 解析多服务器 URL
  // 支持在环境变量中用逗号隔开：url1,url2,url3
  const serverUrls = process.env.SERVER_PAGE_URL 
    ? process.env.SERVER_PAGE_URL.split(',').map(url => url.trim()).filter(url => url)
    : [];

  if (serverUrls.length === 0) {
    console.error('❌ 错误: 未配置 SERVER_PAGE_URL 环境变量！');
    process.exit(1);
  }

  console.log(`📋 检测到共有 ${serverUrls.length} 个服务器待处理...`);

  // 启动无头浏览器
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1024 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  // 用一个数组记录所有服务器的最终处理结果，最后汇总发一条 TG
  let reportSummary = []; 
  let hasError = false;

  try {
    // ================== 【第一阶段：统一登录】 ==================
    console.log('🚀 正在打开 Freemchost 登录页面...');
    await page.goto('https://new.freemchost.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 }); 

    console.log('📝 正在输入账号密码...');
    await page.waitForSelector('input[type="email"]', { timeout: 15000 });
    await page.locator('input[type="email"]').fill(process.env.FREE_EMAIL);
    await page.locator('input[type="password"]').fill(process.env.FREE_PASSWORD);
    
    console.log('🔐 正在尝试登录...');
    await page.locator('button:has-text("Sign in")').click();
    
    console.log('⏳ 等待登录跳转...');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('✅ 账号登录成功！');

    // ================== 【第二阶段：循环遍历续期】 ==================
    for (let i = 0; i < serverUrls.length; i++) {
      const currentUrl = serverUrls[i];
      // 从 URL 中提取服务器 ID 或者用序号标记，方便日志看
      const serverLabel = `服务器 [${i + 1}/${serverUrls.length}]`;
      console.log(`\n------------------ 正在处理 ${serverLabel} ------------------`);
      
      try {
        console.log(`📂 正在直达详情页: ${currentUrl}`);
        await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        console.log('🗂️ 正在切换到 [Manage] 标签页...');
        const manageTab = page.getByText('Manage', { exact: true });
        await manageTab.waitFor({ state: 'visible', timeout: 15000 });
        await manageTab.click();

        await page.waitForTimeout(2000);

        console.log('🔍 正在寻觅红色的 [Renew now] 按钮...');
        const renewBtn = page.locator('button:has-text("Renew now")').last();
        
        try {
          await renewBtn.waitFor({ state: 'visible', timeout: 8000 });
        } catch (e) {
          // 找不到按钮代表无需续期
        }
        
        if (await renewBtn.isVisible()) {
          await renewBtn.click();
          console.log(`🎉 【成功】${serverLabel} 已精准点击续期按钮！`);
          reportSummary.push(`🟢 <b>${serverLabel}</b>: 续期成功`);
          await page.waitForTimeout(3000);
        } else {
          console.log(`⚠️ ${serverLabel} 未找到续期按钮，可能时间未到。`);
          reportSummary.push(`🟡 <b>${serverLabel}</b>: 跳过（时间未到或已续期）`);
        }

      } catch (innerError) {
        console.error(`❌ ${serverLabel} 执行期间发生异常:`, innerError.message);
        hasError = true;
        reportSummary.push(`🔴 <b>${serverLabel}</b>: 失败 (<code>${innerError.message.substring(0, 40)}</code>)`);
        
        // 针对出错的服务器单独截个现场图
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const screenshotPath = path.join(screenshotDir, `error-server-${i+1}-${timestamp}.png`);
        try {
          await page.screenshot({ path: screenshotPath, fullPage: true });
          console.log(`📸 ${serverLabel} 错误现场截图已保存: ${screenshotPath}`);
        } catch (snapErr) {
          console.error('❌ 截图失败:', snapErr.message);
        }
      }
    }

    // ================== 【第三阶段：汇总推送到 TG】 ==================
    const finalReport = `🤖 <b>Freemchost 自动续期报告</b>\n\n${reportSummary.join('\n')}\n\n<b>时间:</b> ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
    await sendTG(finalReport);

  } catch (globalError) {
    // 捕获全局登录阶段或者致命的系统错误
    console.error('❌ 致命全局错误:', globalError.message);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    await page.screenshot({ path: path.join(screenshotDir, `global-error-${timestamp}.png`), fullPage: true });
    
    await sendTG(`🚨 <b>Freemchost 脚本致命全局崩溃</b>\n\n<b>错误:</b> <code>${globalError.message}</code>\n请检查账号密码或登录面板是否变动！`);
    hasError = true;
  } finally {
    await browser.close();
    console.log('\n🏁 浏览器已关闭，多服务器续期任务结束。');
    // 如果有任何一台服务器失败了，让 GitHub Actions 报错挂起，方便留意到
    if (hasError) {
      process.exit(1);
    }
  }
})();
