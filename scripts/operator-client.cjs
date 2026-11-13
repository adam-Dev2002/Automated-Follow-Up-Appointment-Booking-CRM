const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function operatorToken(dataDir) {
    const filename = path.join(dataDir, 'operator-token');
    fs.mkdirSync(dataDir, { recursive: true });
    try { fs.writeFileSync(filename, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const token = fs.readFileSync(filename, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid local operator token.');
    return token;
}

function operatorEndpoint(endpoint) {
    const url = new URL(endpoint);
    url.pathname = url.pathname.replace(/\/appointments-api\/?$/, '/appointments-operator-api');
    if (url.href === new URL(endpoint).href) throw new Error('Set APPOINTMENTS_OPERATOR_API_URL for a custom booking webhook path.');
    return url;
}

function actorEnvelope(user) {
    return { id: user.id, display_name: user.display_name, role: user.role };
}

module.exports = { operatorToken, operatorEndpoint, actorEnvelope };
