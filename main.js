const Engine = {
    db: { config: null, scenes: null, npcs: null, buffs: null, objects: null, actions: null },
    cur: null, pIdx: 0, flags: {}, 
    time: { month: 2, day: 24, hour: 8, minute: 0 },
    state: {},

    async init() {
        const files = ['config', 'scenes', 'npcs', 'buffs', 'objects', 'actions'];
        try {
            const results = await Promise.all(files.map(async f => {
                const r = await fetch(`./data/${f}.json?v=${Date.now()}`);
                if (!r.ok) throw new Error(`丢失文件: ${f}.json`);
                return r.json();
            }));
            files.forEach((f, i) => this.db[f] = results[i]);
            const pID = Object.keys(this.db.npcs).find(k => this.db.npcs[k].is_player);
            this.state = JSON.parse(JSON.stringify(this.db.npcs[pID].base_stats));
            this.setupResizer();
            this.loadScene(this.db.config.startScene, this.db.config.startIndex);
        } catch (e) {
            console.error(e);
            document.getElementById('loc-display').innerText = "载入失败，请检查控制台";
        }
    },

    loadScene(id, entry = null) {
        this.cur = JSON.parse(JSON.stringify(this.db.scenes[id]));
        if (entry !== null) this.pIdx = entry;
        this.render();
        this.log(`<b>[位置]</b> 抵达：${this.cur.name}`);
    },

    advanceTime(mins) {
        // 强制确保 mins 是有效数字
        const m = Number(mins) || 0;
        this.time.minute += m;
        while (this.time.minute >= 60) { this.time.minute -= 60; this.time.hour++; }
        while (this.time.hour >= 24) { this.time.hour -= 24; this.time.day++; }
        
        // 生存自然衰减
        this.state.fullness = Math.max(0, this.state.fullness - m/80);
        this.state.hydration = Math.max(0, this.state.hydration - m/60);
        this.state.fatigue = Math.min(100, this.state.fatigue + m/100);

        this.tickBuffs();
        this.render();
    },

    tickBuffs() {
        if (!this.state.buffs) return;
        this.state.buffs.forEach((b, idx) => {
            const proto = this.db.buffs.effects[b.id];
            if (proto && proto.onTick) this.run(proto.onTick);
            b.timer--;
            if (b.timer <= 0) {
                this.log(`<b>[状态消失]</b> ${proto.name}的效果结束了。`);
                this.state.buffs.splice(idx, 1);
            }
        });
    },

    render() {
        this.updateVisual();
        const g = document.getElementById('action-grid');
        g.innerHTML = "";
        this.cur.grid.forEach((c, i) => {
            const btn = document.createElement('div');
            const isP = (i === this.pIdx);
            const ref = c.object_id ? this.db.objects[c.object_id] : (c.npc_id ? this.db.npcs[c.npc_id] : null);
            btn.className = `btn ${c.type || (ref?ref.type:'')} ${c.blocking || (ref?ref.blocking:false) ? 'blocking' : ''} ${isP ? 'player-token' : ''}`;
            btn.innerText = isP ? "我" : (ref ? ref.sn : (c.sn || ""));
            btn.onclick = () => this.click(i);
            g.appendChild(btn);
        });
        this.renderStats();
        this.updateMenu();
    },

    click(i) {
        const c = this.cur.grid[i], d = this.dist(this.pIdx, i);
        if (d === 1) {
            const ref = c.object_id ? this.db.objects[c.object_id] : null;
            if (c.blocking || (ref && ref.blocking)) return;
            
            this.pIdx = i;
            
            // 修复 NaN 的核心逻辑：严谨判断 timeMult
            let costFactor = 1;
            if (c.timeMult) costFactor = c.timeMult;
            else if (ref && ref.timeMult) costFactor = ref.timeMult;
            
            this.advanceTime(10 * costFactor);

            const cmds = c.onStep || (ref ? ref.onStep : null);
            if (cmds) this.run(cmds);
            this.render();
        } else if (d === 0) this.updateMenu();
    },

    run(cmds) {
        if (!cmds) return;
        cmds.forEach(c => {
            switch(c.type) {
                case 'log': this.log(c.val); break;
                case 'move': this.loadScene(c.target, c.entry); break;
                case 'advance_time': this.advanceTime(c.val); break;
                case 'flash': this.flash(); break;
                case 'mod_stat': 
                    const maxS = 100;
                    this.state[c.key] = Math.max(0, Math.min(maxS, this.state[c.key] + Number(c.val))); 
                    break;
                case 'hp_limb':
                    const mL = this.state.maxLimbs[c.limb];
                    this.state.limbs[c.limb] = Math.min(mL, Math.max(0, this.state.limbs[c.limb] + Number(c.val)));
                    break;
                case 'recover_all_limbs':
                    Object.keys(this.state.limbs).forEach(l => this.state.limbs[l] = this.state.maxLimbs[l]);
                    break;
                case 'add_buff':
                    this.state.buffs.push({ id: c.id, timer: c.dur });
                    this.log(`<b>[状态]</b> ${this.db.buffs.effects[c.id].name}`);
                    break;
                case 'call_action': 
                    if (this.db.actions[c.id]) this.run(this.db.actions[c.id]);
                    else console.error("未找到动作 ID:", c.id);
                    break;
                case 'check_body_text': this.log(`<b>[感知]</b> ${this.getSensation()}`); break;
            }
        });
        this.render();
    },

    getSensation() {
        const sens = this.db.buffs.sensations;
        const res = [];
        for (let s of sens) {
            if (s.condition === "default") continue;
            let match = false;
            if (s.condition.limb) {
                const ratio = this.state.limbs[s.condition.limb] / this.state.maxLimbs[s.condition.limb];
                if (ratio <= s.condition.ratio) match = true;
            } else if (s.condition.stat) {
                const val = this.state[s.condition.stat];
                if (s.condition.op === "lt" && val < s.condition.val) match = true;
                if (s.condition.op === "gt" && val > s.condition.val) match = true;
            }
            if (match) res.push(s.text);
        }
        return res.length > 0 ? res.join(" ") : sens.find(s => s.condition === "default").text;
    },

    renderStats() {
        const s = this.state;
        const limbs = Object.entries(s.limbs).map(([k, v]) => {
            const m = s.maxLimbs[k];
            const c = v < m * 0.4 ? '#e74c3c' : '#2c3e50';
            return `<span style="color:${c};margin-right:8px">${k}:${v.toFixed(0)}/${m}</span>`;
        }).join('');
        document.getElementById('stat-monitor').innerHTML = `
            <div style="margin-bottom:5px">${limbs}</div>
            <div style="font-weight:bold; color:#7f8c8d">饱食: ${s.fullness.toFixed(1)} | 饮水: ${s.hydration.toFixed(1)} | 疲劳: ${s.fatigue.toFixed(1)}</div>
        `;
    },

    updateMenu() {
        const s = document.getElementById('self-options'); s.innerHTML = "";
        this.db.config.sys_acts.forEach(a => {
            const b = document.createElement('button'); b.className = "menu-btn"; b.innerText = a.label;
            b.onclick = () => this.run(a.cmd);
            s.appendChild(b);
        });
        const cS = document.getElementById('context-section'), cO = document.getElementById('context-options');
        const c = this.cur.grid[this.pIdx];
        const r = c.object_id ? this.db.objects[c.object_id] : (c.npc_id ? this.db.npcs[c.npc_id] : null);
        const acts = c.acts || (r ? r.acts : null);
        if (acts) {
            cS.classList.remove('hidden');
            cO.innerHTML = `<p style="font-size:11px;color:#999">${c.fn || (r?r.fn:'')}</p>`;
            acts.forEach(a => {
                const b = document.createElement('button'); b.className = "menu-btn"; b.innerText = a.label;
                b.onclick = () => this.run(a.cmd);
                cO.appendChild(b);
            });
        } else cS.classList.add('hidden');
    },

    dist(a, b) { return Math.abs(Math.floor(a/8)-Math.floor(b/8)) + Math.abs(a%8-b%8); },
    updateVisual() {
        const app = document.getElementById('game-app');
        if (this.time.hour >= 19 || this.time.hour < 6) app.classList.add('night');
        else app.classList.remove('night');
    },
    flash() { const a = document.getElementById('game-app'); a.classList.add('damage-flash'); setTimeout(()=>a.classList.remove('damage-flash'),150); },
    log(txt) { const e = document.createElement('div'); e.className = 'log'; e.innerHTML = txt; document.getElementById('log-content').appendChild(e); document.getElementById('log-console').scrollTop = 99999; },
    setupResizer() { /* 维持原样 */ }
};
window.onload = () => Engine.init();