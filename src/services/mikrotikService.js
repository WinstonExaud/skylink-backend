/**
 * SKYLINK NET — MikroTik Service
 * Uses RouterOS API protocol over TCP port 8728
 */

const net = require('net');

const HOST = process.env.MIKROTIK_HOST || '192.168.88.1';
const PORT = parseInt(process.env.MIKROTIK_PORT) || 8728;
const USER = process.env.MIKROTIK_USER || 'admin';
const PASS = process.env.MIKROTIK_PASS || '';

// ── Low-level API protocol ────────────────────────────────────────────────────

function encodeLength(len) {
  if (len < 0x80)       return Buffer.from([len]);
  if (len < 0x4000)     return Buffer.from([(len >> 8) | 0x80, len & 0xff]);
  if (len < 0x200000)   return Buffer.from([(len >> 16) | 0xC0, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.from([(len >> 24) | 0xE0, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
}

function encodeWord(word) {
  const b = Buffer.from(word, 'utf8');
  return Buffer.concat([encodeLength(b.length), b]);
}

function encodeSentence(words) {
  return Buffer.concat([...words.map(encodeWord), Buffer.from([0])]);
}

// ── Run any RouterOS API command ──────────────────────────────────────────────
function api(commands) {
  return new Promise((resolve, reject) => {
    const socket  = new net.Socket();
    const results = [];
    let   buf     = Buffer.alloc(0);
    let   authed  = false;

    socket.setTimeout(8000);

    socket.connect(PORT, HOST, () => {
      // Send login
      socket.write(encodeSentence(['/login', `=name=${USER}`, `=password=${PASS}`]));
    });

    function parseBuffer() {
      let pos = 0;
      const words = [];

      while (pos < buf.length) {
        let len = 0, skip = 1;
        const b = buf[pos];
        if      ((b & 0xE0) === 0xE0) { len = ((b&0x1f)<<24|buf[pos+1]<<16|buf[pos+2]<<8|buf[pos+3]); skip=4; }
        else if ((b & 0xC0) === 0xC0) { len = ((b&0x3f)<<16|buf[pos+1]<<8|buf[pos+2]); skip=3; }
        else if ((b & 0x80) === 0x80) { len = ((b&0x7f)<<8|buf[pos+1]); skip=2; }
        else                           { len = b; skip=1; }

        if (len === 0) {
          pos += skip;
          words.push(null); // sentence end marker
          continue;
        }

        if (pos + skip + len > buf.length) break; // need more data
        words.push(buf.slice(pos + skip, pos + skip + len).toString('utf8'));
        pos += skip + len;
      }

      buf = buf.slice(pos);
      return words;
    }

    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      const words = parseBuffer();

      let sentence = [];
      for (const w of words) {
        if (w === null) {
          // End of sentence
          if (!authed) {
            authed = true;
            // Send the real command(s)
            for (const cmd of commands) {
              socket.write(encodeSentence(cmd));
            }
          } else {
            if (sentence.length > 0) results.push([...sentence]);
            sentence = [];
            // Check if we got a !done or !trap
            const last = results[results.length - 1];
            if (last && (last[0] === '!done' || last[0] === '!trap')) {
              socket.destroy();
              if (last[0] === '!trap') {
                const msg = last.find(w => w.startsWith('=message='));
                reject(new Error(msg ? msg.replace('=message=','') : 'RouterOS error'));
              } else {
                resolve(results);
              }
            }
          }
        } else {
          sentence.push(w);
        }
      }
    });

    socket.on('timeout', () => { socket.destroy(); reject(new Error('MikroTik timeout')); });
    socket.on('error',   err => reject(err));
    socket.on('close',   ()  => { if (!socket.destroyed) resolve(results); });
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Allow internet: create hotspot user then log them in
 * This is the correct way — add user to /ip/hotspot/user
 * MikroTik will automatically grant internet when the user authenticates
 */
async function loginUser({ mac, ip, profile = 'daily', comment = '' }) {
  if (!mac || mac === 'UNKNOWN') {
    console.warn('[MikroTik] ⚠ MAC is UNKNOWN — skipping MikroTik auth. User will NOT get internet.');
    console.warn('[MikroTik] ⚠ Fix: ensure MikroTik hotspot redirect includes $(mac) in URL');
    return { success: false, error: 'MAC unknown' };
  }

  try {
    // Step 1: Remove existing user with same MAC (cleanup)
    try {
      await api([['/ip/hotspot/user/print', `?mac-address=${mac}`]]);
      // Try to remove if exists
      await api([['/ip/hotspot/user/remove', `?mac-address=${mac}`]]);
    } catch { /* ignore — user may not exist */ }

    // Step 2: Add hotspot user bound to MAC address
    // When bound to MAC, user gets internet WITHOUT needing to enter username/password
    await api([[
      '/ip/hotspot/user/add',
      `=mac-address=${mac}`,
      `=name=${mac}`,           // use MAC as username
      `=profile=${profile}`,
      `=comment=SKYLINK-${comment || mac}`,
    ]]);

    console.log(`[MikroTik] ✅ User added: ${mac} (${ip}) profile=${profile}`);
    return { success: true };

  } catch (err) {
    console.error('[MikroTik] loginUser error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Disconnect user — remove from hotspot users + kick active session
 */
async function disconnectUser({ mac }) {
  if (!mac || mac === 'UNKNOWN') return { success: false };
  try {
    // Kick active session
    try {
      const active = await api([['/ip/hotspot/active/print', `?mac-address=${mac}`]]);
      for (const sentence of active) {
        const idLine = sentence.find(w => w.startsWith('=.id='));
        if (idLine) {
          const id = idLine.split('=')[2];
          await api([['/ip/hotspot/active/remove', `=.id=${id}`]]);
        }
      }
    } catch { /* no active session */ }

    // Remove user binding
    try {
      await api([['/ip/hotspot/user/remove', `?mac-address=${mac}`]]);
    } catch { /* user may not exist */ }

    console.log(`[MikroTik] ✅ User disconnected: ${mac}`);
    return { success: true };
  } catch (err) {
    console.error('[MikroTik] disconnectUser error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Block device — add to address list + remove from hotspot
 */
async function blockDevice({ mac }) {
  try {
    await disconnectUser({ mac });
    await api([[
      '/ip/firewall/address-list/add',
      `=list=skylink_blocked`,
      `=address=${mac}`,
      `=comment=Blocked by SKYLINK NET`,
    ]]);
    console.log(`[MikroTik] ✅ Blocked: ${mac}`);
    return { success: true };
  } catch (err) {
    console.error('[MikroTik] blockDevice error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Unblock device
 */
async function unblockDevice({ mac }) {
  try {
    const list = await api([['/ip/firewall/address-list/print', `?list=skylink_blocked`, `?address=${mac}`]]);
    for (const sentence of list) {
      const idLine = sentence.find(w => w.startsWith('=.id='));
      if (idLine) {
        const id = idLine.split('=')[2];
        await api([['/ip/firewall/address-list/remove', `=.id=${id}`]]);
      }
    }
    console.log(`[MikroTik] ✅ Unblocked: ${mac}`);
    return { success: true };
  } catch (err) {
    console.error('[MikroTik] unblockDevice error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Test connection
 */
async function testConnection() {
  try {
    await api([['/system/identity/print']]);
    return { connected: true };
  } catch (err) {
    return { connected: false, error: err.message };
  }
}

async function getActiveUsers() {
  try {
    const result = await api([['/ip/hotspot/active/print']]);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, data: [], error: err.message };
  }
}

module.exports = { loginUser, disconnectUser, blockDevice, unblockDevice, testConnection, getActiveUsers };