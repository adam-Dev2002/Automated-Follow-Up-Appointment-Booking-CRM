const fs = require('node:fs');
const path = require('node:path');
const { fail } = require('./security-store.cjs');

class ClientAvatars {
    constructor(security) {
        this.security = security;
        this.db = security.db;
        this.db.exec(fs.readFileSync(path.join(__dirname,'migrations/005-client-avatars.sql'),'utf8'));
    }
    decorate(record, id = record.id) {
        const avatar = this.db.prepare('SELECT version,length(image)>0 AS has_avatar FROM crm_client_avatars WHERE client_id=?').get(id || '');
        return {...record,has_avatar:Boolean(avatar?.has_avatar),avatar_version:avatar?.version || 0};
    }
    image(id) {
        const avatar = this.db.prepare('SELECT image,content_type FROM crm_client_avatars WHERE client_id=?').get(id);
        if (!avatar?.image?.length) throw fail(404,'No client photo or logo is saved.');
        return avatar;
    }
    save(id, input, actor) {
        if (!Number.isSafeInteger(input.version) || input.version < 0 || typeof input.image !== 'string') throw fail(400,'Refresh the client profile and try again.');
        let image = null, type = '';
        if (input.image) {
            const match = input.image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
            if (!match || match[2].length > 64000) throw fail(400,'Choose a JPG, PNG, or WebP photo or logo up to 48 KB.');
            type = match[1]; image = Buffer.from(match[2],'base64');
            const valid = type === 'image/jpeg' ? image[0] === 255 && image[1] === 216 && image[2] === 255 && image.at(-2) === 255 && image.at(-1) === 217 : type === 'image/png' ? image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : image.toString('ascii',0,4) === 'RIFF' && image.toString('ascii',8,12) === 'WEBP';
            if (!valid || !image.length || image.length > 48000) throw fail(400,'Choose a valid JPG, PNG, or WebP photo or logo up to 48 KB.');
        }
        return this.security.transaction(() => {
            const active = this.db.prepare('SELECT disabled FROM workspace_users WHERE id=?').get(actor?.id || '');
            if (!active || active.disabled) throw fail(401,'Sign in to continue.');
            if (!this.db.prepare('SELECT id FROM crm_clients WHERE id=?').get(id)) throw fail(404,'Client not found.');
            const before = this.decorate({id});
            if (before.avatar_version !== input.version) throw fail(409,'This client photo changed. Reopen the profile before saving.');
            this.db.prepare('INSERT INTO crm_client_avatars (client_id,image,content_type,version,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(client_id) DO UPDATE SET image=excluded.image,content_type=excluded.content_type,version=excluded.version,updated_at=excluded.updated_at').run(id,image,type,input.version+1,new Date().toISOString());
            const after = this.decorate({id});
            this.security.audit(actor,'client.avatar_updated','client',id,{has_avatar:before.has_avatar},{has_avatar:after.has_avatar});
            return after;
        });
    }
}
module.exports = { ClientAvatars };
