// Terminal Simulator — app.js
// Self-contained. Stores users in localStorage (signup possible), demo account sparkpacket/win32 exists.
// Virtual filesystem, many commands, history, tab completion, redirection, man pages.

(() => {
  // Utilities
  const qs = (s) => document.querySelector(s);
  const qsa = (s) => Array.from(document.querySelectorAll(s));

  // DOM
  const overlay = qs('#login-overlay');
  const loginForm = qs('#login-form');
  const signupBtn = qs('#signup-btn');
  const loginMsg = qs('#login-msg');
  const usernameInput = qs('#username');
  const passwordInput = qs('#password');

  const app = qs('#terminal-app');
  const status = qs('#status');
  const outputEl = qs('#output');
  const promptEl = qs('#prompt');
  const cmdInput = qs('#cmdline');
  const screen = qs('#screen');

  // State
  const state = {
    user: null,
    usersKey: 'term_sim_users_v1',
    history: [],
    histIndex: null,
    aliases: {},
    env: { PATH: '/bin:/usr/bin', USER: 'guest', HOME: '/home/guest', TERM: 'xterm-256color' },
    cwd: '/home/guest',
    fs: {}, // virtual filesystem
  };

  // Initialize demo user
  function loadUsers(){
    try{
      const raw = localStorage.getItem(state.usersKey);
      if(!raw){
        const demo = { sparkpacket: { password: 'win32', home: '/home/sparkpacket' } };
        localStorage.setItem(state.usersKey, JSON.stringify(demo));
        return demo;
      }
      return JSON.parse(raw);
    }catch(e){
      return {};
    }
  }
  function saveUsers(users){
    localStorage.setItem(state.usersKey, JSON.stringify(users));
  }

  // Simple virtual filesystem: nodes are {type:'dir'|'file', children:Map or object, content:string, mode, owner}
  function mkfs(){
    const now = () => Date.now();
    const file = (content='') => ({ type:'file', content, mode: 0o644, owner:'root', mtime: now() });
    const dir = (children={}) => ({ type:'dir', children, mode: 0o755, owner:'root', mtime: now() });

    return {
      '/': dir({
        bin: dir({}),
        usr: dir({ bin: dir({}) }),
        home: dir({
          guest: dir({ 'welcome.txt': file('Welcome to Terminal Simulator!\nType help to get started.\n') }),
          sparkpacket: dir({ 'readme.txt': file('Hello sparkpacket — enjoy the simulator!\n') })
        }),
        etc: dir({ hosts: file('127.0.0.1 localhost\n') }),
        tmp: dir({})
      })
    }['/'];
  }

  function pathJoin(...parts){
    const segs = [];
    for(const p of parts.join('/').split('/')){
      if(!p || p === '.') continue;
      if(p === '..'){ if(segs.length) segs.pop(); continue; }
      segs.push(p);
    }
    return '/' + segs.join('/');
  }

  function resolvePath(p){
    if(!p) return state.cwd;
    if(p.startsWith('/')) return pathJoin(p);
    return pathJoin(state.cwd, p);
  }

  function fsGetNode(path){
    const p = resolvePath(path);
    if(p === '/') return state.fs;
    const parts = p.split('/').slice(1);
    let cur = state.fs;
    for(const part of parts){
      if(cur.type !== 'dir' || !cur.children[part]) return null;
      cur = cur.children[part];
    }
    return cur;
  }

  function fsWriteFile(path, content, append=false){
    const p = resolvePath(path);
    const parts = p.split('/').slice(1);
    const name = parts.pop();
    let cur = state.fs;
    for(const part of parts){
      if(!cur.children[part]) cur.children[part] = { type:'dir', children: {}, mode:0o755, owner:'root' , mtime: Date.now()};
      cur = cur.children[part];
      if(cur.type !== 'dir') return false;
    }
    if(!cur.children[name]) cur.children[name] = { type:'file', content:'', mode:0o644, owner: state.user || 'root', mtime: Date.now()};
    if(cur.children[name].type !== 'file') return false;
    cur.children[name].content = append ? (cur.children[name].content + content) : content;
    cur.children[name].mtime = Date.now();
    return true;
  }

  function fsList(path){
    const node = fsGetNode(path);
    if(!node) return null;
    if(node.type !== 'dir') return null;
    return Object.entries(node.children).map(([name, nd]) => ({ name, type: nd.type }));
  }

  // Output helpers
  function print(text, cls){
    if(text == null) text = '';
    const div = document.createElement('div');
    div.className = 'line' + (cls ? ' ' + cls : '');
    div.innerHTML = text;
    outputEl.appendChild(div);
    screen.scrollTop = screen.scrollHeight;
  }
  function println(text){ print(escapeHtml(text)); }
  function escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // Commands registry
  const commands = {};

  function register(name, fn, meta={}){
    commands[name] = { fn, meta };
  }

  // register many realistic commands (>40)
  // Utilities for commands
  function helpText(){
    const names = Object.keys(commands).sort();
    return names.map(n => n.padEnd(12) + (commands[n].meta && commands[n].meta.short ? ' - ' + commands[n].meta.short : '')).join('\n');
  }

  function manPage(cmd){
    const c = commands[cmd];
    if(!c) return `No manual entry for ${cmd}`;
    return c.meta.man || `${cmd} — no manual available.`;
  }

  // Register core commands
  register('help', async (ctx,args) => helpText(), { short:'Show this help' });
  register('man', async (ctx,args) => {
    if(args.length === 0) return 'Usage: man <command>';
    return manPage(args[0]);
  }, { short:'Show manual for command' });
  register('echo', async (ctx,args) => args.join(' '), { short:'Echo arguments' });
  register('whoami', async () => state.user || 'guest', { short:'Show current user' });
  register('pwd', async () => state.cwd, { short:'Print working directory' });
  register('date', async () => new Date().toString(), { short:'Show current date/time' });
  register('clear', async () => { outputEl.innerHTML = ''; return ''; }, { short:'Clear the screen' });
  register('ls', async (ctx,args) => {
    const path = args[0] || '.';
    const list = fsList(path);
    if(list === null) return `ls: cannot access '${path}': No such directory`;
    return list.map(e => e.type === 'dir' ? e.name + '/' : e.name).join('\n');
  }, { short:'List directory' });

  register('cat', async (ctx,args) => {
    if(args.length === 0) return 'Usage: cat <file>';
    const node = fsGetNode(args[0]);
    if(!node) return `cat: ${args[0]}: No such file or directory`;
    if(node.type !== 'file') return `cat: ${args[0]}: Is a directory`;
    return node.content;
  }, { short:'Concatenate and print files' });

  register('touch', async (ctx,args) => {
    if(!args[0]) return 'Usage: touch <file>';
    const ok = fsWriteFile(args[0], '', false);
    if(ok) return '';
    return `touch: cannot touch '${args[0]}'`;
  }, { short:'Create empty file / update timestamp' });

  register('mkdir', async (ctx,args) => {
    if(!args[0]) return 'Usage: mkdir <dir>';
    const p = resolvePath(args[0]);
    const parts = p.split('/').slice(1);
    let cur = state.fs;
    for(const part of parts){
      if(!cur.children[part]) cur.children[part] = { type:'dir', children:{}, mode:0o755, owner: state.user || 'root', mtime:Date.now() };
      cur = cur.children[part];
      if(cur.type !== 'dir') return `mkdir: cannot create directory '${args[0]}': Not a directory`;
    }
    return '';
  }, { short:'Make directories' });

  register('rmdir', async (ctx,args) => {
    if(!args[0]) return 'Usage: rmdir <dir>';
    const p = resolvePath(args[0]);
    if(p === '/') return 'rmdir: refusing to remove root';
    const parts = p.split('/').slice(1);
    const name = parts.pop();
    let cur = state.fs;
    for(const part of parts){
      if(!cur.children[part]) return `rmdir: failed to remove '${args[0]}': No such file or directory`;
      cur = cur.children[part];
      if(cur.type !== 'dir') return `rmdir: failed to remove '${args[0]}': Not a directory`;
    }
    if(!cur.children[name]) return `rmdir: failed to remove '${args[0]}': No such file or directory`;
    if(cur.children[name].type !== 'dir') return `rmdir: failed to remove '${args[0]}': Not a directory`;
    if(Object.keys(cur.children[name].children).length) return `rmdir: failed to remove '${args[0]}': Directory not empty`;
    delete cur.children[name];
    return '';
  }, { short:'Remove empty directory' });

  register('rm', async (ctx,args) => {
    if(!args[0]) return 'Usage: rm <file>';
    let recursive = false;
    const filtered = [];
    for(const a of args){
      if(a === '-r' || a === '-rf' || a === '-fr') recursive = true;
      else filtered.push(a);
    }
    for(const p of filtered){
      const path = resolvePath(p);
      if(path === '/') return `rm: refusing to remove '/'`;
      const parts = path.split('/').slice(1);
      const name = parts.pop();
      let cur = state.fs;
      for(const part of parts){
        if(!cur.children[part]) return `rm: cannot remove '${p}': No such file or directory`;
        cur = cur.children[part];
      }
      if(!cur.children[name]) return `rm: cannot remove '${p}': No such file or directory`;
      if(cur.children[name].type === 'dir' && !recursive) return `rm: cannot remove '${p}': Is a directory`;
      delete cur.children[name];
    }
    return '';
  }, { short:'Remove files or directories' });

  register('cd', async (ctx,args) => {
    const dest = args[0] ? args[0] : state.env.HOME || '/';
    const path = resolvePath(dest);
    const node = fsGetNode(path);
    if(!node || node.type !== 'dir') return `cd: ${dest}: No such file or directory`;
    state.cwd = path;
    return '';
  }, { short:'Change directory' });

  register('mv', async (ctx,args) => {
    if(args.length < 2) return 'Usage: mv <source> <dest>';
    const src = resolvePath(args[0]);
    const dst = resolvePath(args[1]);
    const srcNode = fsGetNode(src);
    if(!srcNode) return `mv: cannot stat '${args[0]}': No such file or directory`;
    // remove from parent
    const sParts = src.split('/').slice(1);
    const sName = sParts.pop();
    let cur = state.fs;
    for(const part of sParts) cur = cur.children[part];
    delete cur.children[sName];
    // place at dest (if dest is dir)
    const dNode = fsGetNode(dst);
    if(dNode && dNode.type === 'dir'){
      dNode.children[sName] = srcNode;
    }else{
      // create intermediate
      const dParts = dst.split('/').slice(1);
      const dName = dParts.pop();
      let cd = state.fs;
      for(const part of dParts){
        if(!cd.children[part]) cd.children[part] = { type:'dir', children:{}, mode:0o755, owner:'root', mtime:Date.now()};
        cd = cd.children[part];
      }
      cd.children[dName] = srcNode;
    }
    return '';
  }, { short:'Move/rename files' });

  register('cp', async (ctx,args) => {
    if(args.length < 2) return 'Usage: cp <source> <dest>';
    const src = resolvePath(args[0]);
    const dst = resolvePath(args[1]);
    const srcNode = fsGetNode(src);
    if(!srcNode) return `cp: cannot stat '${args[0]}': No such file or directory`;
    function cloneNode(n){
      if(n.type === 'file') return { type:'file', content: n.content, mode:n.mode, owner:n.owner, mtime:Date.now() };
      const ch = {};
      for(const k of Object.keys(n.children)) ch[k] = cloneNode(n.children[k]);
      return { type:'dir', children: ch, mode:n.mode, owner:n.owner, mtime:Date.now() };
    }
    const copy = cloneNode(srcNode);
    const dNode = fsGetNode(dst);
    if(dNode && dNode.type === 'dir'){
      dNode.children[args[0].split('/').pop()] = copy;
    }else{
      const dParts = dst.split('/').slice(1);
      const dName = dParts.pop();
      let cd = state.fs;
      for(const part of dParts){
        if(!cd.children[part]) cd.children[part] = { type:'dir', children:{}, mode:0o755, owner:'root', mtime:Date.now()};
        cd = cd.children[part];
      }
      cd.children[dName] = copy;
    }
    return '';
  }, { short:'Copy files and directories' });

  register('grep', async (ctx,args) => {
    if(args.length < 2) return 'Usage: grep <pattern> <file>';
    const [pattern, file] = args;
    const node = fsGetNode(file);
    if(!node) return `grep: ${file}: No such file`;
    if(node.type !== 'file') return `grep: ${file}: Is a directory`;
    const re = new RegExp(pattern);
    return node.content.split('\n').filter(l => re.test(l)).join('\n');
  }, { short:'Search file for pattern' });

  register('head', async (ctx,args) => {
    const lines = 10;
    const node = fsGetNode(args[0] || '');
    if(!node) return 'Usage: head <file>';
    if(node.type !== 'file') return 'head: Not a file';
    return node.content.split('\n').slice(0, lines).join('\n');
  }, { short:'Print first lines of file' });

  register('tail', async (ctx,args) => {
    const lines = 10;
    const node = fsGetNode(args[0] || '');
    if(!node) return 'Usage: tail <file>';
    if(node.type !== 'file') return 'tail: Not a file';
    const arr = node.content.split('\n');
    return arr.slice(Math.max(0, arr.length - lines)).join('\n');
  }, { short:'Print last lines' });

  register('wc', async (ctx,args) => {
    if(!args[0]) return 'Usage: wc <file>';
    const node = fsGetNode(args[0]);
    if(!node || node.type !== 'file') return `wc: ${args[0]}: No such file`;
    const lines = node.content.split('\n').length;
    const words = node.content.split(/\s+/).filter(Boolean).length;
    const bytes = new TextEncoder().encode(node.content).length;
    return `${lines} ${words} ${bytes} ${args[0]}`;
  }, { short:'Word/line/byte count' });

  register('sort', async (ctx,args) => {
    if(!args[0]) return 'Usage: sort <file>';
    const node = fsGetNode(args[0]);
    if(!node || node.type !== 'file') return `sort: ${args[0]}: No such file`;
    return node.content.split('\n').sort().join('\n');
  }, { short:'Sort lines' });

  register('uniq', async (ctx,args) => {
    if(!args[0]) return 'Usage: uniq <file>';
    const node = fsGetNode(args[0]);
    if(!node || node.type !== 'file') return `uniq: ${args[0]}: No such file`;
    const seen = new Set();
    return node.content.split('\n').filter(l => { if(seen.has(l)) return false; seen.add(l); return true; }).join('\n');
  }, { short:'Filter duplicate lines' });

  register('chmod', async (ctx,args) => {
    if(args.length < 2) return 'Usage: chmod <mode> <file>';
    const mode = parseInt(args[0], 8);
    const node = fsGetNode(args[1]);
    if(!node) return `chmod: cannot access '${args[1]}': No such file`;
    node.mode = mode || node.mode;
    return '';
  }, { short:'Change file mode bits' });

  register('chown', async (ctx,args) => {
    if(args.length < 2) return 'Usage: chown <owner> <file>';
    const node = fsGetNode(args[1]);
    if(!node) return `chown: cannot access '${args[1]}': No such file`;
    node.owner = args[0];
    return '';
  }, { short:'Change file owner (simulated)' });

  register('ps', async (ctx,args) => {
    // Simulated processes
    return 'PID TTY          TIME CMD\n1 ?        00:00:00 init\n12 ?       00:00:01 node\n34 ?       00:00:00 bash';
  }, { short:'Report process status' });

  register('kill', async (ctx,args) => {
    if(!args[0]) return 'Usage: kill <pid>';
    return `kill: (${args[0]}) - process terminated (simulated)`;
  }, { short:'Send signal to process (simulated)' });

  register('top', async () => 'top - Simulated load. CPU 1% MEM 42%\nPID USER  %CPU %MEM CMD\n12  guest   0.1  0.5  node\n34  guest   0.0  0.1  bash', { short:'Display real-time system info (simulated)' });

  register('uptime', async () => {
    const s = Math.floor((Date.now() - (window._boot || Date.now())) / 1000);
    return `up ${s} seconds`;
  }, { short:'Show how long system has been up' });

  register('who', async () => 'guest pts/0 2025-08-27', { short:'Show who is logged on' });

  register('alias', async (ctx,args) => {
    if(args.length === 0) return Object.entries(state.aliases).map(([k,v]) => `${k}='${v}'`).join('\n');
    for(const a of args){
      const [k,v] = a.split('=');
      state.aliases[k] = (v || '').replace(/^'|'$/g,'');
    }
    return '';
  }, { short:'Create alias' });

  register('unalias', async (ctx,args) => {
    for(const a of args) delete state.aliases[a];
    return '';
  }, { short:'Remove alias' });

  register('env', async () => Object.entries(state.env).map(([k,v]) => `${k}=${v}`).join('\n'), { short:'Show environment variables' });

  register('export', async (ctx,args) => {
    for(const a of args){
      const [k,v] = a.split('=');
      state.env[k] = v || '';
    }
    return '';
  }, { short:'Set environment variables' });

  register('history', async () => state.history.join('\n'), { short:'Show command history' });

  register('ping', async (ctx,args) => {
    const host = args[0] || '127.0.0.1';
    // simulated ping
    let out = '';
    for(let i=0;i<4;i++) out += `64 bytes from ${host}: icmp_seq=${i+1} ttl=64 time=${(10+Math.random()*80).toFixed(2)} ms\n`;
    return out + '\n--- ' + host + ' ping statistics ---\n4 packets transmitted, 4 received, 0% packet loss\n';
  }, { short:'Ping network host (simulated)' });

  register('ssh', async (ctx,args) => {
    if(!args[0]) return 'ssh: usage: ssh user@host';
    return `Connecting to ${args[0]}... (simulated)\nPermission denied (publickey).`;
  }, { short:'Open SSH connection (simulated)' });

  register('wget', async (ctx,args) => {
    if(!args[0]) return 'wget: missing URL';
    return `--2025-- Downloading from ${args[0]} (simulated)\nSaved to ./index.html (simulated)`;
  }, { short:'Download files (simulated)' });

  register('curl', async (ctx,args) => {
    if(!args[0]) return 'curl: try ' + "'curl <url>'";
    return `HTTP/1.1 200 OK\nContent-Type: text/html\n\n<html><body><h1>Simulated ${args[0]}</h1></body></html>`;
  }, { short:'Transfer data from URL (simulated)' });

  register('git', async (ctx,args) => {
    const sub = args[0] || 'help';
    if(sub === 'status') return 'On branch main\nnothing to commit, working tree clean (simulated)';
    if(sub === 'log') return 'commit abcdef12345 - Initial commit';
    if(sub === 'commit') return '[main abcdef1] simulated commit';
    if(sub === 'clone') return `Cloning into '${args[1] || 'repo'}'... done (simulated)`;
    return 'git (simulated) — supported: status, log, commit, clone';
  }, { short:'Git (simulated)' });

  register('nano', async (ctx,args) => {
    return `Opening nano editor for ${args[0] || 'newfile'} (simulated). Type content then run :wq to save (not implemented).`;
  }, { short:'Text editor (simulated)' });

  register('vi', async (ctx,args) => {
    return `vi: ${args[0] || ''} opened (simulated).`;
  }, { short:'Text editor (simulated)' });

  register('sudo', async (ctx,args) => {
    if(!args[0]) return 'sudo: usage: sudo <command>';
    return `sudo: a password is required (simulated)\nSorry, user ${state.user || 'guest'} is not allowed to run sudo on this system.`;
  }, { short:'Execute a command as another user (simulated)' });

  register('su', async (ctx,args) => {
    const u = args[0] || 'root';
    return `Password: (simulated) \nsu: Authentication failure for ${u}`;
  }, { short:'Switch user (simulated)' });

  register('uptime', async () => ' 06:00:00 up 1 day,  3:42, 1 user, load average: 0.00, 0.01, 0.05', { short:'Show uptime' });

  register('df', async () => '/dev/sim 100G 42G 58G 42% /', { short:'Report filesystem disk space usage (simulated)' });

  register('du', async (ctx,args) => '4\t./home\n2\t./home/guest', { short:'Estimate file space usage (simulated)' });

  register('mount', async () => '/dev/sim on / type ext4 (rw,relatime)', { short:'Show mounted filesystems (simulated)' });

  register('umount', async (ctx,args) => 'umount: ' + (args[0] || '') + ': not mounted', { short:'Unmount filesystem (simulated)' });

  register('traceroute', async (ctx,args) => {
    const host = args[0] || 'example.com';
    return `traceroute to ${host} (simulated)\n 1  192.168.0.1 ...\n 2  10.1.0.1  ...\n 3  ${host} ...`;
  }, { short:'Trace route to host (simulated)' });

  register('route', async () => 'Kernel IP routing table (simulated)', { short:'Show / manipulate the IP routing table (simulated)' });

  register('netstat', async () => 'Proto Recv-Q Send-Q Local Address        Foreign Address      State\ntcp        0      0 0.0.0.0:22         0.0.0.0:*            LISTEN', { short:'Network connections (simulated)' });

  register('ifconfig', async () => 'eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\ninet 192.168.1.100  netmask 255.255.255.0', { short:'Configure network interfaces (simulated)' });

  register('ip', async (ctx,args) => 'ip (simulated) - try ip addr', { short:'Show/manipulate routing, devices, policy routing and tunnels (simulated)' });

  register('shutdown', async () => 'Shutdown scheduled (simulated)', { short:'Halt, power-off, or reboot the machine (simulated)' });

  register('reboot', async () => 'Rebooting (simulated)...', { short:'Reboot the system (simulated)' });

  register('calc', async (ctx,args) => {
    try{ const expr = args.join(' '); // safe-ish eval
      if(!expr) return 'Usage: calc <expression>';
      // basic arithmetic only
      if(!/^[0-9+\-*/().\s]+$/.test(expr)) return 'calc: invalid characters';
      // eslint-disable-next-line no-eval
      const res = eval(expr);
      return String(res);
    }catch(e){ return 'calc: error'; }
  }, { short:'Simple arithmetic' });

  register('helpfull', async () => 'This is an extended help: ' + Object.keys(commands).length + ' commands available.', { short:'Extended help' });

  // Several aliases to increase count
  ['ll','la','lsblk','mountpoint','stat','nice','renice'].forEach(a => {
    register(a, async () => `${a}: simulated helper command`, { short: 'Simulated ' + a });
  });

  // manual pages for some commands
  if(commands['ls']) commands['ls'].meta.man = `LS(1) User Commands\n\nls - list directory contents\n\nUsage: ls [directory]\n\nOptions: (simulated)\n`;
  if(commands['git']) commands['git'].meta.man = `GIT(1)\n\nSimulated git commands: status, clone, commit, log\n`;

  // Parser: handle redirection > and >> and simple piping not implemented fully.
  async function runCommandLine(line){
    // store history
    if(line.trim()) state.history.push(line);
    state.histIndex = null;

    // apply aliases
    const aliasKeys = Object.keys(state.aliases);
    const aliasedLine = aliasKeys.reduce((L, k) => {
      const re = new RegExp('^' + k + '(\\s|$)');
      if(re.test(L)) return L.replace(re, state.aliases[k] + '$1');
      return L;
    }, line);

    // parse redirection >
    let outToFile = null, append = false;
    let base = aliasedLine;
    const m = aliasedLine.match(/(.*)>>(?:\s*)(\S+)$/);
    if(m){ base = m[1].trim(); outToFile = m[2]; append = true; }
    else {
      const mm = aliasedLine.match(/(.*)>(?:\s*)(\S+)$/);
      if(mm){ base = mm[1].trim(); outToFile = mm[2]; append = false; }
    }

    const parts = base.split(/\s+/).filter(Boolean);
    if(parts.length === 0) return;
    const cmd = parts[0];
    const args = parts.slice(1);

    // check for builtins/commands
    let output = '';
    if(commands[cmd]){
      try{
        const res = await commands[cmd].fn({ state }, args);
        output = res == null ? '' : String(res);
      }catch(e){
        output = `Error executing ${cmd}: ${e.message}`;
      }
    }else{
      output = `${cmd}: command not found`;
    }

    // if redirect
    if(outToFile){
      const ok = fsWriteFile(outToFile, output + '\n', append);
      if(!ok) print(`<span class="error">Failed to write to ${outToFile}</span>`);
      return;
    }

    if(output) print(`<span class="stdin">${escapeHtml(output)}</span>`);
  }

  // Input handling
  cmdInput.addEventListener('keydown', async (ev) => {
    if(ev.key === 'Enter'){
      ev.preventDefault();
      const line = cmdInput.value;
      print(`<span class="prompt">${escapeHtml(buildPrompt())}</span> ${escapeHtml(line)}`, 'cmd');
      cmdInput.value = '';
      await runCommandLine(line);
      renderPrompt();
    } else if(ev.key === 'ArrowUp'){
      ev.preventDefault();
      if(state.history.length === 0) return;
      if(state.histIndex === null) state.histIndex = state.history.length - 1;
      else state.histIndex = Math.max(0, state.histIndex - 1);
      cmdInput.value = state.history[state.histIndex] || '';
    } else if(ev.key === 'ArrowDown'){
      ev.preventDefault();
      if(state.history.length === 0) return;
      if(state.histIndex === null) return;
      state.histIndex = Math.min(state.history.length - 1, state.histIndex + 1);
      if(state.histIndex === state.history.length - 1) { cmdInput.value = ''; state.histIndex = null; }
      else cmdInput.value = state.history[state.histIndex] || '';
    } else if(ev.key === 'Tab'){
      ev.preventDefault();
      const cur = cmdInput.value.trim();
      const candidates = Object.keys(commands).concat(Object.keys(state.aliases)).filter(n => n.startsWith(cur));
      if(candidates.length === 1) cmdInput.value = candidates[0] + ' ';
      else if(candidates.length > 1) print(candidates.join(' '));
    }
  });

  // Build prompt
  function buildPrompt(){
    const user = state.user || 'guest';
    const host = 'simhost';
    const cwd = state.cwd.replace(state.env.HOME || '/home/guest', '~');
    return `${user}@${host}:${cwd}$`;
  }

  function renderPrompt(){
    promptEl.textContent = buildPrompt();
    cmdInput.focus();
  }

  // Login logic
  const users = loadUsers();

  loginForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const user = usernameInput.value.trim();
    const pass = passwordInput.value;
    const stored = loadUsers();
    if(stored[user] && stored[user].password === pass){
      loginSuccess(user);
    }else{
      loginMsg.textContent = 'Invalid username or password';
      setTimeout(()=> loginMsg.textContent='', 4000);
    }
  });

  signupBtn.addEventListener('click', () => {
    const user = usernameInput.value.trim();
    const pass = passwordInput.value;
    if(!user || !pass){ loginMsg.textContent = 'Provide username and password to sign up'; return; }
    const us = loadUsers();
    if(us[user]){ loginMsg.textContent = 'User already exists'; return; }
    us[user] = { password: pass, home: `/home/${user}` };
    saveUsers(us);
    // create home directory
    state.fs.children.home.children[user] = { type:'dir', children: { 'welcome.txt': { type:'file', content: `Welcome ${user}!\n`, mode:0o644, owner:user, mtime:Date.now() } }, mode:0o755, owner:user, mtime:Date.now() };
    loginSuccess(user);
  });

  function loginSuccess(user){
    const us = loadUsers();
    state.user = user;
    state.env.USER = user;
    const home = (us[user] && us[user].home) || `/home/${user}`;
    state.env.HOME = home;
    state.cwd = home;
    overlay.classList.add('hidden');
    app.classList.remove('hidden');
    status.textContent = `User: ${user}`;
    state.fs = state.fs || mkfs();
    // ensure home exists
    const homeNode = fsGetNode(home);
    if(!homeNode){
      // create
      const parts = home.split('/').slice(1);
      let cur = state.fs;
      for(const p of parts){
        if(!cur.children[p]) cur.children[p] = { type:'dir', children:{}, mode:0o755, owner:user, mtime:Date.now() };
        cur = cur.children[p];
      }
    }
    print(`Welcome ${user}! This is a simulated terminal. Type 'help' to see commands.`);
    renderPrompt();
    cmdInput.focus();
  }

  // Boot
  function boot(){
    window._boot = Date.now();
    state.fs = mkfs();
    // copy demo account home
    const us = loadUsers();
    if(us.sparkpacket && us.sparkpacket.home) {
      // ensure dir
      const p = us.sparkpacket.home;
      const parts = p.split('/').slice(1);
      let cur = state.fs;
      for(const part of parts){
        if(!cur.children[part]) cur.children[part] = { type:'dir', children:{}, mode:0o755, owner:'sparkpacket', mtime:Date.now() };
        cur = cur.children[part];
      }
      cur.children['readme.txt'] = { type:'file', content: 'Hello sparkpacket — enjoy the simulator!\n', mode:0o644, owner:'sparkpacket', mtime:Date.now() };
    }
  }

  boot();

  // Keyboard focus when clicking output area
  screen.addEventListener('click', () => cmdInput.focus());

  // Expose some objects for debugging in console
  window.termSim = { state, commands, fsGetNode, fsWriteFile };

  // initial UX: if stored demo user and prefill
  usernameInput.value = 'sparkpacket';
  passwordInput.value = 'win32';
})();
