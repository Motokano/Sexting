const Engine = {
    db: { config: null, scenes: null, npcs: null, buffs: null, objects: null, actions: null, events: null },
    cur: null, pIdx: 0, flags: {}, 
    time: { month: 2, day: 24, hour: 8, minute: 0 },
    state: {},

    async init() {
        const files = ['config', 'scenes', 'npcs', 'buffs', 'objects', 'actions', 'events'];
        try {
            const results = await Promise.all(files.map(async f => {
                const r = await fetch(`./data/${f}.json?v=${Date.now()}`);
                if (!r.ok) throw new Error(`${f}.json缺失`);
                return r.json();
            }));
            files.forEach((f, i) => Engine.db[f] = results[i]);
            const pID = Object.keys(Engine.db.npcs).find(k => Engine.db.npcs[k].is_player);
            Engine.state = JSON.parse(JSON.stringify(Engine.db.npcs[pID].base_stats));
            Engine.setupResizer();
            Engine.loadScene(Engine.db.config.startScene, Engine.db.config.startIndex);
        } catch (e) { console.error(e); }
    },

    loadScene(id, entry = null) {
        if (!Engine.db.scenes[id]) return;
        Engine.cur = JSON.parse(JSON.stringify(Engine.db.scenes[id]));
        if (entry !== null) Engine.pIdx = entry;
        Engine.render();
        Engine.log(`<b>[环境]</b> 抵达：${Engine.cur.name}`);
    },

    advanceTime(mins) {
        const m = Number(mins) || 0;
        Engine.time.minute += m;
        while (Engine.time.minute >= 60) { Engine.time.minute -= 60; Engine.time.hour++; }
        while (Engine.time.hour >= 24) { Engine.time.hour -= 24; Engine.time.day++; }
        Engine.state.fullness = Math.max(0, Engine.state.fullness - m/80);
        Engine.state.hydration = Math.max(0, Engine.state.hydration - m/60);
        Engine.state.fatigue = Math.min(100, Engine.state.fatigue + m/120);
        Engine.render();
    },

    render() {
        UI.updateStatus(Engine.time, Engine.cur.name);
        const g = document.getElementById('action-grid');
        g.innerHTML = "";
        Engine.cur.grid.forEach((c, i) => {
            const isP = (i === Engine.pIdx);
            const ref = c.object_id ? Engine.db.objects[c.object_id] : (c.npc_id ? Engine.db.npcs[c.npc_id] : null);
            const btn = document.createElement('div');
            btn.className = `btn ${c.type || (ref?ref.type:'')} ${c.blocking || (ref?ref.blocking:false) ? 'blocking' : ''} ${isP ? 'player-token' : ''}`;
            btn.innerText = isP ? "我" : (ref ? ref.sn : (c.sn || ""));
            btn.onclick = () => Engine.click(i);
            g.appendChild(btn);
        });
        UI.renderStats(Engine.state);
        Engine.updateMenus();
    },

    click(i) {
        const c = Engine.cur.grid[i], d = Engine.dist(Engine.pIdx, i);
        if (d === 1) {
            const ref = c.object_id ? Engine.db.objects[c.object_id] : null;
            if (c.blocking || (ref && ref.blocking)) return;
            
            let legMult = 1;
            if (Engine.state.limbs.l_leg <= 0 && Engine.state.limbs.r_leg <= 0) legMult = 3;
            else if (Engine.state.limbs.l_leg <= 0 || Engine.state.limbs.r_leg <= 0) legMult = 2;

            Engine.pIdx = i;
            Engine.advanceTime(10 * legMult);
            const cmds = c.onStep || (ref ? ref.onStep : null);
            if (cmds) Engine.run(cmds);
            Engine.render();
        } else if (d === 0) Engine.render(); 
    },

    updateMenus() {
        UI.renderMenu('self-options', Engine.db.config.sys_events, "个人指令");
        const c = Engine.cur.grid[Engine.pIdx];
        const ref = c.object_id ? Engine.db.objects[c.object_id] : (c.npc_id ? Engine.db.npcs[c.npc_id] : null);
        const evts = c.event_ids || (ref ? ref.event_ids : null);
        const ctxSec = document.getElementById('context-section');
        if (evts) {
            ctxSec.classList.remove('hidden');
            UI.renderMenu('context-options', evts, c.fn || (ref ? ref.fn : "当前"));
        } else ctxSec.classList.add('hidden');
    },

    run(cmds) {
        if (!cmds) return;
        cmds.forEach(c => {
            switch(c.type) {
                case 'log': Engine.log(c.val); break;
                case 'move': Engine.loadScene(c.target, c.entry); break;
                case 'advance_time': Engine.advanceTime(c.val); break;
                case 'mod_stat': Engine.state[c.key] = Math.max(0, Math.min(100, Engine.state[c.key] + Number(c.val))); break;
                case 'hp_limb': Engine.applyLimbDamage(c.limb, Number(c.val)); break;
                case 'recover_limbs_ratio':
                    Object.keys(Engine.state.limbs).forEach(l => {
                        const m = Engine.state.maxLimbs[l];
                        Engine.state.limbs[l] = Math.min(m, Engine.state.limbs[l] + m * Number(c.val));
                    });
                    break;
                case 'call_action': if (Engine.db.actions[c.id]) Engine.run(Engine.db.actions[c.id]); break;
                case 'check_body_text': Engine.log(`<b>[感知]</b> ${Engine.getSensation()}`); break;
            }
        });
        Engine.render();
    },

    applyLimbDamage(limb, val) {
        if (val < 0) {
            let overflow = Math.abs(val);
            const cur = Engine.state.limbs[limb];
            if (cur > 0) {
                const dmg = Math.min(cur, overflow);
                Engine.state.limbs[limb] -= dmg;
                overflow -= dmg;
            }
            if (overflow > 0) {
                Engine.log(`<span style='color:red'>[溢出] ${limb}已毁，余威冲击全身！</span>`);
                const alive = Object.keys(Engine.state.limbs).filter(k => Engine.state.limbs[k] > 0);
                if (alive.length > 0) {
                    const share = overflow / alive.length;
                    alive.forEach(k => Engine.state.limbs[k] = Math.max(0, Engine.state.limbs[k] - share));
                }
            }
            document.getElementById('game-app').classList.add('damage-flash');
            setTimeout(() => document.getElementById('game-app').classList.remove('damage-flash'), 150);
        } else {
            Engine.state.limbs[limb] = Math.min(Engine.state.maxLimbs[limb], Engine.state.limbs[limb] + val);
        }
    },
    dist(a, b) { return Math.abs(Math.floor(a/8)-Math.floor(b/8)) + Math.abs(a%8-b%8); },
    log(txt) {
        const e = document.createElement('div'); e.className = 'log'; e.innerHTML = txt;
        document.getElementById('log-content').appendChild(e);
        document.getElementById('log-console').scrollTop = 99999;
    },
    getSensation() {
        const sArr = Engine.db.buffs.sensations;
        const res = [];
        for (let s of sArr) {
            if (s.condition === "default") continue;
            let match = false;
            if (s.condition.limb) {
                const r = Engine.state.limbs[s.condition.limb] / Engine.state.maxLimbs[s.condition.limb];
                if (r <= s.condition.ratio) match = true;
            } else if (s.condition.stat) {
                const v = Engine.state[s.condition.stat];
                if (s.condition.op === "lt" && v < s.condition.val) match = true;
            }
            if (match) res.push(s.text);
        }
        return res.length > 0 ? res.join(" ") : sArr.find(s => s.condition === "default").text;
    },
    setupResizer() {
        let act = false; const r = document.getElementById('log-resizer'), c = document.getElementById('log-console');
        r.onmousedown = () => act = true;
        document.onmousemove = (e) => { if (act) { const h = window.innerHeight - e.clientY; if (h > 50 && h < window.innerHeight * 0.7) c.style.height = h + 'px'; } };
        document.onmouseup = () => act = false;
    }
};
window.onload = () => Engine.init();