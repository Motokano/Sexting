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
                if (!r.ok) throw new Error(`丢失: ${f}.json`);
                return r.json();
            }));
            files.forEach((f, i) => this.db[f] = results[i]);
            const pID = Object.keys(this.db.npcs).find(k => this.db.npcs[k].is_player);
            this.state = JSON.parse(JSON.stringify(this.db.npcs[pID].base_stats));
            this.setupResizer();
            this.loadScene(this.db.config.startScene, this.db.config.startIndex);
        } catch (e) { console.error(e); }
    },

    loadScene(id, entry = null) {
        this.cur = JSON.parse(JSON.stringify(this.db.scenes[id]));
        if (entry !== null) this.pIdx = entry;
        this.render();
        this.log(`<b>[位置]</b> 抵达：${this.cur.name}`);
    },

    // 修复：显式更新 UI 时间
    advanceTime(mins) {
        const m = Number(mins) || 0;
        this.time.minute += m;
        while (this.time.minute >= 60) { this.time.minute -= 60; this.time.hour++; }
        while (this.time.hour >= 24) { this.time.hour -= 24; this.time.day++; }
        
        this.state.fullness = Math.max(0, this.state.fullness - m/80);
        this.state.hydration = Math.max(0, this.state.hydration - m/60);
        this.state.fatigue = Math.min(100, this.state.fatigue + m/100);

        this.tickBuffs();
        this.updateVisual(); // 确保推进后立刻刷 UI
        this.render();
    },

    updateVisual() {
        const app = document.getElementById('game-app');
        const t = this.time;
        // 修复：确保 DOM 存在再更新
        const timeDisplay = document.getElementById('time-display');
        if (timeDisplay) {
            timeDisplay.innerText = `${t.month}月${t.day}日 ${t.hour.toString().padStart(2, '0')}:${t.minute.toString().padStart(2, '0')}`;
        }
        if (t.hour >= 19 || t.hour < 6) app.classList.add('night');
        else app.classList.remove('night');
    },

    click(i) {
        const c = this.cur.grid[i], d = this.dist(this.pIdx, i);
        if (d === 1) {
            const ref = c.object_id ? this.db.objects[c.object_id] : null;
            if (c.blocking || (ref && ref.blocking)) return;

            // --- 新增：肢体惩罚计算 ---
            let legMult = 1;
            const lLeg = this.state.limbs.l_leg;
            const rLeg = this.state.limbs.r_leg;
            
            if (lLeg <= 0 && rLeg <= 0) {
                legMult = 3; // 双腿全断，爬行速度
                this.log("<span style='color:#e74c3c'>[伤损] 你失去了双腿的支撑，只能在地上艰难爬行。</span>");
            } else if (lLeg <= 0 || rLeg <= 0) {
                legMult = 2; // 一条腿断，蹒跚速度
                this.log("<span style='color:#f39c12'>[伤损] 你的一条腿已无法受力，行走变得十分缓慢。</span>");
            }

            this.pIdx = i;
            const terrainMult = c.timeMult || (ref ? ref.timeMult : 1) || 1;
            this.advanceTime(10 * terrainMult * legMult);

            const stepCmds = c.onStep || (ref ? ref.onStep : null);
            if (stepCmds) this.run(stepCmds);
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
                    this.state[c.key] = Math.max(0, Math.min(100, this.state[c.key] + Number(c.val))); 
                    break;
                case 'hp_limb':
                    this.applyLimbDamage(c.limb, Number(c.val));
                    break;
                case 'recover_all_limbs':
                    Object.keys(this.state.limbs).forEach(l => this.state.limbs[l] = this.state.maxLimbs[l]);
                    break;
                case 'call_action': this.run(this.db.actions[c.id]); break;
                case 'check_body_text': this.log(`<b>[感知]</b> ${this.getSensation()}`); break;
            }
        });
        this.render();
    },

    // --- 新增：伤害分配算法 ---
    applyLimbDamage(targetLimb, damage) {
        if (damage >= 0) { // 回复逻辑
            const max = this.state.maxLimbs[targetLimb];
            this.state.limbs[targetLimb] = Math.min(max, this.state.limbs[targetLimb] + damage);
        } else { // 伤害逻辑
            let remainingDmg = Math.abs(damage);
            
            // 1. 首先扣除目标肢体的血量
            const currentHP = this.state.limbs[targetLimb];
            if (currentHP > 0) {
                const actualDmg = Math.min(currentHP, remainingDmg);
                this.state.limbs[targetLimb] -= actualDmg;
                remainingDmg -= actualDmg;
            }

            // 2. 如果还有溢出伤害，分摊到其他完好的肢体上
            if (remainingDmg > 0) {
                this.log(`<span style='color:red'>[剧痛] ${targetLimb}部位已损毁，伤势向全身蔓延！</span>`);
                const aliveLimbs = Object.keys(this.state.limbs).filter(key => this.state.limbs[key] > 0);
                
                if (aliveLimbs.length > 0) {
                    const splitDmg = remainingDmg / aliveLimbs.length;
                    aliveLimbs.forEach(limb => {
                        this.state.limbs[limb] = Math.max(0, this.state.limbs[limb] - splitDmg);
                    });
                }
            }
            this.flash();
            this.checkDeath();
        }
    },

    checkDeath() {
        if (this.state.limbs.head <= 0 || this.state.limbs.chest <= 0) {
            this.log("<b style='color:red'>[濒死] 核心部位受损，你的意识正在消散...</b>");
            // 这里可以触发 faint 或 game over
        }
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
            const c = v <= 0 ? '#7f8c8d' : (v < m * 0.4 ? '#e74c3c' : '#2c3e50');
            const style = v <= 0 ? 'text-decoration:line-through;' : '';
            return `<span style="color:${c};margin-right:8px;${style}">${k}:${v.toFixed(0)}/${m}</span>`;
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
    flash() { const a = document.getElementById('game-app'); a.classList.add('damage-flash'); setTimeout(()=>a.classList.remove('damage-flash'),150); },
    log(txt) { const e = document.createElement('div'); e.className = 'log'; e.innerHTML = txt; document.getElementById('log-content').appendChild(e); document.getElementById('log-console').scrollTop = 99999; },
    setupResizer() { /* 保持原样 */ }
};
window.onload = () => Engine.init();