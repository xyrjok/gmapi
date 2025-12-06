export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // 0. 获取数据库和环境变量
    const XYRJ_GMAILAPI = env.XYRJ_GMAILAPI;
    const ADMIN_USER = env.ADMIN_USERNAME || "";
    const ADMIN_PASS = env.ADMIN_PASSWORD || ""; 

    // 辅助函数
    const jsonResp = (data, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*' 
      }
    });

    // ============================================================
    // 1. 公开 API (发信相关)
    // ============================================================

    // 获取公开渠道
    if (path === '/api/public/channels' && request.method === 'GET') {
      try {
        const { results } = await XYRJ_GMAILAPI.prepare("SELECT id, name FROM gmail_apis WHERE is_active = 1 ORDER BY id ASC").run();
        return jsonResp(results);
      } catch (e) {
        return jsonResp({ error: "Database Error", details: e.message }, 500);
      }
    }

    // 发送留言
    if (path === '/api/contact' && request.method === 'POST') {
      try {
        const { name, contact, message, channel_id } = await request.json();
        
        let targetEmail = env.ADMIN_EMAIL; 
        try {
            const setting = await XYRJ_GMAILAPI.prepare("SELECT value FROM settings WHERE key = 'admin_email'").first();
            if (setting && setting.value) targetEmail = setting.value;
        } catch(e) { console.error("读取数据库配置失败", e); }

        if (!targetEmail) return jsonResp({ success: false, msg: "管理员未设置接收邮箱" }, 500);

        let apiConfig;
        if (channel_id) {
            apiConfig = await XYRJ_GMAILAPI.prepare("SELECT * FROM gmail_apis WHERE id = ? AND is_active = 1").bind(channel_id).first();
        } else {
            apiConfig = await XYRJ_GMAILAPI.prepare("SELECT * FROM gmail_apis WHERE is_active = 1 ORDER BY RANDOM() LIMIT 1").first();
        }

        if (!apiConfig) return jsonResp({ success: false, msg: "暂无可用发送渠道" }, 503);

        const subject = `[${apiConfig.name}] 来自 ${name} 的消息`;
        const body = `姓名: ${name}\n联系方式: ${contact}\n渠道: ${apiConfig.name}\n\n留言内容:\n${message}`;
        const params = new URLSearchParams({ action: 'send', token: apiConfig.token, to: targetEmail, subject, body });

        await fetch(`${apiConfig.script_url}?${params}`);
        await XYRJ_GMAILAPI.prepare("INSERT INTO email_logs (recipient, subject, status) VALUES (?, ?, ?)").bind("ADMIN", subject, `成功(${apiConfig.name})`).run();

        return jsonResp({ success: true, msg: "发送成功" });
      } catch (e) {
        return jsonResp({ success: false, msg: "发送失败: " + e.message }, 500);
      }
    }

    // ============================================================
    // 2. 🔐 管理员 API
    // ============================================================

    // 登录
    if (path === '/api/login' && request.method === 'POST') {
      const { username, password } = await request.json();
      if (username === ADMIN_USER && password === ADMIN_PASS) return jsonResp({ success: true, token: ADMIN_PASS });
      return jsonResp({ success: false, msg: "用户名或密码错误" }, 401);
    }

    // 鉴权中间件
    if (path.startsWith('/api/admin/')) {
      const authHeader = request.headers.get("Authorization");
      if (authHeader !== ADMIN_PASS) return jsonResp({ success: false, msg: "无权访问" }, 401);
    }

    // 系统配置
    if (path === '/api/admin/config' && request.method === 'GET') {
        const { results } = await XYRJ_GMAILAPI.prepare("SELECT * FROM settings").run();
        const config = {}; results.forEach(r => config[r.key] = r.value);
        return jsonResp(config);
    }
    if (path === '/api/admin/config' && request.method === 'POST') {
        const { admin_email } = await request.json();
        await XYRJ_GMAILAPI.prepare("INSERT INTO settings (key, value) VALUES ('admin_email', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(admin_email).run();
        return jsonResp({ success: true });
    }

    // 收件规则管理
    if (path === '/api/admin/receivers' && request.method === 'GET') {
        const { results } = await XYRJ_GMAILAPI.prepare("SELECT * FROM receive_rules ORDER BY id DESC").run();
        return jsonResp(results);
    }
    if (path === '/api/admin/receivers' && request.method === 'POST') {
        const data = await request.json();
        
        // 必填项校验
        if (!data.access_code || !data.name || !data.target_api_name) {
             return jsonResp({ success: false, msg: "必填参数缺失 (名称/查询码/API节点)" }, 400);
        }
        
        // 默认值处理：留空则分别设为 5 和 0 (0代表永久)
        const fetchCount = (data.fetch_count === undefined || data.fetch_count === null || data.fetch_count === '') ? 5 : parseInt(data.fetch_count);
        const validDays = (data.valid_days === undefined || data.valid_days === null || data.valid_days === '') ? 0 : parseInt(data.valid_days);

        try {
            if (data.id) {
                await XYRJ_GMAILAPI.prepare("UPDATE receive_rules SET name=?, access_code=?, fetch_count=?, valid_days=?, match_sender=?, match_body=?, target_api_name=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
                    .bind(data.name, data.access_code, fetchCount, validDays, data.match_sender||'', data.match_body||'', data.target_api_name, data.id).run();
            } else {
                await XYRJ_GMAILAPI.prepare("INSERT INTO receive_rules (name, access_code, fetch_count, valid_days, match_sender, match_body, target_api_name) VALUES (?, ?, ?, ?, ?, ?, ?)")
                    .bind(data.name, data.access_code, fetchCount, validDays, data.match_sender||'', data.match_body||'', data.target_api_name).run();
            }
            return jsonResp({ success: true });
        } catch(e) { return jsonResp({ success: false, msg: e.message }, 500); }
    }
    if (path.startsWith('/api/admin/receivers/') && request.method === 'DELETE') {
        const id = path.split('/').pop();
        await XYRJ_GMAILAPI.prepare("DELETE FROM receive_rules WHERE id = ?").bind(id).run();
        return jsonResp({ success: true });
    }

    // Gmail 节点管理
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
        const parts = line.split(/[|,，]/); 
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

    // 日志管理
    if (path === '/api/admin/logs' && request.method === 'GET') {
      const { results } = await XYRJ_GMAILAPI.prepare("SELECT * FROM email_logs ORDER BY id DESC LIMIT 50").run();
      return jsonResp(results);
    }
    if (path === '/api/admin/logs/clear' && request.method === 'POST') {
        await XYRJ_GMAILAPI.prepare("DELETE FROM email_logs").run();
        return jsonResp({ success: true });
    }

    // ============================================================
    // 3. 【智能拦截】 域名/查询码 收取邮件
    // ============================================================
    const isApi = path.startsWith('/api/');
    // 定义系统文件，防止被误判为查询码
    const isSystemFile = path === '/' || path === '/index.html' || path === '/email.html' || path === '/admin' || path === '/admin.html';
    // 静态资源（含点的文件，如 abc.html, style.css 等）
    const isStaticAsset = path.includes('.'); 

    if (!isApi && !isSystemFile && !isStaticAsset) {
        const code = path.substring(1); // 去掉开头的 /
        
        if (code) {
            const rule = await XYRJ_GMAILAPI.prepare("SELECT * FROM receive_rules WHERE access_code = ?").bind(code).first();
            
            if (rule) {
                try {
                    // 有效期检查 (valid_days=0 代表永久)
                    if (rule.valid_days > 0) {
                        const startTime = new Date(rule.updated_at).getTime();
                        const now = Date.now();
                        const expireTime = startTime + (rule.valid_days * 86400000);
                        if (now > expireTime) {
                            return new Response(`查询码已过期 (Expired)\n过期时间: ${new Date(expireTime).toLocaleString()}`, { status: 403, headers:{'Content-Type':'text/plain;charset=utf-8'} });
                        }
                    }

                    // 节点查找 (严格匹配名称)
                    const apiNode = await XYRJ_GMAILAPI.prepare("SELECT * FROM gmail_apis WHERE name = ? AND is_active = 1").bind(rule.target_api_name).first();
                    if (!apiNode) {
                        return new Response(`配置错误: 指定的 API 节点 [${rule.target_api_name}] 不存在或已停用。`, { status: 503, headers:{'Content-Type':'text/plain;charset=utf-8'} });
                    }

                    // 抓取
                    const fetchUrl = `${apiNode.script_url}?action=get&limit=${rule.fetch_count}&count=${rule.fetch_count}&token=${apiNode.token}`;
                    
                    const gasRes = await fetch(fetchUrl);
                    let emails = [];
                    try { 
                        emails = await gasRes.json(); 
                    } catch (err) { 
                        return new Response("解析邮件数据失败。可能是 Token 错误或 GAS 脚本未返回 JSON。", { status: 502, headers:{'Content-Type':'text/plain;charset=utf-8'} }); 
                    }

                    // 过滤
                    const finalEmails = emails.filter(email => {
                        const content = (email.body || email.snippet || "").toLowerCase();
                        const sender = (email.from || "").toLowerCase();
                        let matchS = true, matchB = true;
                        
                        if (rule.match_sender && rule.match_sender.trim()) {
                            const keys = rule.match_sender.split(/[|,，]/).filter(k => k.trim());
                            matchS = keys.some(k => sender.includes(k.toLowerCase()));
                        }
                        if (rule.match_body && rule.match_body.trim()) {
                            const keys = rule.match_body.split(/[|,，]/).filter(k => k.trim());
                            matchB = keys.some(k => content.includes(k.toLowerCase()));
                        }
                        return matchS && matchB;
                    });

                    // 格式化输出: 日期 时间 | 正文 (中国时间)
                    const contentHtml = finalEmails.map(e => {
                        // 时间转换 UTC -> UTC+8
                        const d = new Date(e.date);
                        const utc = d.getTime(); 
                        const cst = new Date(utc + 8 * 3600000); // 加8小时
                        
                        const y = cst.getUTCFullYear();
                        const m = String(cst.getUTCMonth() + 1).padStart(2, '0');
                        const dd = String(cst.getUTCDate()).padStart(2, '0');
                        const hh = String(cst.getUTCHours()).padStart(2, '0');
                        const mm = String(cst.getUTCMinutes()).padStart(2, '0');
                        const ss = String(cst.getUTCSeconds()).padStart(2, '0');
                        
                        const timeStr = `${y}-${m}-${dd} ${hh}:${mm}:${ss}`;
                        const displayBody = (e.body || e.snippet || "").replace(/</g,'&lt;');

                        return `<div>${timeStr} | ${displayBody}</div>`;
                    }).join('');

                    // 简单的 HTML 外壳
                    let html = `<!DOCTYPE html>
                    <html lang="zh-CN">
                    <head>
                        <meta charset="UTF-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <title>查询结果</title>
                        <style>
                            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 20px; color: #333; line-height: 1.6; font-size: 15px; }
                        </style>
                    </head>
                    <body>
                        ${contentHtml || '<div>暂无符合条件的邮件</div>'}
                    </body>
                    </html>`;

                    return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
                } catch (e) {
                    return new Response("系统错误: " + e.message, { status: 500, headers:{'Content-Type':'text/plain;charset=utf-8'} });
                }
            } else {
                // 数据库中未找到该查询码 -> 显示错误
                return new Response("查询码错！", { status: 404, headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
            }
        }
    }

    return env.ASSETS.fetch(request);
  }
};
