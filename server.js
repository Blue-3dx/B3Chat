// server.js
const WebSocket = require('ws');
const sqlite = require('sqlite3').verbose();
const db = new sqlite.Database('users.db');

const port = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port });

// Initialize SQLite users table
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    password TEXT NOT NULL
  )
`);

let clients = new Map(); // ws -> { username, currentRoom }
let chatRooms = {};      // roomName -> { host, users:Set(ws), isPrivate, banned:Set, muted:Set, nicknames:Map, messages:[] }

function broadcast(room, data) {
  if (!chatRooms[room]) return;
  chatRooms[room].users.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  });
}

wss.on('connection', ws => {
  clients.set(ws, { username: null, currentRoom: null });

  ws.on('message', msg => {
    let data;
    try { data = JSON.parse(msg); }
    catch { return ws.send(JSON.stringify({ type:'error', message:'Invalid JSON' })); }

    const client = clients.get(ws);

    // --- AUTH HANDLERS ---
    if (data.type === 'register') {
      // { username, password }
      return db.get(`SELECT 1 FROM users WHERE username=?`, data.username, (e, row) => {
        if (row) {
          ws.send(JSON.stringify({ type:'auth', success:false, message:'Username exists' }));
        } else {
          db.run(`INSERT INTO users(username,password) VALUES(?,?)`, data.username, data.password, err => {
            ws.send(JSON.stringify({ type:'auth', success:!err, message: err? 'Error' : 'Registered' }));
          });
        }
      });
    }
    if (data.type === 'login') {
      // { username, password }
      return db.get(`SELECT password FROM users WHERE username=?`, data.username, (e, row) => {
        if (!row || row.password !== data.password) {
          ws.send(JSON.stringify({ type:'auth', success:false, message:'Invalid credentials' }));
        } else {
          client.username = data.username;
          ws.send(JSON.stringify({ type:'auth', success:true, message:'Logged in' }));
        }
      });
    }
    // must be logged in for everything else
    if (!client.username) {
      return ws.send(JSON.stringify({ type:'error', message:'Please login/register first' }));
    }

    // --- ROOM & CHAT HANDLERS ---
    switch(data.type) {
      case 'create_room':
        if (chatRooms[data.roomName]) {
          ws.send(JSON.stringify({ type:'error', message:'Room exists' }));
        } else {
          chatRooms[data.roomName] = {
            host: client.username,
            users: new Set(),
            isPrivate: false,
            banned: new Set(),
            muted: new Set(),
            nicknames: new Map(),
            messages: []
          };
          joinRoom(ws, data.roomName);
          updateRooms();
        }
        break;

      case 'list_rooms':
        ws.send(JSON.stringify({
          type:'room_list',
          rooms: Object.entries(chatRooms)
            .filter(([_,r]) => !r.isPrivate)
            .map(([n,r]) => ({ name:n, userCount:r.users.size }))
        }));
        break;

      case 'join_room':
        joinRoom(ws, data.roomName);
        break;

      case 'leave_room':
        leaveRoom(ws);
        break;

      case 'chat_message':
        handleChat(ws, data.text);
        break;

      default:
        ws.send(JSON.stringify({ type:'error', message:'Unknown type' }));
    }
  });

  ws.on('close', () => {
    leaveRoom(ws);
    clients.delete(ws);
  });
});

// --- Room functions ---
function joinRoom(ws, name) {
  const client = clients.get(ws);
  const room = chatRooms[name];
  if (!room) return ws.send(JSON.stringify({ type:'error', message:'No such room' }));
  if (room.banned.has(client.username)) {
    return ws.send(JSON.stringify({ type:'error', message:'You are banned' }));
  }
  leaveRoom(ws);
  room.users.add(ws);
  client.currentRoom = name;
  ws.send(JSON.stringify({ type:'joined_room', roomName:name, isHost: room.host===client.username }));
  room.messages.forEach(m =>
    ws.send(JSON.stringify({ type:'message', user:m.user, text:m.text, isHostMsg:false }))
  );
  broadcast(name, { type:'message', user:'System', text:`${client.username} joined`, isHostMsg:false });
  updateRooms();
}

function leaveRoom(ws) {
  const client = clients.get(ws);
  if (!client.currentRoom) return;
  const room = chatRooms[client.currentRoom];
  room.users.delete(ws);
  broadcast(client.currentRoom, { type:'message', user:'System', text:`${client.username} left`, isHostMsg:false });
  if (room.users.size===0) delete chatRooms[client.currentRoom];
  client.currentRoom = null;
  updateRooms();
}

function updateRooms(){
  const list = Object.entries(chatRooms)
    .filter(([_,r]) => !r.isPrivate)
    .map(([n,r]) => ({ name:n, userCount:r.users.size }));
  wss.clients.forEach(c => {
    if (c.readyState===WebSocket.OPEN) c.send(JSON.stringify({ type:'room_list', rooms:list }));
  });
}

// --- Chat & commands ---
function handleChat(ws, text) {
  const client = clients.get(ws);
  const room = chatRooms[client.currentRoom];
  if (!room || room.muted.has(client.username)) return;
  if (text.startsWith('!cmd ') && client.username===room.host) {
    let [_,cmd, u, nick] = text.split(' ');
    let ok=false;
    switch(cmd){
      case 'mute':   if(u && !room.muted.has(u)){ room.muted.add(u); ok=true; } break;
      case 'clear':  room.messages=[]; ok=true; break;
      case 'shutdown':
        room.users.forEach(x=>x.close());
        delete chatRooms[client.currentRoom];
        ok=true; break;
      case 'kick':
        room.users.forEach(x=>{
          const d = clients.get(x);
          if(d.username===u){ x.send(JSON.stringify({type:'message',user:'System',text:'You were kicked',isHostMsg:false})); leaveRoom(x); }
        }); ok=true; break;
      case 'ban':    if(u){ room.banned.add(u); ok=true; } break;
      case 'nick':   if(u && nick){ room.nicknames.set(u,nick); ok=true; } break;
    }
    ws.send(JSON.stringify({ type:'message', user:'System', text: ok?'done!':'denied', isHostMsg:false }));
    return updateRooms();
  }
  // normal message
  const user = chatRooms[client.currentRoom].nicknames.get(client.username) || client.username;
  room.messages.push({ user, text });
  broadcast(client.currentRoom, { type:'message', user, text, isHostMsg:false });
}
