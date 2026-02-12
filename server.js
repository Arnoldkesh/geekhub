const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const STORE_PATH = path.join(__dirname, 'data', 'store.json');
const CSS_PATH = path.join(__dirname, 'public', 'styles.css');
const sessions = new Map();

function readStore() {
  return JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
}
function writeStore(data) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}
function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(raw.split(';').filter(Boolean).map((pair) => {
    const idx = pair.indexOf('=');
    return [pair.slice(0, idx).trim(), decodeURIComponent(pair.slice(idx + 1))];
  }));
}
function getSessionUser(req, store) {
  const sid = parseCookies(req).sid;
  const userId = sid && sessions.get(sid);
  if (!userId) return null;
  return store.users.find((u) => u.id === userId) || null;
}
function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      const out = {};
      new URLSearchParams(data).forEach((v, k) => { out[k] = v; });
      resolve(out);
    });
  });
}
function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}
function renderPage(title, body) {
  return `<!doctype html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>${title}</title><link rel="stylesheet" href="/styles.css"/></head><body>${body}</body></html>`;
}
function nav(user) {
  if (!user) return '';
  const links = user.role === 'admin'
    ? '<a href="/admin">Admin Panel</a>'
    : '<a href="/dashboard">Dashboard</a><a href="/payments">Payments</a>';
  return `<nav>${links}<form action="/logout" method="post"><button>Logout</button></form></nav>`;
}

function renderPaymentsPage(user, store, message) {
  const payments = store.payments
    .filter((p) => p.userId === user.id)
    .map((p) => `<li><strong>${escapeHtml(p.method)}</strong> - ${escapeHtml(p.amount)} | Ref: ${escapeHtml(p.reference)} (${escapeHtml(p.status)})</li>`)
    .join('');

  const body = `<header><h1>Payments</h1><p>Submit 420Shots payments via bank transfer or mobile money.</p><nav><a href="/dashboard">Dashboard</a><a href="/">Home</a><form action="/logout" method="post"><button>Logout</button></form></nav></header><main>
      ${message ? `<p class="alert success">${message}</p>` : ''}
      <section class="grid-two"><div class="card"><h2>New Payment</h2><form action="/payments" method="post"><label>Payment Method<select name="method" required><option value="">Choose method</option><option value="bank">Bank Transfer</option><option value="mobile_money">Mobile Money</option></select></label><label>Amount<input name="amount" type="number" min="1" required/></label><label>Reference / Transaction ID<input name="reference" required/></label><button>Submit Payment</button></form></div>
      <div class="card"><h2>Payment History</h2>${payments ? `<ul>${payments}</ul>` : '<p>No payments submitted yet.</p>'}</div></section>
      <section class="card"><h2>Payment Details</h2><p>${escapeHtml(store.site.description)}</p></section></main>`;

  return renderPage('420Shots | Payments', body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const store = readStore();
  const user = getSessionUser(req, store);

  if (req.method === 'GET' && url.pathname === '/styles.css') {
    res.writeHead(200, { 'Content-Type': 'text/css' });
    return res.end(fs.readFileSync(CSS_PATH));
  }

  if (req.method === 'GET' && url.pathname === '/') {
    const error = escapeHtml(url.searchParams.get('error') || '');
    const success = escapeHtml(url.searchParams.get('success') || '');
    const aboutImgs = store.site.images.map((img) => `<img src="${escapeHtml(img)}" alt="420Shots image" />`).join('');
    const body = `<header><h1>420Shots</h1><p>Payments via bank or mobile money + user administration.</p>${nav(user)}</header><main>
      ${error ? `<p class="alert error">${error}</p>` : ''}
      ${success ? `<p class="alert success">${success}</p>` : ''}
      <section class="grid-two">
        <div class="card"><h2>Login</h2><form action="/login" method="post"><label>Email <input name="email" type="email" required/></label><label>Password <input name="password" type="password" required/></label><button>Sign in</button></form><small>Default admin: admin@420shots.com / admin</small></div>
        <div class="card"><h2>Create Account</h2><form action="/register" method="post"><label>Name <input name="name" required/></label><label>Email <input name="email" type="email" required/></label><label>Password <input name="password" type="password" required/></label><button>Register</button></form></div>
      </section>
      <section class="card"><h2>About</h2><p>${escapeHtml(store.site.description)}</p><div class="image-grid">${aboutImgs}</div></section>
    </main>`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(renderPage('420Shots | Home', body));
  }

  if (req.method === 'POST' && url.pathname === '/register') {
    const { name, email, password } = await parseBody(req);
    if (!name || !email || !password) return redirect(res, '/?error=All registration fields are required');
    if (store.users.some((u) => u.email.toLowerCase() === email.toLowerCase())) return redirect(res, '/?error=Email already in use');
    store.users.push({ id: `u${Date.now()}`, name, email, passwordHash: hashPassword(password), role: 'user', createdAt: new Date().toISOString() });
    writeStore(store);
    return redirect(res, '/?success=Account created. Please login.');
  }

  if (req.method === 'POST' && url.pathname === '/login') {
    const { email, password } = await parseBody(req);
    const found = store.users.find((u) => u.email.toLowerCase() === String(email).toLowerCase());
    if (!found || found.passwordHash !== hashPassword(password)) return redirect(res, '/?error=Invalid login details');
    const sid = crypto.randomUUID();
    sessions.set(sid, found.id);
    res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; Path=/; Max-Age=86400`);
    return redirect(res, found.role === 'admin' ? '/admin' : '/dashboard');
  }

  if (req.method === 'POST' && url.pathname === '/logout') {
    const sid = parseCookies(req).sid;
    if (sid) sessions.delete(sid);
    res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
    return redirect(res, '/');
  }

  if (req.method === 'GET' && url.pathname === '/dashboard') {
    if (!user) return redirect(res, '/');
    const message = escapeHtml(url.searchParams.get('message') || '');
    const body = `<header><h1>Welcome, ${escapeHtml(user.name)}</h1><nav><a href="/">Home</a><a href="/payments">Payments</a><form action="/logout" method="post"><button>Logout</button></form></nav></header><main>
      ${message ? `<p class="alert success">${message}</p>` : ''}
      <section class="card"><h2>User Dashboard</h2><p>Manage your account and submit payments on the Payments page.</p><a href="/payments"><button type="button">Go to Payments</button></a></section>
      <section class="card"><h2>About 420Shots</h2><p>${escapeHtml(store.site.description)}</p></section></main>`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(renderPage('420Shots | Dashboard', body));
  }

  if (req.method === 'GET' && url.pathname === '/payments') {
    if (!user) return redirect(res, '/');
    const message = escapeHtml(url.searchParams.get('message') || '');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(renderPaymentsPage(user, store, message));
  }

  if (req.method === 'POST' && url.pathname === '/payments') {
    if (!user) return redirect(res, '/');
    const { method, amount, reference } = await parseBody(req);
    if (!method || !amount || !reference) return redirect(res, '/payments?message=Please fill every payment field');
    if (!['bank', 'mobile_money'].includes(method)) return redirect(res, '/payments?message=Payment method not supported');
    store.payments.push({ id: `p${Date.now()}`, userId: user.id, method, amount, reference, status: 'pending_verification', createdAt: new Date().toISOString() });
    writeStore(store);
    return redirect(res, '/payments?message=Payment submitted for verification');
  }

  if (req.method === 'GET' && url.pathname === '/admin') {
    if (!user || user.role !== 'admin') {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Admins only');
    }
    const message = escapeHtml(url.searchParams.get('message') || '');
    const usersHtml = store.users.map((u) => `<tr><td>${escapeHtml(u.name)}</td><td>${escapeHtml(u.email)}</td><td>${escapeHtml(u.role)}</td><td><form action="/admin/users/${u.id}/role" method="post"><button>Toggle Role</button></form></td></tr>`).join('');
    const paymentsHtml = store.payments.length ? store.payments.map((p) => `<li>${escapeHtml(p.id)} - <strong>${escapeHtml(p.method)}</strong> | Amount: ${escapeHtml(p.amount)} | Ref: ${escapeHtml(p.reference)} | Status: ${escapeHtml(p.status)}</li>`).join('') : '<li>No submitted payments yet.</li>';
    const body = `<header><h1>Admin Panel</h1><nav><a href="/">Home</a><form action="/logout" method="post"><button>Logout</button></form></nav></header><main>
      ${message ? `<p class="alert success">${message}</p>` : ''}
      <section class="card"><h2>Manage Users</h2><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Action</th></tr></thead><tbody>${usersHtml}</tbody></table></section>
      <section class="card"><h2>Submitted Payments</h2><ul>${paymentsHtml}</ul></section>
      <section class="card"><h2>Website Description & Pictures</h2><form action="/admin/site" method="post"><label>Description<textarea name="description" rows="4">${escapeHtml(store.site.description)}</textarea></label><label>Image URL 1<input name="image1" value="${escapeHtml(store.site.images[0] || '')}"/></label><label>Image URL 2<input name="image2" value="${escapeHtml(store.site.images[1] || '')}"/></label><label>Image URL 3<input name="image3" value="${escapeHtml(store.site.images[2] || '')}"/></label><button>Save Content</button></form></section>
    </main>`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(renderPage('420Shots | Admin', body));
  }

  if (req.method === 'POST' && /^\/admin\/users\/[^/]+\/role$/.test(url.pathname)) {
    if (!user || user.role !== 'admin') {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Admins only');
    }
    const id = url.pathname.split('/')[3];
    const target = store.users.find((u) => u.id === id);
    if (!target) return redirect(res, '/admin?message=User not found');
    target.role = target.role === 'admin' ? 'user' : 'admin';
    writeStore(store);
    return redirect(res, '/admin?message=User role updated');
  }

  if (req.method === 'POST' && url.pathname === '/admin/site') {
    if (!user || user.role !== 'admin') {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Admins only');
    }
    const { description, image1, image2, image3 } = await parseBody(req);
    store.site.description = description || '';
    store.site.images = [image1, image2, image3].filter(Boolean);
    writeStore(store);
    return redirect(res, '/admin?message=Site content updated');
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`420Shots app running at http://localhost:${PORT}`);
});
