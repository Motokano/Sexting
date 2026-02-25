const UI = {
    // 根据事件 ID 列表渲染菜单
    renderMenu(containerId, eventIds, fullName) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = `<p style="font-size:11px;color:#999;margin-bottom:8px">${fullName || ""}</p>`;
        
        if (!eventIds) return;

        eventIds.forEach(id => {
            const evt = Engine.db.events[id];
            if (!evt) return;

            const btn = document.createElement('button');
            btn.className = "menu-btn";
            btn.innerText = evt.label;

            const flagKey = evt.flag || id;
            const triggered = Engine.flags[flagKey];

            if (evt.repeatable === false && triggered) {
                btn.classList.add('disabled');
                btn.disabled = true;
                btn.innerText += " (已完成)";
            } else {
                btn.onclick = () => {
                    if (evt.repeatable === false) Engine.flags[flagKey] = true;
                    Engine.run(evt.cmd);
                };
            }
            container.appendChild(btn);
        });
    },

    renderStats(state) {
        const limbMap = { head: "头部", chest: "胸部", stomach: "腹部", l_arm: "左手", r_arm: "右手", l_leg: "左腿", r_leg: "右腿" };
        const limbs = Object.entries(state.limbs).map(([k, v]) => {
            const m = state.maxLimbs[k];
            const name = limbMap[k] || k;
            const c = v <= 0 ? '#7f8c8d' : (v < m * 0.4 ? '#e74c3c' : '#2c3e50');
            return `<span style="color:${c}; margin-right:10px; ${v<=0?'text-decoration:line-through':''}">${name}:${v.toFixed(0)}/${m}</span>`;
        }).join('');

        document.getElementById('stat-monitor').innerHTML = `
            <div style="margin-bottom:8px; line-height:1.6; display:flex; flex-wrap:wrap;">${limbs}</div>
            <div style="font-weight:bold; color:#7f8c8d; border-top:1px dashed #ddd; padding-top:5px">
                饱食:${state.fullness.toFixed(1)} | 饮水:${state.hydration.toFixed(1)} | 疲劳:${state.fatigue.toFixed(1)}
            </div>
        `;
    },

    updateStatus(time, sceneName) {
        const tEl = document.getElementById('time-display');
        const lEl = document.getElementById('loc-display');
        if (tEl) tEl.innerText = `${time.month}月${time.day}日 ${time.hour.toString().padStart(2, '0')}:${time.minute.toString().padStart(2, '0')}`;
        if (lEl) lEl.innerText = sceneName;
    }
};