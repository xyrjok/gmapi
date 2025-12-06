// 全局配置与工具函数

// 1. 鉴权检查 (在非登录页执行)
function checkAuth() {
    if (!sessionStorage.getItem('admin_token')) {
        window.location.href = 'index.html'; // 跳转回登录页
    }
}

// 2. 退出登录
function logout() {
    sessionStorage.removeItem('admin_token');
    window.location.href = 'index.html';
}

// 3. 通用 API 请求函数
async function api(url, method = 'GET', data = null) {
    const headers = { 
        'Content-Type': 'application/json', 
        'Authorization': sessionStorage.getItem('admin_token') 
    };
    const opts = { method, headers };
    if (data) opts.body = JSON.stringify(data);
    
    try {
        const res = await fetch(url, opts);
        if (res.status === 401) { 
            sessionStorage.removeItem('admin_token');
            window.location.href = 'index.html'; 
            return null; 
        }
        return res.json();
    } catch(e) { console.error(e); return null; }
}

// 4. 侧边栏交互
function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('show');
    document.getElementById('overlay').classList.toggle('show');
}

// 5. 初始化侧边栏高亮 (根据当前URL)
function initSidebar() {
    const path = window.location.pathname;
    document.querySelectorAll('.nav-link').forEach(link => {
        if (path.includes(link.getAttribute('href'))) {
            link.classList.add('active');
        }
    });
}
