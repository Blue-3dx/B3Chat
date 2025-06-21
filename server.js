// server.js
const http = require('http'),
      fs   = require('fs'),
      path = require('path'),
      WebSocket = require('ws'),
      sqlite3 = require('sqlite3').verbose();

// — CONFIGURE HTTP SERVER to serve your HTML/JS/CSS —
const server = http.createServer((req, res) => {
  let file = req.url === '/' ? '/index.html' : req.url;
  let ext  = path.extname(file).toLowerCase();
  let map  = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };
  let contentType = map[ext]||'application/octet-stream';
  fs.readFile(path.join(__dirname,'public',file), (err, data)=>{
    if(err){ res.writeHead(404); return res.end(); }
    res.writeHead(200, {'Content-Type': contentType});
    res.end(data);
  });
});

// — SETUP WebSocket SERVER —
const wss = new WebSocket.Server({ server });

// — SQLITE USER DATABASE —
const db = new sqlite3.Database(path.join(__dirname,'users.db'));
db.run(`CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  password TEXT NOT NULL
)`);

// — IN‑MEMORY CHATROOMS STATE —
let clients   = new Map();   // ws -> { username, room }
let chatRooms = {};          // name -> { host, users:Set(ws), isPrivate, banned:Set, muted:Set, nicknames:Map, messages:[] }

function broadcast(room, data){
  if(!chatRooms[room]) return;
  chatRooms[room].users.forEach(ws=>{
    if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(data));
  });
}

function updateRoomList(){
  let list = Object.entries(chatRooms)
    .filter(([_,r])=>!r.isPrivate)
    .map(([n,r])=>({ name:n, userCount:r.users.size }));
  wss.clients.forEach(ws=>{
    if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify({ type:'room_list', rooms:list }));
  });
}

wss.on('connection', ws => {
  clients.set(ws, { username:null, room:null });

  ws.on('message', raw => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    let client = clients.get(ws);

    // — AUTHENTICATION —
    if(data.type==='register'){
      return db.get(`SELECT 1 FROM users WHERE username=?`, data.username, (e,row)=>{
        if(row){
          ws.send(JSON.stringify({ type:'auth', success:false, message:'Username taken' }));
        } else {
          db.run(`INSERT INTO users(username,password) VALUES(?,?)`, data.username,data.password, err=>{
            ws.send(JSON.stringify({ type:'auth', success:!err, message: err?'Error':'Registered' }));
          });
        }
      });
    }
    if(data.type==='login'){
      return db.get(`SELECT password FROM users WHERE username=?`, data.username, (e,row)=>{
        if(!row || row.password!==data.password){
          ws.send(JSON.stringify({ type:'auth', success:false, message:'Invalid credentials' }));
        } else {
          client.username = data.username;
          ws.send(JSON.stringify({ type:'auth', success:true, message:'Logged in' }));
        }
      });
    }

    // — REQUIRE LOGIN for everything else —
    if(!client.username){
      return ws.send(JSON.stringify({ type:'error', message:'Login required' }));
    }

    // — CHATROOM LOGIC —
    switch(data.type){
      case 'create_room':
        if(chatRooms[data.roomName]){
          ws.send(JSON.stringify({ type:'error', message:'Room exists' }));
        } else {
          chatRooms[data.roomName] = {
            host: client.username,
            users:new Set(), isPrivate:false,
            banned:new Set(), muted:new Set(),
            nicknames:new Map(), messages:[]
          };
          joinRoom(ws,data.roomName);
          updateRoomList();
        }
        break;

      case 'list_rooms':
        updateRoomList();
        break;

      case 'join_room':
        joinRoom(ws,data.roomName);
        break;

      case 'leave_room':
        leaveRoom(ws);
        break;

      case 'chat_message':
        handleChat(ws,data.text);
        break;
    }
  });

  ws.on('close', () => {
    leaveRoom(ws);
    clients.delete(ws);
  });
});

function joinRoom(ws,name){
  let client = clients.get(ws);
  let room = chatRooms[name];
  if(!room){
    return ws.send(JSON.stringify({ type:'error', message:'No such room' }));
  }
  if(room.banned.has(client.username)){
    return ws.send(JSON.stringify({ type:'error', message:'You are banned' }));
  }
  leaveRoom(ws);
  room.users.add(ws);
  client.room = name;
  ws.send(JSON.stringify({ type:'joined_room', roomName:name, isHost: room.host===client.username }));
  ws.send(JSON.stringify({ type:'room_status', isPrivate: room.isPrivate }));
  room.messages.forEach(m=> ws.send(JSON.stringify({ type:'message', user:m.user, text:m.text })));
  broadcast(name,{ type:'message', user:'System', text:`${client.username} joined` });
  updateRoomList();
}

function leaveRoom(ws){
  let client = clients.get(ws);
  let name = client.room;
  if(name && chatRooms[name]){
    let room = chatRooms[name];
    room.users.delete(ws);
    broadcast(name,{ type:'message', user:'System', text:`${client.username} left` });
    if(room.users.size===0) delete chatRooms[name];
    client.room = null;
    updateRoomList();
  }
}

function handleChat(ws,text){
  let client = clients.get(ws);
  let room = chatRooms[client.room];
  if(!room || room.muted.has(client.username)) return;

  // — HOST COMMANDS —
  if(text.startsWith('!cmd ') && client.username===room.host){
    let [_,cmd,arg,nick] = text.split(' ');
    let ok=false;
    switch(cmd){
      case 'mute':    if(arg&&!room.muted.has(arg)){ room.muted.add(arg); ok=true;} break;
      case 'clear':   room.messages=[]; ok=true; break;
      case 'shutdown':
        room.users.forEach(x=>x.close());
        delete chatRooms[client.room];
        ok=true; break;
      case 'kick':
        room.users.forEach(x=>{
          let c=clients.get(x);
          if(c.username===arg){ x.send(JSON.stringify({ type:'message', user:'System', text:'You were kicked' })); leaveRoom(x); }
        });
        ok=true; break;
      case 'ban':     if(arg){ room.banned.add(arg); ok=true;} break;
      case 'nick':    if(arg&&nick){ room.nicknames.set(arg,nick); ok=true;} break;
    }
    ws.send(JSON.stringify({ type:'message', user:'System', text: ok?'done!':'denied' }));
    return updateRoomList();
  }

  // — NORMAL MESSAGE —
  let display = room.nicknames.get(client.username)||client.username;
  let msg = { user:display, text };
  room.messages.push(msg);
  broadcast(client.room,msg);
}

// — START SERVER ON CLOUD PORT OR 3000 —
const PORT = process.env.PORT||3000;
server.listen(PORT, ()=> console.log(`Listening on port ${PORT}`));
