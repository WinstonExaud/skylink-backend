# SKYLINK NET — Backend API

Node.js + Express + PostgreSQL ISP-grade hotspot management backend.

---

## 🚀 Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env with your database credentials and MikroTik details
```

### 3. Create the database
```sql
-- In psql or pgAdmin:
CREATE DATABASE skylink_db;
CREATE USER skylink_user WITH PASSWORD 'skylink_pass_change_me';
GRANT ALL PRIVILEGES ON DATABASE skylink_db TO skylink_user;
```

### 4. Run migrations (creates all tables)
```bash
npm run migrate
```

### 5. Seed default admin + plans
```bash
npm run seed
# Creates admin/admin123 and the 4 data plans
```

### 6. Start the server
```bash
npm run dev      # Development (auto-restart)
npm start        # Production
```

---

## 📁 Project Structure

```
skylink-backend/
├── src/
│   ├── app.js                    # Express app + server entry
│   ├── routes/
│   │   └── index.js              # All API routes
│   ├── controllers/
│   │   ├── authController.js     # Admin login/logout
│   │   ├── voucherController.js  # Voucher CRUD + captive portal auth
│   │   ├── sessionController.js  # Session management
│   │   └── adminController.js    # Dashboard stats, devices, logs, plans
│   ├── services/
│   │   ├── mikrotikService.js    # MikroTik RouterOS API integration
│   │   ├── voucherService.js     # Voucher generation + validation logic
│   │   └── sessionService.js     # Session lifecycle management
│   ├── middleware/
│   │   ├── authMiddleware.js     # JWT verification
│   │   └── validateVoucher.js    # Request validation
│   ├── jobs/
│   │   └── expiryJob.js          # Cron: enforce 24h expiry every minute
│   └── config/
│       ├── db.js                 # PostgreSQL connection pool
│       ├── migrate.js            # Run: npm run migrate
│       └── seed.js               # Run: npm run seed
├── .env.example
├── package.json
└── README.md
```

---

## 🔌 API Endpoints

**Base URL:** `http://192.168.88.2:3000/api`

### Public Endpoints (no auth — captive portal)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/auth/admin-login` | Admin login → returns JWT |
| POST | `/auth/voucher-login` | User authenticates with voucher |
| POST | `/auth/heartbeat` | Keep session alive |
| GET  | `/health` | Server health check |

### Protected Endpoints (JWT required)
Add header: `Authorization: Bearer <token>`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET  | `/admin/me` | Get current admin info |
| PUT  | `/admin/change-password` | Change admin password |
| GET  | `/admin/stats` | Dashboard statistics |
| GET  | `/admin/stats/revenue?period=week\|month\|year` | Revenue chart data |
| GET  | `/admin/vouchers` | List vouchers (filter: status, plan, search) |
| POST | `/admin/vouchers/generate` | Generate batch of vouchers |
| PUT  | `/admin/vouchers/:code/reset` | Reset voucher to unused |
| DELETE | `/admin/vouchers/:code` | Delete voucher |
| GET  | `/admin/sessions` | List sessions |
| DELETE | `/admin/sessions/:sessionId` | Kick/disconnect user |
| GET  | `/admin/devices` | List devices |
| PUT  | `/admin/devices/:mac/block` | Block device |
| PUT  | `/admin/devices/:mac/unblock` | Unblock device |
| GET  | `/admin/logs` | Activity logs |
| GET  | `/admin/plans` | List data plans |
| POST | `/admin/plans` | Create new plan |
| GET  | `/admin/mikrotik/status` | Test MikroTik connection |

---

## 📡 Captive Portal Integration

The captive portal HTML/JS should call:

```javascript
// 1. User submits voucher code
const response = await fetch('http://192.168.88.2:3000/api/auth/voucher-login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    voucherCode: 'SKY-AB12',
    macAddress:  'AA:BB:CC:DD:EE:FF',
    ipAddress:   '192.168.88.10',
    deviceName:  'Samsung Galaxy A14',
  }),
});
const data = await response.json();
// { status: 'ACTIVE', sessionId: '...', expiryTime: '...' }

// 2. Send heartbeat every 60 seconds
setInterval(async () => {
  await fetch('http://192.168.88.2:3000/api/auth/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: data.sessionId }),
  });
}, 60000);
```

---

## 🔐 Admin Panel Integration

```javascript
// 1. Login
const res = await fetch('http://192.168.88.2:3000/api/auth/admin-login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
});
const { token } = await res.json();
localStorage.setItem('skylink_token', token);

// 2. All protected calls
const stats = await fetch('http://192.168.88.2:3000/api/admin/stats', {
  headers: { 'Authorization': `Bearer ${localStorage.getItem('skylink_token')}` },
});
```

---

## ⚙️ MikroTik Setup

On your MikroTik router, enable the API service:
```
/ip service enable api
/ip service set api port=8728
```

Create API user:
```
/user add name=skylink group=full password=your_password
```

The firewall rule to block all traffic before login (walled garden):
```
/ip firewall filter add chain=forward action=drop
  comment="Block unauthenticated hotspot users"
  src-address-list=!skylink_allowed
```

---

## 🗄️ Database Tables

- **admins** — admin accounts (bcrypt passwords)
- **plans** — data plans (Hourly/Daily/Weekly/Monthly)
- **vouchers** — generated voucher codes + lifecycle
- **sessions** — active user sessions + heartbeat
- **devices** — known MAC addresses + block list
- **admin_logs** — full audit trail

---

## 🔧 Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| PORT | Server port | 3000 |
| DB_HOST | PostgreSQL host | localhost |
| DB_NAME | Database name | skylink_db |
| DB_USER | Database user | skylink_user |
| DB_PASSWORD | Database password | — |
| JWT_SECRET | JWT signing secret | — |
| JWT_EXPIRES_IN | Token expiry | 8h |
| MIKROTIK_HOST | Router IP | 192.168.88.1 |
| MIKROTIK_USER | Router API user | admin |
| MIKROTIK_PASS | Router API password | — |
| EXPIRY_CRON | Expiry job schedule | `* * * * *` |
| ALLOWED_ORIGINS | CORS origins (comma-separated) | — |

---

## 🚨 Default Credentials

After running `npm run seed`:
- **Username:** `admin`
- **Password:** `admin123`

**Change immediately in production!**
