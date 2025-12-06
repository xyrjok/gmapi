export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // ============================================================
    // 1. 基础配置 (从环境变量读取身份信息)
    // ============================================================
    const ADMIN_USER = env.ADMIN_USERNAME || "";
    const ADMIN_PASS = env.ADMIN_PASSWORD || ""; // 建议在CF后台设置

    // 辅助函数
    const jsonResp = (data, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*' 
      }
    });

    // ============================================================
    // 🌍 公开 API
    // ============================================================

    // 1. 获取公开渠道列表
    if (path === '/api/public/channels' && request.method === 'GET') {
      const { results } = await XYRJ_GMAILAPI.prepare(
        "SELECT id, name FROM gmail_apis WHERE is_active = 1 ORDER BY id ASC"
      ).run();
      return jsonResp(results);
    }

    // 2. 游客发送留言 (核心修改：从数据库读取接收邮箱)
    if (path === '/api/contact' && request.method === 'POST') {
      try {
        const { name, contact, message, channel_id } = await request.json();
        
        // A. 获取接收邮箱 (优先读数据库，没有则读环境变量)
        let targetEmail = env.ADMIN_EMAIL; // 环境变量兜底
        try {
            const setting = await XYRJ_GMAILAPI.prepare("SELECT value FROM settings WHERE key = 'admin_email'").first();
            if (setting && setting.value) targetEmail = setting.value;
        } catch(e) { console.error("读取数据库配置失败", e); }

        if (!targetEmail) return jsonResp({ success: false, msg: "管理员未设置接收邮箱" }, 500);

        // B. 确定发送渠道
        let apiConfig;
        if (channel_id) {
            apiConfig = await XYRJ_GMAILAPI.prepare("SELECT * FROM gmail_apis WHERE id = ? AND is_active = 1").bind(channel_id).first();
        } else {
            apiConfig = await XYRJ_GMAILAPI.prepare("SELECT * FROM gmail_apis WHERE is_active = 1 ORDER BY RANDOM() LIMIT 1").first();
        }

        if (!apiConfig) return jsonResp({ success: false, msg: "暂无可用发送渠道" }, 503);

        // C. 发送
        const subject = `[${apiConfig.name}] 来自 ${name} 的消息`;
        const body = `姓名: ${name}\n联系方式: ${contact}\n渠道: ${apiConfig.name}\n\n留言内容:\n${message}`;

        const params = new URLSearchParams({
          action: 'send', token: apiConfig.token, 
          to: targetEmail, subject, body
        });

        await fetch(`${apiConfig.script_url}?${params}`);
        
        // D. 记日志
        await XYRJ_GMAILAPI.prepare("INSERT INTO email_logs (recipient, subject, status) VALUES (?, ?, ?)")
          .bind("ADMIN", subject, `成功(${apiConfig.name})`).run();

        return jsonResp({ success: true, msg: "发送成功" });
      } catch (e) {
        return jsonResp({ success: false, msg: "发送失败: " + e.message }, 500);
      }
    }

    // ============================================================
    // 🔐 管理员 API (需要 Token)
    // ============================================================

    // 登录 (修改：验证用户名和密码)
    if (path === '/api/login' && request.method === 'POST') {
      const { username, password } = await request.json();
      // 只有用户名和密码都对，才返回 Token (Token 直接用密码本身即可，或者你可以生成一个随机数存KV)
      if (username === ADMIN_USER && password === ADMIN_PASS) {
          return jsonResp({ success: true, token: ADMIN_PASS });
      }
      return jsonResp({ success: false, msg: "用户名或密码错误" }, 401);
    }

    // 鉴权中间件
    if (path.startsWith('/api/admin/')) {
      const authHeader = request.headers.get("Authorization");
      if (authHeader !== ADMIN_PASS) return jsonResp({ success: false, msg: "无权访问" }, 401);
    }

    // --- 新增：系统配置管理 (读写 settings 表) ---
    
    // 获取配置
    if (path === '/api/admin/config' && request.method === 'GET') {
        const { results } = await XYRJ_GMAILAPI.prepare("SELECT * FROM settings").run();
        // 转换成对象格式 { admin_email: "..." }
        const config = {};
        results.forEach(r => config[r.key] = r.value);
        return jsonResp(config);
    }

    // 保存配置
    if (path === '/api/admin/config' && request.method === 'POST') {
        const { admin_email } = await request.json();
        // 使用 UPSERT 语法 (如果有则更新，无则插入)
        await XYRJ_GMAILAPI.prepare(`
            INSERT INTO settings (key, value) VALUES ('admin_email', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).bind(admin_email).run();
        return jsonResp({ success: true });
    }

    // --- Gmail API 管理 (保持不变) ---
    if (path === '/api/admin/gmails' && request.method === 'GET') {
      const { results } = await XYRJ_GMAILAPI.prepare("SELECT * FROM gmail_apis ORDER BY id DESC").run();
      return jsonResp(results);
    }
    if (path === '/api/admin/gmails' && request.method === 'POST') {
      const { name, url, token } = await request.json();
      await XYRJ_GMAILAPI.prepare("INSERT INTO gmail_apis (name, script_url, token) VALUES (?, ?, ?)").bind(name, url, token).run();
      return jsonResp({ success: true });
    }
    if (path === '/api/admin/gmails/batch' && request.method === 'POST') {
      const { content } = await request.json(); 
      const lines = content.split('\n');
      const stmt = XYRJ_GMAILAPI.prepare("INSERT INTO gmail_apis (name, script_url, token) VALUES (?, ?, ?)");
      const batch = [];
      for (let line of lines) {
        const parts = line.split(',');
        if (parts.length >= 3) batch.push(stmt.bind(parts[0].trim(), parts[1].trim(), parts[2].trim()));
      }
      if(batch.length > 0) await XYRJ_GMAILAPI.batch(batch);
      return jsonResp({ success: true });
    }
    if (path.startsWith('/api/admin/gmails/') && request.method === 'DELETE') {
      const id = path.split('/').pop();
      await XYRJ_GMAILAPI.prepare("DELETE FROM gmail_apis WHERE id = ?").bind(id).run();
      return jsonResp({ success: true });
    }
    if (path === '/api/admin/gmails/toggle' && request.method === 'POST') {
        const { id, status } = await request.json();
        await XYRJ_GMAILAPI.prepare("UPDATE gmail_apis SET is_active = ? WHERE id = ?").bind(status, id).run();
        return jsonResp({ success: true });
    }

    // --- 日志管理 (保持不变) ---
    if (path === '/api/admin/logs' && request.method === 'GET') {
      const { results } = await XYRJ_GMAILAPI.prepare("SELECT * FROM email_logs ORDER BY id DESC LIMIT 50").run();
      return jsonResp(results);
    }
    if (path === '/api/admin/logs/clear' && request.method === 'POST') {
        await XYRJ_GMAILAPI.prepare("DELETE FROM email_logs").run();
        return jsonResp({ success: true });
    }

    // 页面路由
    // 修复：删除了之前导致死循环的 /admin 手动判断
    return env.ASSETS.fetch(request);
  }
};
