// Print only the hash to seed in n8n. The actual operator token stays private.
const path=require('node:path');
const crypto=require('node:crypto');
const {operatorToken}=require('./operator-client.cjs');
const directory=path.resolve(process.env.APPOINTMENTS_DATA_DIR||path.join(__dirname,'../.local'));
console.log(crypto.createHash('sha256').update(operatorToken(directory)).digest('hex'));
