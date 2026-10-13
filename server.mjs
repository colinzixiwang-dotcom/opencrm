import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { DomainError, mutate, seedState, publicState, verifyPassword, report } from './lib/domain.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};
const digest = s => createHash('sha256').update(s).digest('hex');
const safeUser = ({passwordHash, ...user}) => user;
const cookieToken = req => (req.headers.cookie || '').split(';').map(x=>x.trim()).find(x=>x.startsWith('harbor_session='))?.slice(15);

export function createApp({ databasePath = process.env.DB_PATH || resolve(root, 'data/harbor.sqlite') } = {}) {
  if (databasePath !== ':memory:') mkdirSync(dirname(resolve(databasePath)), {recursive:true});
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS request_receipts (key TEXT PRIMARY KEY, user_id TEXT NOT NULL, payload_hash TEXT NOT NULL, result TEXT NOT NULL, created INTEGER NOT NULL);');
  if (!db.prepare('SELECT id FROM app_state WHERE id=1').get()) db.prepare('INSERT INTO app_state(id,data) VALUES(1,?)').run(JSON.stringify(seedState()));
  const getState = () => JSON.parse(db.prepare('SELECT data FROM app_state WHERE id=1').get().data);
  const loginAttempts = new Map();
  const send = (res, status, value, extra={}) => {
    res.writeHead(status, {...securityHeaders,'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...extra}); res.end(JSON.stringify(value));
  };
  const body = async req => {
    if (!String(req.headers['content-type']||'').startsWith('application/json')) throw new DomainError('Use application/json.',415);
    let size=0;const chunks=[];
    for await(const chunk of req){size+=chunk.length;if(size>1_048_576)throw new DomainError('Request is too large.',413);chunks.push(chunk);}
    try { const parsed=JSON.parse(Buffer.concat(chunks).toString());if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw 0;return parsed; }
    catch {throw new DomainError('Invalid JSON request.',400);}
  };
  const auth = req => {
    const token=cookieToken(req);if(!token)throw new DomainError('Sign in to continue.',401);
    const session=db.prepare('SELECT * FROM sessions WHERE hash=? AND expires>?').get(digest(token),Date.now());
    const user=session&&getState().users.find(x=>x.id===session.user_id&&x.active);
    if(!user)throw new DomainError('Your session has expired. Sign in again.',401);return user;
  };
  const server=http.createServer(async(req,res)=>{
    try {
      const host=req.headers.host||'';
      if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(host)) throw new DomainError('Invalid host.',403);
      const url=new URL(req.url,`http://${host}`);
      if(req.method==='POST' && req.headers.origin && ![`http://${host}`].includes(req.headers.origin))throw new DomainError('Cross-origin writes are not permitted.',403);
      if(url.pathname==='/api/health'){send(res,200,{ok:true,version:'1.0.0',storage:'sqlite'});return;}
      if(req.method==='POST'&&url.pathname==='/api/login'){
        const input=await body(req);const email=typeof input.email==='string'?input.email.trim().toLowerCase():'';
        if(typeof input.password!=='string'||input.password.length>200)throw new DomainError('Invalid credentials.',401);
        const ip=req.socket.remoteAddress||'local';const attempts=loginAttempts.get(ip)||{count:0,reset:Date.now()+60000};
        if(Date.now()>attempts.reset){attempts.count=0;attempts.reset=Date.now()+60000;}
        if(attempts.count>=15)throw new DomainError('Too many sign-in attempts. Try again in one minute.',429);
        const user=getState().users.find(x=>x.email===email&&x.active);
        if(!user||!verifyPassword(input.password,user.passwordHash)){attempts.count++;loginAttempts.set(ip,attempts);throw new DomainError('Email or password is incorrect.',401);}
        loginAttempts.delete(ip);const token=randomBytes(32).toString('hex');
        db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
        db.prepare('INSERT INTO sessions(hash,user_id,expires) VALUES(?,?,?)').run(digest(token),user.id,Date.now()+12*3600000);
        send(res,200,{user:safeUser(user)},{'Set-Cookie':`harbor_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`});return;
      }
      if(url.pathname.startsWith('/api/')){
        const user=auth(req);
        if(req.method==='POST'&&url.pathname==='/api/logout'){
          db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(cookieToken(req)));send(res,200,{ok:true},{'Set-Cookie':'harbor_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});return;
        }
        if(req.method==='GET'&&url.pathname==='/api/bootstrap'){send(res,200,publicState(getState(),user));return;}
        if(req.method==='GET'&&url.pathname==='/api/report'){
          const from=url.searchParams.get('from')||'0000-01-01',to=url.searchParams.get('to')||'9999-12-31';
          if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to)throw new DomainError('Invalid reporting date range.');
          const channel=url.searchParams.get('channel')||'all';if(!['all','Amazon','Shopify','Direct','Wholesale'].includes(channel))throw new DomainError('Unknown channel.');
          send(res,200,report(getState(),{from,to,channel}));return;
        }
        if(req.method==='POST'&&url.pathname==='/api/action'){
          const input=await body(req);if(typeof input.action!=='string'||!input.payload||typeof input.payload!=='object'||Array.isArray(input.payload))throw new DomainError('An action and payload are required.');
          const key=req.headers['idempotency-key'];if(key&&(typeof key!=='string'||key.length>150||!/^[-a-zA-Z0-9]+$/.test(key)))throw new DomainError('Invalid idempotency key.');
          db.exec('BEGIN IMMEDIATE');
          try {
            const payloadHash=digest(JSON.stringify(input));
            if(key){const existing=db.prepare('SELECT * FROM request_receipts WHERE key=?').get(key);if(existing){if(existing.user_id!==user.id||existing.payload_hash!==payloadHash)throw new DomainError('Idempotency key was already used for another request.',409);db.exec('COMMIT');send(res,200,{...JSON.parse(existing.result),replayed:true});return;}}
            const {state,result}=mutate(getState(),input.action,input.payload,user);
            db.prepare('UPDATE app_state SET data=? WHERE id=1').run(JSON.stringify(state));const response={result,version:state.version};
            if(key)db.prepare('INSERT INTO request_receipts(key,user_id,payload_hash,result,created) VALUES(?,?,?,?,?)').run(key,user.id,payloadHash,JSON.stringify(response),Date.now());
            db.exec('COMMIT');send(res,200,response);return;
          }catch(e){db.exec('ROLLBACK');throw e;}
        }
        if(req.method==='GET'&&url.pathname.startsWith('/api/export/')){
          const name=url.pathname.split('/').at(-1);const s=getState();
          const allowed=['products','suppliers','warehouses','purchases','sales','shipments','stocks','movements','payments','expenses','campaigns','tickets','tasks','audit'];
          if(!allowed.includes(name))throw new DomainError('Unknown export.',404);
          const rows=s[name];const keys=[...new Set(rows.flatMap(x=>Object.keys(x)))];
          const cell=v=>{let t=v==null?'':typeof v==='object'?JSON.stringify(v):String(v);if(/^[=+\-@\t\r]/.test(t))t="'"+t;return '"'+t.replaceAll('"','""')+'"';};
          const csv='\uFEFF'+[keys.map(cell).join(','),...rows.map(x=>keys.map(k=>cell(x[k])).join(','))].join('\r\n');
          res.writeHead(200,{...securityHeaders,'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="harbor-${name}.csv"`,'Cache-Control':'no-store'});res.end(csv);return;
        }
        if(req.method==='GET'&&url.pathname==='/api/backup'){
          const s=getState();delete s.users;send(res,200,{format:'harbor-business-snapshot-v1',exportedAt:new Date().toISOString(),state:s},{'Content-Disposition':'attachment; filename="harbor-backup.json"'});return;
        }
        throw new DomainError('API route not found.',404);
      }
      if(req.method!=='GET'&&req.method!=='HEAD')throw new DomainError('Method not allowed.',405);
      const assets={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
      const asset=assets[url.pathname];if(!asset)throw new DomainError('Page not found.',404);
      const file=resolve(root,'public',asset);const type={'.html':'text/html','.js':'text/javascript','.css':'text/css'}[extname(file)];
      res.writeHead(200,{...securityHeaders,'Content-Type':`${type}; charset=utf-8`,'Cache-Control':'no-cache'});res.end(req.method==='HEAD'?'':readFileSync(file));
    }catch(e){send(res,e instanceof DomainError?e.status:500,{error:e instanceof DomainError?e.message:'An unexpected server error occurred.'});if(!(e instanceof DomainError))console.error(e);}
  });
  server.on('close',()=>db.close());
  return {server, getState, db};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const port=Number(process.env.PORT||4317);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT must be between 1 and 65535.');
  const {server}=createApp();server.listen(port,'127.0.0.1',()=>console.log(`Harbor ERP ready at http://127.0.0.1:${port}\nLocal SQLite storage · Example data · Press Ctrl+C to stop`));
  process.on('SIGTERM',()=>server.close());process.on('SIGINT',()=>server.close());
}
