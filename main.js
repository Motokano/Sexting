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
            files.forEach((f, i) => Engine.db[f] = results[i]);

            // 寻找主控角色
            const pID = Object.keys(Engine.db.npcs).find(k => Engine.db.npcs[k].is_player);
            Engine.state = JSON.parse(JSON.stringify(Engine.db.npcs[pID].base_stats));

            Engine.setupResizer();
            // 确保渲染函数存在后再加载
            Engine.loadScene(Engine.db.config.startScene, Engine.db.config.startIndex);
        } catch (e) {
            console.error("初始化失败:", e);
        }
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
        Engine.state.fatigue = Math.min(100, Engine.state.fatigue + m/100);

        Engine.tickBuffs();
        Engine.updateVisual();
        Engine.render();
    },

    tickBuffs() {
        if (!Engine.state.buffs) return;
        Engine.state.buffs.forEach((b, idx) => {
            const proto = Engine.db.buffs.effects[b.id];
            if (proto && proto.onTick) Engine.run(proto.onTick);
            b.timer--;
            if (b.timer <= 0) {
                Engine.log(`<b>[状态消失]</b> ${proto.name}的效果结束了。`);
                Engine.state.buffs.splice(idx, 1);
            }
        });
    },

    updateVisual() {
        const app = document.getElementById('game-app');
        const timeEl = document.getElementById('time-display');
        if (timeEl) {
            const t = Engine.time;
            timeEl.innerText = `${t.month}月${t.day}日 ${t.hour.toString().padStart(2, '0')}:${t.minute.toString().padStart(2, '0')}`;
        }
        if (Engine.time.hour >= 19 || Engine.time.hour < 6) app.classList.add('night');
        else app.classList.remove('night');
    },

    render() {
        Engine.updateVisual();
        const g = document.getElementById('action-grid');
        g.innerHTML = "";
        Engine.cur.grid.forEach((c, i) => {
            const btn = document.createElement('div');
            const isP = (i === Engine.pIdx);
            const ref = c.object_id ? Engine.db.objects[c.object_id] : (c.npc_id ? Engine.db.npcs[c.npc_id] : null);
            
            btn.className = `btn ${c.type || (ref?ref.type:'')} ${c.blocking || (ref?ref.blocking:false) ? 'blocking' : ''} ${isP ? 'player-token' : ''}`;
            btn.innerText = isP ? "我" : (ref ? ref.sn : (c.sn || ""));
            btn.onclick = () => Engine.click(i);
            g.appendChild(btn);
        });
        Engine.renderStats();
        Engine.updateMenu();
    },

    click(i) {
        const c = Engine.cur.grid[i], d = Engine.dist(Engine.pIdx, i);
        if (d === 1) {
            const ref = c.object_id ? Engine.db.objects[c.object_id] : null;
            if (c.blocking || (ref && ref.blocking)) return;

            // --- 肢体伤损对移动的影响 ---
            let legMult = 1;
            const l_hp = Engine.state.limbs.l_leg;
            const r_hp = Engine.state.limbs.r_leg;
            
            if (l_hp <= 0 && r_hp <= 0) {
                legMult = 3; 
                Engine.log("<span style='color:red'>[伤损] 双腿均已废去，你只能在地上爬行。</span>");
            } else if (l_hp <= 0 || r_hp <= 0) {
                legMult = 2;
                Engine.log("<span style='color:orange'>[伤损] 一条腿已无法支撑，你步履蹒跚。</span>");
            }

            Engine.pIdx = i;
            const terrainMult = c.timeMult || (ref ? ref.timeMult : 1) || 1;
            Engine.advanceTime(10 * terrainMult * legMult);

            const stepCmds = c.onStep || (ref ? ref.onStep : null);
            if (stepCmds) Engine.run(stepCmds);
            Engine.render();
        } else if (d === 0) Engine.updateMenu();
    },

    run(cmds) {
        if (!cmds) return;
        cmds.forEach(c => {
            switch(c.type) {
                case 'log': Engine.log(c.val); break;
                case 'move': Engine.loadScene(c.target, c.entry); break;
                case 'advance_time': Engine.advanceTime(c.val); break;
                case 'flash': Engine.flash(); break;
                case 'mod_stat': 
                    Engine.state[c.key] = Math.max(0, Math.min(100, Engine.state[c.key] + Number(c.val))); 
                    break;
                case 'hp_limb':
                    Engine.applyLimbDamage(c.limb, Number(c.val));
                    break;
                case 'recover_all_limbs':
                    Object.keys(Engine.state.limbs).forEach(l => Engine.state.limbs[l] = Engine.state.maxLimbs[l]);
                    break;
                case 'add_buff':
                    Engine.state.buffs.push({ id: c.id, timer: c.dur });
                    Engine.log(`<b>[状态]</b> ${Engine.db.buffs.effects[c.id].name}`);
                    break;
                case 'call_action': 
                    if (Engine.db.actions[c.id]) Engine.run(Engine.db.actions[c.id]);
                    break;
                case 'check_body_text': Engine.log(`<b>[感知]</b> ${Engine.getSensation()}`); break;
            }
        });
        Engine.render();
    },

    // --- 伤害溢出均摊逻辑 ---
    applyLimbDamage(targetLimb, val) {
        if (val >= 0) { // 回复
            Engine.state.limbs[targetLimb] = Math.min(Engine.state.maxLimbs[targetLimb], Engine.state.limbs[targetLimb] + val);
        } else { // 伤害
            let overflow = Math.abs(val);
            const current = Engine.state.limbs[targetLimb];

            if (current > 0) {
                const damageTaken = Math.min(current, overflow);
                Engine.state.limbs[targetLimb] -= damageTaken;
                overflow -= damageTaken;
            }

            if (overflow > 0) {
                Engine.log(`<span style='color:red'>[溢出] ${targetLimb}已毁，余威冲击全身！</span>`);
                const alive = Object.keys(Engine.state.limbs).filter(k => Engine.state.limbs[k] > 0);
                if (alive.length > 0) {
                    const share = overflow / alive.length;
                    alive.forEach(k => Engine.state.limbs[k] = Math.max(0, Engine.state.limbs[k] - share));
                }
            }
            Engine.flash();
            if (Engine.state.limbs.head <= 0 || Engine.state.limbs.chest <= 0) {
                Engine.log("<b style='color:red'>[死亡] 核心部位损毁，你失去了意识...</b>");
            }
        }
    },

    getSensation() {
        const sens = Engine.db.buffs.sensations;
        const res = [];
        for (let s of sens) {
            if (s.condition === "default") continue;
            let match = false;
            if (s.condition.limb) {
                const ratio = Engine.state.limbs[s.condition.limb] / Engine.state.maxLimbs[s.condition.limb];
                if (ratio <= s.condition.ratio) match = true;
            } else if (s.condition.stat) {
                const val = Engine.state[s.condition.stat];
                if (s.condition.op === "lt" && val < s.condition.val) match = true;
                if (s.condition.op === "gt" && val > s.condition.val) match = true;
            }
            if (match) res.push(s.text);
        }
        return res.length > 0 ? res.join(" ") : sens.find(s => s.condition === "default").text;
    },

    renderStats() {
        const s = Engine.state;
        const limbs = Object.entries(s.limbs).map(([k, v]) => {
            const m = s.maxLimbs[k];
            const c = v <= 0 ? '#7f8c8d' : (v < m * 0.4 ? '#e74c3c' : '#2c3e50');
            return `<span style="color:${c};margin-right:8px;${v<=0?'text-decoration:line-through':''}"> ${k}:${v.toFixed(0)}/${m}</span>`;
        }).join('');
        document.getElementById('stat-monitor').innerHTML = `
            <div style="margin-bottom:5px">${limbs}</div>
            <div style="font-weight:bold; color:#7f8c8d">饱食:${s.fullness.toFixed(1)} 饮水:${s.hydration.toFixed(1)} 疲劳:${s.fatigue.toFixed(1)}</div>
        `;
    },

    updateMenu() {
        const s = document.getElementById('self-options'); s.innerHTML = "";
        Engine.db.config.sys_acts.forEach(a => {
            const b = document.createElement('button'); b.className = "menu-btn"; b.innerText = a.label;
            b.onclick = () => Engine.run(a.cmd);
            s.appendChild(b);
        });
        const cS = document.getElementById('context-section'), cO = document.getElementById('context-options');
        const c = Engine.cur.grid[Engine.pIdx];
        const r = c.object_id ? Engine.db.objects[c.object_id] : (c.npc_id ? Engine.db.npcs[c.npc_id] : null);
        const acts = c.acts || (r ? r.acts : null);
        if (acts) {
            cS.classList.remove('hidden');
            cO.innerHTML = `<p style="font-size:11px;color:#999">${c.fn || (r?r.fn:'')}</p>`;
            acts.forEach(a => {
                const b = document.createElement('button'); b.className = "menu-btn"; b.innerText = a.label;
                b.onclick = () => Engine.run(a.cmd);
                cO.appendChild(b);
            });
        } else cS.classList.add('hidden');
    },

    dist(a, b) { return Math.abs(Math.floor(a/8)-Math.floor(b/8)) + Math.abs(a%8-b%8); },
    flash() { const a = document.getElementById('game-app'); a.classList.add('damage-flash'); setTimeout(()=>a.classList.remove('damage-flash'),150); },
    log(txt) { const e = document.createElement('div'); e.className = 'log'; e.innerHTML = txt; document.getElementById('log-content').appendChild(e); document.getElementById('log-console').scrollTop = 99999; },
    setupResizer() {
        let active = false; const r = document.getElementById('log-resizer'), c = document.getElementById('log-console');
        r.onmousedown = () => active = true;
        document.onmousemove = (e) => {
            if (active) {
                const h = window.innerHeight - e.clientY;
                if (h > 50 && h < window.innerHeight * 0.7) c.style.height = h + 'px';
            }
        };
        document.onmouseup = () => active = false;
    }
};
window.onload = () => Engine.init();
