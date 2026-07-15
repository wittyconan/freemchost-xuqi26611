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

  // 启动无头浏览器
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    console.log('🚀 正在打开 Freemchost 登录页面...');
    await page.goto('https://new.freemchost.com/login', { waitUntil: 'networkidle', timeout: 60000 }); 

    console.log('📝 正在输入账号密码...');
    await page.waitForSelector('input[type="email"]', { timeout: 15000 });
    await page.locator('input[type="email"]').fill(process.env.FREE_EMAIL);
    await page.locator('input[type="password"]').fill(process.env.FREE_PASSWORD);
    
    console.log('🔐 正在尝试登录...');
    await page.locator('button:has-text("Sign in")').click();
    
    console.log('⏳ 等待登录跳转...');
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 });
    console.log('✅ 登录成功！');

    console.log('📂 正在直达服务器详情页...');
    await page.goto(process.env.SERVER_PAGE_URL, { waitUntil: 'networkidle', timeout: 30000 });

    // 🛡️ 终极防线：自动检测并关闭连环弹窗 (Discord邀请、Trustpilot评价等)
    console.log('🕵️ 正在检测并清理屏幕上的连环拦截弹窗...');
    // 循环3次，对付连环弹窗。就算它弹3个不同的窗也能全部点掉
    for (let i = 0; i < 3; i++) {
      try {
        // 使用 .first() 防止出现多个隐藏按钮导致 strict 模式报错
        const maybeLaterBtn = page.getByText('Maybe later', { exact: true }).first();
        // 最多等 3 秒，如果没弹窗就会报错跳入 catch 并结束循环
        await maybeLaterBtn.waitFor({ state: 'visible', timeout: 3000 });
        
        console.log(`👋 发现弹窗 (第 ${i + 1} 个)，已成功点击关闭！`);
        await maybeLaterBtn.click();
        await page.waitForTimeout(1500); // 给一点时间让弹窗动画消失，迎接可能出现的下一个弹窗
      } catch (e) {
        // 如果超时报错，说明页面上已经没有可见的 Maybe later 按钮了，安全了
        break; 
      }
    }
    console.log('✅ 弹窗检测完毕，环境安全！');

    console.log('🗂️ 正在切换到 [Manage] 标签页...');
    const manageTab = page.getByText('Manage', { exact: true });
    await manageTab.waitFor({ state: 'visible', timeout: 15000 });
    await manageTab.click();

    await page.waitForTimeout(2000);

    console.log('🔍 正在寻觅红色的 [Renew now] 按钮...');
    const renewBtn = page.locator('button:has-text("Renew now")').last();
    
    await renewBtn.waitFor({ state: 'visible', timeout: 10000 });
    
    if (await renewBtn.isVisible()) {
      await renewBtn.click();
      console.log('🎉 【成功】已精准点击续期按钮！');
      
      // 调用 TG 发送成功通知！
      await sendTG(`🎉 <b>Freemchost 自动续期成功</b>\n\n<b>状态:</b> GitHub 机器人已成功登录并点击续期按钮。\n<b>时间:</b> ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
      
      await page.waitForTimeout(5000);
    } else {
      console.log('⚠️ 未找到续期按钮，可能已被续期，或者页面结构有变。');
      // 调用 TG 发送跳过通知
      await sendTG(`⚠️ <b>Freemchost 续期跳过</b>\n\n<b>状态:</b> 页面上未找到 Renew now 按钮，可能时间未到或页面变动。`);
    }

  } catch (error) {
    console.error('❌ 自动化执行期间发生异常:', error.message);
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const screenshotPath = path.join(screenshotDir, `error-${timestamp}.png`);
    
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`📸 现场截图已保存至: ${screenshotPath}`);
    } catch (screenshotError) {
      console.error('❌ 截图保存失败:', screenshotError.message);
    }
    
    // 调用 TG 发送失败报警！
    await sendTG(`🚨 <b>Freemchost 自动续期失败</b>\n\n<b>错误详情:</b> <code>${error.message.substring(0, 150)}...</code>\n<b>排查:</b> 脚本已异常退出，请前往 GitHub Actions 页面下载现场截图！`);
    
    process.exit(1);
  } finally {
    await browser.close();
    console.log('🏁 浏览器已关闭，任务结束。');
  }
})();
